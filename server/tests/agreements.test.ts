/**
 * Agreements suppliers accept in the portal. Uses Government suppliers only (agreements here apply to that
 * vendor type), so other test files running at the same time aren't affected.
 */
import { afterAll, describe, expect, test } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { approvedVendor, client, lastLinkTo, login, tokenOf } from './helpers.js';
import { db, schema } from '../src/lib/db.js';

const PDF = '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF';
const CODE = 'Suppliers must act honestly and lawfully, pay fair wages, respect human rights, avoid conflicts of interest and never offer bribes or gifts to our staff.';
const created: string[] = [];
type C = ReturnType<typeof client>;

async function newSupplier(name: string, email: string) {
  const admin = await login('admin@acme.test');
  const id = (await admin.post('/api/staff/vendors', { name, vendorType: 'GOVERNMENT', contactFirstName: 'Gov', contactLastName: 'User', contactEmail: email, contactMobile: '9800033344' })).body.vendor.id;
  const token = tokenOf((await lastLinkTo(email))!);
  const v = client();
  const { devOtp } = (await v.post('/api/vendor-auth/request-otp', { token })).body;
  await v.post('/api/vendor-auth/verify-otp', { token, code: devOtp });
  await v.post('/api/vendor/consent', { version: (await v.get('/api/vendor')).body.privacy.version });
  return { id, v, admin };
}
const acceptAll = async (v: C) => {
  for (const a of (await v.get('/api/vendor')).body.agreements.filter((x: any) => x.outstanding)) {
    expect((await v.post(`/api/vendor/agreements/${a.id}/accept`, { versionId: a.current.id, signerName: 'Gita Rao', signerDesignation: 'Director', agree: true })).status).toBe(200);
  }
};

afterAll(async () => {
  const admin = await login('admin@acme.test');
  for (const id of created) await admin.post(`/api/agreements/${id}/archive`);
});

describe('agreements', () => {
  let codeId = '';
  test('admin sets up a text agreement and a PDF one; others cannot', async () => {
    const admin = await login('admin@acme.test');
    expect((await (await login('tax@acme.test')).post('/api/agreements', { title: 'X', kind: 'TEXT', body: CODE })).status).toBe(403);
    expect((await admin.post('/api/agreements', { title: 'Gov Code of Conduct', vendorTypes: ['GOVERNMENT'], kind: 'TEXT', body: 'too short' })).status).toBe(400);
    const code = await admin.post('/api/agreements', { title: 'Gov Code of Conduct', titleAr: 'مدونة السلوك', vendorTypes: ['GOVERNMENT'], required: true, kind: 'TEXT', body: CODE, bodyAr: 'يجب على الموردين التصرف بأمانة.' });
    expect(code.status).toBe(201);
    codeId = code.body.id; created.push(codeId);
    const nda = await admin.agent.post('/api/agreements').set('X-Requested-With', 'fetch')
      .field('title', 'Gov NDA').field('vendorTypes', 'GOVERNMENT').field('required', 'false').field('kind', 'PDF')
      .attach('file', Buffer.from(PDF), { filename: 'nda.pdf', contentType: 'application/pdf' });
    expect(nda.status).toBe(201);
    created.push(nda.body.id);
    const list = (await admin.get('/api/agreements')).body;
    const row = list.find((a: any) => a.id === codeId);
    expect(row.versions[0]).toMatchObject({ version: 1, kind: 'TEXT', publishedByName: 'Anita Rao' });
    expect(row.versions[0].storagePath).toBeUndefined();
    const ndaRow = list.find((a: any) => a.id === nda.body.id);
    expect((await admin.get(`/api/agreements/versions/${ndaRow.versions[0].id}/file`)).status).toBe(200);
  });

  test('supplier must accept required agreements before submitting; acceptance is recorded with a certificate', async () => {
    const { v, id } = await newSupplier('Gov Works Dept', 'gov1@agree.test');
    const me = (await v.get('/api/vendor')).body;
    expect(me.agreements.map((a: any) => a.title)).toEqual(expect.arrayContaining(['Gov Code of Conduct', 'Gov NDA']));
    const code = me.agreements.find((a: any) => a.id === codeId);
    expect(code).toMatchObject({ required: true, outstanding: true, current: { version: 1, kind: 'TEXT', body: CODE } });
    expect(me.checklist.find((c: any) => c.id === `agreement.${codeId}`)).toMatchObject({ ok: false, section: 'agreements', message: 'Gov Code of Conduct must be accepted' });
    // A DOMESTIC supplier doesn't get these.
    const dom = await approvedVendor('Domestic Unaffected Ltd', 'dom@agree.test');
    expect((await dom.v.get('/api/vendor')).body.agreements).toEqual([]);

    expect((await v.post(`/api/vendor/agreements/${codeId}/accept`, { versionId: 'old', signerName: 'Gita Rao', signerDesignation: 'Director', agree: true })).status).toBe(409);
    expect((await v.post(`/api/vendor/agreements/${codeId}/accept`, { versionId: code.current.id, signerName: 'Gita Rao', signerDesignation: 'Director' })).status).toBe(400);
    const ok = await v.post(`/api/vendor/agreements/${codeId}/accept`, { versionId: code.current.id, signerName: 'Gita Rao', signerDesignation: 'Director', agree: true });
    expect(ok.status).toBe(200);
    expect(ok.body.checklist.find((c: any) => c.id === `agreement.${codeId}`).ok).toBe(true);
    const acc = ok.body.agreements.find((a: any) => a.id === codeId).accepted;
    expect(acc).toMatchObject({ version: 1, signerName: 'Gita Rao', signerDesignation: 'Director' });
    const row = (await db.select().from(schema.agreementAcceptances).where(eq(schema.agreementAcceptances.id, acc.id)))[0];
    expect(row).toMatchObject({ signerEmail: 'gov1@agree.test', vendorId: id });
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const cert = await v.agent.get(`/api/agreements/acceptances/${acc.id}/certificate.pdf`).set('X-Requested-With', 'fetch');
    expect(cert.status).toBe(200);
    expect(cert.headers['content-type']).toBe('application/pdf');
    // Another supplier can't open it; staff can.
    const other = await newSupplier('Gov Other Dept', 'gov2@agree.test');
    expect((await other.v.agent.get(`/api/agreements/acceptances/${acc.id}/certificate.pdf`).set('X-Requested-With', 'fetch')).status).toBe(404);
    expect((await (await login('tax@acme.test')).agent.get(`/api/agreements/acceptances/${acc.id}/certificate.pdf`).set('X-Requested-With', 'fetch')).status).toBe(200);
    // Staff see it on the supplier's page.
    expect((await (await login('tax@acme.test')).get(`/api/staff/vendors/${id}`)).body.agreements.find((a: any) => a.id === codeId).accepted.signerName).toBe('Gita Rao');
    const actions = (await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.vendorId, id))).map((a) => a.action);
    expect(actions).toContain('AGREEMENT_ACCEPTED');
  });

  test('a new version: accept again only when the admin asks; approved suppliers are flagged and emailed', async () => {
    const admin = await login('admin@acme.test');
    const { v, id } = await approvedVendor('Gov Approved Board', 'gov3@agree.test', { vendorType: 'GOVERNMENT', beforeSubmit: acceptAll });
    expect((await admin.get(`/api/staff/vendors/${id}`)).body.flags.map((f: any) => f.code)).not.toContain('AGREEMENT_PENDING');
    // v2 without "accept again": nothing changes for suppliers who accepted v1.
    expect((await admin.post(`/api/agreements/${codeId}/versions`, { kind: 'TEXT', body: `${CODE} Typo fixed.`, changeNote: 'Typo', reaccept: false })).status).toBe(201);
    expect((await v.get('/api/vendor')).body.agreements.find((a: any) => a.id === codeId).outstanding).toBe(false);
    // v3 with "accept again": approved suppliers are asked, flagged and emailed.
    expect((await admin.post(`/api/agreements/${codeId}/versions`, { kind: 'TEXT', body: `${CODE} Suppliers must also report modern-slavery risks.`, changeNote: 'New clause', reaccept: true })).status).toBe(201);
    const me = (await v.get('/api/vendor')).body;
    const a = me.agreements.find((x: any) => x.id === codeId);
    expect(a).toMatchObject({ outstanding: true, current: { version: 3 }, accepted: { version: 1 } });
    expect((await admin.get(`/api/staff/vendors/${id}`)).body.flags.map((f: any) => f.code)).toContain('AGREEMENT_PENDING');
    const mail = (await db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, 'gov3@agree.test')).orderBy(desc(schema.emailOutbox.createdAt)))[0];
    expect(mail.subject).toMatch(/please accept the Gov Code of Conduct/);
    expect((await v.post(`/api/vendor/agreements/${codeId}/accept`, { versionId: a.current.id, signerName: 'Gita Rao', signerDesignation: 'Director', agree: true })).status).toBe(200);
    expect((await admin.get(`/api/staff/vendors/${id}`)).body.flags.map((f: any) => f.code)).not.toContain('AGREEMENT_PENDING');
    const list = (await admin.get('/api/agreements')).body.find((x: any) => x.id === codeId);
    expect(list.versions.map((x: any) => x.version)).toEqual([3, 2, 1]);
    expect(list.accepted).toBeGreaterThan(0);
  });

  test('buyer filling in for the supplier records a signed copy', async () => {
    const admin = await login('admin@acme.test');
    const id = (await admin.post('/api/staff/vendors', { name: 'Gov Paper Signers', vendorType: 'GOVERNMENT', contactFirstName: 'P', contactLastName: 'S', contactEmail: 'gov4@agree.test', contactMobile: '9800033355', notify: false })).body.vendor.id;
    const page = (await admin.get(`/api/staff/vendors/${id}`)).body;
    expect(page.agreements.find((a: any) => a.id === codeId).outstanding).toBe(true);
    const up = (signer?: string) => admin.agent.post(`/api/staff/vendors/${id}/assist/agreements/${codeId}/signed-copy`).set('X-Requested-With', 'fetch')
      .field('signerName', signer ?? '').field('signerDesignation', 'Joint Secretary').attach('file', Buffer.from(PDF), { filename: 'signed.pdf', contentType: 'application/pdf' });
    expect((await up()).status).toBe(400);
    const r = await up('K. Menon');
    expect(r.status).toBe(201);
    const a = r.body.agreements.find((x: any) => x.id === codeId);
    expect(a).toMatchObject({ outstanding: false, accepted: { signerName: 'K. Menon', recordedByName: 'Anita Rao' } });
    expect(r.body.checklist.find((c: any) => c.id === `agreement.${codeId}`).ok).toBe(true);
    const acc = (await db.select().from(schema.agreementAcceptances).where(eq(schema.agreementAcceptances.vendorId, id)))[0];
    expect(acc.signedCopyDocumentId).toBeTruthy();
  });
});
