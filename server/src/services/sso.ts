/**
 * Single sign-on for staff. Each workspace chooses how its people sign in:
 *  - VendorGate password (+ 2FA), the default;
 *  - OpenID Connect: Microsoft Entra ID (Azure AD), Okta, Google Workspace, or any other OIDC provider;
 *  - SAML 2.0: AD FS, Okta / Entra SAML apps, Ping, JumpCloud…
 * With SSO on, password sign-in can stay on for everyone, for admins only (break-glass), or be switched
 * off — the last only after an admin has signed in through SSO successfully, so nobody locks themselves out.
 * Suppliers are not affected (they sign in with emailed codes).
 */
import * as oidc from 'openid-client';
import { SAML, type CacheProvider } from '@node-saml/node-saml';
import { and, eq, lt } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { env } from '../lib/env.js';
import { HttpError } from '../lib/http.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import type { Tenant } from '../db/schema.js';

export type SsoProvider = 'entra' | 'okta' | 'google' | 'oidc' | 'saml';
export type PasswordLogin = 'everyone' | 'admins' | 'off';

export interface SsoSettings {
  enabled: boolean;
  provider: SsoProvider;
  /** Button text, e.g. "Sign in with Microsoft". */
  label?: string;
  /* OpenID Connect */
  issuer?: string;
  clientId?: string;
  clientSecretEnc?: string;
  /* SAML 2.0 */
  samlEntryPoint?: string;
  samlIdpIssuer?: string;
  samlCert?: string;
  /** Only these email domains may sign in through SSO (empty = any address the provider vouches for). */
  allowedDomains: string[];
  passwordLogin: PasswordLogin;
  /** Create a VendorGate user on first sign-in (allowed domains only), with this role. */
  autoCreate: boolean;
  defaultRoleId?: string;
  /** Set when an admin has signed in through SSO with the current settings. */
  verifiedAt?: string;
  verifiedBy?: string;
}

export const PROVIDER_LABELS: Record<SsoProvider, string> = {
  entra: 'Microsoft', okta: 'Okta', google: 'Google', oidc: 'single sign-on', saml: 'single sign-on',
};

export const ssoOf = (t: Tenant): SsoSettings | undefined => (t.settings.sso?.enabled ? t.settings.sso : undefined);
export const buttonLabel = (s: SsoSettings) => s.label?.trim() || `Sign in with ${PROVIDER_LABELS[s.provider]}`;

/* ---------- URLs the identity provider needs ---------- */

export const oidcRedirectUri = () => `${env.appBaseUrl}/api/auth/sso/callback`;
export const samlAcsUrl = () => `${env.appBaseUrl}/api/auth/sso/saml/acs`;
export const samlEntityId = (slug: string) => `${env.appBaseUrl}/api/auth/sso/saml/${slug}`;

/* ---------- State carried through the identity provider (sealed, short-lived) ---------- */

export interface SsoState { t: string; v?: string; n?: string; s?: string; exp: number; next?: string }
export const seal = (s: Omit<SsoState, 'exp'>) => encrypt(JSON.stringify({ ...s, exp: Date.now() + 10 * 60_000 }));
export function unseal(raw: string | undefined): SsoState {
  try {
    const s = JSON.parse(decrypt(String(raw))) as SsoState;
    if (s.exp > Date.now()) return s;
  } catch { /* fall through */ }
  throw new HttpError(400, 'The sign-in took too long or was started in another browser. Please try again.');
}

/* ---------- OpenID Connect ---------- */

const discovered = new Map<string, { at: number; config: oidc.Configuration }>();
/** Test hook: lets the tests talk to a local fake provider over http. */
let allowHttpIssuers = !env.isProd;
export const setAllowHttpIssuers = (on: boolean) => { allowHttpIssuers = on; };

export async function oidcConfig(s: SsoSettings) {
  if (!s.issuer || !s.clientId) throw new HttpError(400, 'Single sign-on is not fully set up. Ask your administrator.');
  const key = `${s.issuer}|${s.clientId}|${s.clientSecretEnc ?? ''}`;
  const hit = discovered.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.config;
  const secret = s.clientSecretEnc ? decrypt(s.clientSecretEnc) : undefined;
  const insecure = allowHttpIssuers && s.issuer.startsWith('http://');
  const config = await oidc.discovery(new URL(s.issuer), s.clientId, secret, secret ? undefined : oidc.None(), insecure ? { execute: [oidc.allowInsecureRequests] } : undefined);
  discovered.set(key, { at: Date.now(), config });
  return config;
}
export const forgetOidcConfig = () => discovered.clear();

export async function oidcStart(tenant: Tenant, s: SsoSettings, next?: string) {
  const config = await oidcConfig(s);
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const params: Record<string, string> = {
    redirect_uri: oidcRedirectUri(), scope: 'openid email profile', state, nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', prompt: 'select_account',
  };
  // Google: only offer accounts of the workspace's domain.
  if (s.provider === 'google' && s.allowedDomains.length === 1) params.hd = s.allowedDomains[0];
  return { url: oidc.buildAuthorizationUrl(config, params).href, cookie: seal({ t: tenant.slug, v: verifier, n: nonce, s: state, next }) };
}

export async function oidcFinish(s: SsoSettings, state: SsoState, callbackUrl: URL) {
  const config = await oidcConfig(s);
  const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, { pkceCodeVerifier: state.v!, expectedState: state.s!, expectedNonce: state.n! });
  const c = tokens.claims();
  if (!c) throw new HttpError(401, 'The identity provider did not return who you are.');
  const email = String(c.email ?? c.preferred_username ?? c.upn ?? '').trim().toLowerCase();
  // Google and most providers say whether the address is verified; Entra's work accounts don't send the flag.
  if (c.email_verified === false) throw new HttpError(401, 'Your email address is not verified with your identity provider.');
  const name = String(c.name ?? [c.given_name, c.family_name].filter(Boolean).join(' ') ?? '').trim();
  return { email, name, subject: String(c.sub) };
}

/* ---------- SAML 2.0 ---------- */

/** Outstanding SAML requests live in the database, so the reply can be matched on any server. */
const samlCache: CacheProvider = {
  async saveAsync(key, value) {
    const at = new Date(value);
    await db.insert(schema.ssoRequests).values({ id: key, createdAt: Number.isNaN(at.getTime()) ? new Date() : at }).onConflictDoNothing();
    await db.delete(schema.ssoRequests).where(lt(schema.ssoRequests.createdAt, new Date(Date.now() - 60 * 60_000)));
    return { createdAt: Date.now(), value };
  },
  async getAsync(key) {
    const r = await db.query.ssoRequests.findFirst({ where: eq(schema.ssoRequests.id, key) });
    // node-saml reads this back as a date.
    return r && r.createdAt > new Date(Date.now() - 15 * 60_000) ? r.createdAt.toISOString() : null;
  },
  async removeAsync(key) {
    if (!key) return null;
    const [r] = await db.delete(schema.ssoRequests).where(eq(schema.ssoRequests.id, key)).returning();
    return r ? key : null;
  },
};

export function samlFor(tenant: Tenant, s: SsoSettings) {
  if (!s.samlEntryPoint || !s.samlCert) throw new HttpError(400, 'Single sign-on is not fully set up. Ask your administrator.');
  return new SAML({
    callbackUrl: samlAcsUrl(), entryPoint: s.samlEntryPoint, issuer: samlEntityId(tenant.slug), audience: samlEntityId(tenant.slug),
    idpIssuer: s.samlIdpIssuer || undefined, idpCert: s.samlCert.replace(/-----(BEGIN|END) CERTIFICATE-----|\s+/g, ''),
    wantAssertionsSigned: true, wantAuthnResponseSigned: false, validateInResponseTo: 'always' as any, cacheProvider: samlCache,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress', disableRequestedAuthnContext: true, acceptedClockSkewMs: 120_000,
  });
}

export async function samlStart(tenant: Tenant, s: SsoSettings, next?: string) {
  return samlFor(tenant, s).getAuthorizeUrlAsync(seal({ t: tenant.slug, next }), undefined, {});
}

const CLAIM = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/';
export async function samlFinish(tenant: Tenant, s: SsoSettings, body: Record<string, string>) {
  const { profile } = await samlFor(tenant, s).validatePostResponseAsync(body);
  if (!profile) throw new HttpError(401, 'The identity provider did not return who you are.');
  const p = profile as Record<string, any>;
  const email = String(p.email ?? p.mail ?? p[`${CLAIM}emailaddress`] ?? p['http://schemas.xmlsoap.org/claims/EmailAddress'] ?? p[`${CLAIM}upn`] ?? (String(p.nameID ?? '').includes('@') ? p.nameID : '')).trim().toLowerCase();
  const name = String(p.displayName ?? p[`${CLAIM}name`] ?? [p.givenName ?? p[`${CLAIM}givenname`], p.surname ?? p[`${CLAIM}surname`]].filter(Boolean).join(' ') ?? '').trim();
  return { email, name, subject: String(p.nameID ?? email) };
}

export function samlMetadata(tenant: Tenant, s: SsoSettings | undefined) {
  const cfg = s?.samlEntryPoint && s.samlCert ? s : { ...(s ?? {}), samlEntryPoint: 'https://idp.example/sso', samlCert: 'MIIB' } as SsoSettings;
  return samlFor(tenant, cfg).generateServiceProviderMetadata(null, null);
}

/* ---------- Who may use password sign-in ---------- */

/** Admins (anyone who can change workspace settings or manage users) keep password access in "admins" mode. */
export async function isWorkspaceAdmin(userId: string, tenantId: string) {
  const rs = await db.select({ permissions: schema.roles.permissions }).from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
    .where(and(eq(schema.userRoles.userId, userId), eq(schema.roles.tenantId, tenantId)));
  return rs.some((r) => r.permissions.includes('tenant.settings') || r.permissions.includes('users.manage'));
}

export const domainOf = (email: string) => email.split('@')[1] ?? '';
