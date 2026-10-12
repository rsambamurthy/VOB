import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { and, count, desc, eq, gt, sql } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { env } from '../lib/env.js';
import { sendMail } from '../lib/mailer.js';
import { sendSms } from '../integrations/sms/index.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';
import { createSession, destroySession } from '../auth/session.js';
import { inArray, isNull, ne, or } from 'drizzle-orm';
import { sensitiveLimiter, loginLimiter } from '../lib/rateLimits.js';

const { vendors, otpCodes, tenants } = schema;
export const vendorAuthRouter = Router();

async function byInvite(token: string) {
  const v = await db.query.vendors.findFirst({ where: eq(vendors.inviteToken, token) });
  if (!v) throw new HttpError(404, 'This invitation link is not valid');
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, v.tenantId) });
  if (!tenant || tenant.status !== 'ACTIVE') throw new HttpError(404, 'This invitation link is not valid');
  return { v, tenant };
}
const maskEmail = (e: string) => e.replace(/^(.{2}).*(@.*)$/, (_m, a, b) => `${a}•••${b}`);
const maskMobile = (m: string) => { const d = m.replace(/\D/g, ''); return `••••••${d.slice(-4)}`; };

vendorAuthRouter.get('/invite/:token', ah(async (req, res) => {
  const { v, tenant } = await byInvite(req.params.token);
  res.json({ vendorName: v.name, email: maskEmail(v.contactEmail), status: v.status, buyer: { name: tenant.name, branding: tenant.branding } });
}));

vendorAuthRouter.post('/request-otp', sensitiveLimiter, ah(async (req, res) => {
  const { token } = z.object({ token: z.string() }).parse(req.body);
  const { v, tenant } = await byInvite(token);
  const [{ recent }] = await db.select({ recent: count() }).from(otpCodes).where(and(eq(otpCodes.vendorId, v.id), gt(otpCodes.createdAt, new Date(Date.now() - 60_000))));
  if (recent >= 3) throw new HttpError(429, 'Too many codes requested. Please wait a minute.');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await db.insert(otpCodes).values({ tenantId: tenant.id, vendorId: v.id, codeHash: await bcrypt.hash(code, 8), expiresAt: new Date(Date.now() + 10 * 60_000) });
  const channel = tenant.settings.vendorOtpChannel ?? 'email';
  const sentTo: string[] = [];
  if (channel !== 'sms') {
    await sendMail({ tenantId: tenant.id, to: v.contactEmail, subject: `Your ${tenant.name} vendor portal sign-in code`, body: `Your one-time code is ${code}. It expires in 10 minutes. Never share this code.` });
    sentTo.push(maskEmail(v.contactEmail));
  }
  if (channel !== 'email') {
    try {
      await sendSms({ tenantId: tenant.id, to: v.contactMobile, purpose: 'otp', vars: { otp: code, var1: code }, body: `${code} is your ${tenant.name} supplier portal code. Valid 10 min. Do not share.` });
      sentTo.push(maskMobile(v.contactMobile));
    } catch (err) {
      logger.warn({ err }, 'OTP SMS failed');
      if (channel === 'sms') {
        await sendMail({ tenantId: tenant.id, to: v.contactEmail, subject: `Your ${tenant.name} vendor portal sign-in code`, body: `Your one-time code is ${code}. It expires in 10 minutes.` });
        sentTo.push(maskEmail(v.contactEmail));
      }
    }
  }
  res.json({ sentTo: sentTo.join(' and '), ...(env.devShowOtp ? { devOtp: code } : {}) });
}));

vendorAuthRouter.post('/verify-otp', loginLimiter, ah(async (req, res) => {
  const { token, code } = z.object({ token: z.string(), code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }).parse(req.body);
  const { v, tenant } = await byInvite(token);
  const otp = await db.query.otpCodes.findFirst({ where: and(eq(otpCodes.vendorId, v.id), eq(otpCodes.used, false), gt(otpCodes.expiresAt, new Date())), orderBy: desc(otpCodes.createdAt) });
  if (!otp || otp.attempts >= 5) throw new HttpError(401, 'Code expired — request a new one');
  if (!(await bcrypt.compare(code, otp.codeHash))) {
    await db.update(otpCodes).set({ attempts: sql`${otpCodes.attempts} + 1` }).where(eq(otpCodes.id, otp.id));
    throw new HttpError(401, 'Incorrect code');
  }
  await db.update(otpCodes).set({ used: true }).where(eq(otpCodes.id, otp.id));
  if (v.status === 'INVITED') await db.update(vendors).set({ status: 'IN_PROGRESS' }).where(eq(vendors.id, v.id));
  await createSession(req, res, { kind: 'VENDOR', tenant, vendorId: v.id });
  await audit({ tenantId: tenant.id, vendorId: v.id, actor: v.contactEmail, action: 'VENDOR_SIGNED_IN', ip: req.ip });
  res.json({ ok: true });
}));

/* ---------- Sign-in by email (returning suppliers, several people per supplier) ---------- */

const activeTenant = async (slug: string) => {
  const t = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug.trim().toLowerCase()) });
  if (!t || t.status !== 'ACTIVE') throw new HttpError(404, 'This sign-in link is not valid');
  return t;
};

/** Vendors this email may sign in for: the vendor's main contact or an active portal contact. */
async function vendorsForEmail(tenantId: string, email: string) {
  const e = email.trim().toLowerCase();
  const viaContacts = db.select({ id: schema.supplierContacts.vendorId }).from(schema.supplierContacts)
    .where(and(eq(schema.supplierContacts.tenantId, tenantId), eq(schema.supplierContacts.email, e), eq(schema.supplierContacts.active, true)));
  return db.select({ id: vendors.id, name: vendors.name, code: vendors.code, contactEmail: vendors.contactEmail }).from(vendors)
    .where(and(eq(vendors.tenantId, tenantId), isNull(vendors.erasedAt), ne(vendors.status, 'REJECTED'), or(sql`lower(${vendors.contactEmail}) = ${e}`, inArray(vendors.id, viaContacts))));
}

vendorAuthRouter.get('/workspace/:slug', ah(async (req, res) => {
  const t = await activeTenant(req.params.slug);
  res.json({ name: t.name, branding: t.branding });
}));

vendorAuthRouter.post('/email/request', sensitiveLimiter, ah(async (req, res) => {
  const { workspace, email } = z.object({ workspace: z.string().min(1), email: z.string().trim().toLowerCase().email('Enter a valid email address') }).parse(req.body);
  const t = await activeTenant(workspace);
  const vs = await vendorsForEmail(t.id, email);
  let devOtp: string | undefined;
  if (vs.length) {
    const [{ recent }] = await db.select({ recent: count() }).from(otpCodes).where(and(eq(otpCodes.tenantId, t.id), eq(otpCodes.email, email), gt(otpCodes.createdAt, new Date(Date.now() - 60_000))));
    if (recent >= 3 * vs.length) throw new HttpError(429, 'Too many codes requested. Please wait a minute.');
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const hash = await bcrypt.hash(code, 8);
    await db.insert(otpCodes).values(vs.map((v) => ({ tenantId: t.id, vendorId: v.id, email, codeHash: hash, expiresAt: new Date(Date.now() + 10 * 60_000) })));
    await sendMail({ tenantId: t.id, to: email, subject: `Your ${t.name} supplier portal sign-in code`, body: `Your one-time code is ${code}. It expires in 10 minutes. Never share this code.` });
    if (env.devShowOtp) devOtp = code;
  }
  // Same answer either way, so the form can't be used to find out who is a supplier.
  res.json({ ok: true, ...(devOtp ? { devOtp } : {}) });
}));

vendorAuthRouter.post('/email/verify', loginLimiter, ah(async (req, res) => {
  const { workspace, email, code, vendorId } = z.object({ workspace: z.string().min(1), email: z.string().trim().toLowerCase().email(), code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'), vendorId: z.string().optional() }).parse(req.body);
  const t = await activeTenant(workspace);
  const rows = await db.select().from(otpCodes).where(and(eq(otpCodes.tenantId, t.id), eq(otpCodes.email, email), eq(otpCodes.used, false), gt(otpCodes.expiresAt, new Date()))).orderBy(desc(otpCodes.createdAt));
  const latest = rows[0];
  if (!latest || latest.attempts >= 5) throw new HttpError(401, 'Code expired — request a new one');
  const batch = rows.filter((r) => r.codeHash === latest.codeHash);
  if (!(await bcrypt.compare(code, latest.codeHash))) {
    await db.update(otpCodes).set({ attempts: sql`${otpCodes.attempts} + 1` }).where(inArray(otpCodes.id, batch.map((r) => r.id)));
    throw new HttpError(401, 'Incorrect code');
  }
  const allowed = await vendorsForEmail(t.id, email);
  const choices = allowed.filter((v) => batch.some((r) => r.vendorId === v.id));
  if (!choices.length) throw new HttpError(401, 'Your access has been removed. Contact the buyer.');
  if (choices.length > 1 && !vendorId) return res.json({ choose: choices.map((v) => ({ id: v.id, name: v.name, code: v.code })) });
  const v = vendorId ? choices.find((x) => x.id === vendorId) : choices[0];
  if (!v) throw new HttpError(400, 'Choose one of the listed suppliers');
  await db.update(otpCodes).set({ used: true }).where(inArray(otpCodes.id, batch.map((r) => r.id)));
  await createSession(req, res, { kind: 'VENDOR', tenant: t, vendorId: v.id, contactEmail: email });
  await audit({ tenantId: t.id, vendorId: v.id, actor: email, action: 'VENDOR_SIGNED_IN', detail: { via: 'email' }, ip: req.ip });
  res.json({ ok: true });
}));

vendorAuthRouter.post('/logout', ah(async (req, res) => {
  await destroySession(res, 'VENDOR', req.vendor?.sessionId);
  res.json({ ok: true });
}));
