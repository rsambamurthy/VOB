import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import QRCode from 'qrcode';
import bcrypt from 'bcryptjs';
import { generateSecret, generateURI, verifySync } from 'otplib';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { checkPassword, hashPassword, passwordProblem } from '../lib/password.js';
import { decrypt, encrypt, randomToken, sha256 } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';
import { env } from '../lib/env.js';
import { createSession, destroySession, revokeUserSessions, staffCtx } from '../auth/session.js';
import { consumeToken, issueToken } from '../services/users.js';
import { loginLimiter, sensitiveLimiter } from '../lib/rateLimits.js';

const { users, tenants, sessions } = schema;
export const staffAuthRouter = Router();

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
// Used to keep response time constant when the user doesn't exist.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', 12);

const findTenant = (slug: string) => db.query.tenants.findFirst({ where: eq(tenants.slug, slug.trim().toLowerCase()) });

function verifyTotp(secretEnc: string | null, code: string) {
  if (!secretEnc) return false;
  return verifySync({ secret: decrypt(secretEnc), token: code, epochTolerance: 30 }).valid;
}

function me(req: Request) {
  const s = staffCtx(req);
  return {
    user: s.user,
    tenant: { id: s.tenant.id, slug: s.tenant.slug, name: s.tenant.name, branding: s.tenant.branding, settings: s.tenant.settings },
    roles: s.roles,
    permissions: [...s.permissions],
    mfaSetupRequired: s.mfaSetupRequired,
    devMailbox: env.devShowOtp,
  };
}

staffAuthRouter.post('/login', loginLimiter, ah(async (req, res) => {
  const { workspace, email, password } = z.object({ workspace: z.string().min(1), email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const generic = new HttpError(401, 'Workspace, email or password is incorrect');
  const tenant = await findTenant(workspace);
  const user = tenant && await db.query.users.findFirst({ where: and(eq(users.tenantId, tenant.id), eq(users.email, email.trim().toLowerCase())) });
  const ok = await checkPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!tenant || !user || !user.passwordHash) throw generic;
  if (tenant.status !== 'ACTIVE') throw new HttpError(403, 'This workspace is suspended. Contact support.');
  if (user.lockedUntil && user.lockedUntil > new Date()) throw new HttpError(429, `Too many failed attempts. Try again after ${LOCK_MINUTES} minutes.`);
  if (!ok) {
    const failed = user.failedLogins + 1;
    await db.update(users).set({ failedLogins: failed, lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null }).where(eq(users.id, user.id));
    await audit({ tenantId: tenant.id, actor: user.email, action: failed >= MAX_FAILED ? 'LOGIN_LOCKED' : 'LOGIN_FAILED', ip: req.ip });
    throw generic;
  }
  if (user.status === 'DISABLED') throw new HttpError(403, 'Your account has been disabled. Contact your administrator.');
  await db.update(users).set({ failedLogins: 0, lockedUntil: null }).where(eq(users.id, user.id));
  if (user.mfaEnabled) {
    await createSession(req, res, { kind: 'STAFF', tenant, userId: user.id, mfaPending: true });
    return res.json({ mfaRequired: true });
  }
  await createSession(req, res, { kind: 'STAFF', tenant, userId: user.id });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await audit({ tenantId: tenant.id, actor: user.email, action: 'LOGIN', ip: req.ip });
  res.json({ mfaRequired: false, mfaSetupRequired: !!tenant.settings.requireMfa && !user.mfaEnabled });
}));

/** Second step of login: TOTP code or a one-time recovery code. */
staffAuthRouter.post('/mfa/verify', loginLimiter, ah(async (req, res) => {
  const s = req.staff;
  if (!s?.mfaPending) throw new HttpError(400, 'No two-factor check is pending. Sign in again.');
  const { code } = z.object({ code: z.string().min(6).max(20) }).parse(req.body);
  const user = await db.query.users.findFirst({ where: eq(users.id, s.user.id) });
  if (!user) throw new HttpError(401, 'Please sign in');
  const clean = code.replace(/\s|-/g, '');
  let ok = /^\d{6}$/.test(clean) && verifyTotp(user.mfaSecretEnc, clean);
  let usedRecovery = false;
  if (!ok) {
    const h = sha256(clean.toUpperCase());
    if (user.mfaRecoveryHashes.includes(h)) {
      ok = usedRecovery = true;
      await db.update(users).set({ mfaRecoveryHashes: user.mfaRecoveryHashes.filter((x) => x !== h) }).where(eq(users.id, user.id));
    }
  }
  if (!ok) {
    await audit({ tenantId: s.tenant.id, actor: user.email, action: 'MFA_FAILED', ip: req.ip });
    throw new HttpError(401, 'That code is not valid');
  }
  // Rotate the session so the pre-MFA token can't be reused.
  await destroySession(res, 'STAFF', s.sessionId);
  await createSession(req, res, { kind: 'STAFF', tenant: s.tenant, userId: user.id });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await audit({ tenantId: s.tenant.id, actor: user.email, action: usedRecovery ? 'LOGIN_RECOVERY_CODE' : 'LOGIN', ip: req.ip });
  res.json({ ok: true, recoveryCodesLeft: usedRecovery ? user.mfaRecoveryHashes.length - 1 : undefined });
}));

staffAuthRouter.post('/logout', ah(async (req, res) => {
  await destroySession(res, 'STAFF', req.staff?.sessionId);
  res.json({ ok: true });
}));

staffAuthRouter.get('/me', ah(async (req, res) => {
  if (!req.staff) throw new HttpError(401, 'Please sign in');
  if (req.staff.mfaPending) return res.json({ mfaPending: true });
  res.json(me(req));
}));

/* ---------- Invites & password reset ---------- */

staffAuthRouter.get('/invite/:token', ah(async (req, res) => {
  const { user, tenant } = await consumeToken(req.params.token, 'INVITE', { markUsed: false });
  res.json({ name: user.name, email: user.email, workspace: tenant.slug, tenantName: tenant.name });
}));

staffAuthRouter.post('/accept-invite', sensitiveLimiter, ah(async (req, res) => {
  const { token, name, password } = z.object({ token: z.string(), name: z.string().min(2).max(100), password: z.string() }).parse(req.body);
  const { user: peek } = await consumeToken(token, 'INVITE', { markUsed: false });
  const problem = passwordProblem(password, { email: peek.email, name });
  if (problem) throw new HttpError(400, problem);
  const { user, tenant } = await consumeToken(token, 'INVITE');
  await db.update(users).set({ name: name.trim(), passwordHash: await hashPassword(password), status: 'ACTIVE', passwordChangedAt: new Date(), lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await audit({ tenantId: tenant.id, actor: user.email, action: 'INVITE_ACCEPTED', ip: req.ip });
  await createSession(req, res, { kind: 'STAFF', tenant, userId: user.id });
  res.json({ ok: true, mfaSetupRequired: !!tenant.settings.requireMfa });
}));

staffAuthRouter.post('/forgot-password', sensitiveLimiter, ah(async (req, res) => {
  const { workspace, email } = z.object({ workspace: z.string().min(1), email: z.string().email() }).parse(req.body);
  const tenant = await findTenant(workspace);
  const user = tenant && await db.query.users.findFirst({ where: and(eq(users.tenantId, tenant.id), eq(users.email, email.trim().toLowerCase())) });
  if (tenant && user && user.status === 'ACTIVE') {
    const token = await issueToken(tenant.id, user.id, 'PASSWORD_RESET');
    await sendMail({ tenantId: tenant.id, to: user.email, subject: 'Reset your password',
      body: `Hello ${user.name},\n\nSomeone (hopefully you) asked to reset your password for the ${tenant.name} workspace. The link below is valid for 1 hour. If this wasn't you, you can ignore this email.`,
      link: `${env.appBaseUrl}/reset-password/${token}` });
    await audit({ tenantId: tenant.id, actor: user.email, action: 'PASSWORD_RESET_REQUESTED', ip: req.ip });
  }
  // Same response either way, so the endpoint can't be used to discover accounts.
  res.json({ ok: true });
}));

staffAuthRouter.post('/reset-password', sensitiveLimiter, ah(async (req, res) => {
  const { token, password } = z.object({ token: z.string(), password: z.string() }).parse(req.body);
  const { user: peek } = await consumeToken(token, 'PASSWORD_RESET', { markUsed: false });
  const problem = passwordProblem(password, { email: peek.email });
  if (problem) throw new HttpError(400, problem);
  const { user, tenant } = await consumeToken(token, 'PASSWORD_RESET');
  await db.update(users).set({ passwordHash: await hashPassword(password), passwordChangedAt: new Date(), failedLogins: 0, lockedUntil: null }).where(eq(users.id, user.id));
  await revokeUserSessions(user.id);
  await audit({ tenantId: tenant.id, actor: user.email, action: 'PASSWORD_RESET', ip: req.ip });
  res.json({ ok: true, workspace: tenant.slug });
}));

/* ---------- Signed-in account security ---------- */

/** Allowed while MFA setup is required (so users can enrol). */
function requireFullSession(req: Request) {
  const s = staffCtx(req);
  if (s.mfaPending) throw new HttpError(401, 'Two-factor verification required');
  return s;
}

staffAuthRouter.post('/change-password', sensitiveLimiter, ah(async (req, res) => {
  const s = requireFullSession(req);
  const { currentPassword, newPassword } = z.object({ currentPassword: z.string(), newPassword: z.string() }).parse(req.body);
  const user = await db.query.users.findFirst({ where: eq(users.id, s.user.id) });
  if (!user?.passwordHash || !(await checkPassword(currentPassword, user.passwordHash))) throw new HttpError(400, 'Current password is incorrect');
  const problem = passwordProblem(newPassword, { email: user.email });
  if (problem) throw new HttpError(400, problem);
  await db.update(users).set({ passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date() }).where(eq(users.id, user.id));
  await revokeUserSessions(user.id, s.sessionId);
  await audit({ tenantId: s.tenant.id, actor: user.email, action: 'PASSWORD_CHANGED', ip: req.ip });
  res.json({ ok: true });
}));

staffAuthRouter.post('/mfa/setup', ah(async (req, res) => {
  const s = requireFullSession(req);
  if (s.user.mfaEnabled) throw new HttpError(409, 'Two-factor authentication is already on');
  const secret = generateSecret();
  await db.update(users).set({ mfaSecretEnc: encrypt(secret) }).where(eq(users.id, s.user.id));
  const uri = generateURI({ issuer: `${s.tenant.branding.productName ?? 'VendorGate'} (${s.tenant.slug})`, label: s.user.email, secret });
  res.json({ secret, otpauthUrl: uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 200 }) });
}));

staffAuthRouter.post('/mfa/enable', sensitiveLimiter, ah(async (req, res) => {
  const s = requireFullSession(req);
  const { code } = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your app') }).parse(req.body);
  const user = await db.query.users.findFirst({ where: eq(users.id, s.user.id) });
  if (!user || !verifyTotp(user.mfaSecretEnc, code)) throw new HttpError(400, 'That code didn’t match. Check the time on your phone and try again.');
  const codes = Array.from({ length: 10 }, () => randomToken(6).replace(/[-_]/g, 'X').slice(0, 8).toUpperCase());
  await db.update(users).set({ mfaEnabled: true, mfaRecoveryHashes: codes.map(sha256) }).where(eq(users.id, user.id));
  await revokeUserSessions(user.id, s.sessionId);
  await audit({ tenantId: s.tenant.id, actor: user.email, action: 'MFA_ENABLED', ip: req.ip });
  res.json({ recoveryCodes: codes });
}));

staffAuthRouter.post('/mfa/disable', sensitiveLimiter, ah(async (req, res) => {
  const s = requireFullSession(req);
  if (s.tenant.settings.requireMfa) throw new HttpError(409, 'Your workspace requires two-factor authentication');
  const { password, code } = z.object({ password: z.string(), code: z.string() }).parse(req.body);
  const user = await db.query.users.findFirst({ where: eq(users.id, s.user.id) });
  if (!user?.passwordHash || !(await checkPassword(password, user.passwordHash)) || !verifyTotp(user.mfaSecretEnc, code)) throw new HttpError(400, 'Password or code is incorrect');
  await db.update(users).set({ mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryHashes: [] }).where(eq(users.id, user.id));
  await audit({ tenantId: s.tenant.id, actor: user.email, action: 'MFA_DISABLED', ip: req.ip });
  res.json({ ok: true });
}));

staffAuthRouter.get('/sessions', ah(async (req, res) => {
  const s = requireFullSession(req);
  const rows = await db.select({ id: sessions.id, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, ip: sessions.ip, userAgent: sessions.userAgent })
    .from(sessions).where(and(eq(sessions.userId, s.user.id), eq(sessions.mfaPending, false)));
  res.json(rows.map((r) => ({ ...r, current: r.id === s.sessionId })));
}));

staffAuthRouter.post('/sessions/revoke-others', ah(async (req, res) => {
  const s = requireFullSession(req);
  await revokeUserSessions(s.user.id, s.sessionId);
  res.json({ ok: true });
}));
