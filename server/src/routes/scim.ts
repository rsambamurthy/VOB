/**
 * SCIM 2.0 user provisioning (RFC 7643 / 7644) for Microsoft Entra ID, Okta, OneLogin, JumpCloud…
 *
 *   Base URL: <app>/api/scim/v2      Auth: Authorization: Bearer <workspace SCIM token>
 *
 * - Users the identity provider assigns to VendorGate are created here; changes to name / email follow;
 *   deactivation or deletion disables the user and signs them out at once (history and approvals are kept).
 * - Groups are VendorGate roles, matched by name: membership of "Finance Manager" gives that role.
 *   The identity provider can't create or delete roles — they are defined in VendorGate.
 */
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { env } from '../lib/env.js';
import { sha256 } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { revokeUserSessions } from '../auth/session.js';
import { effectiveLimits, trialExpired } from '../lib/plans.js';
import { sendStaffInvite } from '../services/users.js';
import { ssoOf } from '../services/sso.js';
import type { Tenant } from '../db/schema.js';

type User = typeof schema.users.$inferSelect;
const { users, roles, userRoles, tenants } = schema;
const ACTOR = 'SCIM (identity provider)';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';

export const scimBase = () => `${env.appBaseUrl}/api/scim/v2`;
export const scimRouter = Router();
scimRouter.use(express.json({ type: ['application/scim+json', 'application/json'], limit: '1mb' }));

class ScimError extends Error {
  constructor(public status: number, message: string, public scimType?: string) { super(message); }
}
const send = (res: Response, status: number, body: unknown) => res.status(status).type('application/scim+json').send(JSON.stringify(body));
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

/* ---------- Authentication: one bearer token per workspace ---------- */

declare global { namespace Express { interface Request { scimTenant?: Tenant } } }

scimRouter.use((req: Request, _res: Response, next: NextFunction) => { authenticate(req).then(() => next(), next); });
async function authenticate(req: Request) {
  const token = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '')?.[1]?.trim();
  if (!token) throw new ScimError(401, 'Missing bearer token');
  const hash = sha256(token);
  const [tenant] = await db.select().from(tenants).where(sql`${tenants.settings}->'scim'->>'tokenHash' = ${hash}`).limit(1);
  if (!tenant || !tenant.settings.scim?.enabled) throw new ScimError(401, 'Invalid or disabled token');
  if (tenant.status !== 'ACTIVE') throw new ScimError(403, 'This workspace is suspended');
  req.scimTenant = tenant;
  // Remember when the identity provider last called (at most once a minute).
  const last = tenant.settings.scim.lastUsedAt ? Date.parse(tenant.settings.scim.lastUsedAt) : 0;
  if (Date.now() - last > 60_000) {
    await db.update(tenants).set({ settings: sql`jsonb_set(${tenants.settings}, '{scim,lastUsedAt}', to_jsonb(${new Date().toISOString()}::text))` }).where(eq(tenants.id, tenant.id));
  }
}

/* ---------- Discovery ---------- */

scimRouter.get('/ServiceProviderConfig', (_req, res) => send(res, 200, {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
  documentationUri: `${env.appBaseUrl}/staff/admin/sign-in`,
  patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 200 }, changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
  authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'Token from VendorGate → Administration → Sign-in & SSO', primary: true }],
}));
scimRouter.get('/ResourceTypes', (_req, res) => send(res, 200, {
  schemas: [LIST], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: [
    { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: USER },
    { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: GROUP },
  ],
}));
scimRouter.get('/Schemas', (_req, res) => send(res, 200, {
  schemas: [LIST], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: [
    { id: USER, name: 'User', attributes: ['userName', 'name', 'displayName', 'emails', 'active', 'externalId'].map((name) => ({ name })) },
    { id: GROUP, name: 'Group', attributes: ['displayName', 'members'].map((name) => ({ name })) },
  ],
}));

/* ---------- Users ---------- */

const splitName = (n: string) => { const parts = n.trim().split(/\s+/); return { givenName: parts.slice(0, -1).join(' ') || parts[0] || '', familyName: parts.length > 1 ? parts.at(-1)! : '' }; };

async function userResource(tenant: Tenant, u: User) {
  const rs = await db.select({ id: roles.id, name: roles.name }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(eq(userRoles.userId, u.id));
  return {
    schemas: [USER], id: u.id, externalId: u.scimExternalId ?? undefined, userName: u.email,
    name: { ...splitName(u.name), formatted: u.name }, displayName: u.name,
    emails: [{ value: u.email, type: 'work', primary: true }], active: u.status !== 'DISABLED',
    groups: rs.map((r) => ({ value: r.id, display: r.name, $ref: `${scimBase()}/Groups/${r.id}` })),
    meta: { resourceType: 'User', created: u.createdAt?.toISOString?.(), location: `${scimBase()}/Users/${u.id}` },
  };
}

/** Values from a SCIM User body (create / replace). Entra sends booleans as strings ("False"). */
function readUser(body: any) {
  const email = String(body?.userName ?? body?.emails?.find((e: any) => e.primary)?.value ?? body?.emails?.[0]?.value ?? '').trim().toLowerCase();
  const n = body?.name ?? {};
  const name = String(body?.displayName ?? n.formatted ?? [n.givenName, n.familyName].filter(Boolean).join(' ') ?? '').trim();
  return { email, name: name || email, externalId: body?.externalId ? String(body.externalId) : undefined, active: body?.active === undefined ? undefined : bool(body.active) };
}
const bool = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() === 'true' : !!v);
const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

async function findUser(tenant: Tenant, id: string) {
  const u = await db.query.users.findFirst({ where: and(eq(users.id, id), eq(users.tenantId, tenant.id)) });
  if (!u) throw new ScimError(404, `User ${id} not found`);
  return u;
}

/** Simple filters as sent by Entra / Okta: userName eq "x", externalId eq "x", emails.value eq "x" (and "co"/"sw" for userName). */
function parseFilter(filter: string | undefined) {
  if (!filter) return null;
  const m = /^\s*([\w.[\]" ]+?)\s+(eq|co|sw)\s+"([^"]*)"\s*$/i.exec(filter);
  if (!m) throw new ScimError(400, `Unsupported filter: ${filter}`, 'invalidFilter');
  const attr = m[1].replace(/\[.*?\]/g, '').replace(/\s+/g, '').toLowerCase();
  return { attr, op: m[2].toLowerCase(), value: m[3] };
}

scimRouter.get('/Users', wrap(async (req, res) => {
  const tenant = req.scimTenant!;
  const f = parseFilter(req.query.filter as string | undefined);
  let list = await db.select().from(users).where(eq(users.tenantId, tenant.id)).orderBy(asc(users.createdAt));
  if (f) {
    const v = f.value.toLowerCase();
    const pick = (u: User) => (f.attr === 'externalid' ? u.scimExternalId ?? '' : f.attr === 'username' || f.attr === 'emails.value' || f.attr === 'emails' ? u.email : f.attr === 'displayname' ? u.name : null);
    if (list.length && pick(list[0]) === null) throw new ScimError(400, `Filtering on ${f.attr} is not supported`, 'invalidFilter');
    list = list.filter((u) => { const x = String(pick(u) ?? '').toLowerCase(); return f.op === 'eq' ? x === v : f.op === 'sw' ? x.startsWith(v) : x.includes(v); });
  }
  const start = Math.max(1, Number(req.query.startIndex) || 1);
  const count = Math.min(200, Math.max(0, Number(req.query.count ?? 100)));
  const page = list.slice(start - 1, start - 1 + count);
  send(res, 200, { schemas: [LIST], totalResults: list.length, startIndex: start, itemsPerPage: page.length, Resources: await Promise.all(page.map((u) => userResource(tenant, u))) });
}));

scimRouter.get('/Users/:id', wrap(async (req, res) => send(res, 200, await userResource(req.scimTenant!, await findUser(req.scimTenant!, req.params.id)))));

scimRouter.post('/Users', wrap(async (req, res) => {
  const tenant = req.scimTenant!;
  const input = readUser(req.body);
  if (!validEmail(input.email)) throw new ScimError(400, 'userName must be the person’s email address', 'invalidValue');
  const exists = await db.query.users.findFirst({ where: and(eq(users.tenantId, tenant.id), eq(users.email, input.email)) });
  if (exists) throw new ScimError(409, `A user with userName ${input.email} already exists`, 'uniqueness');
  if (trialExpired(tenant)) throw new ScimError(403, 'The workspace trial has ended');
  const max = effectiveLimits(tenant).maxUsers;
  if (max !== null) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(and(eq(users.tenantId, tenant.id), sql`${users.status} <> 'DISABLED'`));
    if (n >= max) throw new ScimError(403, `The workspace plan allows ${max} users`);
  }
  // With single sign-on people sign in straight away; without it they get an invitation to set a password.
  const sso = !!ssoOf(tenant);
  const active = input.active !== false;
  const [u] = await db.insert(users).values({ tenantId: tenant.id, email: input.email, name: input.name, scimExternalId: input.externalId ?? null, status: !active ? 'DISABLED' : sso ? 'ACTIVE' : 'INVITED' }).returning();
  const roleId = tenant.settings.scim?.defaultRoleId;
  if (roleId && await db.query.roles.findFirst({ where: and(eq(roles.id, roleId), eq(roles.tenantId, tenant.id)) })) await db.insert(userRoles).values({ userId: u.id, roleId }).onConflictDoNothing();
  if (active && !sso) await sendStaffInvite(tenant, u, ACTOR);
  await audit({ tenantId: tenant.id, actor: ACTOR, action: 'SCIM_USER_CREATED', detail: { email: u.email, active } });
  send(res, 201, await userResource(tenant, u));
}));

/** Apply attribute changes; returns what changed for the audit log. */
async function applyUser(tenant: Tenant, u: User, changes: { email?: string; name?: string; externalId?: string | null; active?: boolean }) {
  const set: Partial<User> = {};
  if (changes.email !== undefined && changes.email !== u.email) {
    if (!validEmail(changes.email)) throw new ScimError(400, 'userName must be an email address', 'invalidValue');
    const clash = await db.query.users.findFirst({ where: and(eq(users.tenantId, tenant.id), eq(users.email, changes.email)) });
    if (clash && clash.id !== u.id) throw new ScimError(409, `A user with userName ${changes.email} already exists`, 'uniqueness');
    set.email = changes.email;
  }
  if (changes.name !== undefined && changes.name && changes.name !== u.name) set.name = changes.name;
  if (changes.externalId !== undefined && changes.externalId !== u.scimExternalId) set.scimExternalId = changes.externalId;
  if (changes.active === false && u.status !== 'DISABLED') set.status = 'DISABLED';
  if (changes.active === true && u.status === 'DISABLED') set.status = u.passwordHash || ssoOf(tenant) ? 'ACTIVE' : 'INVITED';
  if (!Object.keys(set).length) return u;
  const [next] = await db.update(users).set(set).where(eq(users.id, u.id)).returning();
  if (set.status === 'DISABLED') {
    await revokeUserSessions(u.id);
    await audit({ tenantId: tenant.id, actor: ACTOR, action: 'SCIM_USER_DISABLED', detail: { email: next.email } });
  } else {
    await audit({ tenantId: tenant.id, actor: ACTOR, action: 'SCIM_USER_UPDATED', detail: { email: next.email, changed: Object.keys(set).join(', ') } });
  }
  return next;
}

scimRouter.put('/Users/:id', wrap(async (req, res) => {
  const tenant = req.scimTenant!;
  const input = readUser(req.body);
  const u = await applyUser(tenant, await findUser(tenant, req.params.id), { email: input.email || undefined, name: input.name, externalId: input.externalId ?? null, active: input.active ?? true });
  send(res, 200, await userResource(tenant, u));
}));

scimRouter.patch('/Users/:id', wrap(async (req, res) => {
  const tenant = req.scimTenant!;
  let u = await findUser(tenant, req.params.id);
  const ops: any[] = req.body?.Operations ?? [];
  if (!Array.isArray(ops) || !ops.length) throw new ScimError(400, 'No Operations', 'invalidSyntax');
  const changes: { email?: string; name?: string; externalId?: string | null; active?: boolean } = {};
  const given = { givenName: undefined as string | undefined, familyName: undefined as string | undefined };
  const apply = (path: string, value: any) => {
    const p = path.replace(/\[.*?\]/g, '').toLowerCase();
    if (p === 'active') changes.active = bool(value);
    else if (p === 'username' || p === 'emails' || p === 'emails.value') changes.email = String(Array.isArray(value) ? value[0]?.value : value?.value ?? value).trim().toLowerCase();
    else if (p === 'displayname' || p === 'name.formatted') changes.name = String(value).trim();
    else if (p === 'name.givenname') given.givenName = String(value).trim();
    else if (p === 'name.familyname') given.familyName = String(value).trim();
    else if (p === 'name' && value && typeof value === 'object') { given.givenName = value.givenName ?? given.givenName; given.familyName = value.familyName ?? given.familyName; }
    else if (p === 'externalid') changes.externalId = value ? String(value) : null;
    // Other attributes (title, phone numbers, enterprise extension…) are not kept by VendorGate: ignored.
  };
  for (const op of ops) {
    const kind = String(op.op ?? '').toLowerCase();
    if (!['add', 'replace', 'remove'].includes(kind)) throw new ScimError(400, `Unsupported op ${op.op}`, 'invalidSyntax');
    if (kind === 'remove') { if (String(op.path ?? '').toLowerCase() === 'externalid') changes.externalId = null; continue; }
    if (op.path) apply(String(op.path), op.value);
    else if (op.value && typeof op.value === 'object') for (const [k, v] of Object.entries(op.value)) apply(k, v);
  }
  if ((given.givenName !== undefined || given.familyName !== undefined) && changes.name === undefined) {
    const cur = splitName(u.name);
    changes.name = [given.givenName ?? cur.givenName, given.familyName ?? cur.familyName].filter(Boolean).join(' ');
  }
  u = await applyUser(tenant, u, changes);
  send(res, 200, await userResource(tenant, u));
}));

/** Deleting in the identity provider disables here: the person's approvals and audit history stay intact. */
scimRouter.delete('/Users/:id', wrap(async (req, res) => {
  const tenant = req.scimTenant!;
  await applyUser(tenant, await findUser(tenant, req.params.id), { active: false });
  res.status(204).end();
}));

/* ---------- Groups = VendorGate roles ---------- */

async function groupResource(tenant: Tenant, role: { id: string; name: string }, withMembers = true) {
  const members = withMembers ? await db.select({ id: users.id, email: users.email }).from(userRoles).innerJoin(users, eq(users.id, userRoles.userId)).where(eq(userRoles.roleId, role.id)) : [];
  return { schemas: [GROUP], id: role.id, displayName: role.name, members: members.map((m) => ({ value: m.id, display: m.email, $ref: `${scimBase()}/Users/${m.id}` })), meta: { resourceType: 'Group', location: `${scimBase()}/Groups/${role.id}` } };
}
async function findRole(tenant: Tenant, id: string) {
  const r = await db.query.roles.findFirst({ where: and(eq(roles.id, id), eq(roles.tenantId, tenant.id)) });
  if (!r) throw new ScimError(404, `Group ${id} not found`);
  return r;
}
async function setMembers(tenant: Tenant, role: { id: string; name: string }, add: string[], remove: string[] | 'all') {
  const valid = add.length ? (await db.select({ id: users.id }).from(users).where(and(eq(users.tenantId, tenant.id), inArray(users.id, add)))).map((x) => x.id) : [];
  if (remove === 'all') await db.delete(userRoles).where(eq(userRoles.roleId, role.id));
  else if (remove.length) await db.delete(userRoles).where(and(eq(userRoles.roleId, role.id), inArray(userRoles.userId, remove)));
  if (valid.length) await db.insert(userRoles).values(valid.map((userId) => ({ userId, roleId: role.id }))).onConflictDoNothing();
  // A change of roles takes effect on the next request (permissions are read per request).
  if (valid.length || remove === 'all' || remove.length) await audit({ tenantId: tenant.id, actor: ACTOR, action: 'SCIM_ROLES_CHANGED', detail: { role: role.name, added: valid.length, removed: remove === 'all' ? 'all' : remove.length } });
}

scimRouter.get('/Groups', wrap(async (req, res) => {
  const tenant = req.scimTenant!;
  const f = parseFilter(req.query.filter as string | undefined);
  let list = await db.select({ id: roles.id, name: roles.name }).from(roles).where(eq(roles.tenantId, tenant.id)).orderBy(asc(roles.name));
  if (f) {
    if (f.attr !== 'displayname' && f.attr !== 'id') throw new ScimError(400, `Filtering on ${f.attr} is not supported`, 'invalidFilter');
    list = list.filter((r) => (f.attr === 'id' ? r.id === f.value : r.name.toLowerCase() === f.value.toLowerCase()));
  }
  const withMembers = !String(req.query.excludedAttributes ?? '').includes('members');
  send(res, 200, { schemas: [LIST], totalResults: list.length, startIndex: 1, itemsPerPage: list.length, Resources: await Promise.all(list.map((r) => groupResource(tenant, r, withMembers))) });
}));
scimRouter.get('/Groups/:id', wrap(async (req, res) => send(res, 200, await groupResource(req.scimTenant!, await findRole(req.scimTenant!, req.params.id)))));

/** "Creating" a group links it to the VendorGate role of the same name; roles themselves are defined in VendorGate. */
scimRouter.post('/Groups', wrap(async (req, res) => {
  const tenant = req.scimTenant!;
  const name = String(req.body?.displayName ?? '').trim();
  const role = (await db.select({ id: roles.id, name: roles.name }).from(roles).where(eq(roles.tenantId, tenant.id))).find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (!role) throw new ScimError(400, `VendorGate has no role named "${name}". Create the role in VendorGate (Administration → Roles) or rename the group to match one.`, 'invalidValue');
  const ids = (req.body?.members ?? []).map((m: any) => String(m.value));
  if (ids.length) await setMembers(tenant, role, ids, []);
  send(res, 201, await groupResource(tenant, role));
}));

scimRouter.put('/Groups/:id', wrap(async (req, res) => {
  const tenant = req.scimTenant!;
  const role = await findRole(tenant, req.params.id);
  await setMembers(tenant, role, (req.body?.members ?? []).map((m: any) => String(m.value)), 'all');
  send(res, 200, await groupResource(tenant, role));
}));

scimRouter.patch('/Groups/:id', wrap(async (req, res) => {
  const tenant = req.scimTenant!;
  const role = await findRole(tenant, req.params.id);
  for (const op of req.body?.Operations ?? []) {
    const kind = String(op.op ?? '').toLowerCase();
    const path = String(op.path ?? '');
    const values: string[] = (Array.isArray(op.value) ? op.value : op.value?.members ?? (op.value ? [op.value] : [])).map((m: any) => String(m?.value ?? m));
    const filtered = /members\[value eq "([^"]+)"\]/i.exec(path)?.[1];
    if (kind === 'add') await setMembers(tenant, role, values, []);
    else if (kind === 'remove') await setMembers(tenant, role, [], filtered ? [filtered] : values.length ? values : 'all');
    else if (kind === 'replace' && (/^members$/i.test(path) || op.value?.members)) await setMembers(tenant, role, values, 'all');
    // replace displayName: VendorGate role names are changed in VendorGate, not by the identity provider.
  }
  send(res, 200, await groupResource(tenant, role));
}));

/** Unlinking a group in the identity provider leaves the role (and its people) in VendorGate. */
scimRouter.delete('/Groups/:id', wrap(async (req, res) => { await findRole(req.scimTenant!, req.params.id); res.status(204).end(); }));

/* ---------- Errors in SCIM's format ---------- */

scimRouter.use((_req: Request, _res: Response, next: NextFunction) => next(new ScimError(404, 'Unknown SCIM endpoint')));
scimRouter.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof ScimError ? err.status : err?.type === 'entity.parse.failed' ? 400 : 500;
  send(res, status, { schemas: [ERROR], status: String(status), ...(err?.scimType ? { scimType: err.scimType } : {}), detail: status === 500 ? 'Internal error' : String(err?.message ?? err) });
});
