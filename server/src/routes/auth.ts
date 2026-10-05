import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { and, desc, eq, gt, count, sql } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';

const { users, vendors, otpCodes } = schema;
const vendorByToken = (t: string) => db.query.vendors.findFirst({ where: eq(vendors.inviteToken, t) });
import { ah, HttpError } from '../lib/http.js';
import { signToken } from '../lib/auth.js';
import { env } from '../lib/env.js';
import { sendMail } from '../lib/mailer.js';
import { audit } from '../lib/audit.js';

export const authRouter = Router();

/**
 * PROTOTYPE staff login: pick a seeded user by email, no password.
 * Replace with SSO (Azure AD / Google Workspace) or password + MFA for production.
 */
authRouter.post('/staff-login', ah(async (req, res) => {
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  const user = await db.query.users.findFirst({ where: eq(users.email, email.toLowerCase()) });
  if (!user) throw new HttpError(401, 'Unknown staff user');
  const token = signToken({ kind: 'staff', userId: user.id, role: user.role, name: user.name, email: user.email });
  res.json({ token, user });
}));

const maskEmail = (e: string) => e.replace(/^(.{2}).*(@.*)$/, (_m, a, b) => `${a}•••${b}`);

/** Vendor opens the invite link: show who it's for (masked). */
authRouter.get('/invite/:token', ah(async (req, res) => {
  const v = await vendorByToken(req.params.token);
  if (!v) throw new HttpError(404, 'This invite link is not valid');
  res.json({ vendorName: v.name, email: maskEmail(v.contactEmail), status: v.status });
}));

authRouter.post('/request-otp', ah(async (req, res) => {
  const { token } = z.object({ token: z.string() }).parse(req.body);
  const v = await vendorByToken(token);
  if (!v) throw new HttpError(404, 'This invite link is not valid');
  const [{ recent }] = await db.select({ recent: count() }).from(otpCodes).where(and(eq(otpCodes.vendorId, v.id), gt(otpCodes.createdAt, new Date(Date.now() - 60_000))));
  if (recent >= 3) throw new HttpError(429, 'Too many codes requested. Please wait a minute.');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await db.insert(otpCodes).values({ vendorId: v.id, codeHash: await bcrypt.hash(code, 8), expiresAt: new Date(Date.now() + 10 * 60_000) });
  await sendMail(v.contactEmail, 'Your vendor portal sign-in code', `Your one-time code is ${code}. It expires in 10 minutes.`);
  res.json({ sentTo: maskEmail(v.contactEmail), ...(env.devShowOtp ? { devOtp: code } : {}) });
}));

authRouter.post('/verify-otp', ah(async (req, res) => {
  const { token, code } = z.object({ token: z.string(), code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }).parse(req.body);
  const v = await vendorByToken(token);
  if (!v) throw new HttpError(404, 'This invite link is not valid');
  const otp = await db.query.otpCodes.findFirst({ where: and(eq(otpCodes.vendorId, v.id), eq(otpCodes.used, false), gt(otpCodes.expiresAt, new Date())), orderBy: desc(otpCodes.createdAt) });
  if (!otp || otp.attempts >= 5) throw new HttpError(401, 'Code expired — request a new one');
  if (!(await bcrypt.compare(code, otp.codeHash))) {
    await db.update(otpCodes).set({ attempts: sql`${otpCodes.attempts} + 1` }).where(eq(otpCodes.id, otp.id));
    throw new HttpError(401, 'Incorrect code');
  }
  await db.update(otpCodes).set({ used: true }).where(eq(otpCodes.id, otp.id));
  if (v.status === 'INVITED') await db.update(vendors).set({ status: 'IN_PROGRESS' }).where(eq(vendors.id, v.id));
  await audit(v.id, v.contactEmail, 'VENDOR_SIGNED_IN');
  res.json({ token: signToken({ kind: 'vendor', vendorId: v.id, email: v.contactEmail }) });
}));
