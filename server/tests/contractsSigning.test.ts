/** Contracts step 2: review by the other party (email link + code, supplier portal), comments and proposals, e-signature. */
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { client, invitedSupplier, lastLinkTo, login, tokenOf } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import type { Tenant } from '../src/db/schema.js';
import { readBytes } from '../src/integrations/storage/index.js';
import { PROVIDERS, type EmailProvider, type LinkProvider } from '../src/integrations/esign/index.js';
import { forgetTokens } from '../src/integrations/esign/http.js';
import { jwtAssertion } from '../src/integrations/esign/docusign.js';

let acme: Tenant;
let original: Pick<Tenant, 'settings' | 'limits' | 'plan'>;
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const pageCount = async (fileId: string) => (await PDFDocument.load(await readBytes((await db.query.contractFiles.findFirst({ where: eq(schema.contractFiles.id, fileId) }))!))).getPageCount();

beforeAll(async () => {
  acme = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
  original = { settings: acme.settings, limits: acme.limits, plan: acme.plan };
  await db.update(schema.tenants).set({ limits: { features: { contracts: true } } }).where(eq(schema.tenants.id, acme.id));
  const admin = await login('admin@acme.test');
  expect((await admin.put('/api/admin/contracts', { enabled: true, types: { nda: true, service: true }, features: { esign: true, internalApproval: false } })).status).toBe(200);
});
afterAll(async () => { await db.update(schema.tenants).set(original).where(eq(schema.tenants.id, acme.id)); });

async function draftedNda(admin: Awaited<ReturnType<typeof login>>, name: string, email: string, extra: object = {}) {
  const party = (await admin.post('/api/staff/parties', { kind: 'CUSTOMER', name, country: 'IN', contacts: [{ name: 'Meena Shah', email, signatory: true }], ...extra })).body.party;
  const c = (await admin.post('/api/staff/contracts', { title: `NDA — ${name}`, direction: 'SELL', type: 'nda', partyId: party.id, startDate: iso(1), endDate: iso(700), description: 'A joint bid for a metro project.' })).body;
  const tpl = c.drafting.templates.find((t: any) => t.name === 'Mutual non-disclosure agreement');
  await admin.post(`/api/staff/contracts/${c.contract.id}/draft`, { templateId: tpl.id });
  await admin.post(`/api/staff/contracts/${c.contract.id}/document`);
  return { id: c.contract.id as string, party };
}
async function reviewer(email: string) {
  const token = tokenOf((await lastLinkTo(email))!);
  const r = client();
  expect((await r.get(`/api/review/link/${token}`)).body.contract.number).toMatch(/^NDA-/);
  const { devOtp } = (await r.post(`/api/review/link/${token}/code`)).body;
  expect((await r.post(`/api/review/link/${token}/verify`, { code: devOtp === '000000' ? '111111' : '000000' })).status).toBe(401);
  await db.update(schema.contractReviewers).set({ codeExpiresAt: new Date(Date.now() + 600_000) }).where(eq(schema.contractReviewers.email, email));
  expect((await r.post(`/api/review/link/${token}/verify`, { code: devOtp })).status).toBe(200);
  return r;
}

describe('e-signature settings', () => {
  test('choose a provider; secrets are required, stored encrypted and never sent back', async () => {
    const admin = await login('admin@acme.test');
    expect((await admin.put('/api/admin/contracts/esign', { provider: 'docusign', sandbox: true, values: { integrationKey: 'ik', userId: 'u' } })).body.error).toMatch(/RSA private key/);
    const ok = await admin.put('/api/admin/contracts/esign', { provider: 'docusign', sandbox: true, values: { integrationKey: 'ik', userId: 'u', privateKey: 'SECRET-KEY-TEXT' } });
    expect(ok.body.esign).toMatchObject({ provider: 'docusign', secretsSet: ['privateKey'], values: { integrationKey: 'ik', userId: 'u' } });
    expect(JSON.stringify(ok.body)).not.toContain('SECRET-KEY-TEXT');
    const stored = (await db.query.tenants.findFirst({ where: eq(schema.tenants.id, acme.id) }))!.settings as any;
    expect(JSON.stringify(stored)).not.toContain('SECRET-KEY-TEXT');
    // Saving again with the secret left empty keeps it.
    expect((await admin.put('/api/admin/contracts/esign', { provider: 'docusign', sandbox: false, values: { integrationKey: 'ik2', userId: 'u' } })).body.esign.secretsSet).toEqual(['privateKey']);
    expect((await admin.put('/api/admin/contracts/esign', { provider: 'test', sandbox: true, values: {} })).body.esign.provider).toBe('test');
    expect((await admin.post('/api/admin/contracts/esign/check')).body).toMatchObject({ ok: true });
  });
});

describe('review by the other party', () => {
  test('email link + code; comments and proposed wording; accepting a proposal reopens the draft; accept; test signing; supplier portal', async () => {
    const admin = await login('admin@acme.test');
    const { id } = await draftedNda(admin, 'Metro Builders', 'meena@metro.example');
    const share = await admin.post(`/api/staff/contracts/${id}/share`, { people: [{ name: 'Meena Shah', email: 'meena@metro.example' }], note: 'Please review by Friday.' });
    expect(share.body.contract.status).toBe('WITH_PARTY');
    const r = await reviewer('meena@metro.example');
    let view = (await r.get('/api/review/session')).body;
    expect(view.versions[0]).toMatchObject({ number: 1, status: 'OPEN', note: 'Please review by Friday.' });
    expect(view.clauses.find((c: any) => c.group === 'nda-purpose').text).toContain('A joint bid for a metro project');
    const pdf = view.versions[0].files.find((f: any) => f.fileName.endsWith('.pdf') || f.fileName.endsWith('.docx'));
    expect((await r.get(`/api/review/session/files/${pdf.id}`)).status).toBe(200);
    // Another contract's file is not reachable through this session.
    const other = await draftedNda(admin, 'Other Customer', 'x@other.example');
    const otherFile = (await admin.get(`/api/staff/contracts/${other.id}`)).body.files[0];
    expect((await r.get(`/api/review/session/files/${otherFile.id}`)).status).toBe(404);

    await r.post('/api/review/session/comments', { clauseGroup: 'confidentiality', text: 'Five years, please.', proposedText: 'Each Party shall keep the other’s information confidential for five (5) years after this Agreement ends.' });
    expect((await r.post('/api/review/session/comments', { clauseGroup: 'bogus', text: 'x?' })).status).toBe(400);
    const internal = await admin.post(`/api/staff/contracts/${id}/comments`, { text: 'Legal is fine with five years.', internal: true });
    expect(internal.status).toBe(200);
    view = (await r.post('/api/review/session/respond', { decision: 'CHANGES', note: 'See our comment on confidentiality.' })).body;
    expect(view.versions[0].status).toBe('CHANGES_REQUESTED');
    expect(view.comments.map((c: any) => c.text)).not.toContain('Legal is fine with five years.');

    let d = (await admin.get(`/api/staff/contracts/${id}`)).body;
    const proposal = d.negotiation.comments.find((c: any) => c.proposedText);
    d = (await admin.put(`/api/staff/contracts/${id}/comments/${proposal.id}`, { status: 'ACCEPTED' })).body;
    expect(d.contract.status).toBe('DRAFT');
    expect(d.drafting.draft).toMatchObject({ nonStandard: true, upToDate: false });
    expect(d.drafting.draft.clauses.find((c: any) => c.group === 'confidentiality').body).toContain('five (5) years');
    expect((await r.get('/api/review/session')).status).toBe(404);

    expect((await admin.post(`/api/staff/contracts/${id}/share`, { people: [{ name: 'Meena Shah', email: 'meena@metro.example' }] })).body.error).toMatch(/Make the document first/);
    await admin.post(`/api/staff/contracts/${id}/document`);
    await admin.post(`/api/staff/contracts/${id}/share`, { people: [{ name: 'Meena Shah', email: 'meena@metro.example' }] });
    const r2 = await reviewer('meena@metro.example');
    expect((await r2.post('/api/review/session/respond', { decision: 'ACCEPT' })).body.contract.status).toBe('AGREED');

    // Signature with the built-in test provider: the customer signs first, then us.
    expect((await admin.post(`/api/staff/contracts/${id}/signature`, { signers: [{ name: 'Meena Shah', email: 'meena@metro.example', side: 'PARTY' }] })).body.error).toMatch(/each side/);
    const sent = await admin.post(`/api/staff/contracts/${id}/signature`, { signers: [{ name: 'Anita Rao', email: 'admin@acme.test', side: 'US' }, { name: 'Meena Shah', email: 'meena@metro.example', side: 'PARTY' }] });
    expect(sent.body.contract.status).toBe('SIGNING');
    expect(sent.body.signing.request.signers.map((s: any) => [s.side, s.status])).toEqual([['PARTY', 'SENT'], ['US', 'WAITING']]);
    expect((await admin.post(`/api/staff/contracts/${id}/signature/start`)).body.error).toMatch(/Meena Shah’s turn/);
    const r3 = await reviewer('meena@metro.example');
    expect((await r3.get('/api/review/session')).body.signing).toMatchObject({ myTurn: true, test: true });
    const url = (await r3.post('/api/review/session/sign')).body.url as string;
    const back = await r3.agent.get(new URL(url).pathname);
    expect(back.status).toBe(303);
    expect(back.headers.location).toBe('/review?signing=done');
    expect((await r3.agent.get(new URL(url).pathname)).status).toBe(404); // the return code works once
    d = (await admin.get(`/api/staff/contracts/${id}`)).body;
    expect(d.signing.myTurn).toBe(true);
    const url2 = (await admin.post(`/api/staff/contracts/${id}/signature/start`)).body.url as string;
    expect((await admin.agent.get(new URL(url2).pathname)).headers.location).toBe(`/staff/contracts/${id}?signing=done`);
    d = (await admin.get(`/api/staff/contracts/${id}`)).body;
    expect(d.contract).toMatchObject({ status: 'ACTIVE', signedDate: iso(0) });
    expect(d.signing.request).toMatchObject({ status: 'COMPLETED' });
    const signed = d.files.find((f: any) => f.kind === 'SIGNED');
    const sentPdf = d.files.find((f: any) => f.kind === 'DRAFT' && f.fileName.endsWith('.pdf'));
    if (sentPdf) expect(await pageCount(signed.id)).toBe((await pageCount(sentPdf.id)) + 2);
    expect(d.history.map((h: any) => h.action)).toEqual(expect.arrayContaining(['CONTRACT_SENT_FOR_REVIEW', 'CONTRACT_PARTY_ACCEPTED', 'CONTRACT_SIGNED_BY', 'CONTRACT_SIGNED']));
    // The customer can download the signed copy.
    expect((await (await reviewer('meena@metro.example')).get(`/api/review/session/files/${signed.id}`)).status).toBe(200);
  });

  test('an onboarded supplier sees contracts shared with them in the supplier portal', async () => {
    const { id: vendorId, v, admin } = await invitedSupplier('Portal Supplier Co', 'portal@supplier.example');
    const party = (await admin.post('/api/staff/parties/from-supplier', { vendorId })).body.party;
    const c = (await admin.post('/api/staff/contracts', { title: 'Supply NDA', direction: 'BUY', type: 'nda', partyId: party.id, startDate: iso(1), endDate: iso(365) })).body;
    expect((await v.get('/api/vendor/contracts')).body.contracts).toEqual([]);
    const tpl = c.drafting.templates.find((t: any) => t.name === 'Mutual non-disclosure agreement');
    await admin.post(`/api/staff/contracts/${c.contract.id}/draft`, { templateId: tpl.id });
    await admin.post(`/api/staff/contracts/${c.contract.id}/document`);
    await admin.post(`/api/staff/contracts/${c.contract.id}/share`, { people: [{ name: 'Test Supplier', email: 'portal@supplier.example' }] });
    const list = (await v.get('/api/vendor/contracts')).body.contracts;
    expect(list.map((x: any) => x.number)).toEqual([c.contract.number]);
    const view = (await v.get(`/api/vendor/contracts/${c.contract.id}`)).body;
    expect(view.canRespond).toBe(true);
    expect((await v.post(`/api/vendor/contracts/${c.contract.id}/respond`, { decision: 'ACCEPT' })).body.contract.status).toBe('AGREED');
    // Another supplier can't open it.
    const other = await invitedSupplier('Nosy Supplier', 'nosy@supplier.example');
    expect((await other.v.get(`/api/vendor/contracts/${c.contract.id}`)).status).toBe(404);
  });
});

/* ---------------- connectors, against recorded answers ---------------- */

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };
function fakeFetch(answers: [RegExp, (call: Call) => { status?: number; json?: unknown; bytes?: Buffer }][]) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const call: Call = { method: init.method ?? 'GET', url: String(url), headers: (init.headers ?? {}) as Record<string, string>, body: init.body };
    calls.push(call);
    const hit = answers.find(([re]) => re.test(`${call.method} ${call.url}`));
    if (!hit) return new Response(JSON.stringify({ message: `no fake for ${call.method} ${call.url}` }), { status: 599 });
    const a = hit[1](call);
    return a.bytes ? new Response(new Uint8Array(a.bytes), { status: a.status ?? 200 }) : new Response(JSON.stringify(a.json ?? {}), { status: a.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  });
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); forgetTokens(); });
const PDF_BYTES = Buffer.from('%PDF-1.4\n%fake\n%%EOF');
const REQ = { title: 'NDA-2026-0001 NDA', message: 'Please sign', pdf: PDF_BYTES, fileName: 'NDA-2026-0001.pdf', reference: 'NDA-2026-0001', callbackUrl: 'https://vg.example/api/esign/webhook/t/x',
  signers: [{ name: 'Meena', email: 'meena@x.example', side: 'PARTY' as const, order: 1 }, { name: 'Anita', email: 'anita@acme.example', side: 'US' as const, order: 2 }] };

describe('connectors', () => {
  test('DocuSign: JWT grant, envelope with anchors and webhook, status, download, HMAC-checked webhooks', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const cfg = { integrationKey: 'ik-1', userId: 'user-1', accountId: 'acc-1', privateKey, hmacKey: 'hk', sandbox: 'true' };
    const [h, b, sig] = jwtAssertion(cfg, 1_800_000_000).split('.');
    expect(JSON.parse(Buffer.from(b, 'base64url').toString())).toMatchObject({ iss: 'ik-1', sub: 'user-1', aud: 'account-d.docusign.com', scope: 'signature impersonation' });
    expect(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${b}`), publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
    const calls = fakeFetch([
      [/POST https:\/\/account-d\.docusign\.com\/oauth\/token/, () => ({ json: { access_token: 'tok', expires_in: 3600 } })],
      [/GET https:\/\/account-d\.docusign\.com\/oauth\/userinfo/, () => ({ json: { accounts: [{ account_id: 'acc-1', base_uri: 'https://demo.docusign.net', is_default: true }] } })],
      [/POST .*\/accounts\/acc-1\/envelopes$/, () => ({ status: 201, json: { envelopeId: 'env-9', status: 'sent' } })],
      [/GET .*\/envelopes\/env-9\?include=recipients/, () => ({ json: { status: 'completed', recipients: { signers: [{ email: 'meena@x.example', status: 'completed', signedDateTime: '2026-11-20T10:00:00Z' }, { email: 'anita@acme.example', status: 'completed' }] } } })],
      [/GET .*\/envelopes\/env-9\/documents\/combined/, () => ({ bytes: Buffer.from('%PDF-signed') })],
    ]);
    const p = PROVIDERS.docusign as EmailProvider;
    expect((await p.send(cfg, REQ)).externalId).toBe('env-9');
    const env = JSON.parse(String(calls.find((c) => c.url.endsWith('/envelopes'))!.body));
    expect(env.recipients.signers.map((s: any) => [s.email, s.routingOrder, s.tabs.signHereTabs[0].anchorString])).toEqual([['meena@x.example', '1', '/vgsig-party/'], ['anita@acme.example', '2', '/vgsig-us/']]);
    expect(env.eventNotification.url).toBe(REQ.callbackUrl);
    expect(env.documents[0].documentBase64).toBe(PDF_BYTES.toString('base64'));
    expect(calls.find((c) => c.url.endsWith('/envelopes'))!.headers.Authorization).toBe('Bearer tok');
    expect(await p.status(cfg, 'env-9')).toMatchObject({ state: 'COMPLETED', signers: [{ email: 'meena@x.example', status: 'SIGNED' }, { status: 'SIGNED' }] });
    expect((await p.download(cfg, 'env-9')).toString()).toBe('%PDF-signed');
    const body = Buffer.from(JSON.stringify({ event: 'envelope-completed', data: { envelopeId: 'env-9' } }));
    const good = crypto.createHmac('sha256', 'hk').update(body).digest('base64');
    expect(p.webhook(cfg, { 'x-docusign-signature-1': good }, body)).toEqual({ externalId: 'env-9' });
    expect(p.webhook(cfg, { 'x-docusign-signature-1': 'forged' }, body)).toBeNull();
  });

  test('Adobe Acrobat Sign: transient document then agreement in order; members; webhook client id echo', async () => {
    const calls = fakeFetch([
      [/GET https:\/\/api\.adobesign\.com\/api\/rest\/v6\/baseUris/, () => ({ json: { apiAccessPoint: 'https://api.in1.adobesign.com/' } })],
      [/POST https:\/\/api\.in1\.adobesign\.com\/api\/rest\/v6\/transientDocuments/, () => ({ status: 201, json: { transientDocumentId: 'tr-1' } })],
      [/POST .*\/agreements$/, () => ({ status: 201, json: { id: 'ag-1' } })],
      [/GET .*\/agreements\/ag-1$/, () => ({ json: { status: 'OUT_FOR_SIGNATURE' } })],
      [/GET .*\/agreements\/ag-1\/members/, () => ({ json: { participantSets: [{ memberInfos: [{ email: 'meena@x.example', status: 'COMPLETED' }] }, { memberInfos: [{ email: 'anita@acme.example', status: 'WAITING_FOR_MY_SIGNATURE' }] }] } })],
    ]);
    const p = PROVIDERS.adobe as EmailProvider; const cfg = { accessToken: 'key-1' };
    expect((await p.send(cfg, REQ)).externalId).toBe('ag-1');
    const ag = JSON.parse(String(calls.find((c) => c.url.endsWith('/agreements'))!.body));
    expect(ag).toMatchObject({ fileInfos: [{ transientDocumentId: 'tr-1' }], signatureType: 'ESIGN', state: 'IN_PROCESS' });
    expect(ag.participantSetsInfo.map((x: any) => [x.memberInfos[0].email, x.order, x.role])).toEqual([['meena@x.example', 1, 'SIGNER'], ['anita@acme.example', 2, 'SIGNER']]);
    expect(await p.status(cfg, 'ag-1')).toEqual({ state: 'SENT', signers: [{ email: 'meena@x.example', status: 'SIGNED' }, { email: 'anita@acme.example', status: 'SENT' }] });
    expect(p.webhookAnswer!({ 'x-adobesign-clientid': 'cid' })).toEqual({ 'X-AdobeSign-ClientId': 'cid' });
    expect(p.webhook(cfg, {}, Buffer.from(JSON.stringify({ event: 'AGREEMENT_WORKFLOW_COMPLETED', agreement: { id: 'ag-1' } })))).toEqual({ externalId: 'ag-1' });
  });

  test('Zoho Sign: refresh token, request then submit with a field per signer on the last page', async () => {
    const pdf = Buffer.from(await (async () => { const d = await PDFDocument.create(); d.addPage(); d.addPage(); return d.save(); })());
    const calls = fakeFetch([
      [/POST https:\/\/accounts\.zoho\.in\/oauth\/v2\/token/, () => ({ json: { access_token: 'zt', expires_in: 3600 } })],
      [/POST https:\/\/sign\.zoho\.in\/api\/v1\/requests$/, () => ({ json: { status: 'success', requests: { request_id: '777', document_ids: [{ document_id: 'd1' }], actions: [{ action_id: 'a1', recipient_name: 'Meena', recipient_email: 'meena@x.example' }, { action_id: 'a2', recipient_name: 'Anita', recipient_email: 'anita@acme.example' }] } } })],
      [/POST .*\/requests\/777\/submit/, () => ({ json: { status: 'success' } })],
      [/GET .*\/requests\/777$/, () => ({ json: { requests: { request_status: 'completed', actions: [{ recipient_email: 'meena@x.example', action_status: 'SIGNED' }] } } })],
    ]);
    const p = PROVIDERS.zoho as EmailProvider; const cfg = { clientId: 'c', clientSecret: 's', refreshToken: 'r', dataCenter: 'in' };
    expect((await p.send(cfg, { ...REQ, pdf })).externalId).toBe('777');
    const submit = calls.find((c) => c.url.endsWith('/submit'))!;
    const data = JSON.parse(String((submit.body as FormData).get('data')));
    expect(data.requests.actions.map((a: any) => [a.action_id, a.fields[0].page_no, a.fields[0].field_type_name])).toEqual([['a1', 1, 'Signature'], ['a2', 1, 'Signature']]);
    expect(submit.headers.Authorization).toBe('Zoho-oauthtoken zt');
    expect((await p.status(cfg, '777')).state).toBe('COMPLETED');
  });

  test('Digio (Aadhaar eSign): Basic auth, signers with the sign type, sequential; checksum-checked webhooks', async () => {
    const calls = fakeFetch([
      [/POST https:\/\/ext\.digio\.in:444\/v2\/client\/document\/uploadpdf/, () => ({ json: { id: 'DID123', agreement_status: 'requested' } })],
      [/GET .*\/v2\/client\/document\/DID123$/, () => ({ json: { agreement_status: 'requested', signing_parties: [{ identifier: 'meena@x.example', status: 'signed' }, { identifier: 'anita@acme.example', status: 'requested' }] } })],
    ]);
    const p = PROVIDERS.digio as EmailProvider; const cfg = { clientId: 'AI1', clientSecret: 'sec', signType: 'aadhaar', webhookSecret: 'whs', sandbox: 'true' };
    expect((await p.send(cfg, REQ)).externalId).toBe('DID123');
    const up = calls[0];
    expect(up.headers.Authorization).toBe(`Basic ${Buffer.from('AI1:sec').toString('base64')}`);
    const body = JSON.parse(String(up.body));
    expect(body).toMatchObject({ sequential: true, notify_signers: true, file_data: PDF_BYTES.toString('base64') });
    expect(body.signers.map((s: any) => [s.identifier, s.sign_type])).toEqual([['meena@x.example', 'aadhaar'], ['anita@acme.example', 'aadhaar']]);
    expect(await p.status(cfg, 'DID123')).toMatchObject({ state: 'SENT', signers: [{ status: 'SIGNED' }, { status: 'SENT' }] });
    const hook = Buffer.from(JSON.stringify({ event: 'doc.signed', payload: { document: { id: 'DID123' } } }));
    expect(p.webhook(cfg, { 'x-digio-checksum': crypto.createHmac('sha256', 'whs').update(hook).digest('hex') }, hook)).toEqual({ externalId: 'DID123' });
    expect(p.webhook(cfg, { 'x-digio-checksum': 'nope' }, hook)).toBeNull();
  });

  test('UAE PASS: client-credentials token, signer process with the PDF, browser task, then the signed content', async () => {
    const calls = fakeFetch([
      [/POST https:\/\/stg-id\.uaepass\.ae\/trustedx-authserver\/oauth\/main-as\/token/, () => ({ json: { access_token: 'ut', expires_in: 600 } })],
      [/POST .*\/esignsp\/v2\/signer_processes$/, () => ({ status: 201, json: { id: 'sp_1', tasks: { pending: [{ type: 'UserBrowserTask', id: 'tk_1', url: 'https://stg-id.uaepass.ae/trustedx-gw/x' }] }, documents: [{ url: 'https://stg-id.uaepass.ae/trustedx-resources/esignsp/v2/documents/doc_1' }] } })],
      [/GET .*\/signer_processes\/sp_1$/, () => ({ json: { id: 'sp_1' } })],
      [/GET .*\/documents\/doc_1\/content/, () => ({ bytes: Buffer.from('%PDF-uaepass-signed') })],
      [/DELETE .*\/signer_processes\/sp_1/, () => ({ status: 204, json: {} })],
    ]);
    const p = PROVIDERS.uaepass as LinkProvider; const cfg = { clientId: 'sp', clientSecret: 'ss', signaturePolicyId: 'urn:policy', sandbox: 'true' };
    const s = await p.start(cfg, { pdf: PDF_BYTES, fileName: 'x.pdf', signer: REQ.signers[0], callbackUrl: 'https://vg.example/api/esign/return/s/n', reference: 'NDA-1' });
    expect(s).toMatchObject({ processId: 'sp_1', url: 'https://stg-id.uaepass.ae/trustedx-gw/x' });
    const proc = JSON.parse(await ((calls[1].body as FormData).get('process') as Blob).text());
    expect(proc).toMatchObject({ finish_callback_url: 'https://vg.example/api/esign/return/s/n', signer: { signature_policy_id: 'urn:policy', parameters: { type: 'pades-baseline' } } });
    expect((await p.finish(cfg, { processId: 'sp_1', state: s.state, pdf: PDF_BYTES, signer: REQ.signers[0], query: { status: 'finished' } })).toString()).toBe('%PDF-uaepass-signed');
    await expect(p.finish(cfg, { processId: 'sp_1', state: s.state, pdf: PDF_BYTES, signer: REQ.signers[0], query: { status: 'canceled' } })).rejects.toThrow(/cancelled/);
  });
});
