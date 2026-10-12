import { describe, expect, test, vi, afterEach } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { client, login, lastLinkTo, tokenOf } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import { sendMail, setEmailDriver, renderEmail } from '../src/integrations/email/index.js';
import { testDriver, sendgridDriver, resendDriver } from '../src/integrations/email/drivers.js';
import { msg91Driver, twilioDriver, normaliseMobile, testSmsDriver } from '../src/integrations/sms/drivers.js';
import { setSmsDriver } from '../src/integrations/sms/index.js';
import { sniffType, pdfLooksActive } from '../src/integrations/storage/scan.js';
import { safeKey } from '../src/integrations/storage/drivers.js';
import { nameMatch } from '../src/integrations/kyc/nameMatch.js';
import { surepassKyc } from '../src/integrations/kyc/surepass.js';
import { setKycProvider } from '../src/integrations/kyc/index.js';
import { mockKyc } from '../src/integrations/kyc/mock.js';
import { anthropicExtractor, mockExtractor } from '../src/integrations/ai/extractors.js';
import { setExtractor } from '../src/integrations/ai/index.js';
import { EXTRACTABLE } from '../src/integrations/ai/catalog.js';
import { gstinCheckChar } from '../src/lib/validators.js';

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const PDF = '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF';

afterEach(() => { setEmailDriver(testDriver); setSmsDriver(testSmsDriver); setKycProvider(mockKyc); setExtractor(mockExtractor); });

async function newVendor(name: string, email: string) {
  const admin = await login('admin@acme.test');
  const r = await admin.post('/api/staff/vendors', { name, vendorType: 'DOMESTIC', contactFirstName: 'Int', contactLastName: 'Test', contactEmail: email, contactMobile: '9811122233' });
  const token = tokenOf((await lastLinkTo(email))!);
  const v = client();
  const { devOtp } = (await v.post('/api/vendor-auth/request-otp', { token })).body;
  await v.post('/api/vendor-auth/verify-otp', { token, code: devOtp });
  await v.post('/api/vendor/consent', { version: (await v.get('/api/vendor')).body.privacy.version });
  return { admin, v, id: r.body.vendor.id as string, token };
}

describe('email', () => {
  test('test mode only records; a live driver sends branded HTML and marks SENT; failures are recorded', async () => {
    await sendMail({ tenantId: null, to: 'a@b.test', subject: 'Hi', body: 'Body' });
    const t = await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, 'a@b.test') });
    expect(t?.status).toBe('TEST');

    const sent: any[] = [];
    setEmailDriver({ name: 'fake', live: true, async send(m) { sent.push(m); return { id: 'msg-1' }; } });
    const acme = await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') });
    await sendMail({ tenantId: acme!.id, to: 'live@b.test', subject: 'Invite', body: 'Line one\n\nLine two', link: 'http://app.test/onboard/abc' });
    const row = await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, 'live@b.test') });
    expect(row).toMatchObject({ status: 'SENT', providerMessageId: 'msg-1', attempts: 1 });
    expect(sent[0].from).toContain('Acme Industries Ltd via');
    expect(sent[0].html).toContain('Open the supplier portal');
    expect(sent[0].html).toContain('#6d1a73');
    expect(sent[0].text).toContain('http://app.test/onboard/abc');

    setEmailDriver({ name: 'fake', live: true, async send() { throw new Error('SMTP 550 mailbox unavailable'); } });
    await sendMail({ tenantId: acme!.id, to: 'bounce@b.test', subject: 'X', body: 'Y' });
    const failed = await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, 'bounce@b.test') });
    expect(failed).toMatchObject({ status: 'FAILED' });
    expect(failed!.error).toContain('550');
  });

  test('HTML escapes user content', () => {
    const { html } = renderEmail({ subject: 's', body: '<script>alert(1)</script>', tenantName: 'A&B' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('A&amp;B');
  });

  test('SendGrid request shape', async () => {
    const f = vi.fn(async () => new Response(null, { status: 202, headers: { 'x-message-id': 'sg-1' } }));
    const r = await sendgridDriver({ apiKey: 'SG.x' }, f as any).send({ to: 'x@y.test', from: 'Acme <no-reply@acme.test>', subject: 'S', html: '<p>h</p>', text: 't' });
    expect(r.id).toBe('sg-1');
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(init.headers.Authorization).toBe('Bearer SG.x');
    const body = JSON.parse(init.body);
    expect(body.from).toEqual({ name: 'Acme', email: 'no-reply@acme.test' });
    expect(body.tracking_settings.click_tracking.enable).toBe(false);
  });

  test('Resend request shape and errors', async () => {
    const f = vi.fn(async () => jsonResponse(200, { id: 're-1' }));
    const r = await resendDriver({ apiKey: 're_x' }, f as any).send({ to: 'x@y.test', from: 'VendorGate <no-reply@acme.test>', replyTo: 'help@acme.test', subject: 'S', html: '<p>h</p>', text: 't' });
    expect(r.id).toBe('re-1');
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer re_x');
    expect(JSON.parse(init.body)).toMatchObject({ from: 'VendorGate <no-reply@acme.test>', to: ['x@y.test'], reply_to: 'help@acme.test', subject: 'S' });
    const bad = vi.fn(async () => jsonResponse(403, { name: 'validation_error', message: 'The integratatech.ai domain is not verified.' }));
    await expect(resendDriver({ apiKey: 're_x' }, bad as any).send({ to: 'x@y.test', from: 'a@b.test', subject: 'S', html: '', text: '' })).rejects.toThrow(/Resend 403: The integratatech.ai domain is not verified/);
  });
});

describe('sms', () => {
  test('number normalisation', () => {
    expect(normaliseMobile('98765 43210')).toBe('919876543210');
    expect(normaliseMobile('+49 40 320800')).toBe('4940320800');
    expect(normaliseMobile('09876543210')).toBe('919876543210');
  });
  test('MSG91 flow + Twilio request shapes', async () => {
    const f = vi.fn(async () => jsonResponse(200, { type: 'success', message: 'req-9' }));
    await msg91Driver({ authKey: 'k', templates: { otp: 'tpl-1' } }, f as any).send({ to: '919876543210', body: 'x', vars: { otp: '123456' }, purpose: 'otp' });
    const [u, i] = f.mock.calls[0] as any;
    expect(u).toBe('https://control.msg91.com/api/v5/flow');
    expect(JSON.parse(i.body)).toMatchObject({ template_id: 'tpl-1', recipients: [{ mobiles: '919876543210', otp: '123456' }] });
    await expect(msg91Driver({ authKey: 'k', templates: {} }, f as any).send({ to: '1', body: '', purpose: 'otp' })).rejects.toThrow(/template/);

    const t = vi.fn(async () => jsonResponse(201, { sid: 'SM1' }));
    const r = await twilioDriver({ sid: 'AC1', token: 'tok', from: '+15550001111' }, t as any).send({ to: '4940320800', body: 'hello', purpose: 'otp' });
    expect(r.id).toBe('SM1');
    const [tu, ti] = t.mock.calls[0] as any;
    expect(tu).toContain('/Accounts/AC1/Messages.json');
    expect(String(ti.body)).toContain('To=%2B4940320800');
  });
  test('workspace OTP channel "both" sends email and SMS', async () => {
    const admin = await login('admin@acme.test');
    await admin.patch('/api/admin/tenant', { settings: { vendorOtpChannel: 'both' } });
    const { v, token } = await newVendor('Sms Channel Co', 'sms@chan.test');
    const r = await v.post('/api/vendor-auth/request-otp', { token });
    expect(r.body.sentTo).toMatch(/•••.*and ••••••2233/);
    const sms = await db.query.smsLog.findFirst({ orderBy: desc(schema.smsLog.createdAt) });
    expect(sms).toMatchObject({ to: '919811122233', purpose: 'otp', status: 'TEST' });
    await admin.patch('/api/admin/tenant', { settings: { vendorOtpChannel: 'email' } });
  });
});

describe('uploads and storage', () => {
  test('file type is checked from content, active PDFs rejected, keys are tenant-scoped', async () => {
    expect(sniffType(Buffer.from(PDF))).toBe('application/pdf');
    expect(sniffType(Buffer.from('MZ\x90\x00'))).toBeNull();
    expect(pdfLooksActive(Buffer.from('%PDF-1.4 /OpenAction << /JS (app.alert(1)) >>'))).toBe(true);
    expect(() => safeKey('../etc/passwd')).toThrow();
    expect(() => safeKey('/abs/key')).toThrow();

    const { v, id } = await newVendor('Upload Rules Co', 'up@rules.test');
    const disguised = await v.upload('/api/vendor/documents', 'PAN_CARD', 'MZ this is an exe', 'pan.pdf', 'application/pdf');
    expect(disguised.status).toBe(400);
    expect(disguised.body.error).toMatch(/contents/);
    const active = await v.upload('/api/vendor/documents', 'PAN_CARD', '%PDF-1.4\n/OpenAction << /JS (x) >> /JavaScript', 'pan.pdf');
    expect(active.status).toBe(400);
    const ok = await v.upload('/api/vendor/documents', 'PAN_CARD', PDF, '../../evil name?.pdf');
    expect(ok.status).toBe(201);
    expect(ok.body.storagePath).toBeUndefined();
    const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, ok.body.id) });
    expect(doc!.storagePath.startsWith(`${doc!.tenantId}/${id}/`)).toBe(true);
    expect(doc!.fileName).not.toContain('/');
    expect(doc!.sha256).toHaveLength(64);
    const dl = await v.get(`/api/documents/${ok.body.id}`);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('application/pdf');
    expect(dl.headers['content-security-policy']).toContain('sandbox');
  });
});

describe('KYC verification', () => {
  test('name matching ignores suffixes and order', () => {
    expect(nameMatch('M/s Precision Valves Pvt. Ltd.', 'PRECISION VALVES PRIVATE LIMITED')).toBe(100);
    expect(nameMatch('Kaveri Steel Traders', 'Steel Traders Kaveri')).toBe(100);
    expect(nameMatch('Kaveri Steel Traders', 'Ganga Textiles')!).toBeLessThan(40);
  });

  test('checks are masked, cached, limited, and re-runnable by reviewers', async () => {
    const { v, id } = await newVendor('Kyc Flow Industries Pvt Ltd', 'kyc@flow.test');
    const bad = (await v.post('/api/vendor/verify/pan', { pan: 'NOTAPAN' })).body;
    expect(bad.status).toBe('INVALID_FORMAT');
    const g = `27AAKCK1234M1Z`; const gstin = g + gstinCheckChar(g);
    const first = (await v.post('/api/vendor/verify/gstin', { gstin })).body;
    expect(first).toMatchObject({ status: 'VERIFIED', test: true, nameMatch: 100 });
    expect(first.inputMasked).toMatch(/^27AA•+1Z.$/);
    const rows = await db.select().from(schema.verifications).where(eq(schema.verifications.vendorId, id));
    expect(JSON.stringify(rows)).not.toContain(gstin); // full identifier never stored
    await v.post('/api/vendor/verify/gstin', { gstin });
    expect((await db.select().from(schema.verifications).where(eq(schema.verifications.vendorId, id))).filter((r) => r.kind === 'gstin')).toHaveLength(1); // cached

    // reviewer re-run uses the vendor's saved answer
    await v.put('/api/vendor/profile/tax', { hasGst: 'Yes', gstin, pan: 'AAKCK1234M' });
    const tax = await login('tax@acme.test');
    expect((await tax.post(`/api/staff/vendors/${id}/verify/pan`)).body.status).toBe('VERIFIED');
    const detail = (await tax.get(`/api/staff/vendors/${id}`)).body;
    expect(detail.checks.map((c: any) => c.kind).sort()).toEqual(['gstin', 'pan']);
  });

  test('Surepass adapter parsing', async () => {
    const f = vi.fn(async (url: string) => url.includes('gstin')
      ? jsonResponse(200, { success: true, data: { legal_name: 'ACME LTD', gstin_status: 'Active', taxpayer_type: 'Regular' } })
      : url.includes('bank') ? jsonResponse(200, { success: true, data: { account_exists: false } })
      : jsonResponse(422, { success: false, message: 'Invalid PAN' }));
    const p = surepassKyc({ baseUrl: 'https://sandbox.example/api/v1/', token: 't', paths: { gstin: '/corporate/gstin', pan: '/pan/pan', bank: '/bank-verification/', cin: '/corporate/company-details' } }, f as any);
    expect(await p.check('gstin', { gstin: 'X' }, { legalName: 'Acme' })).toMatchObject({ status: 'VERIFIED', nameOnRecord: 'ACME LTD', data: { gstStatus: 'Active' } });
    expect((await p.check('bank', { accountNumber: '1', ifsc: 'X' }, { legalName: 'A' })).status).toBe('NOT_FOUND');
    expect(await p.check('pan', { pan: 'X' }, { legalName: 'A' })).toMatchObject({ status: 'NOT_FOUND', message: 'Invalid PAN' });
    expect((f.mock.calls[0] as any)[0]).toBe('https://sandbox.example/api/v1/corporate/gstin');
  });
});

describe('AI document reading', () => {
  test('mock extraction runs on upload and suggestions can be applied', async () => {
    const { v } = await newVendor('Ai Apply Co', 'ai@apply.test');
    await v.put('/api/vendor/profile/bank', { accountHolderName: 'Ai Apply Co', accountNumber: '123456789012', ifsc: 'HDFC0001234' });
    await v.upload('/api/vendor/documents', 'CANCELLED_CHEQUE', PDF);
    const me = (await v.get('/api/vendor')).body;
    const ex = me.extractions[0];
    expect(ex).toMatchObject({ status: 'DONE', test: true });
    expect(ex.suggestions.find((s: any) => s.fieldId === 'bank.ifsc')).toMatchObject({ state: 'match' });
  });

  test('Claude extractor: structured output, invalid identifiers dropped, PAN derived, wrong document flagged', async () => {
    const g = `29AABCT1234F1Z`; const gstin = g + gstinCheckChar(g);
    const create = vi.fn(async () => ({ content: [{ type: 'tool_use', id: 't', name: 'record_document', input: {
      documentType: 'GST_CERT', values: { gstin, legalName: 'TEST TRADERS PRIVATE LIMITED', address: '12 MG Road' }, confidence: { gstin: 0.97, legalName: 0.9, address: 0.8 }, notes: '' } }] }));
    setExtractor(anthropicExtractor({ apiKey: 'x', model: 'claude-sonnet-5-5' }, { messages: { create } } as any));
    const admin = await login('admin@acme.test');
    await admin.patch('/api/admin/tenant', { settings: { aiExtraction: true } });
    const { v } = await newVendor('Test Traders Pvt Ltd', 'ai@claude.test');
    await v.upload('/api/vendor/documents', 'GST_CERT', PDF);
    const call = (create.mock.calls[0] as any)[0];
    expect(call.model).toBe('claude-sonnet-5-5');
    expect(call.tool_choice).toEqual({ type: 'tool', name: 'record_document' });
    expect(call.messages[0].content[0]).toMatchObject({ type: 'document', source: { media_type: 'application/pdf' } });
    const ex = (await v.get('/api/vendor')).body.extractions[0];
    const byId = Object.fromEntries(ex.suggestions.map((s: any) => [s.fieldId, s]));
    expect(byId['tax.gstin'].value).toBe(gstin);
    expect(byId['tax.pan'].value).toBe('AABCT1234F');
    expect(byId['basic.vendorName']).toMatchObject({ state: 'differs', current: 'Test Traders Pvt Ltd' });

    const applied = (await v.post(`/api/vendor/extractions/${ex.id}/apply`, { fieldIds: ['tax.gstin', 'tax.pan', 'basic.address'] })).body;
    expect(applied.applied.sort()).toEqual(['basic.address', 'tax.gstin', 'tax.pan']);
    expect(applied.profile.tax.gstin).toBe(gstin);

    // garbage identifier is dropped, wrong document type flagged
    create.mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 't', name: 'record_document', input: { documentType: 'PAN_CARD', values: { gstin: '29AABCT1234F1ZZ' }, confidence: { gstin: 0.4 } } }] } as any);
    await v.upload('/api/vendor/documents', 'GST_CERT', PDF);
    const latest = (await v.get('/api/vendor')).body.extractions[0];
    expect(latest.suggestions).toHaveLength(0);
    expect(latest.summary).toMatch(/pan card/i);

    // workspace switched off → documents are not sent to the AI
    await admin.patch('/api/admin/tenant', { settings: { aiExtraction: false } });
    const before = create.mock.calls.length;
    await v.upload('/api/vendor/documents', 'GST_CERT', PDF);
    expect(create.mock.calls.length).toBe(before);
    expect((await v.get('/api/vendor')).body.extractions[0].status).toBe('SKIPPED');
  });

  test('catalog only targets fields that exist in the default template', async () => {
    const { defaultConfig } = await import('../src/config/defaultTemplate.js');
    const ids = new Set(defaultConfig.sections.flatMap((s) => s.groups.flatMap((g) => g.fields.map((f) => `${s.key}.${f.key}`))));
    for (const spec of Object.values(EXTRACTABLE)) for (const k of spec.keys) expect(ids.has(k.target), k.target).toBe(true);
  });
});

describe('integrations admin', () => {
  test('status shows test modes; test email lands in the outbox', async () => {
    const admin = await login('admin@acme.test');
    const s = (await admin.get('/api/admin/integrations')).body;
    expect(s).toMatchObject({ email: { provider: 'test', live: false }, sms: { provider: 'test' }, storage: { driver: 'local' }, kyc: { provider: 'mock' }, ai: { provider: 'mock' } });
    expect((await admin.post('/api/admin/integrations/test-email')).body.to).toBe('admin@acme.test');
    expect((await admin.post('/api/admin/integrations/test-storage')).body.ok).toBe(true);
    expect((await (await login('tax@acme.test')).get('/api/admin/integrations')).status).toBe(403);
  });
});
