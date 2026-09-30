import { describe, expect, test } from 'vitest';
import { login } from './helpers.js';

describe('role-based permissions', () => {
  test('reviewers cannot create vendors or manage users', async () => {
    const tax = await login('tax@acme.test');
    expect((await tax.post('/api/staff/vendors', { name: 'X Co', vendorType: 'DOMESTIC', contactFirstName: 'a', contactLastName: 'b', contactEmail: 'a@b.test', contactMobile: '9800000000' })).status).toBe(403);
    expect((await tax.get('/api/admin/users')).status).toBe(403);
    expect((await tax.patch('/api/admin/tenant', { name: 'Hacked' })).status).toBe(403);
    expect((await tax.get('/api/staff/vendors')).status).toBe(200);
  });

  test('vendor admin can create vendors but not export to ERP', async () => {
    const va = await login('vendoradmin@acme.test');
    const list = (await va.get('/api/staff/vendors')).body.vendors;
    const approved = list.find((v: any) => v.status === 'APPROVED');
    expect((await va.get(`/api/staff/vendors/${approved.id}/erp-export`)).status).toBe(403);
    const mdm = await login('mdm@acme.test');
    expect((await mdm.get(`/api/staff/vendors/${approved.id}/erp-export`)).status).toBe(200);
  });

  test('only the role assigned to the pending level can act on it', async () => {
    const list = (await (await login('admin@acme.test')).get('/api/staff/vendors?status=UNDER_REVIEW')).body.vendors;
    const kaveri = list.find((v: any) => v.name.startsWith('Kaveri'));
    const tax = await login('tax@acme.test');
    const r = await tax.post(`/api/staff/vendors/${kaveri.id}/decision`, { action: 'APPROVE' });
    expect(r.status).toBe(403);
    const queue = (await (await login('finance@acme.test')).get('/api/staff/vendors?mine=true')).body;
    expect(queue.vendors.map((v: any) => v.id)).toContain(kaveri.id);
  });

  test('custom roles: create, assign, and guard rails', async () => {
    const admin = await login('admin@acme.test');
    const created = await admin.post('/api/admin/roles', { name: 'Compliance Officer', description: 'Extra checks', permissions: ['vendors.view', 'audit.view'] });
    expect(created.status).toBe(201);
    expect((await admin.post('/api/admin/roles', { name: 'compliance officer', permissions: [] })).status).toBe(409);
    expect((await admin.post('/api/admin/roles', { name: 'Bad', permissions: ['root.everything'] })).status).toBe(400);

    const { roles } = (await admin.get('/api/admin/roles')).body;
    const adminRole = roles.find((r: any) => r.key === 'ADMIN');
    expect((await admin.patch(`/api/admin/roles/${adminRole.id}`, { permissions: ['vendors.view'] })).status).toBe(409);
    expect((await admin.del(`/api/admin/roles/${adminRole.id}`)).status).toBe(409);

    const me = (await admin.get('/api/auth/me')).body.user;
    expect((await admin.patch(`/api/admin/users/${me.id}`, { roleIds: [created.body.id] })).status).toBe(409); // last admin
    expect((await admin.patch(`/api/admin/users/${me.id}`, { status: 'DISABLED' })).status).toBe(409);
    expect((await admin.del(`/api/admin/roles/${created.body.id}`)).status).toBe(200);
  });

  test('disabling a user ends their sessions', async () => {
    const admin = await login('admin@acme.test');
    const viewer = await login('vendoradmin@acme.test');
    const u = (await admin.get('/api/admin/users')).body.find((x: any) => x.email === 'vendoradmin@acme.test');
    await admin.patch(`/api/admin/users/${u.id}`, { status: 'DISABLED' });
    expect((await viewer.get('/api/auth/me')).status).toBe(401);
    await admin.patch(`/api/admin/users/${u.id}`, { status: 'ACTIVE' });
  });

  test('audit log records security events', async () => {
    const admin = await login('admin@acme.test');
    const { rows } = (await admin.get('/api/admin/audit')).body;
    expect(rows.some((r: any) => r.action === 'LOGIN')).toBe(true);
    expect((await (await login('tax@acme.test')).get('/api/admin/audit')).status).toBe(403);
  });
});
