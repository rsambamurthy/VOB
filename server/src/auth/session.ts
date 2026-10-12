/**
 * Cookie sessions for staff and vendors (separate cookies, so one browser can hold both).
 * Cookie value = random token; DB stores sha256(token). Sessions are revocable server-side.
 */
import type { Request, Response, NextFunction } from 'express';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { env } from '../lib/env.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';
import type { Permission } from '../lib/permissions.js';
import type { Tenant, User } from '../db/schema.js';

const { sessions, tenants, users, userRoles, roles } = schema;

export const COOKIE = { STAFF: 'vg_s', VENDOR: 'vg_v' } as const;
const DEFAULT_SESSION_HOURS = 12;
const VENDOR_SESSION_HOURS = 8;

export interface StaffCtx {
  kind: 'staff';
  sessionId: string;
  tenant: Tenant;
  user: Pick<User, 'id' | 'name' | 'email' | 'mfaEnabled' | 'tenantId'>;
  roles: { id: string; key: string; name: string }[];
  roleIds: Set<string>;
  permissions: Set<Permission>;
  mfaPending: boolean;
  /** Workspace requires 2FA and this user hasn't enrolled yet: only the enrolment routes are allowed. */
  mfaSetupRequired: boolean;
  /** Read-only support session opened by a platform admin. */
  support?: { by: string; reason: string | null; endsAt: Date };
}
export interface VendorCtx { kind: 'vendor'; sessionId: string; tenant: Tenant; vendorId: string; contactEmail: string | null }

declare global {
  namespace Express {
    interface Request { staff?: StaffCtx; vendor?: VendorCtx }
  }
}

function cookieOpts(hours: number) {
  return { httpOnly: true, secure: env.isProd, sameSite: 'lax' as const, path: '/', maxAge: hours * 3600_000 };
}

export async function createSession(
  req: Request, res: Response,
  s: { kind: 'STAFF'; tenant: Tenant; userId: string; mfaPending?: boolean; support?: { adminId: string; reason: string; minutes: number } } | { kind: 'VENDOR'; tenant: Tenant; vendorId: string; contactEmail?: string },
) {
  const token = randomToken();
  const hours = s.kind === 'STAFF' ? (s.support ? s.support.minutes / 60 : s.tenant.settings.sessionHours ?? DEFAULT_SESSION_HOURS) : VENDOR_SESSION_HOURS;
  const [row] = await db.insert(sessions).values({
    tokenHash: sha256(token), kind: s.kind, tenantId: s.tenant.id,
    userId: s.kind === 'STAFF' ? s.userId : null,
    vendorId: s.kind === 'VENDOR' ? s.vendorId : null,
    mfaPending: s.kind === 'STAFF' ? !!s.mfaPending : false,
    supportAdminId: s.kind === 'STAFF' ? s.support?.adminId ?? null : null,
    contactEmail: s.kind === 'VENDOR' ? s.contactEmail ?? null : null,
    supportReason: s.kind === 'STAFF' ? s.support?.reason ?? null : null,
    expiresAt: new Date(Date.now() + hours * 3600_000),
    ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 300),
  }).returning();
  res.cookie(s.kind === 'STAFF' ? COOKIE.STAFF : COOKIE.VENDOR, token, cookieOpts(hours));
  return row;
}

export async function destroySession(res: Response, kind: 'STAFF' | 'VENDOR', sessionId?: string) {
  if (sessionId) await db.delete(sessions).where(eq(sessions.id, sessionId));
  res.clearCookie(kind === 'STAFF' ? COOKIE.STAFF : COOKIE.VENDOR, { path: '/' });
}

/** Revoke every session of a user (password reset, disable, role change safety). */
export async function revokeUserSessions(userId: string, exceptSessionId?: string) {
  const all = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId));
  const ids = all.map((s) => s.id).filter((id) => id !== exceptSessionId);
  if (ids.length) await db.delete(sessions).where(inArray(sessions.id, ids));
}

async function loadStaff(token: string): Promise<StaffCtx | undefined> {
  const s = await db.query.sessions.findFirst({ where: and(eq(sessions.tokenHash, sha256(token)), eq(sessions.kind, 'STAFF'), gt(sessions.expiresAt, new Date())) });
  if (!s?.userId) return;
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, s.tenantId) });
  if (!tenant || tenant.status !== 'ACTIVE') return;
  const user = await db.query.users.findFirst({ where: and(eq(users.id, s.userId), eq(users.tenantId, tenant.id)) });
  if (!user || user.status !== 'ACTIVE') return;
  const rs = await db.select({ id: roles.id, key: roles.key, name: roles.name, permissions: roles.permissions })
    .from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(userRoles.userId, user.id), eq(roles.tenantId, tenant.id)));
  touch(s.id, s.lastSeenAt);
  const supporter = s.supportAdminId ? await db.query.platformAdmins.findFirst({ where: eq(schema.platformAdmins.id, s.supportAdminId) }) : undefined;
  if (s.supportAdminId && supporter?.status !== 'ACTIVE') return;
  return {
    kind: 'staff', sessionId: s.id, tenant, mfaPending: s.mfaPending,
    mfaSetupRequired: !supporter && !!tenant.settings.requireMfa && !user.mfaEnabled,
    support: supporter ? { by: `${supporter.name} (${supporter.email})`, reason: s.supportReason, endsAt: s.expiresAt } : undefined,
    user: { id: user.id, name: user.name, email: user.email, mfaEnabled: user.mfaEnabled, tenantId: user.tenantId },
    roles: rs.map(({ id, key, name }) => ({ id, key, name })),
    roleIds: new Set(rs.map((r) => r.id)),
    permissions: new Set(rs.flatMap((r) => r.permissions) as Permission[]),
  };
}

async function loadVendor(token: string): Promise<VendorCtx | undefined> {
  const s = await db.query.sessions.findFirst({ where: and(eq(sessions.tokenHash, sha256(token)), eq(sessions.kind, 'VENDOR'), gt(sessions.expiresAt, new Date())) });
  if (!s?.vendorId) return;
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, s.tenantId) });
  if (!tenant || tenant.status !== 'ACTIVE') return;
  touch(s.id, s.lastSeenAt);
  return { kind: 'vendor', sessionId: s.id, tenant, vendorId: s.vendorId, contactEmail: s.contactEmail };
}

/** Update last-seen at most every 5 minutes (fire-and-forget). */
function touch(id: string, last: Date) {
  if (Date.now() - last.getTime() > 5 * 60_000) db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, id)).catch(() => {});
}

export async function loadSessions(req: Request, _res: Response, next: NextFunction) {
  try {
    const st = req.cookies?.[COOKIE.STAFF];
    const vt = req.cookies?.[COOKIE.VENDOR];
    if (st) req.staff = await loadStaff(st);
    if (vt) req.vendor = await loadVendor(vt);
    next();
  } catch (e) { next(e); }
}

/**
 * CSRF defence: cookie-authenticated state changes must carry X-Requested-With.
 * Browsers can't add custom headers cross-site without a CORS preflight, which we never allow.
 */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with')) return next();
  // The ERP API (/api/v1) authenticates with a bearer key and never reads cookies, so cross-site forgery doesn't apply.
  if (req.path.startsWith('/v1/')) return next();
  next(new HttpError(403, 'Missing X-Requested-With header'));
}

/** Support sessions can look but not change anything (sign-out is the only write allowed). */
export function supportReadOnly(req: Request, _res: Response, next: NextFunction) {
  if (!req.staff?.support || ['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/auth/logout') return next();
  next(new HttpError(403, 'Support access is read-only', undefined, 'SUPPORT_READ_ONLY'));
}

export function requireStaff(...perms: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const s = req.staff;
    if (!s) return next(new HttpError(401, 'Please sign in'));
    if (s.mfaPending) return next(new HttpError(401, 'Two-factor verification required', undefined, 'MFA_PENDING'));
    if (s.mfaSetupRequired) return next(new HttpError(403, 'Your workspace requires two-factor authentication. Set it up to continue.', undefined, 'MFA_SETUP_REQUIRED'));
    const missing = perms.filter((p) => !s.permissions.has(p));
    if (missing.length) return next(new HttpError(403, 'You don’t have permission to do this'));
    next();
  };
}

export function requireVendor(req: Request, _res: Response, next: NextFunction) {
  if (!req.vendor) return next(new HttpError(401, 'Your session has expired. Open the invitation link again.'));
  next();
}

export const staffCtx = (req: Request) => { if (!req.staff) throw new HttpError(401, 'Please sign in'); return req.staff; };
export const vendorCtx = (req: Request) => { if (!req.vendor) throw new HttpError(401, 'Vendor sign-in required'); return req.vendor; };
