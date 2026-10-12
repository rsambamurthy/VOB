/**
 * Platform console API (/api/platform): sign-in for platform admins and everything they can do across tenants —
 * create, suspend and reactivate workspaces, change plans and limits, open read-only support access, manage
 * sign-up settings and other platform admins. Every change is written to platform_audit.
 */
import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { generateSecret, generateURI } from 'otplib';
import { and, count, desc, eq, gte, ilike, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { checkPassword, hashPassword, passwordProblem } from '../lib/password.js';
import { encrypt, randomToken, sha256 } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';
import { loginLimiter, sensitiveLimiter } from '../lib/rateLimits.js';
import { createSession } from '../auth/session.js';
import { createTenant, slugProblem } from '../services/tenants.js';
import { sendStaffInvite } from '../services/users.js';
import { assertCanAddUser, startOfDay, usage } from '../services/limits.js';
import { effectiveLimits, FEATURE_LABELS, PLAN_KEYS, PLANS } from '../lib/plans.js';
import { adminByToken, createPlatformSession, destroyPlatformSession, issuePlatformToken, platformCtx, platformLog, requirePlatform, verifyTotp } from './session.js';
import { getPlatformSettings } from './settings.js';

const { platformAdmins, platformSessions, tenants, users, userRoles, roles, vendors, emailOutbox, auditLogs, sessions, signups, platformAudit, platformSettings } = schema;
export const platformRouter = Router();

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', 12);
const DAY = 86_400_000;

const adminView = (a: typeof platformAdmins.$inferSelect) => ({ id: a.id, name: a.name, email: a.email, status: a.status, mfaEnabled: a.mfaEnabled, lastLoginAt: a.lastLoginAt, createdAt: a.createdAt });

/* ================= Sign-in ================= */

platformRouter.post('/auth/login', loginLimiter, ah(async (req, res) => {
  const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const generic = new HttpError(401, 'Email or password is incorrect');
  const a = await db.query.platformAdmins.findFirst({ where: eq(platformAdmins.email, email.trim().toLowerCase()) });
  const ok = await checkPassword(password, a?.passwordHash ?? DUMMY_HASH);
  if (!a || !a.passwordHash || a.status === 'DISABLED') throw generic;
  if (a.lockedUntil && a.lockedUntil > new Date()) throw new HttpError(429, `Too many failed attempts. Try again after ${LOCK_MINUTES} minutes.`);
  if (!ok) {
    const failed = a.failedLogins + 1;
    await db.update(platformAdmins).set({ failedLogins: failed, lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null }).where(eq(platformAdmins.id, a.id));
    await platformLog({ actor: a.email, action: failed >= MAX_FAILED ? 'LOGIN_LOCKED' : 'LOGIN_FAILED', ip: req.ip });
    throw generic;
  }
  await db.update(platformAdmins).set({ failedLogins: 0, lockedUntil: null }).where(eq(platformAdmins.id, a.id));
  await createPlatformSession(req, res, a.id, a.mfaEnabled);
  if (!a.mfaEnabled) await platformLog({ actor: a.email, action: 'LOGIN_BEFORE_2FA_SETUP', ip: req.ip });
  res.json({ mfaRequired: a.mfaEnabled, mfaSetupRequired: !a.mfaEnabled });
}));

platformRouter.post('/auth/mfa/verify', loginLimiter, ah(async (req, res) => {
  const p = req.platform;
  if (!p?.mfaPending) throw new HttpError(400, 'No two-factor check is pending. Sign in again.');
  const clean = z.object({ code: z.string().min(6).max(20) }).parse(req.body).code.replace(/\s|-/g, '');
  let ok = verifyTotp(p.admin.mfaSecretEnc, clean), usedRecovery = false;
  if (!ok) {
    const h = sha256(clean.toUpperCase());
    if (p.admin.mfaRecoveryHashes.includes(h)) {
      ok = usedRecovery = true;
      await db.update(platformAdmins).set({ mfaRecoveryHashes: p.admin.mfaRecoveryHashes.filter((x) => x !== h) }).where(eq(platformAdmins.id, p.admin.id));
    }
  }
  if (!ok) { await platformLog({ actor: p.admin.email, action: 'MFA_FAILED', ip: req.ip }); throw new HttpError(401, 'That code is not valid'); }
  await destroyPlatformSession(res, p.sessionId);
  await createPlatformSession(req, res, p.admin.id, false);
  await db.update(platformAdmins).set({ lastLoginAt: new Date() }).where(eq(platformAdmins.id, p.admin.id));
  await platformLog({ actor: p.admin.email, action: usedRecovery ? 'LOGIN_RECOVERY_CODE' : 'LOGIN', ip: req.ip });
  res.json({ ok: true, recoveryCodesLeft: usedRecovery ? p.admin.mfaRecoveryHashes.length - 1 : undefined });
}));

platformRouter.post('/auth/mfa/setup', ah(async (req, res) => {
  const p = platformCtx(req, { allowEnrol: true });
  if (p.admin.mfaEnabled) throw new HttpError(409, 'Two-factor authentication is already on');
  const secret = generateSecret();
  await db.update(platformAdmins).set({ mfaSecretEnc: encrypt(secret) }).where(eq(platformAdmins.id, p.admin.id));
  const uri = generateURI({ issuer: 'VendorGate Platform', label: p.admin.email, secret });
  res.json({ secret, otpauthUrl: uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 200 }) });
}));

platformRouter.post('/auth/mfa/enable', sensitiveLimiter, ah(async (req, res) => {
  const p = platformCtx(req, { allowEnrol: true });
  const { code } = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your app') }).parse(req.body);
  const a = await db.query.platformAdmins.findFirst({ where: eq(platformAdmins.id, p.admin.id) });
  if (!a || !verifyTotp(a.mfaSecretEnc, code)) throw new HttpError(400, 'That code didn’t match. Check the time on your phone and try again.');
  const codes = Array.from({ length: 10 }, () => randomToken(6).replace(/[-_]/g, 'X').slice(0, 8).toUpperCase());
  await db.update(platformAdmins).set({ mfaEnabled: true, mfaRecoveryHashes: codes.map(sha256), lastLoginAt: new Date() }).where(eq(platformAdmins.id, a.id));
  await platformLog({ actor: a.email, action: 'MFA_ENABLED', ip: req.ip });
  res.json({ recoveryCodes: codes });
}));

platformRouter.get('/auth/me', ah(async (req, res) => {
  const p = req.platform;
  if (!p) throw new HttpError(401, 'Please sign in');
  if (p.mfaPending) return res.json({ mfaPending: true });
  res.json({ admin: adminView(p.admin), mfaSetupRequired: !p.admin.mfaEnabled });
}));

platformRouter.post('/auth/logout', ah(async (req, res) => {
  await destroyPlatformSession(res, req.platform?.sessionId);
  res.json({ ok: true });
}));

platformRouter.get('/auth/invite/:token', ah(async (req, res) => {
  const a = await adminByToken(req.params.token, 'INVITE');
  res.json({ name: a.name, email: a.email });
}));

platformRouter.post('/auth/accept-invite', sensitiveLimiter, ah(async (req, res) => {
  const { token, name, password } = z.object({ token: z.string(), name: z.string().min(2).max(100), password: z.string() }).parse(req.body);
  const a = await adminByToken(token, 'INVITE');
  const problem = passwordProblem(password, { email: a.email, name });
  if (problem) throw new HttpError(400, problem);
  await db.update(platformAdmins).set({ name: name.trim(), passwordHash: await hashPassword(password), status: 'ACTIVE', tokenHash: null, tokenPurpose: null, tokenExpiresAt: null }).where(eq(platformAdmins.id, a.id));
  await platformLog({ actor: a.email, action: 'INVITE_ACCEPTED', ip: req.ip });
  await createPlatformSession(req, res, a.id, false);
  res.json({ ok: true, mfaSetupRequired: true });
}));

platformRouter.post('/auth/forgot-password', sensitiveLimiter, ah(async (req, res) => {
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  const a = await db.query.platformAdmins.findFirst({ where: eq(platformAdmins.email, email.trim().toLowerCase()) });
  if (a?.status === 'ACTIVE') {
    const link = await issuePlatformToken(a.id, 'RESET');
    await sendMail({ tenantId: null, to: a.email, subject: 'Reset your VendorGate platform password', body: `Hello ${a.name},\n\nSomeone (hopefully you) asked to reset your platform console password. The link is valid for 1 hour. You will still need your authenticator app to sign in.`, link });
    await platformLog({ actor: a.email, action: 'PASSWORD_RESET_REQUESTED', ip: req.ip });
  }
  res.json({ ok: true });
}));

platformRouter.post('/auth/reset-password', sensitiveLimiter, ah(async (req, res) => {
  const { token, password } = z.object({ token: z.string(), password: z.string() }).parse(req.body);
  const a = await adminByToken(token, 'RESET');
  const problem = passwordProblem(password, { email: a.email });
  if (problem) throw new HttpError(400, problem);
  await db.update(platformAdmins).set({ passwordHash: await hashPassword(password), failedLogins: 0, lockedUntil: null, tokenHash: null, tokenPurpose: null, tokenExpiresAt: null }).where(eq(platformAdmins.id, a.id));
  await db.delete(platformSessions).where(eq(platformSessions.adminId, a.id));
  await platformLog({ actor: a.email, action: 'PASSWORD_RESET', ip: req.ip });
  res.json({ ok: true });
}));

platformRouter.post('/auth/change-password', sensitiveLimiter, ah(async (req, res) => {
  const p = platformCtx(req);
  const { currentPassword, newPassword } = z.object({ currentPassword: z.string(), newPassword: z.string() }).parse(req.body);
  if (!p.admin.passwordHash || !(await checkPassword(currentPassword, p.admin.passwordHash))) throw new HttpError(400, 'Current password is incorrect');
  const problem = passwordProblem(newPassword, { email: p.admin.email });
  if (problem) throw new HttpError(400, problem);
  await db.update(platformAdmins).set({ passwordHash: await hashPassword(newPassword) }).where(eq(platformAdmins.id, p.admin.id));
  await db.delete(platformSessions).where(and(eq(platformSessions.adminId, p.admin.id), ne(platformSessions.id, p.sessionId)));
  await platformLog({ actor: p.admin.email, action: 'PASSWORD_CHANGED', ip: req.ip });
  res.json({ ok: true });
}));

/* ================= Console (everything below needs a full, 2FA-verified session) ================= */

platformRouter.use(requirePlatform);
const actor = (req: Parameters<typeof platformCtx>[0]) => platformCtx(req).admin.email;

platformRouter.get('/plans', (_req, res) => { res.json({ plans: PLANS, features: FEATURE_LABELS }); });

platformRouter.get('/overview', ah(async (_req, res) => {
  const now = new Date(), in7 = new Date(Date.now() + 7 * DAY), ago30 = new Date(Date.now() - 30 * DAY);
  const [byStatus, byPlan, [vendorsN], [usersN], [emailsToday], [signups30], [pendingSignups], endingSoon, recent] = await Promise.all([
    db.select({ status: tenants.status, n: count() }).from(tenants).groupBy(tenants.status),
    db.select({ plan: tenants.plan, n: count() }).from(tenants).groupBy(tenants.plan),
    db.select({ n: count() }).from(vendors),
    db.select({ n: count() }).from(users).where(ne(users.status, 'DISABLED')),
    db.select({ n: count() }).from(emailOutbox).where(gte(emailOutbox.createdAt, startOfDay())),
    db.select({ n: count() }).from(tenants).where(and(eq(tenants.source, 'signup'), gte(tenants.createdAt, ago30))),
    db.select({ n: count() }).from(signups).where(and(isNull(signups.completedAt), gte(signups.expiresAt, now))),
    db.select({ id: tenants.id, name: tenants.name, slug: tenants.slug, trialEndsAt: tenants.trialEndsAt }).from(tenants)
      .where(and(eq(tenants.plan, 'trial'), eq(tenants.status, 'ACTIVE'), lt(tenants.trialEndsAt, in7))).orderBy(tenants.trialEndsAt).limit(10),
    db.select({ id: tenants.id, name: tenants.name, slug: tenants.slug, plan: tenants.plan, source: tenants.source, createdAt: tenants.createdAt }).from(tenants).orderBy(desc(tenants.createdAt)).limit(6),
  ]);
  const st = Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)]));
  res.json({
    tenants: { total: (st.ACTIVE ?? 0) + (st.SUSPENDED ?? 0), active: st.ACTIVE ?? 0, suspended: st.SUSPENDED ?? 0, byPlan: Object.fromEntries(byPlan.map((r) => [r.plan, Number(r.n)])) },
    vendors: Number(vendorsN.n), users: Number(usersN.n), emailsToday: Number(emailsToday.n),
    signupsLast30: Number(signups30.n), pendingSignups: Number(pendingSignups.n),
    trialsEndingSoon: endingSoon, recent,
  });
}));

/* ---------- Tenants ---------- */

platformRouter.get('/tenants', ah(async (req, res) => {
  const q = z.object({ q: z.string().optional(), status: z.enum(['ACTIVE', 'SUSPENDED']).optional(), plan: z.string().optional() }).parse(req.query);
  const where: SQL[] = [];
  if (q.q) where.push(or(ilike(tenants.name, `%${q.q}%`), ilike(tenants.slug, `%${q.q}%`))!);
  if (q.status) where.push(eq(tenants.status, q.status));
  if (q.plan) where.push(eq(tenants.plan, q.plan));
  const rows = await db.select({
    id: tenants.id, slug: tenants.slug, name: tenants.name, status: tenants.status, plan: tenants.plan, source: tenants.source,
    trialEndsAt: tenants.trialEndsAt, createdAt: tenants.createdAt,
    users: sql<number>`(select count(*) from users u where u.tenant_id = ${tenants.id} and u.status <> 'DISABLED')`,
    vendors: sql<number>`(select count(*) from vendors v where v.tenant_id = ${tenants.id})`,
    lastActiveAt: sql<string | null>`(select max(s.last_seen_at) from sessions s where s.tenant_id = ${tenants.id} and s.kind = 'STAFF' and s.support_admin_id is null)`,
    lastLoginAt: sql<string | null>`(select max(u.last_login_at) from users u where u.tenant_id = ${tenants.id})`,
  }).from(tenants).where(where.length ? and(...where) : undefined).orderBy(desc(tenants.createdAt)).limit(500);
  res.json(rows.map((r) => ({ ...r, users: Number(r.users), vendors: Number(r.vendors), lastActiveAt: [r.lastActiveAt, r.lastLoginAt].filter(Boolean).sort().pop() ?? null, lastLoginAt: undefined })));
}));

platformRouter.get('/tenants/check-slug', ah(async (req, res) => {
  const slug = String(req.query.slug ?? '').trim().toLowerCase();
  const problem = await slugProblem(slug);
  res.json({ slug, available: !problem, reason: problem });
}));

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colour must look like #6d1a73');
const limitsSchema = z.object({
  maxUsers: z.number().int().min(1).max(100000).nullable().optional(),
  maxVendors: z.number().int().min(1).max(10000000).nullable().optional(),
  emailsPerDay: z.number().int().min(1).max(1000000).nullable().optional(),
  features: z.object({ erp: z.boolean().optional(), ai: z.boolean().optional(), kyc: z.boolean().optional(), collab: z.boolean().optional() }).optional(),
});

platformRouter.post('/tenants', ah(async (req, res) => {
  const input = z.object({
    name: z.string().trim().min(2).max(120), slug: z.string().trim().min(3).max(40),
    adminName: z.string().trim().min(2).max(100), adminEmail: z.string().trim().email(),
    plan: z.enum(PLAN_KEYS), trialDays: z.number().int().min(1).max(365).optional(),
    primaryColor: hex.optional().or(z.literal('')), productName: z.string().max(40).optional(), notes: z.string().max(2000).optional(),
  }).parse(req.body);
  const p = platformCtx(req);
  const settings = await getPlatformSettings();
  const r = await createTenant({
    slug: input.slug, name: input.name, adminName: input.adminName, adminEmail: input.adminEmail, plan: input.plan, source: 'platform', notes: input.notes,
    trialEndsAt: input.plan === 'trial' ? new Date(Date.now() + (input.trialDays ?? settings.trialDays) * DAY) : null,
    branding: { ...(input.primaryColor ? { primaryColor: input.primaryColor } : {}), ...(input.productName ? { productName: input.productName } : {}) },
    invitedBy: `${p.admin.name} from VendorGate`,
  });
  await audit({ tenantId: r.tenant.id, actor: `VendorGate (${p.admin.name})`, action: 'WORKSPACE_CREATED', detail: { plan: input.plan, admin: r.admin.email } });
  await platformLog({ actor: p.admin.email, action: 'TENANT_CREATED', tenantId: r.tenant.id, detail: { slug: r.tenant.slug, name: r.tenant.name, plan: input.plan, admin: r.admin.email }, ip: req.ip });
  res.status(201).json({ id: r.tenant.id, slug: r.tenant.slug, inviteLink: r.inviteLink });
}));

async function loadTenant(id: string) {
  const t = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
  if (!t) throw new HttpError(404, 'Workspace not found');
  return t;
}

/** Active (or invited) users holding the Administrator role. */
async function tenantAdmins(tenantId: string) {
  return db.select({ id: users.id, name: users.name, email: users.email, status: users.status, mfaEnabled: users.mfaEnabled, lastLoginAt: users.lastLoginAt, createdAt: users.createdAt })
    .from(users).innerJoin(userRoles, eq(userRoles.userId, users.id)).innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(users.tenantId, tenantId), eq(roles.key, 'ADMIN'))).orderBy(users.createdAt);
}

platformRouter.get('/tenants/:id', ah(async (req, res) => {
  const t = await loadTenant(req.params.id);
  const [u, admins, vendorStatus, [emails30], [failed30], activity, [lastSeen]] = await Promise.all([
    usage(t.id), tenantAdmins(t.id),
    db.select({ status: vendors.status, n: count() }).from(vendors).where(eq(vendors.tenantId, t.id)).groupBy(vendors.status),
    db.select({ n: count() }).from(emailOutbox).where(and(eq(emailOutbox.tenantId, t.id), gte(emailOutbox.createdAt, new Date(Date.now() - 30 * DAY)))),
    db.select({ n: count() }).from(emailOutbox).where(and(eq(emailOutbox.tenantId, t.id), eq(emailOutbox.status, 'FAILED'), gte(emailOutbox.createdAt, new Date(Date.now() - 30 * DAY)))),
    db.select({ id: auditLogs.id, actor: auditLogs.actor, action: auditLogs.action, createdAt: auditLogs.createdAt }).from(auditLogs).where(eq(auditLogs.tenantId, t.id)).orderBy(desc(auditLogs.createdAt)).limit(15),
    db.select({ at: sql<string | null>`max(${sessions.lastSeenAt})` }).from(sessions).where(and(eq(sessions.tenantId, t.id), eq(sessions.kind, 'STAFF'), isNull(sessions.supportAdminId))),
  ]);
  const platformHistory = await db.select().from(platformAudit).where(eq(platformAudit.tenantId, t.id)).orderBy(desc(platformAudit.createdAt)).limit(20);
  res.json({
    tenant: { id: t.id, slug: t.slug, name: t.name, status: t.status, statusReason: t.statusReason, plan: t.plan, limits: t.limits, trialEndsAt: t.trialEndsAt, source: t.source, notes: t.notes, createdAt: t.createdAt, branding: t.branding },
    effective: effectiveLimits(t),
    usage: { ...u, emailsLast30: Number(emails30.n), emailsFailedLast30: Number(failed30.n), vendorsByStatus: Object.fromEntries(vendorStatus.map((r) => [r.status, Number(r.n)])), lastActiveAt: lastSeen?.at ?? null },
    admins, activity, platformHistory,
  });
}));

platformRouter.patch('/tenants/:id', ah(async (req, res) => {
  const t = await loadTenant(req.params.id);
  const input = z.object({
    name: z.string().trim().min(2).max(120).optional(), plan: z.enum(PLAN_KEYS).optional(),
    trialEndsAt: z.string().datetime({ offset: true }).nullable().optional().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    limits: limitsSchema.optional(), notes: z.string().max(2000).nullable().optional(),
  }).parse(req.body);
  const set: Partial<typeof tenants.$inferInsert> = {};
  if (input.name) set.name = input.name;
  if (input.plan) set.plan = input.plan;
  if (input.trialEndsAt !== undefined) set.trialEndsAt = input.trialEndsAt ? new Date(input.trialEndsAt.length === 10 ? `${input.trialEndsAt}T23:59:59+05:30` : input.trialEndsAt) : null;
  if (input.plan === 'trial' && !t.trialEndsAt && input.trialEndsAt === undefined) set.trialEndsAt = new Date(Date.now() + (await getPlatformSettings()).trialDays * DAY);
  if (input.limits) set.limits = Object.fromEntries(Object.entries(input.limits).filter(([, v]) => v !== undefined));
  if (input.notes !== undefined) set.notes = input.notes;
  await db.update(tenants).set(set).where(eq(tenants.id, t.id));
  const changed = Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'notes'));
  if (input.plan && input.plan !== t.plan) await audit({ tenantId: t.id, actor: 'VendorGate', action: 'PLAN_CHANGED', detail: { from: t.plan, to: input.plan } });
  await platformLog({ actor: actor(req), action: 'TENANT_UPDATED', tenantId: t.id, detail: { ...changed, ...(input.notes !== undefined ? { notes: 'edited' } : {}) }, ip: req.ip });
  res.json({ ok: true });
}));

platformRouter.post('/tenants/:id/suspend', ah(async (req, res) => {
  const t = await loadTenant(req.params.id);
  const { reason } = z.object({ reason: z.string().trim().min(3, 'Give a reason (shown in the audit trail)').max(300) }).parse(req.body);
  if (t.status === 'SUSPENDED') throw new HttpError(409, 'This workspace is already suspended');
  await db.update(tenants).set({ status: 'SUSPENDED', statusReason: reason }).where(eq(tenants.id, t.id));
  await db.delete(sessions).where(eq(sessions.tenantId, t.id)); // signs out every user and vendor
  await audit({ tenantId: t.id, actor: 'VendorGate', action: 'WORKSPACE_SUSPENDED', detail: { reason } });
  await platformLog({ actor: actor(req), action: 'TENANT_SUSPENDED', tenantId: t.id, detail: { reason }, ip: req.ip });
  res.json({ ok: true });
}));

platformRouter.post('/tenants/:id/reactivate', ah(async (req, res) => {
  const t = await loadTenant(req.params.id);
  if (t.status === 'ACTIVE') throw new HttpError(409, 'This workspace is already active');
  await db.update(tenants).set({ status: 'ACTIVE', statusReason: null }).where(eq(tenants.id, t.id));
  await audit({ tenantId: t.id, actor: 'VendorGate', action: 'WORKSPACE_REACTIVATED' });
  await platformLog({ actor: actor(req), action: 'TENANT_REACTIVATED', tenantId: t.id, ip: req.ip });
  res.json({ ok: true });
}));

/** Add an administrator to a workspace (e.g. the customer's original admin has left). */
platformRouter.post('/tenants/:id/admins', ah(async (req, res) => {
  const t = await loadTenant(req.params.id);
  const p = platformCtx(req);
  const input = z.object({ name: z.string().trim().min(2).max(100), email: z.string().trim().email() }).parse(req.body);
  await assertCanAddUser(t);
  const email = input.email.toLowerCase();
  const adminRole = await db.query.roles.findFirst({ where: and(eq(roles.tenantId, t.id), eq(roles.key, 'ADMIN')) });
  if (!adminRole) throw new HttpError(409, 'This workspace has no Administrator role');
  const existing = await db.query.users.findFirst({ where: and(eq(users.tenantId, t.id), eq(users.email, email)) });
  if (existing) throw new HttpError(409, 'This person already has an account in the workspace. Ask an administrator there to give them the Administrator role.');
  const [user] = await db.insert(users).values({ tenantId: t.id, name: input.name, email, status: 'INVITED' }).returning();
  await db.insert(userRoles).values({ userId: user.id, roleId: adminRole.id });
  const inviteLink = await sendStaffInvite(t, user, `${p.admin.name} from VendorGate`);
  await audit({ tenantId: t.id, actor: `VendorGate (${p.admin.name})`, action: 'USER_INVITED', detail: { email, role: 'Administrator' } });
  await platformLog({ actor: p.admin.email, action: 'TENANT_ADMIN_ADDED', tenantId: t.id, detail: { email }, ip: req.ip });
  res.status(201).json({ id: user.id, inviteLink });
}));

platformRouter.post('/tenants/:id/users/:userId/resend-invite', ah(async (req, res) => {
  const t = await loadTenant(req.params.id);
  const p = platformCtx(req);
  const u = await db.query.users.findFirst({ where: and(eq(users.tenantId, t.id), eq(users.id, req.params.userId)) });
  if (!u) throw new HttpError(404, 'User not found');
  if (u.status !== 'INVITED') throw new HttpError(409, 'This user has already joined');
  const inviteLink = await sendStaffInvite(t, u, `${p.admin.name} from VendorGate`);
  await platformLog({ actor: p.admin.email, action: 'TENANT_INVITE_RESENT', tenantId: t.id, detail: { email: u.email }, ip: req.ip });
  res.json({ ok: true, inviteLink });
}));

/**
 * Read-only support access: opens the tenant's staff app in this browser as one of its administrators,
 * for at most 2 hours. Recorded in the tenant's own audit log, so the customer can see it.
 */
platformRouter.post('/tenants/:id/support-access', sensitiveLimiter, ah(async (req, res) => {
  const t = await loadTenant(req.params.id);
  const p = platformCtx(req);
  const { reason, minutes } = z.object({ reason: z.string().trim().min(5, 'Say why you need access (the customer can see this)').max(300), minutes: z.number().int().min(15).max(120).default(60) }).parse(req.body);
  if (t.status !== 'ACTIVE') throw new HttpError(409, 'Reactivate the workspace before opening support access');
  const [target] = (await tenantAdmins(t.id)).filter((a) => a.status === 'ACTIVE').sort((a, b) => (b.lastLoginAt?.getTime() ?? 0) - (a.lastLoginAt?.getTime() ?? 0));
  if (!target) throw new HttpError(409, 'This workspace has no active administrator yet, so there is nothing to view');
  await createSession(req, res, { kind: 'STAFF', tenant: t, userId: target.id, support: { adminId: p.admin.id, reason, minutes } });
  await audit({ tenantId: t.id, actor: `VendorGate support (${p.admin.name})`, action: 'SUPPORT_ACCESS', detail: { reason, minutes, readOnly: true } });
  await platformLog({ actor: p.admin.email, action: 'SUPPORT_ACCESS', tenantId: t.id, detail: { reason, minutes, viewingAs: target.email }, ip: req.ip });
  res.json({ ok: true, redirect: '/staff/vendors' });
}));

/* ---------- Sign-ups ---------- */

platformRouter.get('/signups', ah(async (_req, res) => {
  const rows = await db.select({ id: signups.id, email: signups.email, name: signups.name, company: signups.company, slug: signups.slug, createdAt: signups.createdAt, expiresAt: signups.expiresAt, completedAt: signups.completedAt, tenantId: signups.tenantId, ip: signups.ip })
    .from(signups).orderBy(desc(signups.createdAt)).limit(200);
  const now = new Date();
  res.json(rows.map((r) => ({ ...r, state: r.completedAt ? 'COMPLETED' : r.expiresAt < now ? 'EXPIRED' : 'WAITING' })));
}));

/* ---------- Settings ---------- */

platformRouter.get('/settings', ah(async (_req, res) => { res.json(await getPlatformSettings()); }));

platformRouter.put('/settings', ah(async (req, res) => {
  const input = z.object({
    signupEnabled: z.boolean(), signupPlan: z.enum(PLAN_KEYS), trialDays: z.number().int().min(1).max(365), blockFreeEmail: z.boolean(),
    notifyEmail: z.string().trim().email().or(z.literal('')).nullable(), termsUrl: z.string().trim().url('Terms link must be a full https:// address').or(z.literal('')).nullable(),
  }).parse(req.body);
  await getPlatformSettings();
  await db.update(platformSettings).set({ ...input, notifyEmail: input.notifyEmail || null, termsUrl: input.termsUrl || null, updatedAt: new Date() }).where(eq(platformSettings.id, 'default'));
  await platformLog({ actor: actor(req), action: 'SETTINGS_CHANGED', detail: input, ip: req.ip });
  res.json(await getPlatformSettings());
}));

/* ---------- Platform admins ---------- */

platformRouter.get('/admins', ah(async (_req, res) => {
  res.json((await db.select().from(platformAdmins).orderBy(platformAdmins.createdAt)).map(adminView));
}));

platformRouter.post('/admins', ah(async (req, res) => {
  const p = platformCtx(req);
  const input = z.object({ name: z.string().trim().min(2).max(100), email: z.string().trim().email() }).parse(req.body);
  const email = input.email.toLowerCase();
  if (await db.query.platformAdmins.findFirst({ where: eq(platformAdmins.email, email) })) throw new HttpError(409, 'There is already a platform admin with this email');
  const [a] = await db.insert(platformAdmins).values({ name: input.name, email }).returning();
  const link = await issuePlatformToken(a.id, 'INVITE');
  await sendMail({ tenantId: null, to: email, subject: 'You’re invited to the VendorGate platform console', body: `Hello ${input.name},\n\n${p.admin.name} has invited you to help run VendorGate. Open the link to set your password; you’ll then set up two-factor authentication. The link is valid for 7 days.`, link });
  await platformLog({ actor: p.admin.email, action: 'ADMIN_INVITED', detail: { email }, ip: req.ip });
  res.status(201).json({ id: a.id, inviteLink: link });
}));

platformRouter.post('/admins/:id/resend-invite', ah(async (req, res) => {
  const a = await db.query.platformAdmins.findFirst({ where: eq(platformAdmins.id, req.params.id) });
  if (!a) throw new HttpError(404, 'Not found');
  if (a.status !== 'INVITED') throw new HttpError(409, 'This admin has already joined');
  const link = await issuePlatformToken(a.id, 'INVITE');
  await sendMail({ tenantId: null, to: a.email, subject: 'You’re invited to the VendorGate platform console', body: `Hello ${a.name},\n\nHere is a fresh link to join the VendorGate platform console. It is valid for 7 days.`, link });
  await platformLog({ actor: actor(req), action: 'ADMIN_INVITE_RESENT', detail: { email: a.email }, ip: req.ip });
  res.json({ ok: true, inviteLink: link });
}));

platformRouter.patch('/admins/:id', ah(async (req, res) => {
  const p = platformCtx(req);
  const { status, resetMfa } = z.object({ status: z.enum(['ACTIVE', 'DISABLED']).optional(), resetMfa: z.boolean().optional() }).parse(req.body);
  const a = await db.query.platformAdmins.findFirst({ where: eq(platformAdmins.id, req.params.id) });
  if (!a) throw new HttpError(404, 'Not found');
  if (a.id === p.admin.id) throw new HttpError(409, 'You can’t change your own access here');
  if (status === 'DISABLED') {
    const [others] = await db.select({ n: count() }).from(platformAdmins).where(and(eq(platformAdmins.status, 'ACTIVE'), ne(platformAdmins.id, a.id)));
    if (Number(others.n) === 0) throw new HttpError(409, 'At least one platform admin must stay active');
  }
  if (status === 'ACTIVE' && a.status === 'INVITED') throw new HttpError(409, 'This admin hasn’t accepted the invitation yet');
  await db.update(platformAdmins).set({
    ...(status && a.status !== 'INVITED' ? { status } : {}),
    ...(resetMfa ? { mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryHashes: [] } : {}),
  }).where(eq(platformAdmins.id, a.id));
  if (status === 'DISABLED' || resetMfa) await db.delete(platformSessions).where(eq(platformSessions.adminId, a.id));
  await platformLog({ actor: p.admin.email, action: resetMfa ? 'ADMIN_MFA_RESET' : 'ADMIN_UPDATED', detail: { email: a.email, status }, ip: req.ip });
  res.json({ ok: true });
}));

/* ---------- Audit ---------- */

platformRouter.get('/audit', ah(async (req, res) => {
  const { tenantId, before } = z.object({ tenantId: z.string().optional(), before: z.string().datetime({ offset: true }).optional() }).parse(req.query);
  const where: SQL[] = [];
  if (tenantId) where.push(eq(platformAudit.tenantId, tenantId));
  if (before) where.push(lt(platformAudit.createdAt, new Date(before)));
  const rows = await db.select({ a: platformAudit, tenantName: tenants.name, tenantSlug: tenants.slug }).from(platformAudit)
    .leftJoin(tenants, eq(tenants.id, platformAudit.tenantId)).where(where.length ? and(...where) : undefined).orderBy(desc(platformAudit.createdAt)).limit(100);
  res.json(rows.map((r) => ({ ...r.a, tenantName: r.tenantName, tenantSlug: r.tenantSlug })));
}));
