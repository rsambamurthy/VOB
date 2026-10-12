/**
 * Self-service sign-up (/api/signup). Two steps so every new workspace has a verified owner:
 *   1. POST /            company, name, work email, workspace ID → emails a confirmation link (24 h)
 *   2. POST /complete    token + password → workspace created on the sign-up plan, owner signed in
 * Off until a platform admin enables it. Protected by rate limits, a honeypot field and (optionally) a
 * block on free email providers.
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, count, eq, gte, isNull } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { env } from '../lib/env.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';
import { passwordProblem } from '../lib/password.js';
import { lookupLimiter, sensitiveLimiter } from '../lib/rateLimits.js';
import { PLANS } from '../lib/plans.js';
import { createSession } from '../auth/session.js';
import { createTenant, slugProblem, suggestSlug } from '../services/tenants.js';
import { getPlatformSettings } from './settings.js';
import { platformLog } from './session.js';

const { signups } = schema;
export const signupRouter = Router();
const DAY = 86_400_000;

/** Common free mailbox providers; blocked when "work email only" is on. */
const FREE_EMAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'ymail.com', 'rocketmail.com', 'outlook.com', 'outlook.in', 'hotmail.com', 'hotmail.co.uk',
  'live.com', 'live.in', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'yandex.ru',
  'zoho.com', 'zohomail.com', 'zohomail.in', 'rediffmail.com', 'rediff.com', 'tutanota.com', 'tuta.io', 'fastmail.com', 'hey.com', 'inbox.com', 'mailinator.com', 'guerrillamail.com',
  'temp-mail.org', '10minutemail.com', 'sharklasers.com', 'yopmail.com', 'trashmail.com', 'getnada.com', 'dispostable.com']);
export const isFreeEmail = (email: string) => FREE_EMAIL.has(email.split('@')[1]?.toLowerCase() ?? '');

signupRouter.get('/config', ah(async (_req, res) => {
  const s = await getPlatformSettings();
  res.json({ enabled: s.signupEnabled, plan: PLANS[s.signupPlan]?.label ?? s.signupPlan, trialDays: s.signupPlan === 'trial' ? s.trialDays : null, termsUrl: s.termsUrl, workEmailOnly: s.blockFreeEmail });
}));

signupRouter.get('/check-slug', lookupLimiter, ah(async (req, res) => {
  const slug = String(req.query.slug ?? '').trim().toLowerCase();
  const company = String(req.query.company ?? '').trim();
  if (!slug && company) return res.json({ slug: await suggestSlug(company), available: true, reason: null });
  const problem = await slugProblem(slug);
  res.json({ slug, available: !problem, reason: problem, suggestion: problem && company ? await suggestSlug(company) : undefined });
}));

signupRouter.post('/', sensitiveLimiter, ah(async (req, res) => {
  const s = await getPlatformSettings();
  if (!s.signupEnabled) throw new HttpError(403, 'Sign-up is not open right now. Contact us and we’ll set up your workspace.', undefined, 'SIGNUP_CLOSED');
  const input = z.object({
    company: z.string().trim().min(2, 'Enter your company name').max(120),
    name: z.string().trim().min(2, 'Enter your name').max(100),
    email: z.string().trim().toLowerCase().email('Enter a valid email address'),
    slug: z.string().trim().toLowerCase().min(1, 'Choose a workspace ID'),
    agree: z.literal(true, { errorMap: () => ({ message: 'Please accept the terms to continue' }) }),
    website: z.string().optional(), // honeypot: real people never see this field
  }).parse(req.body);
  if (input.website) return res.json({ ok: true, email: input.email }); // a bot; pretend it worked
  if (s.blockFreeEmail && isFreeEmail(input.email)) throw new HttpError(400, 'Please use your work email address (not Gmail, Outlook.com, Yahoo and similar).', { field: 'email' }, 'WORK_EMAIL_REQUIRED');
  const problem = await slugProblem(input.slug);
  if (problem) throw new HttpError(problem.includes('taken') ? 409 : 400, `Workspace ID: ${problem}`, { field: 'slug', suggestion: await suggestSlug(input.company) }, 'SLUG');
  // At most 3 confirmation emails per address per day (quietly ignored beyond that).
  const [recent] = await db.select({ n: count() }).from(signups).where(and(eq(signups.email, input.email), gte(signups.createdAt, new Date(Date.now() - DAY))));
  if (Number(recent.n) >= 3) return res.json({ ok: true, email: input.email });
  const token = randomToken();
  await db.insert(signups).values({ email: input.email, name: input.name, company: input.company, slug: input.slug, tokenHash: sha256(token), expiresAt: new Date(Date.now() + DAY), ip: req.ip });
  await sendMail({
    tenantId: null, to: input.email, subject: 'Confirm your email to create your VendorGate workspace',
    body: `Hello ${input.name},\n\nThanks for signing up ${input.company} for VendorGate. Confirm your email address and choose a password to finish creating your workspace (workspace ID: ${input.slug}).\n\nThe link is valid for 24 hours. If you didn’t sign up, you can ignore this email.`,
    link: `${env.appBaseUrl}/signup/verify/${token}`,
  });
  res.json({ ok: true, email: input.email });
}));

async function openSignup(token: string) {
  const row = await db.query.signups.findFirst({ where: eq(signups.tokenHash, sha256(token)) });
  if (!row || row.expiresAt < new Date()) throw new HttpError(400, 'This link is invalid or has expired. Sign up again to get a new one.', undefined, 'SIGNUP_LINK');
  if (row.completedAt) throw new HttpError(409, 'This workspace has already been created. Sign in instead.', { workspace: row.slug }, 'SIGNUP_DONE');
  return row;
}

signupRouter.get('/verify/:token', ah(async (req, res) => {
  const row = await openSignup(req.params.token);
  const problem = await slugProblem(row.slug);
  res.json({ company: row.company, name: row.name, email: row.email, slug: row.slug, slugAvailable: !problem, suggestion: problem ? await suggestSlug(row.company) : undefined });
}));

signupRouter.post('/complete', sensitiveLimiter, ah(async (req, res) => {
  const settings = await getPlatformSettings();
  if (!settings.signupEnabled) throw new HttpError(403, 'Sign-up is not open right now. Contact us and we’ll set up your workspace.', undefined, 'SIGNUP_CLOSED');
  const input = z.object({ token: z.string(), password: z.string(), slug: z.string().trim().toLowerCase().optional() }).parse(req.body);
  const row = await openSignup(input.token);
  const slug = input.slug || row.slug;
  const pwProblem = passwordProblem(input.password, { email: row.email, name: row.name });
  if (pwProblem) throw new HttpError(400, pwProblem, { field: 'password' });
  const problem = await slugProblem(slug);
  if (problem) throw new HttpError(409, `Workspace ID: ${problem}`, { field: 'slug', suggestion: await suggestSlug(row.company) }, 'SLUG');

  // Claim the sign-up first so a double click can't create two workspaces.
  const [claimed] = await db.update(signups).set({ completedAt: new Date() }).where(and(eq(signups.id, row.id), isNull(signups.completedAt))).returning();
  if (!claimed) throw new HttpError(409, 'This workspace has already been created. Sign in instead.', { workspace: row.slug }, 'SIGNUP_DONE');
  let r: Awaited<ReturnType<typeof createTenant>>;
  try {
    r = await createTenant({
      slug, name: row.company, adminName: row.name, adminEmail: row.email, adminPassword: input.password, source: 'signup',
      plan: settings.signupPlan, trialEndsAt: settings.signupPlan === 'trial' ? new Date(Date.now() + settings.trialDays * DAY) : null,
    });
  } catch (e) {
    await db.update(signups).set({ completedAt: null }).where(eq(signups.id, row.id));
    throw e;
  }
  await db.update(signups).set({ tenantId: r.tenant.id, slug }).where(eq(signups.id, row.id));
  await audit({ tenantId: r.tenant.id, actor: row.email, action: 'WORKSPACE_CREATED', detail: { via: 'self-service sign-up', plan: settings.signupPlan }, ip: req.ip });
  await platformLog({ actor: row.email, action: 'TENANT_SIGNED_UP', tenantId: r.tenant.id, detail: { slug, company: row.company, plan: settings.signupPlan }, ip: req.ip });
  await createSession(req, res, { kind: 'STAFF', tenant: r.tenant, userId: r.admin.id });
  await sendMail({
    tenantId: r.tenant.id, to: row.email, subject: `Your ${row.company} workspace is ready`,
    body: `Hello ${row.name},\n\nYour VendorGate workspace is ready.\n\nWorkspace ID: ${slug}\nSign in with: ${row.email}\n${r.tenant.trialEndsAt ? `Your free trial runs until ${r.tenant.trialEndsAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}.\n` : ''}\nGood first steps: add your logo and colours (Workspace), invite your team (Users), then review the vendor form and approval flow (Configuration).`,
    link: `${env.appBaseUrl}/login?workspace=${encodeURIComponent(slug)}`,
  });
  if (settings.notifyEmail) {
    await sendMail({ tenantId: null, to: settings.notifyEmail, subject: `New sign-up: ${row.company}`, body: `${row.name} <${row.email}> created the workspace "${slug}" (${row.company}) on the ${PLANS[settings.signupPlan]?.label ?? settings.signupPlan} plan.`, link: `${env.appBaseUrl}/platform/tenants/${r.tenant.id}` });
  }
  res.json({ ok: true, workspace: slug });
}));
