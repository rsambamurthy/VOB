import { describe, expect, test } from 'vitest';
import { generateSync } from 'otplib';
import { eq } from 'drizzle-orm';
import { client, login, lastLinkTo, tokenOf, DEMO_PASSWORD } from './helpers.js';
import { db, schema } from '../src/lib/db.js';

const OWNER = 'owner@vendorgate.test';
let secret = '';

/** Signs in to the platform console; the first call enrols 2FA. */
async function platform() {
  const c = client();
  const r = await c.post('/api/platform/auth/login', { email: OWNER, password: DEMO_PASSWORD });
  expect(r.status).toBe(200);
  if (r.body.mfaSetupRequired) {
    const setup = await c.post('/api/platform/auth/mfa/setup');
    secret = setup.body.secret;
    expect((await c.post('/api/platform/auth/mfa/enable', { code: generateSync({ secret }) })).status).toBe(200);
  } else {
    expect(r.body.mfaRequired).toBe(true);
    expect((await c.post('/api/platform/auth/mfa/verify', { code: generateSync({ secret }) })).status).toBe(200);
  }
  return c;
}

describe('platform console', () => {
  test('requires its own sign-in and 2FA; tenant admins have no access', async () => {
    const tenantAdmin = await login('admin@acme.test');
    expect((await tenantAdmin.get('/api/platform/tenants')).status).toBe(401);

    const c = client();
    expect((await c.post('/api/platform/auth/login', { email: OWNER, password: 'wrong-password' })).status).toBe(401);
    const r = await c.post('/api/platform/auth/login', { email: OWNER, password: DEMO_PASSWORD });
    expect(r.body.mfaSetupRequired).toBe(true);
    const blocked = await c.get('/api/platform/tenants');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('MFA_SETUP_REQUIRED');

    await platform(); // enrols
    const again = client();
    expect((await again.post('/api/platform/auth/login', { email: OWNER, password: DEMO_PASSWORD })).body.mfaRequired).toBe(true);
    expect((await again.get('/api/platform/tenants')).status).toBe(401); // 2FA still pending
    expect((await again.post('/api/platform/auth/mfa/verify', { code: '000000' })).status).toBe(401);
    expect((await again.post('/api/platform/auth/mfa/verify', { code: generateSync({ secret }) })).status).toBe(200);
    const list = await again.get('/api/platform/tenants');
    expect(list.status).toBe(200);
    expect(list.body.map((t: any) => t.slug)).toEqual(expect.arrayContaining(['acme', 'globex']));
  });

  test('creates a tenant on a plan and invites its administrator', async () => {
    const c = await platform();
    expect((await c.get('/api/platform/tenants/check-slug?slug=platform')).body.available).toBe(false);
    expect((await c.get('/api/platform/tenants/check-slug?slug=hooli')).body.available).toBe(true);
    const r = await c.post('/api/platform/tenants', { name: 'Hooli Ltd', slug: 'hooli', adminName: 'Gavin B', adminEmail: 'gavin@hooli.test', plan: 'trial', trialDays: 10, primaryColor: '#0055aa' });
    expect(r.status).toBe(201);
    const link = await lastLinkTo('gavin@hooli.test');
    expect(link).toContain('/accept-invite/');
    const t = await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'hooli') });
    expect(t?.plan).toBe('trial');
    expect(t?.source).toBe('platform');
    expect(Math.round((t!.trialEndsAt!.getTime() - Date.now()) / 86_400_000)).toBe(10);

    const staff = client();
    expect((await staff.post('/api/auth/accept-invite', { token: tokenOf(link!), name: 'Gavin B', password: 'Hooli-Admin-123' })).status).toBe(200);
    const me = (await staff.get('/api/auth/me')).body;
    expect(me.plan.key).toBe('trial');
    expect(me.plan.features.erp).toBe(false);

    const detail = await c.get(`/api/platform/tenants/${t!.id}`);
    expect(detail.body.admins[0].email).toBe('gavin@hooli.test');
    expect(detail.body.effective.maxUsers).toBe(5);
    const audit = (await c.get(`/api/platform/audit?tenantId=${t!.id}`)).body;
    expect(audit[0].action).toBe('TENANT_CREATED');
  });

  test('plan limits: users, vendors, features and trial end', async () => {
    const c = await platform();
    const t = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'hooli') }))!;
    const staff = await login('gavin@hooli.test', 'hooli', 'Hooli-Admin-123');
    const adminRole = (await staff.get('/api/admin/roles')).body.roles.find((x: any) => x.key === 'ADMIN');

    expect((await c.patch(`/api/platform/tenants/${t.id}`, { limits: { maxUsers: 2, maxVendors: 1 } })).status).toBe(200);
    expect((await staff.post('/api/admin/users', { name: 'Two', email: 'two@hooli.test', roleIds: [adminRole.id] })).status).toBe(201);
    const third = await staff.post('/api/admin/users', { name: 'Three', email: 'three@hooli.test', roleIds: [adminRole.id] });
    expect(third.status).toBe(403);
    expect(third.body.code).toBe('PLAN_LIMIT');

    const v = { vendorType: 'DOMESTIC', contactFirstName: 'A', contactLastName: 'B', contactMobile: '9800011122' };
    expect((await staff.post('/api/staff/vendors', { ...v, name: 'First Vendor', contactEmail: 'v1@x.test' })).status).toBe(201);
    expect((await staff.post('/api/staff/vendors', { ...v, name: 'Second Vendor', contactEmail: 'v2@x.test' })).body.code).toBe('PLAN_LIMIT');

    // ERP isn't in the trial plan
    const erp = await staff.put('/api/admin/erp', { kind: 'webhook', testMode: true, autoPush: false, config: { url: 'https://example.com/hook' }, secrets: {} });
    expect(erp.body.code).toBe('PLAN_LIMIT');
    expect((await c.patch(`/api/platform/tenants/${t.id}`, { limits: { maxUsers: 2, maxVendors: 1, features: { erp: true } } })).status).toBe(200);
    expect((await staff.put('/api/admin/erp', { kind: 'webhook', testMode: true, autoPush: false, config: { url: 'https://example.com/hook' }, secrets: {} })).status).toBe(200);

    // trial ended → no new vendors, sign-in still works
    await c.patch(`/api/platform/tenants/${t.id}`, { limits: {}, trialEndsAt: '2020-01-01' });
    const ended = await staff.post('/api/staff/vendors', { ...v, name: 'Third Vendor', contactEmail: 'v3@x.test' });
    expect(ended.status).toBe(403);
    expect(ended.body.error).toMatch(/trial ended/);
    expect((await staff.get('/api/auth/me')).body.plan.trialExpired).toBe(true);

    // upgrade lifts it
    await c.patch(`/api/platform/tenants/${t.id}`, { plan: 'standard' });
    expect((await staff.post('/api/staff/vendors', { ...v, name: 'Third Vendor', contactEmail: 'v3@x.test' })).status).toBe(201);
  });

  test('suspend signs everyone out and blocks sign-in; reactivate restores it', async () => {
    const c = await platform();
    const t = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'hooli') }))!;
    const staff = await login('gavin@hooli.test', 'hooli', 'Hooli-Admin-123');
    expect((await c.post(`/api/platform/tenants/${t.id}/suspend`, { reason: 'x' })).status).toBe(400); // reason too short
    expect((await c.post(`/api/platform/tenants/${t.id}/suspend`, { reason: 'Unpaid invoice' })).status).toBe(200);
    expect((await staff.get('/api/auth/me')).status).toBe(401);
    expect((await client().post('/api/auth/login', { workspace: 'hooli', email: 'gavin@hooli.test', password: 'Hooli-Admin-123' })).status).toBe(403);
    expect((await c.post(`/api/platform/tenants/${t.id}/reactivate`)).status).toBe(200);
    expect((await client().post('/api/auth/login', { workspace: 'hooli', email: 'gavin@hooli.test', password: 'Hooli-Admin-123' })).status).toBe(200);
  });

  test('support access is read-only, time-limited and shows in the tenant audit log', async () => {
    const c = await platform();
    const acme = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
    expect((await c.post(`/api/platform/tenants/${acme.id}/support-access`, { reason: 'no' })).status).toBe(400);
    const r = await c.post(`/api/platform/tenants/${acme.id}/support-access`, { reason: 'Customer asked why invites fail', minutes: 30 });
    expect(r.status).toBe(200);
    const me = (await c.get('/api/auth/me')).body; // same browser now holds a staff session
    expect(me.tenant.slug).toBe('acme');
    expect(me.support.by).toContain(OWNER);
    expect((await c.get('/api/staff/vendors')).status).toBe(200);
    const write = await c.post('/api/staff/vendors', { name: 'Should Fail', vendorType: 'DOMESTIC', contactFirstName: 'A', contactLastName: 'B', contactEmail: 'f@x.test', contactMobile: '9800011122' });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('SUPPORT_READ_ONLY');
    const session = await db.query.sessions.findFirst({ where: eq(schema.sessions.supportAdminId, (await db.query.platformAdmins.findFirst({ where: eq(schema.platformAdmins.email, OWNER) }))!.id) });
    expect(Math.round((session!.expiresAt.getTime() - Date.now()) / 60_000)).toBe(30);
    const audit = (await (await login('admin@acme.test')).get('/api/admin/audit')).body;
    const rows = Array.isArray(audit) ? audit : audit.rows ?? audit.items;
    expect(JSON.stringify(rows)).toContain('SUPPORT_ACCESS');
    expect((await c.post('/api/auth/logout')).status).toBe(200); // the one write allowed
  });

  test('platform admins: invite, accept, cannot disable the last one', async () => {
    const c = await platform();
    const r = await c.post('/api/platform/admins', { name: 'Second Op', email: 'op2@vendorgate.test' });
    expect(r.status).toBe(201);
    const link = await lastLinkTo('op2@vendorgate.test');
    const n = client();
    expect((await n.get(`/api/platform/auth/invite/${tokenOf(link!)}`)).body.email).toBe('op2@vendorgate.test');
    expect((await n.post('/api/platform/auth/accept-invite', { token: tokenOf(link!), name: 'Second Op', password: 'Second-Op-Pass-1' })).body.mfaSetupRequired).toBe(true);
    expect((await n.get('/api/platform/overview')).status).toBe(403); // must enrol 2FA first
    const me = (await c.get('/api/platform/auth/me')).body.admin;
    expect((await c.patch(`/api/platform/admins/${me.id}`, { status: 'DISABLED' })).status).toBe(409);
  });
});

describe('self-service sign-up', () => {
  const form = { company: 'Pied Piper Pvt Ltd', name: 'Richard H', email: 'richard@piedpiper.test', slug: 'pied-piper', agree: true };

  test('closed until a platform admin opens it', async () => {
    expect((await client().get('/api/signup/config')).body.enabled).toBe(false);
    expect((await client().post('/api/signup', form)).status).toBe(403);
    const c = await platform();
    const s = (await c.get('/api/platform/settings')).body;
    expect((await c.put('/api/platform/settings', { ...s, signupEnabled: true, trialDays: 21, notifyEmail: 'sales@vendorgate.test' })).status).toBe(200);
    expect((await client().get('/api/signup/config')).body).toMatchObject({ enabled: true, trialDays: 21, workEmailOnly: true });
  });

  test('validates email, workspace ID and the honeypot', async () => {
    const u = client();
    expect((await u.post('/api/signup', { ...form, email: 'someone@gmail.com' })).body.code).toBe('WORK_EMAIL_REQUIRED');
    const taken = await u.post('/api/signup', { ...form, slug: 'acme' });
    expect(taken.status).toBe(409);
    expect(taken.body.details.suggestion).toBe('pied-piper');
    expect((await u.post('/api/signup', { ...form, slug: 'admin' })).body.error).toMatch(/reserved/);
    expect((await u.post('/api/signup', { ...form, agree: false })).status).toBe(400);
    expect((await u.get('/api/signup/check-slug?company=Pied%20Piper%20Pvt%20Ltd')).body.slug).toBe('pied-piper');
    const bot = await u.post('/api/signup', { ...form, email: 'bot@spam.test', website: 'http://spam' });
    expect(bot.status).toBe(200);
    expect(await lastLinkTo('bot@spam.test')).toBeUndefined();
  });

  test('confirm email → set password → workspace on the trial plan, owner signed in', async () => {
    const u = client();
    expect((await u.post('/api/signup', form)).status).toBe(200);
    const link = await lastLinkTo(form.email);
    expect(link).toContain('/signup/verify/');
    const token = tokenOf(link!);
    expect((await u.get(`/api/signup/verify/${token}`)).body).toMatchObject({ company: form.company, slug: 'pied-piper', slugAvailable: true });
    expect((await u.post('/api/signup/complete', { token, password: 'short' })).status).toBe(400);
    const done = await u.post('/api/signup/complete', { token, password: 'Pied-Piper-2026!' });
    expect(done.status).toBe(200);
    expect(done.body.workspace).toBe('pied-piper');

    const me = (await u.get('/api/auth/me')).body;
    expect(me.tenant.slug).toBe('pied-piper');
    expect(me.roles.map((r: any) => r.key)).toContain('ADMIN');
    expect(me.plan.key).toBe('trial');
    const t = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'pied-piper') }))!;
    expect(t.source).toBe('signup');
    expect(Math.round((t.trialEndsAt!.getTime() - Date.now()) / 86_400_000)).toBe(21);
    expect(await lastLinkTo('sales@vendorgate.test')).toContain(`/platform/tenants/${t.id}`);
    // the link is single-use
    expect((await client().post('/api/signup/complete', { token, password: 'Pied-Piper-2026!' })).body.code).toBe('SIGNUP_DONE');
    // the owner can sign in normally
    expect((await client().post('/api/auth/login', { workspace: 'pied-piper', email: form.email, password: 'Pied-Piper-2026!' })).status).toBe(200);
    const signups = (await (await platform()).get('/api/platform/signups')).body;
    expect(signups.find((s: any) => s.email === form.email).state).toBe('COMPLETED');
  });
});
