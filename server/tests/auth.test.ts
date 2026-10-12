import { describe, expect, test } from 'vitest';
import { generateSync } from 'otplib';
import { client, login, lastLinkTo, tokenOf, DEMO_PASSWORD, app } from './helpers.js';
import request from 'supertest';

describe('staff sign-in', () => {
  test('valid credentials give a session with permissions', async () => {
    const c = await login('admin@acme.test');
    const me = await c.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.tenant.slug).toBe('acme');
    expect(me.body.permissions).toContain('users.manage');
    expect(me.body.user.email).toBe('admin@acme.test');
  });

  test('wrong password, wrong workspace and unknown user all give the same error', async () => {
    const c = client();
    const a = await c.post('/api/auth/login', { workspace: 'acme', email: 'admin@acme.test', password: 'nope' });
    const b = await c.post('/api/auth/login', { workspace: 'nosuch', email: 'admin@acme.test', password: DEMO_PASSWORD });
    const d = await c.post('/api/auth/login', { workspace: 'acme', email: 'ghost@acme.test', password: DEMO_PASSWORD });
    expect([a.status, b.status, d.status]).toEqual([401, 401, 401]);
    expect(new Set([a.body.error, b.body.error, d.body.error]).size).toBe(1);
  });

  test('user in one workspace cannot sign in to another', async () => {
    const r = await client().post('/api/auth/login', { workspace: 'globex', email: 'admin@acme.test', password: DEMO_PASSWORD });
    expect(r.status).toBe(401);
  });

  test('account locks after 5 failures and admin can unlock', async () => {
    const admin = await login('admin@acme.test');
    const roles = (await admin.get('/api/admin/roles')).body.roles;
    const viewer = roles.find((r: any) => r.key === 'VIEWER');
    await admin.post('/api/admin/users', { name: 'Lock Test', email: 'lock@acme.test', roleIds: [viewer.id] });
    const link = (await lastLinkTo('lock@acme.test'))!;
    await client().post('/api/auth/accept-invite', { token: tokenOf(link), name: 'Lock Test', password: 'Strong-Pass-99' });

    const c = client();
    for (let i = 0; i < 5; i++) await c.post('/api/auth/login', { workspace: 'acme', email: 'lock@acme.test', password: 'Wrong-Pass-00' });
    const locked = await c.post('/api/auth/login', { workspace: 'acme', email: 'lock@acme.test', password: 'Strong-Pass-99' });
    expect(locked.status).toBe(429);

    const users = (await admin.get('/api/admin/users')).body;
    const u = users.find((x: any) => x.email === 'lock@acme.test');
    expect(u.locked).toBe(true);
    await admin.post(`/api/admin/users/${u.id}/unlock`);
    expect((await c.post('/api/auth/login', { workspace: 'acme', email: 'lock@acme.test', password: 'Strong-Pass-99' })).status).toBe(200);
  });

  test('logout ends the session', async () => {
    const c = await login('tax@acme.test');
    await c.post('/api/auth/logout');
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  test('state-changing requests without X-Requested-With are refused (CSRF)', async () => {
    const r = await request(app).post('/api/auth/login').send({ workspace: 'acme', email: 'admin@acme.test', password: DEMO_PASSWORD });
    expect(r.status).toBe(403);
  });
});

describe('invites and password reset', () => {
  test('invited user sets a password, weak passwords refused, link single-use', async () => {
    const admin = await login('admin@acme.test');
    const roles = (await admin.get('/api/admin/roles')).body.roles;
    const r = await admin.post('/api/admin/users', { name: 'New Person', email: 'new.person@acme.test', roleIds: [roles.find((x: any) => x.key === 'TAX_MANAGER').id] });
    expect(r.status).toBe(201);
    const token = tokenOf((await lastLinkTo('new.person@acme.test'))!);

    const info = await client().get(`/api/auth/invite/${token}`);
    expect(info.body).toMatchObject({ email: 'new.person@acme.test', workspace: 'acme' });
    expect((await client().post('/api/auth/accept-invite', { token, name: 'New Person', password: 'password' })).status).toBe(400);
    const c = client();
    expect((await c.post('/api/auth/accept-invite', { token, name: 'New Person', password: 'Gr8-Reviewer!' })).status).toBe(200);
    expect((await c.get('/api/auth/me')).body.roles[0].key).toBe('TAX_MANAGER');
    expect((await client().post('/api/auth/accept-invite', { token, name: 'X', password: 'Another-Pass-1' })).status).toBe(400);
  });

  test('forgot password → reset → old sessions revoked', async () => {
    const old = await login('mdm@acme.test');
    const anon = client();
    expect((await anon.post('/api/auth/forgot-password', { workspace: 'acme', email: 'mdm@acme.test' })).status).toBe(200);
    expect((await anon.post('/api/auth/forgot-password', { workspace: 'acme', email: 'nobody@acme.test' })).status).toBe(200);
    const token = tokenOf((await lastLinkTo('mdm@acme.test'))!);
    expect((await anon.post('/api/auth/reset-password', { token, password: 'New-Mdm-Pass-1' })).status).toBe(200);
    expect((await old.get('/api/auth/me')).status).toBe(401);
    await login('mdm@acme.test', 'acme', 'New-Mdm-Pass-1');
    // put it back for other tests
    const t2 = (await anon.post('/api/auth/forgot-password', { workspace: 'acme', email: 'mdm@acme.test' }), tokenOf((await lastLinkTo('mdm@acme.test'))!));
    await anon.post('/api/auth/reset-password', { token: t2, password: DEMO_PASSWORD });
  });
});

describe('two-factor authentication', () => {
  test('enrol, sign in with TOTP, sign in with a recovery code', async () => {
    const c = await login('finance@acme.test');
    const setup = await c.post('/api/auth/mfa/setup');
    expect(setup.body.qrDataUrl).toMatch(/^data:image\/png/);
    expect((await c.post('/api/auth/mfa/enable', { code: '000000' })).status).toBe(400);
    const en = await c.post('/api/auth/mfa/enable', { code: generateSync({ secret: setup.body.secret }) });
    expect(en.body.recoveryCodes).toHaveLength(10);

    const c2 = client();
    const step1 = await c2.post('/api/auth/login', { workspace: 'acme', email: 'finance@acme.test', password: DEMO_PASSWORD });
    expect(step1.body.mfaRequired).toBe(true);
    expect((await c2.get('/api/staff/vendors')).status).toBe(401); // half-signed-in session can't do anything
    expect((await c2.post('/api/auth/mfa/verify', { code: '123456' })).status).toBe(401);
    expect((await c2.post('/api/auth/mfa/verify', { code: generateSync({ secret: setup.body.secret }) })).status).toBe(200);
    expect((await c2.get('/api/staff/vendors')).status).toBe(200);

    const c3 = client();
    await c3.post('/api/auth/login', { workspace: 'acme', email: 'finance@acme.test', password: DEMO_PASSWORD });
    const rec = await c3.post('/api/auth/mfa/verify', { code: en.body.recoveryCodes[0] });
    expect(rec.status).toBe(200);
    expect(rec.body.recoveryCodesLeft).toBe(9);
    // recovery code is single-use
    const c4 = client();
    await c4.post('/api/auth/login', { workspace: 'acme', email: 'finance@acme.test', password: DEMO_PASSWORD });
    expect((await c4.post('/api/auth/mfa/verify', { code: en.body.recoveryCodes[0] })).status).toBe(401);

    // admin resets it so later tests can log in with password only
    const admin = await login('admin@acme.test');
    const u = (await admin.get('/api/admin/users')).body.find((x: any) => x.email === 'finance@acme.test');
    await admin.post(`/api/admin/users/${u.id}/reset-mfa`);
  });

  test('workspace-wide MFA requirement blocks work until enrolled', async () => {
    const admin = await login('admin@globex.test', 'globex');
    await admin.patch('/api/admin/tenant', { settings: { requireMfa: true } });
    const blocked = await admin.get('/api/staff/vendors');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('MFA_SETUP_REQUIRED');
    const setup = await admin.post('/api/auth/mfa/setup');
    await admin.post('/api/auth/mfa/enable', { code: generateSync({ secret: setup.body.secret }) });
    expect((await admin.get('/api/staff/vendors')).status).toBe(200);
  });
});
