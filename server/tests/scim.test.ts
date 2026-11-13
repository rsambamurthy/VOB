/** SCIM 2.0 provisioning, as Microsoft Entra ID and Okta call it. */
import { afterAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { app, client, lastLinkTo, login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';

let token = '';
const scim = {
  get: (url: string, t = token) => request(app).get(`/api/scim/v2${url}`).set('Authorization', `Bearer ${t}`),
  post: (url: string, body: object) => request(app).post(`/api/scim/v2${url}`).set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/scim+json').send(JSON.stringify(body)),
  put: (url: string, body: object) => request(app).put(`/api/scim/v2${url}`).set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/scim+json').send(JSON.stringify(body)),
  patch: (url: string, body: object) => request(app).patch(`/api/scim/v2${url}`).set('Authorization', `Bearer ${token}`).set('Content-Type', 'application/scim+json').send(JSON.stringify(body)),
  del: (url: string) => request(app).delete(`/api/scim/v2${url}`).set('Authorization', `Bearer ${token}`),
};
const patchOp = (Operations: object[]) => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations });

afterAll(async () => {
  // Other test files sign in as tax@acme.test: put things back.
  const t = await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') });
  if (t) await db.update(schema.tenants).set({ settings: { ...t.settings, scim: undefined } }).where(eq(schema.tenants.id, t.id));
  if (t) await db.update(schema.users).set({ status: 'ACTIVE', name: 'Suresh Iyer' }).where(and(eq(schema.users.tenantId, t.id), eq(schema.users.email, 'tax@acme.test')));
});

describe('SCIM provisioning', () => {
  test('admin turns it on and gets a token shown once; calls without it are refused', async () => {
    const admin = await login('admin@acme.test');
    const roles = (await admin.get('/api/admin/sso')).body.roles as { id: string; name: string }[];
    const viewer = roles.find((r) => /view/i.test(r.name))!;
    const r = await admin.post('/api/admin/scim/token');
    expect(r.body.token).toMatch(/^vgscim_/);
    expect(r.body.baseUrl).toBe('http://app.test/api/scim/v2');
    token = r.body.token;
    expect((await admin.put('/api/admin/scim', { enabled: true, defaultRoleId: viewer.id })).body).toMatchObject({ enabled: true, hasToken: true, defaultRoleId: viewer.id });
    expect((await admin.get('/api/admin/scim')).body.token).toBeUndefined();

    expect((await scim.get('/ServiceProviderConfig')).body.patch.supported).toBe(true);
    expect((await request(app).get('/api/scim/v2/Users')).status).toBe(401);
    const bad = await scim.get('/Users', 'vgscim_wrong');
    expect(bad.status).toBe(401);
    expect(bad.body.schemas).toEqual(['urn:ietf:params:scim:api:messages:2.0:Error']);
    expect((await admin.get('/api/admin/scim')).body.lastUsedAt).toBeTruthy();
  });

  test('Entra creates a user: invited (no SSO yet) with the default role; duplicates are refused', async () => {
    const empty = await scim.get('/Users?filter=' + encodeURIComponent('userName eq "priya.nair@acme.test"'));
    expect(empty.body).toMatchObject({ totalResults: 0, Resources: [] });
    const created = await scim.post('/Users', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User', 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'],
      externalId: 'aad-123', userName: 'Priya.Nair@acme.test', active: true, displayName: 'Priya Nair',
      name: { givenName: 'Priya', familyName: 'Nair' }, emails: [{ primary: true, type: 'work', value: 'Priya.Nair@acme.test' }],
      'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { department: 'Finance' },
    });
    expect(created.status).toBe(201);
    expect(created.headers['content-type']).toMatch(/application\/scim\+json/);
    expect(created.body).toMatchObject({ userName: 'priya.nair@acme.test', externalId: 'aad-123', active: true, displayName: 'Priya Nair' });
    expect(created.body.groups.map((g: any) => g.display)).toEqual(['Viewer']);
    expect(await lastLinkTo('priya.nair@acme.test')).toMatch(/accept-invite/);
    const dup = await scim.post('/Users', { userName: 'priya.nair@acme.test' });
    expect(dup.status).toBe(409);
    expect(dup.body.scimType).toBe('uniqueness');
    const found = await scim.get('/Users?filter=' + encodeURIComponent('externalId eq "aad-123"'));
    expect(found.body.Resources[0].id).toBe(created.body.id);
  });

  test('Entra updates and deactivates (booleans as text): the person is signed out at once', async () => {
    const tax = await login('tax@acme.test');
    expect((await tax.get('/api/auth/me')).status).toBe(200);
    const id = (await scim.get('/Users?filter=' + encodeURIComponent('userName eq "tax@acme.test"'))).body.Resources[0].id;

    const renamed = await scim.patch(`/Users/${id}`, patchOp([{ op: 'Replace', path: 'name.givenName', value: 'Suresh K' }, { op: 'Add', path: 'externalId', value: 'aad-tax' }]));
    expect(renamed.body).toMatchObject({ displayName: 'Suresh K Iyer', externalId: 'aad-tax' });

    const off = await scim.patch(`/Users/${id}`, patchOp([{ op: 'Replace', path: 'active', value: 'False' }]));
    expect(off.body.active).toBe(false);
    expect((await tax.get('/api/auth/me')).status).toBe(401);
    expect((await client().post('/api/auth/login', { workspace: 'acme', email: 'tax@acme.test', password: 'Demo@12345' })).status).toBe(403);

    const on = await scim.patch(`/Users/${id}`, patchOp([{ op: 'replace', value: { active: true } }]));
    expect(on.body.active).toBe(true);
    expect((await client().post('/api/auth/login', { workspace: 'acme', email: 'tax@acme.test', password: 'Demo@12345' })).status).toBe(200);
  });

  test('Okta replaces a user with PUT, and DELETE disables (history kept)', async () => {
    const created = (await scim.post('/Users', { userName: 'okta.user@acme.test', name: { givenName: 'Okta', familyName: 'User' }, active: true })).body;
    const put = await scim.put(`/Users/${created.id}`, { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'okta.user2@acme.test', name: { givenName: 'Okta', familyName: 'Person' }, active: true });
    expect(put.body).toMatchObject({ userName: 'okta.user2@acme.test', displayName: 'Okta Person', active: true });
    expect((await scim.del(`/Users/${created.id}`)).status).toBe(204);
    expect((await scim.get(`/Users/${created.id}`)).body.active).toBe(false);
    expect((await scim.get('/Users/does-not-exist')).status).toBe(404);
  });

  test('groups are roles, matched by name; membership gives and takes the role', async () => {
    const g = (await scim.get('/Groups?filter=' + encodeURIComponent('displayName eq "Finance Manager"'))).body;
    expect(g.totalResults).toBe(1);
    const groupId = g.Resources[0].id;
    expect((await scim.post('/Groups', { displayName: 'Marketing' })).status).toBe(400);
    const linked = await scim.post('/Groups', { displayName: 'finance manager', members: [] });
    expect(linked.status).toBe(201);
    expect(linked.body.id).toBe(groupId);

    const priya = (await scim.get('/Users?filter=' + encodeURIComponent('userName eq "priya.nair@acme.test"'))).body.Resources[0];
    await scim.patch(`/Groups/${groupId}`, patchOp([{ op: 'Add', path: 'members', value: [{ value: priya.id }] }]));
    expect((await scim.get(`/Users/${priya.id}`)).body.groups.map((x: any) => x.display).sort()).toEqual(['Finance Manager', 'Viewer']);
    await scim.patch(`/Groups/${groupId}`, patchOp([{ op: 'Remove', path: `members[value eq "${priya.id}"]` }]));
    expect((await scim.get(`/Users/${priya.id}`)).body.groups.map((x: any) => x.display)).toEqual(['Viewer']);

    const admin = await login('admin@acme.test');
    const actions = (await admin.get('/api/admin/audit')).body.rows.map((r: any) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['SCIM_USER_CREATED', 'SCIM_USER_DISABLED', 'SCIM_ROLES_CHANGED', 'SCIM_TOKEN_CREATED']));
  });

  test('a new token replaces the old one; switching off stops all calls', async () => {
    const admin = await login('admin@acme.test');
    const old = token;
    token = (await admin.post('/api/admin/scim/token')).body.token;
    expect((await scim.get('/Users', old)).status).toBe(401);
    expect((await scim.get('/Users')).status).toBe(200);
    await admin.put('/api/admin/scim', { enabled: false });
    expect((await scim.get('/Users')).status).toBe(401);
  });
});
