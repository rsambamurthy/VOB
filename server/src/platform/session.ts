/**
 * Platform-admin sessions (the people who run VendorGate itself). Kept completely apart from tenant
 * sessions: own table, own cookie, and two-factor authentication is mandatory before anything works.
 */
import type { NextFunction, Request, Response } from 'express';
import { and, eq, gt } from 'drizzle-orm';
import { verifySync } from 'otplib';
import { db, schema } from '../lib/db.js';
import { env } from '../lib/env.js';
import { decrypt, randomToken, sha256 } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';
import type { PlatformAdmin } from '../db/schema.js';

const { platformSessions, platformAdmins, platformAudit } = schema;
export const PLATFORM_COOKIE = 'vg_p';
const SESSION_HOURS = 8;

export interface PlatformCtx { sessionId: string; admin: PlatformAdmin; mfaPending: boolean }
declare global {
  namespace Express { interface Request { platform?: PlatformCtx } }
}

export async function createPlatformSession(req: Request, res: Response, adminId: string, mfaPending: boolean) {
  const token = randomToken();
  await db.insert(platformSessions).values({ tokenHash: sha256(token), adminId, mfaPending, expiresAt: new Date(Date.now() + (mfaPending ? 0.25 : SESSION_HOURS) * 3600_000), ip: req.ip, userAgent: req.get('user-agent')?.slice(0, 300) });
  res.cookie(PLATFORM_COOKIE, token, { httpOnly: true, secure: env.isProd, sameSite: 'strict', path: '/', maxAge: SESSION_HOURS * 3600_000 });
}

export async function destroyPlatformSession(res: Response, sessionId?: string) {
  if (sessionId) await db.delete(platformSessions).where(eq(platformSessions.id, sessionId));
  res.clearCookie(PLATFORM_COOKIE, { path: '/' });
}

export async function loadPlatformSession(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[PLATFORM_COOKIE];
    if (!token) return next();
    const s = await db.query.platformSessions.findFirst({ where: and(eq(platformSessions.tokenHash, sha256(token)), gt(platformSessions.expiresAt, new Date())) });
    if (s) {
      const admin = await db.query.platformAdmins.findFirst({ where: eq(platformAdmins.id, s.adminId) });
      if (admin?.status === 'ACTIVE') {
        req.platform = { sessionId: s.id, admin, mfaPending: s.mfaPending };
        if (Date.now() - s.lastSeenAt.getTime() > 5 * 60_000) db.update(platformSessions).set({ lastSeenAt: new Date() }).where(eq(platformSessions.id, s.id)).catch(() => {});
      }
    }
    next();
  } catch (e) { next(e); }
}

/** Signed in, past the 2FA check (unless allowEnrol and 2FA isn't set up yet). */
export function platformCtx(req: Request, { allowEnrol = false } = {}) {
  const p = req.platform;
  if (!p) throw new HttpError(401, 'Please sign in', undefined, 'PLATFORM_SIGNIN');
  if (p.mfaPending) throw new HttpError(401, 'Two-factor verification required', undefined, 'MFA_PENDING');
  if (!p.admin.mfaEnabled && !allowEnrol) throw new HttpError(403, 'Set up two-factor authentication to continue', undefined, 'MFA_SETUP_REQUIRED');
  return p;
}
export const requirePlatform = (req: Request, _res: Response, next: NextFunction) => { try { platformCtx(req); next(); } catch (e) { next(e); } };

export function verifyTotp(secretEnc: string | null, code: string) {
  if (!secretEnc || !/^\d{6}$/.test(code)) return false;
  return verifySync({ secret: decrypt(secretEnc), token: code, epochTolerance: 30 }).valid;
}

export async function platformLog(e: { actor: string; action: string; tenantId?: string | null; detail?: unknown; ip?: string }) {
  await db.insert(platformAudit).values({ actor: e.actor, action: e.action, tenantId: e.tenantId ?? null, detail: e.detail ?? null, ip: e.ip });
}

/** Issues a one-time invite (7 days) or reset (1 hour) link for a platform admin. */
export async function issuePlatformToken(adminId: string, purpose: 'INVITE' | 'RESET') {
  const token = randomToken();
  await db.update(platformAdmins).set({ tokenHash: sha256(token), tokenPurpose: purpose, tokenExpiresAt: new Date(Date.now() + (purpose === 'INVITE' ? 7 * 24 : 1) * 3600_000) }).where(eq(platformAdmins.id, adminId));
  return `${env.appBaseUrl}/platform/${purpose === 'INVITE' ? 'accept-invite' : 'reset-password'}/${token}`;
}

export async function adminByToken(token: string, purpose: 'INVITE' | 'RESET') {
  const a = await db.query.platformAdmins.findFirst({ where: and(eq(platformAdmins.tokenHash, sha256(token)), eq(platformAdmins.tokenPurpose, purpose)) });
  if (!a || !a.tokenExpiresAt || a.tokenExpiresAt < new Date() || a.status === 'DISABLED') throw new HttpError(400, 'This link is invalid or has expired');
  return a;
}
