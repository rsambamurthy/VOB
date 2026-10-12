import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateSync } from 'otplib';
import { client, login, lastLinkTo, tokenOf, globexAdmin } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import { createTenant } from '../src/services/tenants.js';

describe('tenant isolation', () => {
  test('each workspace only sees its own vendors', async () => {
    const acme = await login('admin@acme.test');
    const list = (await acme.get('/api/staff/vendors')).body.vendors;
    expect(list.map((v: any) => v.name)).not.toContain('Globex Only Supplier Pvt Ltd');
    const globexVendor = await db.query.vendors.findFirst({ where: eq(schema.vendors.name, 'Globex Only Supplier Pvt Ltd') });
    expect((await acme.get(`/api/staff/vendors/${globexVendor!.id}`)).status).toBe(404);
    expect((await acme.post(`/api/staff/vendors/${globexVendor!.id}/invite`)).status).toBe(404);
  });

  test('vendor codes are per workspace', async () => {
    const both = await db.select({ code: schema.vendors.code, t: schema.vendors.tenantId }).from(schema.vendors).where(eq(schema.vendors.code, 'VND-00001'));
    expect(new Set(both.map((b) => b.t)).size).toBeGreaterThanOrEqual(2); // other test files add workspaces too
  });

  test('admin endpoints are workspace-scoped', async () => {
    const acme = await login('admin@acme.test');
    const g = await globexAdmin();
    const acmeUsers = (await acme.get('/api/admin/users')).body.map((u: any) => u.email);
    const globexUsers = (await g.get('/api/admin/users')).body.map((u: any) => u.email);
    expect(acmeUsers).not.toContain('admin@globex.test');
    expect(globexUsers).toEqual(['admin@globex.test']);
    const acmeUser = await db.query.users.findFirst({ where: eq(schema.users.email, 'tax@acme.test') });
    expect((await g.patch(`/api/admin/users/${acmeUser!.id}`, { status: 'DISABLED' })).status).toBe(404);
    const acmeRole = (await acme.get('/api/admin/roles')).body.roles[1];
    expect((await g.post('/api/admin/users', { name: 'Sneaky', email: 's@globex.test', roleIds: [acmeRole.id] })).status).toBe(400);
  });

  test('a vendor session cannot reach another workspace’s documents', async () => {
    const g = await globexAdmin();
    await g.post('/api/staff/vendors', { name: 'Doc Isolation Co', vendorType: 'DOMESTIC', contactFirstName: 'D', contactLastName: 'I', contactEmail: 'di@x.test', contactMobile: '9800000001' });
    const v = client();
    const token = tokenOf((await lastLinkTo('di@x.test'))!);
    const otp = (await v.post('/api/vendor-auth/request-otp', { token })).body.devOtp;
    await v.post('/api/vendor-auth/verify-otp', { token, code: otp });
    await v.post('/api/vendor/consent', { version: (await v.get('/api/vendor')).body.privacy.version });
    const up = await v.upload('/api/vendor/documents', 'PAN_CARD');
    expect(up.status).toBe(201);

    const acme = await login('admin@acme.test');
    expect((await acme.get(`/api/documents/${up.body.id}`)).status).toBe(404);
    expect((await v.get(`/api/documents/${up.body.id}`)).status).toBe(200);
    expect((await v.get('/api/staff/vendors')).status).toBe(401); // vendor session is not a staff session
  });

  test('provisioning a new workspace creates default roles and an admin invite', async () => {
    const r = await createTenant({ slug: 'initech', name: 'Initech', adminName: 'Bill L', adminEmail: 'bill@initech.test' });
    expect(r.roles.map((x) => x.key)).toContain('ADMIN');
    const c = client();
    expect((await c.post('/api/auth/accept-invite', { token: tokenOf(r.inviteLink), name: 'Bill L', password: 'Initech-Admin-1' })).status).toBe(200);
    const me = (await c.get('/api/auth/me')).body;
    expect(me.tenant.slug).toBe('initech');
    expect((await c.get('/api/staff/vendors')).body.vendors).toHaveLength(0);
    await expect(createTenant({ slug: 'initech', name: 'X', adminName: 'Y', adminEmail: 'y@x.test' })).rejects.toThrow(/taken/);
    await expect(createTenant({ slug: 'Bad Slug!', name: 'X', adminName: 'Y', adminEmail: 'y@x.test' })).rejects.toThrow(/Workspace ID/);
    void generateSync;
  });

  test('suspended workspace sessions stop working', async () => {
    const c = await login('bill@initech.test', 'initech', 'Initech-Admin-1');
    await db.update(schema.tenants).set({ status: 'SUSPENDED' }).where(eq(schema.tenants.slug, 'initech'));
    expect((await c.get('/api/auth/me')).status).toBe(401);
    const r = await client().post('/api/auth/login', { workspace: 'initech', email: 'bill@initech.test', password: 'Initech-Admin-1' });
    expect(r.status).toBe(403);
  });
});
