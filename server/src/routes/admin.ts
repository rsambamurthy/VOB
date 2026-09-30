/** Workspace administration: users, roles, workspace settings, audit log. */
import { Router } from 'express';
import { z } from 'zod';
import { and, asc, count, desc, eq, inArray, ne } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { requireStaff, revokeUserSessions, staffCtx } from '../auth/session.js';
import { ALL_PERMISSIONS, PERMISSIONS } from '../lib/permissions.js';
import { audit } from '../lib/audit.js';
import { createStaffUser, sendStaffInvite } from '../services/users.js';

const { users, roles, userRoles, auditLogs, tenants, approvalSteps } = schema;
export const adminRouter = Router();

/* ---------- Users ---------- */

adminRouter.get('/users', requireStaff('users.manage'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  const list = await db.query.users.findMany({
    where: eq(users.tenantId, tenant.id), orderBy: asc(users.name),
    columns: { id: true, name: true, email: true, status: true, mfaEnabled: true, lastLoginAt: true, createdAt: true, lockedUntil: true },
    with: { userRoles: { with: { role: { columns: { id: true, name: true, key: true } } } } },
  });
  res.json(list.map(({ userRoles: ur, ...u }) => ({ ...u, locked: !!u.lockedUntil && u.lockedUntil > new Date(), roles: ur.map((x) => x.role) })));
}));

adminRouter.post('/users', requireStaff('users.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const input = z.object({ name: z.string().min(2).max(100), email: z.string().email(), roleIds: z.array(z.string()).min(1, 'Pick at least one role') }).parse(req.body);
  const { user, inviteLink } = await createStaffUser(s.tenant, input, s.user.name);
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'USER_INVITED', detail: { email: user.email }, ip: req.ip });
  res.status(201).json({ id: user.id, inviteLink });
}));

async function loadUser(tenantId: string, id: string) {
  const u = await db.query.users.findFirst({ where: and(eq(users.tenantId, tenantId), eq(users.id, id)) });
  if (!u) throw new HttpError(404, 'User not found');
  return u;
}

/** Guard: never leave a workspace without an active administrator. */
async function assertNotLastAdmin(tenantId: string, userId: string) {
  const admin = await db.query.roles.findFirst({ where: and(eq(roles.tenantId, tenantId), eq(roles.key, 'ADMIN')) });
  if (!admin) return;
  const others = await db.select({ n: count() }).from(userRoles).innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.roleId, admin.id), eq(users.status, 'ACTIVE'), ne(users.id, userId)));
  if (others[0].n === 0) throw new HttpError(409, 'This is the last active Administrator. Make someone else an Administrator first.');
}

adminRouter.patch('/users/:id', requireStaff('users.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const u = await loadUser(s.tenant.id, req.params.id);
  const input = z.object({ name: z.string().min(2).max(100).optional(), roleIds: z.array(z.string()).optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional() }).parse(req.body);

  if (input.roleIds) {
    const valid = input.roleIds.length ? await db.select({ id: roles.id, key: roles.key }).from(roles).where(and(eq(roles.tenantId, s.tenant.id), inArray(roles.id, input.roleIds))) : [];
    if (valid.length !== input.roleIds.length) throw new HttpError(400, 'One or more roles are invalid');
    if (!valid.some((r) => r.key === 'ADMIN')) await assertNotLastAdmin(s.tenant.id, u.id);
    await db.transaction(async (tx) => {
      await tx.delete(userRoles).where(eq(userRoles.userId, u.id));
      if (input.roleIds!.length) await tx.insert(userRoles).values(input.roleIds!.map((roleId) => ({ userId: u.id, roleId })));
    });
  }
  if (input.status) {
    if (u.status === 'INVITED' && input.status === 'ACTIVE') throw new HttpError(409, 'This user hasn’t accepted their invitation yet');
    if (input.status === 'DISABLED') {
      if (u.id === s.user.id) throw new HttpError(409, 'You can’t disable your own account');
      await assertNotLastAdmin(s.tenant.id, u.id);
      await revokeUserSessions(u.id);
    }
  }
  await db.update(users).set({ ...(input.name ? { name: input.name } : {}), ...(input.status && u.status !== 'INVITED' ? { status: input.status } : {}) }).where(eq(users.id, u.id));
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'USER_UPDATED', detail: { email: u.email, ...input }, ip: req.ip });
  res.json({ ok: true });
}));

adminRouter.post('/users/:id/resend-invite', requireStaff('users.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const u = await loadUser(s.tenant.id, req.params.id);
  if (u.status !== 'INVITED') throw new HttpError(409, 'This user has already joined');
  const inviteLink = await sendStaffInvite(s.tenant, u, s.user.name);
  res.json({ inviteLink });
}));

adminRouter.post('/users/:id/reset-mfa', requireStaff('users.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const u = await loadUser(s.tenant.id, req.params.id);
  await db.update(users).set({ mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryHashes: [] }).where(eq(users.id, u.id));
  await revokeUserSessions(u.id);
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'USER_MFA_RESET', detail: { email: u.email }, ip: req.ip });
  res.json({ ok: true });
}));

adminRouter.post('/users/:id/unlock', requireStaff('users.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const u = await loadUser(s.tenant.id, req.params.id);
  await db.update(users).set({ failedLogins: 0, lockedUntil: null }).where(eq(users.id, u.id));
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'USER_UNLOCKED', detail: { email: u.email }, ip: req.ip });
  res.json({ ok: true });
}));

/* ---------- Roles ---------- */

adminRouter.get('/roles', requireStaff('users.manage'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  const list = await db.select().from(roles).where(eq(roles.tenantId, tenant.id)).orderBy(asc(roles.createdAt));
  const counts = await db.select({ roleId: userRoles.roleId, n: count() }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(eq(roles.tenantId, tenant.id)).groupBy(userRoles.roleId);
  res.json({ roles: list.map((r) => ({ ...r, userCount: counts.find((c) => c.roleId === r.id)?.n ?? 0 })), permissions: PERMISSIONS });
}));

const roleInput = z.object({
  name: z.string().min(2).max(60),
  description: z.string().max(200).optional(),
  permissions: z.array(z.enum(ALL_PERMISSIONS as [string, ...string[]])),
});

adminRouter.post('/roles', requireStaff('users.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const input = roleInput.parse(req.body);
  const key = input.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'ROLE';
  if (await db.query.roles.findFirst({ where: and(eq(roles.tenantId, s.tenant.id), eq(roles.key, key)) })) throw new HttpError(409, 'A role with a similar name already exists');
  const [role] = await db.insert(roles).values({ tenantId: s.tenant.id, key, ...input }).returning();
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'ROLE_CREATED', detail: { name: role.name }, ip: req.ip });
  res.status(201).json(role);
}));

adminRouter.patch('/roles/:id', requireStaff('users.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const role = await db.query.roles.findFirst({ where: and(eq(roles.tenantId, s.tenant.id), eq(roles.id, req.params.id)) });
  if (!role) throw new HttpError(404, 'Role not found');
  const input = roleInput.partial().parse(req.body);
  if (role.key === 'ADMIN' && input.permissions && input.permissions.length !== ALL_PERMISSIONS.length) throw new HttpError(409, 'The Administrator role always has every permission');
  await db.update(roles).set(input).where(eq(roles.id, role.id));
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'ROLE_UPDATED', detail: { name: role.name, ...input }, ip: req.ip });
  res.json({ ok: true });
}));

adminRouter.delete('/roles/:id', requireStaff('users.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const role = await db.query.roles.findFirst({ where: and(eq(roles.tenantId, s.tenant.id), eq(roles.id, req.params.id)) });
  if (!role) throw new HttpError(404, 'Role not found');
  if (role.isSystem) throw new HttpError(409, 'The Administrator role can’t be deleted');
  const [{ n: members }] = await db.select({ n: count() }).from(userRoles).where(eq(userRoles.roleId, role.id));
  if (members > 0) throw new HttpError(409, `Remove this role from its ${members} user(s) first`);
  const [{ n: steps }] = await db.select({ n: count() }).from(approvalSteps).where(eq(approvalSteps.roleId, role.id));
  if (steps > 0) throw new HttpError(409, 'This role has approval history and can’t be deleted. Rename it instead.');
  await db.delete(roles).where(eq(roles.id, role.id));
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'ROLE_DELETED', detail: { name: role.name }, ip: req.ip });
  res.json({ ok: true });
}));

/* ---------- Workspace settings ---------- */

adminRouter.patch('/tenant', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const input = z.object({
    name: z.string().min(2).max(100).optional(),
    branding: z.object({
      productName: z.string().max(40).optional(),
      primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a hex value like #6d1a73').optional(),
      logoUrl: z.string().url().max(500).optional().or(z.literal('')),
    }).optional(),
    settings: z.object({ requireMfa: z.boolean().optional(), sessionHours: z.number().int().min(1).max(72).optional() }).optional(),
  }).parse(req.body);
  await db.update(tenants).set({
    ...(input.name ? { name: input.name } : {}),
    ...(input.branding ? { branding: { ...s.tenant.branding, ...input.branding } } : {}),
    ...(input.settings ? { settings: { ...s.tenant.settings, ...input.settings } } : {}),
  }).where(eq(tenants.id, s.tenant.id));
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'WORKSPACE_SETTINGS_UPDATED', detail: input, ip: req.ip });
  res.json({ ok: true });
}));

/* ---------- Audit log ---------- */

adminRouter.get('/audit', requireStaff('audit.view'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = 50;
  const rows = await db.select().from(auditLogs).where(eq(auditLogs.tenantId, tenant.id)).orderBy(desc(auditLogs.createdAt)).limit(size + 1).offset((page - 1) * size);
  res.json({ rows: rows.slice(0, size), hasMore: rows.length > size, page });
}));
