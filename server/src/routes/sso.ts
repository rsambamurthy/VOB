/** Staff single sign-on: start, provider replies (OIDC callback / SAML ACS), SAML metadata, login-page info. */
import express, { Router, type Request, type Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { env } from '../lib/env.js';
import { ah, HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { createSession } from '../auth/session.js';
import { assertCanAddUser } from '../services/limits.js';
import { loginLimiter } from '../lib/rateLimits.js';
import type { Tenant } from '../db/schema.js';
import {
  buttonLabel, domainOf, isWorkspaceAdmin, oidcFinish, oidcStart, samlFinish, samlMetadata, samlStart, ssoOf, unseal, type SsoSettings,
} from '../services/sso.js';

export const ssoRouter = Router();
const COOKIE = 'vg_sso';
const cookieOpts = { httpOnly: true, secure: env.isProd, sameSite: 'lax' as const, path: '/api/auth/sso', maxAge: 10 * 60_000 };

const findTenant = (slug: string) => db.query.tenants.findFirst({ where: eq(schema.tenants.slug, String(slug ?? '').trim().toLowerCase()) });
/** Only same-site paths inside the staff app are allowed as the place to land after sign-in. */
const safeNext = (n: unknown) => (typeof n === 'string' && /^\/staff(\/[\w\-/?=&.%]*)?$/.test(n) ? n : undefined);

function fail(res: Response, slug: string | undefined, message: string) {
  const q = new URLSearchParams({ ...(slug ? { workspace: slug } : {}), ssoError: message });
  res.redirect(303, `${env.appBaseUrl}/login?${q}`);
}

/** Login page: does this workspace use single sign-on, and may this person still use a password? */
ssoRouter.get('/info/:workspace', ah(async (req, res) => {
  const tenant = await findTenant(req.params.workspace);
  const s = tenant && tenant.status === 'ACTIVE' ? ssoOf(tenant) : undefined;
  res.json(s ? { enabled: true, label: buttonLabel(s), provider: s.provider, passwordLogin: s.passwordLogin } : { enabled: false });
}));

ssoRouter.get('/start', loginLimiter, ah(async (req, res) => {
  const slug = String(req.query.workspace ?? '');
  const tenant = await findTenant(slug);
  const s = tenant && tenant.status === 'ACTIVE' ? ssoOf(tenant) : undefined;
  if (!tenant || !s) return fail(res, slug, 'Single sign-on is not set up for this workspace.');
  const next = safeNext(req.query.next);
  try {
    if (s.provider === 'saml') return res.redirect(303, await samlStart(tenant, s, next));
    const { url, cookie } = await oidcStart(tenant, s, next);
    res.cookie(COOKIE, cookie, cookieOpts);
    res.redirect(303, url);
  } catch (err: any) {
    logger.warn({ err, tenant: tenant.slug }, 'sso start failed');
    fail(res, tenant.slug, `Couldn’t reach your sign-in provider${err instanceof HttpError ? `: ${err.message}` : ''}. Ask your administrator to check the single sign-on settings.`);
  }
}));

/** OpenID Connect: the provider sends the browser back here with a code. */
ssoRouter.get('/callback', loginLimiter, ah(async (req, res) => {
  let slug: string | undefined;
  try {
    const state = unseal(req.cookies?.[COOKIE]);
    slug = state.t;
    res.clearCookie(COOKIE, { path: cookieOpts.path });
    if (req.query.error) throw new HttpError(401, String(req.query.error_description ?? req.query.error).slice(0, 200));
    const tenant = await findTenant(state.t);
    const s = tenant && ssoOf(tenant);
    if (!tenant || !s || s.provider === 'saml') throw new HttpError(400, 'Single sign-on is not set up for this workspace.');
    const who = await oidcFinish(s, state, new URL(req.originalUrl, env.appBaseUrl));
    await complete(req, res, tenant, s, who, state.next);
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'sso callback failed');
    fail(res, slug, err instanceof HttpError ? err.message : 'Single sign-on failed. Please try again.');
  }
}));

/** SAML 2.0: the provider posts the signed response here. */
ssoRouter.post('/saml/acs', express.urlencoded({ extended: false, limit: '2mb' }), loginLimiter, ah(async (req, res) => {
  let slug: string | undefined;
  try {
    const state = unseal(req.body?.RelayState);
    slug = state.t;
    const tenant = await findTenant(state.t);
    const s = tenant && ssoOf(tenant);
    if (!tenant || !s || s.provider !== 'saml') throw new HttpError(400, 'Single sign-on is not set up for this workspace.');
    const who = await samlFinish(tenant, s, req.body);
    await complete(req, res, tenant, s, who, state.next);
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'saml acs failed');
    fail(res, slug, err instanceof HttpError ? err.message : 'Single sign-on failed: the reply from your identity provider could not be verified.');
  }
}));

ssoRouter.get('/saml/:workspace/metadata', ah(async (req, res) => {
  const tenant = await findTenant(req.params.workspace);
  if (!tenant) throw new HttpError(404, 'Unknown workspace');
  res.type('application/xml').send(samlMetadata(tenant, tenant.settings.sso));
}));

/** Signed in at the identity provider: match (or create) the VendorGate user and start a session. */
async function complete(req: Request, res: Response, tenant: Tenant, s: SsoSettings, who: { email: string; name: string; subject: string }, next?: string) {
  if (tenant.status !== 'ACTIVE') throw new HttpError(403, 'This workspace is suspended. Contact support.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(who.email)) throw new HttpError(401, 'Your identity provider did not send an email address. Ask your administrator to include the email claim.');
  const domainOk = !s.allowedDomains.length || s.allowedDomains.includes(domainOf(who.email));
  if (!domainOk) {
    await audit({ tenantId: tenant.id, actor: who.email, action: 'LOGIN_SSO_REFUSED', detail: { reason: 'domain' }, ip: req.ip });
    throw new HttpError(403, `${who.email} is not allowed to sign in to this workspace.`);
  }
  let user = await db.query.users.findFirst({ where: and(eq(schema.users.tenantId, tenant.id), eq(schema.users.email, who.email)) });
  if (!user) {
    if (!s.autoCreate || !s.defaultRoleId || !s.allowedDomains.length) {
      await audit({ tenantId: tenant.id, actor: who.email, action: 'LOGIN_SSO_REFUSED', detail: { reason: 'no user' }, ip: req.ip });
      throw new HttpError(403, `${who.email} doesn’t have access to this workspace yet. Ask your administrator to add you.`);
    }
    await assertCanAddUser(tenant);
    const role = await db.query.roles.findFirst({ where: and(eq(schema.roles.id, s.defaultRoleId), eq(schema.roles.tenantId, tenant.id)) });
    if (!role) throw new HttpError(403, 'Single sign-on is set to create users, but its default role no longer exists. Ask your administrator.');
    [user] = await db.insert(schema.users).values({ tenantId: tenant.id, name: who.name || who.email, email: who.email, status: 'ACTIVE' }).returning();
    await db.insert(schema.userRoles).values({ userId: user.id, roleId: role.id });
    await audit({ tenantId: tenant.id, actor: who.email, action: 'USER_CREATED_SSO', detail: { role: role.name }, ip: req.ip });
  }
  if (user.status === 'DISABLED') throw new HttpError(403, 'Your account has been disabled. Contact your administrator.');
  if (user.status === 'INVITED') await db.update(schema.users).set({ status: 'ACTIVE', ...(who.name ? { name: who.name } : {}) }).where(eq(schema.users.id, user.id));
  await createSession(req, res, { kind: 'STAFF', tenant, userId: user.id, sso: true });
  await db.update(schema.users).set({ lastLoginAt: new Date(), failedLogins: 0, lockedUntil: null }).where(eq(schema.users.id, user.id));
  await audit({ tenantId: tenant.id, actor: user.email, action: 'LOGIN_SSO', detail: { provider: s.provider }, ip: req.ip });
  // An admin got through with the current settings: password sign-in may now be switched off.
  if (!s.verifiedAt && await isWorkspaceAdmin(user.id, tenant.id)) {
    const fresh = await db.query.tenants.findFirst({ where: eq(schema.tenants.id, tenant.id) });
    if (fresh?.settings.sso) await db.update(schema.tenants).set({ settings: { ...fresh.settings, sso: { ...fresh.settings.sso, verifiedAt: new Date().toISOString(), verifiedBy: user.email } } }).where(eq(schema.tenants.id, tenant.id));
  }
  res.redirect(303, `${env.appBaseUrl}${next ?? '/staff/vendors'}`);
}
