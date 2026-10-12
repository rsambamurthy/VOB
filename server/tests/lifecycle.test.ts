import { describe, expect, test } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { approvedVendor, login, lastLinkTo } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import { levelsForChange, runExpiryReminders, runPeriodicReviews, flagsFor, daysUntil } from '../src/services/lifecycle.js';
import { indiaTemplate } from '../src/countries/in/template.js';

const defaultConfig = indiaTemplate();
import { gstinCheckChar } from '../src/lib/validators.js';

const PDF = '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF';
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('change-request routing', () => {
  test('levels are chosen by the fields that changed', () => {
    expect(levelsForChange(defaultConfig, ['bank.ifsc']).map((l) => l.id)).toEqual(['finance', 'mdm']);
    expect(levelsForChange(defaultConfig, ['tax.gstin', 'bank.ifsc']).map((l) => l.id)).toEqual(['tax', 'finance', 'mdm']);
    expect(levelsForChange(defaultConfig, ['basic.websiteUrl']).map((l) => l.id)).toEqual(['mdm']);
    expect(levelsForChange(defaultConfig, ['documents']).map((l) => l.id)).toEqual(['mdm']);
    const noRules = { ...defaultConfig, workflow: { levels: defaultConfig.workflow.levels } };
    expect(levelsForChange(noRules, ['bank.ifsc']).map((l) => l.id)).toEqual(['mdm']); // safety net: final level
  });
});

describe('approved vendor lifecycle', () => {
  test('bank change: approval is routed, the old account stays live until approved, security email + penny-drop', async () => {
    const { v, id, admin } = await approvedVendor('Lifecycle Bank Co', 'life@bank.test');
    expect((await v.put('/api/vendor/profile/bank', { bankBranch: 'X' })).status).toBe(409); // no direct edits once approved
    expect((await v.post('/api/vendor/change-requests', { changes: {} })).status).toBe(400);
    expect((await v.post('/api/vendor/change-requests', { changes: { bank: { ifsc: 'BADIFSC' } } })).status).toBe(422);

    const cr = await v.post('/api/vendor/change-requests', { changes: { bank: { bankName: 'ICICI Bank', accountNumber: '000401999999', ifsc: 'ICIC0000004', bankBranch: 'Fort' } }, note: 'Moved banks' });
    expect(cr.status).toBe(201);
    expect((await v.post('/api/vendor/change-requests', { changes: { basic: { websiteUrl: 'x.com' } } })).status).toBe(409); // one at a time
    expect(await lastLinkTo('life@bank.test')).toContain('/onboard/'); // security notice to registered contact
    const notice = await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, 'life@bank.test'), orderBy: desc(schema.emailOutbox.createdAt) });
    expect(notice?.subject).toMatch(/bank details change/i);
    const penny = await db.query.verifications.findFirst({ where: and(eq(schema.verifications.vendorId, id), eq(schema.verifications.kind, 'bank')), orderBy: desc(schema.verifications.createdAt) });
    expect(penny?.requestedBy).toBe('system (bank change)');

    const detail = (await admin.get(`/api/staff/vendors/${id}`)).body;
    const open = detail.changeRequests[0];
    expect(open.sensitive).toBe(true);
    expect(open.steps.map((s: any) => s.label)).toEqual(['Finance & Risk Review', 'Master Data Approval']);
    expect(open.changes.find((c: any) => c.fieldId === 'bank.ifsc')).toMatchObject({ old: 'HDFC0000001', new: 'ICIC0000004' });
    expect(detail.flags.map((f: any) => f.code)).toContain('CHANGE_PENDING');
    expect(detail.vendor.profile.bank.ifsc).toBe('HDFC0000001'); // not applied yet

    const tax = await login('tax@acme.test');
    expect((await tax.post(`/api/staff/change-requests/${open.id}/decision`, { action: 'APPROVE' })).status).toBe(403);
    const fin = await login('finance@acme.test');
    expect((await fin.get('/api/staff/change-requests?mine=true')).body.map((c: any) => c.id)).toContain(open.id);
    expect((await fin.post(`/api/staff/change-requests/${open.id}/decision`, { action: 'APPROVE' })).body.nextLevel).toBe('Master Data Approval');
    expect((await (await login('mdm@acme.test')).post(`/api/staff/change-requests/${open.id}/decision`, { action: 'APPROVE', remarks: 'Penny-drop OK' })).body.status).toBe('APPROVED');

    const after = (await admin.get(`/api/staff/vendors/${id}`)).body;
    expect(after.vendor.profile.bank).toMatchObject({ ifsc: 'ICIC0000004', bankName: 'ICICI Bank' });
    const erp = (await (await login('mdm@acme.test')).get(`/api/staff/vendors/${id}/erp-export`)).body;
    expect(erp.ERPVendorsData.VENDOR.VENDOR_DATA.VENDOR_SITES.SITE_DATA[0].VENDOR_BANKS.BANK_DATA[0].BRANCH_NUMBER).toBe('ICIC0000004');
  });

  test('document renewal through a change request supersedes the old file; rejection keeps the old one', async () => {
    const { v, id } = await approvedVendor('Lifecycle Docs Co', 'life@docs.test');
    expect((await v.upload('/api/vendor/documents', 'FINANCIALS', PDF)).status).toBe(400); // expiry date required
    const expiredReq = v.agent.post('/api/vendor/documents').set('X-Requested-With', 'fetch').field('docType', 'FINANCIALS').field('expiresOn', '2001-01-01').attach('file', Buffer.from(PDF), { filename: 'f.pdf', contentType: 'application/pdf' });
    expect((await expiredReq).status).toBe(400);
    const up = await v.agent.post('/api/vendor/documents').set('X-Requested-With', 'fetch').field('docType', 'CANCELLED_CHEQUE').attach('file', Buffer.from(PDF), { filename: 'new-cheque.pdf', contentType: 'application/pdf' });
    expect(up.body.status).toBe('PENDING');
    const cr = (await v.post('/api/vendor/change-requests', { changes: {}, note: 'New cheque' })).body;
    const mdm = await login('mdm@acme.test');
    expect((await mdm.post(`/api/staff/change-requests/${cr.id}/decision`, { action: 'REJECT' })).status).toBe(400);
    await mdm.post(`/api/staff/change-requests/${cr.id}/decision`, { action: 'REJECT', remarks: 'Unsigned cheque' });
    const docs = await db.select().from(schema.documents).where(and(eq(schema.documents.vendorId, id), eq(schema.documents.docType, 'CANCELLED_CHEQUE')));
    expect(docs.map((d) => d.status).sort()).toEqual(['ACTIVE', 'REJECTED']);
    const me = (await v.get('/api/vendor')).body;
    expect(me.lifecycle.changeRequests[0]).toMatchObject({ status: 'REJECTED', remarks: 'Unsigned cheque' });

    // try again and approve
    await v.agent.post('/api/vendor/documents').set('X-Requested-With', 'fetch').field('docType', 'CANCELLED_CHEQUE').attach('file', Buffer.from(PDF), { filename: 'signed.pdf', contentType: 'application/pdf' });
    const cr2 = (await v.post('/api/vendor/change-requests', { changes: {} })).body;
    await mdm.post(`/api/staff/change-requests/${cr2.id}/decision`, { action: 'APPROVE' });
    const docs2 = await db.select().from(schema.documents).where(and(eq(schema.documents.vendorId, id), eq(schema.documents.docType, 'CANCELLED_CHEQUE')));
    expect(docs2.filter((d) => d.status === 'ACTIVE').map((d) => d.fileName)).toEqual(['signed.pdf']);
    expect(docs2.some((d) => d.status === 'SUPERSEDED')).toBe(true);
  });

  test('cancel a change request', async () => {
    const { v } = await approvedVendor('Lifecycle Cancel Co', 'life@cancel.test');
    const cr = (await v.post('/api/vendor/change-requests', { changes: { basic: { websiteUrl: 'www.newsite.in' } } })).body;
    // reassigning the open step
    const admin = await login('admin@acme.test');
    const people = (await admin.get(`/api/staff/change-requests/${cr.id}/assignable`)).body;
    const mdmUser = people.find((p: any) => p.email === 'mdm@acme.test');
    expect(mdmUser?.holdsRole).toBe(true);
    const step = (await admin.get('/api/staff/change-requests?status=PENDING')).body.find((c: any) => c.id === cr.id);
    expect(step).toBeTruthy();
    const detail = (await admin.get(`/api/staff/vendors/${step.vendor.id}`)).body.changeRequests[0];
    expect((await admin.post(`/api/staff/change-requests/${cr.id}/steps/${detail.steps[0].id}/assign`, { userId: mdmUser.id })).body.assignee).toBe(mdmUser.name);
    expect((await (await login('tax@acme.test')).get(`/api/staff/change-requests/${cr.id}/assignable`)).status).toBe(403);
    expect((await v.post(`/api/vendor/change-requests/${cr.id}/cancel`)).status).toBe(200);
    expect((await v.post(`/api/vendor/change-requests/${cr.id}/cancel`)).status).toBe(409);
    expect((await v.get('/api/vendor')).body.lifecycle.changeRequests[0].status).toBe('CANCELLED');
  });

  test('MDM proposes a change on the vendor’s behalf; the proposer cannot approve it; the vendor is told', async () => {
    const { v, id, admin } = await approvedVendor('Lifecycle Proxy Co', 'life@proxy.test');
    const mdm = await login('mdm@acme.test');
    expect((await (await login('tax@acme.test')).post(`/api/staff/vendors/${id}/change-requests`, { changes: { bank: { bankBranch: 'Fort' } }, note: 'x' })).status).toBe(403);
    expect((await mdm.post(`/api/staff/vendors/${id}/change-requests`, { changes: { bank: { bankBranch: 'Fort' } } })).status).toBe(400); // reason required

    // a vendor's own unsent upload must not ride along on the staff proposal
    expect((await v.upload('/api/vendor/documents', 'MSME_CERT', PDF)).status).toBe(201);
    const up = await mdm.upload(`/api/staff/vendors/${id}/documents`, 'CANCELLED_CHEQUE', PDF, 'emailed-cheque.pdf');
    expect(up.status).toBe(201);
    expect((await v.get('/api/vendor')).body.vendor.documents.some((d: any) => d.id === up.body.id)).toBe(false); // staff draft hidden from vendor
    expect((await v.del(`/api/vendor/documents/${up.body.id}`)).status).toBe(409);

    const cr = await mdm.post(`/api/staff/vendors/${id}/change-requests`, { changes: { bank: { bankBranch: 'Fort' } }, note: 'Vendor emailed new cheque on 3 Oct' });
    expect(cr.status).toBe(201);
    const row = await db.query.changeRequests.findFirst({ where: eq(schema.changeRequests.id, cr.body.id) });
    expect(row?.documentIds).toEqual([up.body.id]);
    const mail = await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, 'life@proxy.test'), orderBy: desc(schema.emailOutbox.createdAt) });
    expect(mail?.subject).toMatch(/bank details change|updating your registered details/i);

    const mine = await v.get('/api/vendor');
    expect(mine.body.lifecycle.changeRequests[0].byBuyer).toBe(true);
    expect((await v.post(`/api/vendor/change-requests/${cr.body.id}/cancel`)).status).toBe(409);

    expect((await (await login('finance@acme.test')).post(`/api/staff/change-requests/${cr.body.id}/decision`, { action: 'APPROVE' })).status).toBe(200);
    expect((await mdm.get('/api/staff/change-requests?mine=true')).body.map((c: any) => c.id)).not.toContain(cr.body.id);
    const d = (await mdm.get(`/api/staff/vendors/${id}`)).body.changeRequests[0];
    expect(d).toMatchObject({ canAct: false, canWithdraw: true, raisedBy: { name: expect.any(String) } });
    expect((await mdm.post(`/api/staff/change-requests/${cr.body.id}/decision`, { action: 'APPROVE' })).status).toBe(403);

    // with a single MDM, an approvals manager hands the step to someone else
    const people = (await admin.get(`/api/staff/change-requests/${cr.body.id}/assignable`)).body;
    const anita = people.find((p: any) => p.email === 'admin@acme.test');
    const step = d.steps.find((x: any) => x.status === 'PENDING');
    await admin.post(`/api/staff/change-requests/${cr.body.id}/steps/${step.id}/assign`, { userId: anita.id });
    expect((await admin.post(`/api/staff/change-requests/${cr.body.id}/decision`, { action: 'APPROVE' })).body.status).toBe('APPROVED');
    const after = (await admin.get(`/api/staff/vendors/${id}`)).body;
    expect(after.vendor.profile.bank.bankBranch).toBe('Fort');
    expect(after.vendor.documents.filter((x: any) => x.docType === 'CANCELLED_CHEQUE' && x.status === 'ACTIVE').map((x: any) => x.fileName)).toEqual(['emailed-cheque.pdf']);
    expect(after.vendor.documents.find((x: any) => x.docType === 'MSME_CERT')).toMatchObject({ status: 'PENDING', changeRequestId: null });

    // withdraw: proposer can, their staged files are dropped
    const up2 = await mdm.upload(`/api/staff/vendors/${id}/documents`, 'PAN_CARD', PDF);
    const cr2 = (await mdm.post(`/api/staff/vendors/${id}/change-requests`, { changes: {}, note: 'Fresh PAN copy' })).body;
    expect((await (await login('finance@acme.test')).post(`/api/staff/change-requests/${cr2.id}/cancel`)).status).toBe(403);
    expect((await mdm.post(`/api/staff/change-requests/${cr2.id}/cancel`)).status).toBe(200);
    expect((await db.query.documents.findFirst({ where: eq(schema.documents.id, up2.body.id) }))?.status).toBe('REJECTED');
  });

  test('block / unblock: permission, reason, ERP hold, vendor cannot request changes while blocked', async () => {
    const { v, id } = await approvedVendor('Lifecycle Block Co', 'life@block.test');
    const tax = await login('tax@acme.test');
    expect((await tax.post(`/api/staff/vendors/${id}/block`, { reason: 'x' })).status).toBe(403);
    const mdm = await login('mdm@acme.test');
    expect((await mdm.post(`/api/staff/vendors/${id}/block`, { reason: '' })).status).toBe(400);
    expect((await mdm.post(`/api/staff/vendors/${id}/block`, { reason: 'GST cancelled', notifyVendor: true })).status).toBe(200);
    const erp = (await mdm.get(`/api/staff/vendors/${id}/erp-export`)).body.ERPVendorsData.VENDOR.VENDOR_DATA;
    expect(erp).toMatchObject({ HOLD_ALL_PAYMENTS_FLAG: 'Y', HOLD_REASON: 'GST cancelled' });
    expect((await v.post('/api/vendor/change-requests', { changes: { basic: { websiteUrl: 'a.in' } } })).status).toBe(409);
    expect((await v.get('/api/vendor')).body.lifecycle.blocked).toBe(true);
    const list = (await mdm.get('/api/staff/vendors?attention=true')).body.vendors;
    expect(list.find((x: any) => x.id === id).flags.map((f: any) => f.code)).toContain('BLOCKED');
    expect((await mdm.post(`/api/staff/vendors/${id}/unblock`, { reason: 'GST restored' })).status).toBe(200);
    expect((await mdm.get(`/api/staff/vendors/${id}/erp-export`)).body.ERPVendorsData.VENDOR.VENDOR_DATA.HOLD_ALL_PAYMENTS_FLAG).toBe('N');
    const audit = (await mdm.get(`/api/staff/vendors/${id}`)).body.vendor.audit.map((a: any) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['VENDOR_BLOCKED', 'VENDOR_UNBLOCKED']));
  });
});

describe('expiry reminders and periodic review', () => {
  test('reminders at 30 / 7 / 0 days, each sent once', async () => {
    const { v, id } = await approvedVendor('Lifecycle Expiry Co', 'life@expiry.test');
    await v.agent.post('/api/vendor/documents').set('X-Requested-With', 'fetch').field('docType', 'FINANCIALS').field('expiresOn', inDays(25)).attach('file', Buffer.from(PDF), { filename: 'fy.pdf', contentType: 'application/pdf' });
    const cr = (await v.post('/api/vendor/change-requests', { changes: {} })).body;
    await (await login('mdm@acme.test')).post(`/api/staff/change-requests/${cr.id}/decision`, { action: 'APPROVE' });
    const doc = await db.query.documents.findFirst({ where: and(eq(schema.documents.vendorId, id), eq(schema.documents.docType, 'FINANCIALS'), eq(schema.documents.status, 'ACTIVE')) });
    expect(daysUntil(doc!.expiresOn!)).toBe(25);
    const count = async () => (await db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, 'life@expiry.test'))).filter((m) => /Expir/.test(m.subject)).length;
    const before = await count();
    await runExpiryReminders();
    expect(await count()).toBe(before + 1);
    await runExpiryReminders();
    expect(await count()).toBe(before + 1); // not repeated
    await runExpiryReminders(new Date(Date.now() + 20 * 86_400_000)); // 5 days left
    expect(await count()).toBe(before + 2);
    await runExpiryReminders(new Date(Date.now() + 30 * 86_400_000)); // expired
    expect(await count()).toBe(before + 3);
    const flags = flagsFor({ status: 'APPROVED', blockedAt: null, reviewStatus: 'OK', nextReviewAt: null }, [{ status: 'ACTIVE', expiresOn: doc!.expiresOn, docType: 'FINANCIALS' }], false, new Date(Date.now() + 30 * 86_400_000));
    expect(flags.map((f) => f.code)).toEqual(['DOC_EXPIRED']);
  });

  test('periodic review re-runs checks, asks the vendor to confirm, schedules the next one; failures are flagged', async () => {
    const { v, id } = await approvedVendor('Lifecycle Review Co', 'life@review.test');
    const vend = await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) });
    expect(vend!.nextReviewAt!.getTime()).toBeGreaterThan(Date.now() + 300 * 86_400_000); // ~12 months out
    await db.update(schema.vendors).set({ nextReviewAt: new Date(Date.now() - 1000) }).where(eq(schema.vendors.id, id));
    await runPeriodicReviews();
    const reviewed = await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) });
    expect(reviewed).toMatchObject({ reviewStatus: 'OK' });
    expect(reviewed!.nextReviewAt!.getTime()).toBeGreaterThan(Date.now());
    const ask = await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, 'life@review.test'), orderBy: desc(schema.emailOutbox.createdAt) });
    expect(ask?.subject).toMatch(/confirm your registered details/i);
    expect((await v.post('/api/vendor/confirm-details')).status).toBe(200);

    // A bank account that now fails the penny-drop → ATTENTION + flag
    const p = structuredClone(reviewed!.profile); p.bank = { ...p.bank, accountNumber: '501000123450' };
    await db.update(schema.vendors).set({ profile: p }).where(eq(schema.vendors.id, id));
    const mdm = await login('mdm@acme.test');
    const r = (await mdm.post(`/api/staff/vendors/${id}/review`)).body;
    expect(r.status).toBe('ATTENTION');
    expect(r.problems.join(' ')).toMatch(/Bank account/);
    expect((await mdm.get(`/api/staff/vendors/${id}`)).body.flags.map((f: any) => f.code)).toContain('REVIEW_ATTENTION');
  });
});

describe('config: change-approval rules are validated', () => {
  test('unknown level / field in a change rule is reported', async () => {
    const admin = await login('admin@acme.test');
    const cfg = (await admin.get('/api/admin/config')).body.published.config;
    cfg.workflow.changes = { rules: [{ match: ['bank.*', 'nope.field'], levelIds: ['ghost'] }], defaultLevelIds: ['mdm'] };
    const issues = (await admin.put('/api/admin/config/draft', { config: cfg })).body.issues.map((i: any) => i.message).join(' | ');
    expect(issues).toMatch(/ghost/);
    expect(issues).toMatch(/nope\.field/);
    await admin.del('/api/admin/config/draft');
  });
});
