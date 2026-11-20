/** On-prem: licences (signed, dated, with limits), read-only after the grace period, no sign-up or billing. */
import { afterAll, describe, expect, test, vi } from 'vitest';
vi.hoisted(() => { process.env.DEPLOYMENT_MODE = 'onprem'; });
import fs from 'node:fs';
import { desc, eq } from 'drizzle-orm';
import { db, schema } from '../src/lib/db.js';
import { client, invitedSupplier, login } from './helpers.js';
import { licenceState, signLicence, verifyLicence, type Licence } from '../src/lib/licence.js';
import { installLicence, loadLicence, runLicenceReminders } from '../src/services/licence.js';

const KEY = fs.readFileSync(new URL('./fixtures/licence-dev-private.pem', import.meta.url), 'utf8');
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const lic = (o: Partial<Licence> = {}): Licence => ({ v: 1, id: 'VG-TEST-0001', customer: 'Acme Industries Ltd', issuedAt: new Date().toISOString(), validFrom: day(-30), validUntil: day(300), maxUsers: null, maxVendors: null, ...o });
const install = (o: Partial<Licence> = {}) => installLicence(signLicence(lic({ issuedAt: new Date().toISOString(), ...o }), KEY), { name: 'test' });
afterAll(async () => { await db.delete(schema.systemLicence); await loadLicence(); delete process.env.DEPLOYMENT_MODE; });

describe('licence', () => {
  test('signed and checked; changing it breaks the signature; states by date', () => {
    const token = signLicence(lic(), KEY);
    expect(verifyLicence(token)).toMatchObject({ ok: true, licence: { id: 'VG-TEST-0001' } });
    const [p, body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), maxUsers: 9999 })).toString('base64url');
    expect(verifyLicence(`${p}.${forged}.${sig}`)).toMatchObject({ ok: false });
    expect(verifyLicence('hello')).toMatchObject({ ok: false, error: 'This is not a VendorGate licence file' });
    expect(verifyLicence(token, { production: true })).toMatchObject({ ok: false }); // the dev key isn't accepted in production
    expect(licenceState(null).state).toBe('missing');
    expect(licenceState(lic()).state).toBe('valid');
    expect(licenceState(lic({ validUntil: day(10) }))).toMatchObject({ state: 'expiring', daysLeft: 10 });
    expect(licenceState(lic({ validUntil: day(-5) })).state).toBe('grace');
    expect(licenceState(lic({ validUntil: day(-20) })).state).toBe('readonly');
    expect(licenceState(lic({ validUntil: day(-20), graceDays: 30 })).state).toBe('grace');
    expect(licenceState(lic({ validFrom: day(3) })).state).toBe('notYetValid');
  });

  test('on-prem: no sign-up, billing or platform console; the health check says on-prem', async () => {
    const c = client();
    expect((await c.get('/api/health')).body).toMatchObject({ ok: true, mode: 'onprem' });
    expect((await c.get('/api/signup/config')).status).toBe(404);
    expect((await c.get('/api/platform/tenants')).status).toBe(404);
    expect((await (await login('admin@acme.test')).get('/api/admin/billing')).status).toBe(404);
  });

  test('without a licence staff can look but not change; installing one (admins only) unlocks it; suppliers keep working', async () => {
    await db.delete(schema.systemLicence); await loadLicence();
    const admin = await login('admin@acme.test');
    expect((await admin.get('/api/auth/me')).body.licence).toMatchObject({ state: 'missing', readOnly: true });
    expect((await admin.get('/api/staff/vendors')).status).toBe(200);
    const r = await admin.post('/api/staff/vendors', { name: 'Blocked Ltd', vendorType: 'DOMESTIC', contactFirstName: 'A', contactLastName: 'B', contactEmail: 'b@lic.test', contactMobile: '9800011122' });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('LICENCE_READ_ONLY');
    expect((await (await login('tax@acme.test')).post('/api/admin/licence', { token: signLicence(lic(), KEY) })).status).toBe(403);
    expect((await admin.post('/api/admin/licence', { token: 'VGL1.this-is-not.a-real-licence-signature' })).body.code).toBe('LICENCE_INVALID');
    const ok = await admin.post('/api/admin/licence', { token: signLicence(lic(), KEY) });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ state: 'valid', readOnly: false, licence: { customer: 'Acme Industries Ltd' } });
    expect((await admin.get('/api/admin/licence')).body.usage.users).toBeGreaterThan(3);
    const { v } = await invitedSupplier('Licensed Lathes Ltd', 'lathes@lic.test');
    // Expired beyond the grace period: read-only for staff, the supplier portal still works.
    await install({ validUntil: day(-20) });
    expect((await admin.post('/api/staff/vendors', { name: 'Late Ltd', vendorType: 'DOMESTIC', contactFirstName: 'A', contactLastName: 'B', contactEmail: 'late@lic.test', contactMobile: '9800011123' })).status).toBe(403);
    expect((await v.put('/api/vendor/profile/basic', { entityType: 'Company (Pvt / Public Ltd)' })).status).toBe(200);
    expect((await admin.post('/api/auth/logout')).status).toBeLessThan(400);
    // Grace period: everything works, with a warning.
    await install({ validUntil: day(-3) });
    const me = (await (await login('admin@acme.test')).get('/api/auth/me')).body;
    expect(me.licence).toMatchObject({ state: 'grace', readOnly: false });
    expect(me.licence.message).toMatch(/read-only on/);
    expect((await (await login('tax@acme.test')).get('/api/auth/me')).body.licence.message).toBeNull(); // warnings are for administrators
  });

  test('the licence sets user and supplier limits and features', async () => {
    await install({ maxUsers: 2, features: { ai: false } });
    const admin = await login('admin@acme.test');
    const roles = (await admin.get('/api/admin/roles')).body;
    const r = await admin.post('/api/admin/users', { name: 'One Too Many', email: 'toomany@lic.test', roleIds: [(Array.isArray(roles) ? roles : roles.roles)[0].id] });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/^Your VendorGate licence allows 2 users/);
    expect((await admin.get('/api/auth/me')).body.plan).toMatchObject({ label: 'On-premises licence', features: { ai: false, erp: true } });
    // Contracts only (licence tool: --contracts --no-onboarding): purchase orders and sourcing go off with onboarding.
    await install({ features: { contracts: true, onboarding: false, sourcing: true } });
    expect((await admin.get('/api/auth/me')).body.plan.features).toMatchObject({ contracts: true, onboarding: false, collab: false, sourcing: false });
    expect((await admin.get('/api/staff/vendors')).status).toBe(404);
    await install();
  });

  test('administrators are emailed before the end date, once per milestone', async () => {
    await install({ id: 'VG-TEST-REMIND', validUntil: day(6) });
    const before = await db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, 'admin@acme.test'));
    expect(await runLicenceReminders()).toMatchObject({ milestone: '7' });
    expect((await runLicenceReminders()).sent).toBe(0);
    const mails = await db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, 'admin@acme.test')).orderBy(desc(schema.emailOutbox.createdAt));
    expect(mails.length).toBe(before.length + 1);
    expect(mails[0].subject).toBe('VendorGate licence ends in 6 days');
    await install();
  });
});
