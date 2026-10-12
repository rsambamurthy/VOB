import { afterAll, describe, expect, test } from 'vitest';
import { desc, eq, sql } from 'drizzle-orm';
import { approvedVendor, client, lastLinkTo, login, tokenOf } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import { runRetention } from '../src/services/privacy.js';

// Leave acme's notice as the default for the other test files.
afterAll(async () => {
  const t = await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') });
  const { privacy: _p, retention: _r, ...rest } = t!.settings;
  await db.update(schema.tenants).set({ settings: rest }).where(eq(schema.tenants.id, t!.id));
});

describe('DPDP', () => {
  test('changing the privacy notice asks vendors to accept again', async () => {
    const admin = await login('admin@acme.test');
    const { v } = await approvedVendor('Privacy Notice Co', 'pn@privacy.test');
    const p = (await admin.get('/api/admin/privacy')).body;
    expect(p.notice.isDefault).toBe(true);
    expect((await admin.put('/api/admin/privacy', { text: 'too short', contactEmail: '', retention: p.retention })).status).toBe(400);
    const r = await admin.put('/api/admin/privacy', { text: p.template + '\n\nUpdated.', contactEmail: 'dpo@acme.test', retention: { rejectedDays: 365, abandonedDays: 180 } });
    expect(r.body.notice.version).toBe(2);
    expect((await v.get('/api/vendor')).body.privacy).toMatchObject({ needsConsent: true, version: 2, contactEmail: 'dpo@acme.test' });
    expect((await v.post('/api/vendor/confirm-details')).status).toBe(403);
    await v.post('/api/vendor/consent', { version: 2 });
    expect((await v.post('/api/vendor/confirm-details')).status).toBe(200);
    // saving the same text again does not bump the version
    expect((await admin.put('/api/admin/privacy', { text: p.template + '\n\nUpdated.', contactEmail: 'dpo@acme.test', retention: { rejectedDays: 365, abandonedDays: 180 } })).body.notice.version).toBe(2);
  });

  test('data export: vendor gets their data; staff export includes the audit trail', async () => {
    const { v, id, admin } = await approvedVendor('Export Me Co', 'exp@privacy.test');
    const mine = (await v.get('/api/vendor/my-data')).body;
    expect(mine.profile.bank.accountNumber).toBe('501000123456'); // their own data, in full
    expect(mine.documents.length).toBeGreaterThan(0);
    expect(mine.sharedWith.map((x: any) => x.recipient)).toContain('Verification provider');
    expect(mine.auditTrail).toBeUndefined();
    expect(mine.approvals[0].remarks).toBeUndefined();
    const staff = (await admin.get(`/api/staff/vendors/${id}/data-export`)).body;
    expect(staff.auditTrail.length).toBeGreaterThan(0);
    expect((await (await login('tax@acme.test')).get(`/api/staff/vendors/${id}/data-export`)).status).toBe(403);
  });

  test('erasure request → admin erases: personal data gone, statistics and audit kept', async () => {
    const { v, id, admin } = await approvedVendor('Erase Me Co', 'erase@privacy.test');
    expect((await v.post('/api/vendor/erasure-request', { reason: 'We closed the business' })).status).toBe(200);
    expect((await v.post('/api/vendor/erasure-request', {})).status).toBe(409);
    const detail = (await admin.get(`/api/staff/vendors/${id}`)).body;
    expect(detail.flags.map((f: any) => f.code)).toContain('ERASURE_REQUESTED');
    expect(detail.privacy.erasureReason).toBe('We closed the business');

    expect((await (await login('mdm@acme.test')).post(`/api/staff/vendors/${id}/erase`, { reason: 'x', confirm: 'x' })).status).toBe(403);
    expect((await admin.post(`/api/staff/vendors/${id}/erase`, { reason: 'Vendor request', confirm: detail.vendor.code })).status).toBe(409); // must be blocked first
    await (await login('mdm@acme.test')).post(`/api/staff/vendors/${id}/block`, { reason: 'Closing down' });
    expect((await admin.post(`/api/staff/vendors/${id}/erase`, { reason: 'Vendor request', confirm: 'WRONG' })).status).toBe(400);
    expect((await admin.post(`/api/staff/vendors/${id}/erase`, { reason: 'Vendor request', confirm: detail.vendor.code })).status).toBe(200);

    const after = await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) });
    expect(after).toMatchObject({ name: `Erased vendor ${detail.vendor.code}`, contactMobile: '', status: 'APPROVED', erasureRequestedAt: null });
    expect(after!.profile).toEqual({});
    expect(after!.erasedAt).toBeTruthy();
    expect(await db.select().from(schema.documents).where(eq(schema.documents.vendorId, id))).toHaveLength(0);
    expect(await db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, 'erase@privacy.test'))).toHaveLength(0);
    const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.vendorId, id));
    expect(logs.some((l) => l.actor === 'erase@privacy.test')).toBe(false);
    expect(logs.some((l) => l.action === 'SUBMITTED' && l.actor === 'vendor (erased)')).toBe(true);
    expect(logs.find((l) => l.action === 'VENDOR_ERASED')?.detail).toMatchObject({ reason: 'Vendor request' });
    expect((await v.get('/api/vendor')).status).toBe(401); // vendor sessions ended
  });

  test('decline a deletion request with a reason', async () => {
    const { v, id, admin } = await approvedVendor('Keep Me Co', 'keep@privacy.test');
    await v.post('/api/vendor/erasure-request', { reason: '' });
    expect((await admin.post(`/api/staff/vendors/${id}/erasure-request/decline`, { reason: '' })).status).toBe(400);
    expect((await admin.post(`/api/staff/vendors/${id}/erasure-request/decline`, { reason: 'Active supplier: invoices must be kept 8 years' })).status).toBe(200);
    const mail = await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, 'keep@privacy.test'), orderBy: desc(schema.emailOutbox.createdAt) });
    expect(mail?.body).toContain('8 years');
  });

  test('retention: old rejected and abandoned registrations are erased automatically', async () => {
    const admin = await login('admin@acme.test');
    const mk = async (name: string, email: string) => (await admin.post('/api/staff/vendors', { name, vendorType: 'DOMESTIC', contactFirstName: 'R', contactLastName: 'T', contactEmail: email, contactMobile: '9800011122' })).body.vendor.id;
    const abandoned = await mk('Abandoned Ltd', 'ab@privacy.test');
    const fresh = await mk('Fresh Ltd', 'fr@privacy.test');
    await db.execute(sql`update vendors set updated_at = now() - interval '200 days' where id = ${abandoned}`);
    expect(await runRetention()).toBeGreaterThanOrEqual(1);
    expect((await db.query.vendors.findFirst({ where: eq(schema.vendors.id, abandoned) }))!.erasedAt).toBeTruthy();
    expect((await db.query.vendors.findFirst({ where: eq(schema.vendors.id, fresh) }))!.erasedAt).toBeNull();
    const log = await db.query.auditLogs.findFirst({ where: eq(schema.auditLogs.vendorId, abandoned), orderBy: desc(schema.auditLogs.createdAt) });
    expect(log).toMatchObject({ action: 'VENDOR_ERASED', actor: 'system' });
    void client; void lastLinkTo; void tokenOf;
  });
});
