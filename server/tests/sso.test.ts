/**
 * Staff single sign-on, end to end: a real (local) OpenID Connect provider issuing signed ID tokens,
 * and SAML responses signed with a throw-away certificate.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { SignedXml } from 'xml-crypto';
import selfsigned from 'selfsigned';
import { eq } from 'drizzle-orm';
import { client, login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';

/* ---------- A minimal OpenID Connect provider ---------- */

let server: Server;
let issuer = '';
const codes = new Map<string, { nonce: string; email: string; name: string; emailVerified?: boolean }>();
let nextUser = { email: 'admin@acme.test', name: 'Anita Rao', emailVerified: true as boolean | undefined };

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const idp = express();
  idp.use(express.urlencoded({ extended: false }));
  idp.get('/.well-known/openid-configuration', (_q, r) => r.json({
    issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
  }));
  idp.get('/jwks', (_q, r) => r.json({ keys: [jwk] }));
  idp.post('/token', async (q, r) => {
    const c = codes.get(q.body.code);
    if (!c || !q.body.code_verifier) return r.status(400).json({ error: 'invalid_grant' });
    const id_token = await new SignJWT({ email: c.email, name: c.name, nonce: c.nonce, ...(c.emailVerified === undefined ? {} : { email_verified: c.emailVerified }) })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuer).setAudience('vendorgate-client').setSubject(`sub-${c.email}`)
      .setIssuedAt().setExpirationTime('5m').sign(privateKey);
    r.json({ access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token });
  });
  await new Promise<void>((ok) => { server = idp.listen(0, '127.0.0.1', () => ok()); });
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  // Other test files sign in with passwords: leave the workspace as it was.
  const t = await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') });
  if (t) await db.update(schema.tenants).set({ settings: { ...t.settings, sso: undefined, requireMfa: false } }).where(eq(schema.tenants.id, t.id));
  server?.close();
});

/** The error shown on the login page after a refused sign-in. */
const msg = (location: string) => decodeURIComponent(location.replace(/\+/g, ' '));

const oidcSettings = (over: Record<string, unknown> = {}) => ({
  enabled: true, provider: 'entra', issuer, clientId: 'vendorgate-client', clientSecret: 's3cret', allowedDomains: ['acme.test'], passwordLogin: 'everyone', autoCreate: false, ...over,
});

/** Run a full OIDC sign-in in a fresh browser: start → provider → callback. Returns the browser and where it landed. */
async function oidcSignIn(as: typeof nextUser) {
  const b = client();
  const start = await b.get('/api/auth/sso/start?workspace=acme');
  expect(start.status).toBe(303);
  const url = new URL(start.headers.location);
  if (!url.href.startsWith(issuer)) return { b, location: start.headers.location as string };
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('redirect_uri')).toBe('http://app.test/api/auth/sso/callback');
  const code = crypto.randomUUID();
  codes.set(code, { nonce: url.searchParams.get('nonce')!, email: as.email, name: as.name, emailVerified: as.emailVerified });
  const cb = await b.get(`/api/auth/sso/callback?code=${code}&state=${encodeURIComponent(url.searchParams.get('state')!)}`);
  expect(cb.status).toBe(303);
  return { b, location: cb.headers.location as string };
}

describe('single sign-on: OpenID Connect (Entra ID, Okta, Google, any OIDC provider)', () => {
  test('admin sets it up; the login page offers the button; an admin signs in and that verifies the settings', async () => {
    const admin = await login('admin@acme.test');
    const view = (await admin.put('/api/admin/sso', oidcSettings())).body;
    expect(view.sso).toMatchObject({ enabled: true, provider: 'entra', hasClientSecret: true, buttonLabel: 'Sign in with Microsoft' });
    expect(view.sso.clientSecretEnc).toBeUndefined();
    expect(view.provider.redirectUri).toBe('http://app.test/api/auth/sso/callback');
    expect((await client().get('/api/auth/sso/info/acme')).body).toEqual({ enabled: true, label: 'Sign in with Microsoft', provider: 'entra', passwordLogin: 'everyone' });
    expect((await admin.post('/api/admin/sso/check')).body).toMatchObject({ ok: true });

    // Switching passwords off isn't allowed until an admin has come in through SSO.
    expect((await admin.put('/api/admin/sso', oidcSettings({ passwordLogin: 'off', clientSecret: '' }))).status).toBe(409);

    nextUser = { email: 'admin@acme.test', name: 'Anita Rao', emailVerified: true };
    const { b, location } = await oidcSignIn(nextUser);
    expect(location).toBe('http://app.test/staff/vendors');
    const me = (await b.get('/api/auth/me')).body;
    expect(me.user.email).toBe('admin@acme.test');
    expect((await admin.get('/api/admin/sso')).body.sso.verifiedBy).toBe('admin@acme.test');
    const log = (await admin.get('/api/admin/audit')).body.rows.find((r: any) => r.action === 'LOGIN_SSO');
    expect(log).toMatchObject({ actor: 'admin@acme.test', detail: { provider: 'entra' } });
  });

  test('unknown people, other domains and unverified emails are turned away; known users get in', async () => {
    let r = await oidcSignIn({ email: 'stranger@acme.test', name: 'S', emailVerified: true });
    expect(msg(r.location)).toMatch(/\/login\?workspace=acme&ssoError=.*doesn.t have access/);
    r = await oidcSignIn({ email: 'someone@gmail.com', name: 'G', emailVerified: true });
    expect(msg(r.location)).toMatch(/not allowed to sign in/);
    r = await oidcSignIn({ email: 'tax@acme.test', name: 'Suresh', emailVerified: false });
    expect(msg(r.location)).toMatch(/not verified/);
    r = await oidcSignIn({ email: 'tax@acme.test', name: 'Suresh', emailVerified: undefined }); // Entra sends no flag
    expect(r.location).toBe('http://app.test/staff/vendors');
    expect((await r.b.get('/api/auth/me')).body.user.email).toBe('tax@acme.test');
  });

  test('a callback without the browser cookie (another browser, or forged) is refused', async () => {
    const r = await client().get('/api/auth/sso/callback?code=x&state=y');
    expect(r.status).toBe(303);
    expect(msg(r.headers.location)).toMatch(/ssoError=.*another browser/);
  });

  test('users can be created on first sign-in, with the chosen role, for allowed domains only', async () => {
    const admin = await login('admin@acme.test');
    const { roles } = (await admin.get('/api/admin/sso')).body;
    const viewer = roles.find((x: any) => /view/i.test(x.name)) ?? roles[0];
    expect((await admin.put('/api/admin/sso', oidcSettings({ clientSecret: '', autoCreate: true }))).status).toBe(400); // role missing
    expect((await admin.put('/api/admin/sso', oidcSettings({ clientSecret: '', autoCreate: true, defaultRoleId: viewer.id }))).status).toBe(200);
    const r = await oidcSignIn({ email: 'new.joiner@acme.test', name: 'New Joiner', emailVerified: true });
    expect(r.location).toBe('http://app.test/staff/vendors');
    const me = (await r.b.get('/api/auth/me')).body;
    expect(me.user).toMatchObject({ email: 'new.joiner@acme.test', name: 'New Joiner' });
    expect(me.roles.map((x: any) => x.id)).toEqual([viewer.id]);
  });

  test('password sign-in: admins only (break-glass), then off; 2FA is left to the identity provider', async () => {
    const admin = await login('admin@acme.test');
    await admin.put('/api/admin/sso', oidcSettings({ clientSecret: '', passwordLogin: 'admins' }));
    const tax = client();
    const refused = await tax.post('/api/auth/login', { workspace: 'acme', email: 'tax@acme.test', password: 'Demo@12345' });
    expect(refused.status).toBe(403);
    expect(refused.body.message ?? refused.body.error).toMatch(/Sign in with Microsoft/);
    expect((await client().post('/api/auth/login', { workspace: 'acme', email: 'admin@acme.test', password: 'Demo@12345' })).status).toBe(200);

    // Verified earlier with these settings, so passwords may now be switched off entirely.
    expect((await admin.put('/api/admin/sso', oidcSettings({ clientSecret: '', passwordLogin: 'off' }))).status).toBe(200);
    expect((await client().post('/api/auth/login', { workspace: 'acme', email: 'admin@acme.test', password: 'Demo@12345' })).status).toBe(403);

    // Workspace requires 2FA: an SSO session isn't asked to set up VendorGate's own 2FA.
    const t = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
    await db.update(schema.tenants).set({ settings: { ...t.settings, requireMfa: true } }).where(eq(schema.tenants.id, t.id));
    const { b } = await oidcSignIn({ email: 'tax@acme.test', name: 'Suresh', emailVerified: true });
    const me = (await b.get('/api/auth/me')).body;
    expect(me.mfaSetupRequired).toBe(false);
    expect((await b.get('/api/staff/vendors')).status).toBe(200);
    await db.update(schema.tenants).set({ settings: { ...t.settings, requireMfa: false } }).where(eq(schema.tenants.id, t.id));

    // Changing the provider settings resets the check: passwords come back for admins until re-verified.
    const changed = await admin.put('/api/admin/sso', oidcSettings({ clientSecret: 'rotated', passwordLogin: 'off' }));
    expect(changed.status).toBe(409);
  });
});

/* ---------- SAML 2.0 ---------- */

let pem: { key: string; cert: string };
async function samlResponse(opts: { inResponseTo: string; email: string; audience: string; tamper?: boolean }) {
  const now = new Date(); const later = new Date(now.getTime() + 5 * 60_000);
  const id = `_a${crypto.randomUUID().replace(/-/g, '')}`;
  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${now.toISOString()}">`
    + `<saml:Issuer>https://idp.example.com</saml:Issuer>`
    + `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${opts.email}</saml:NameID>`
    + `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${opts.inResponseTo}" NotOnOrAfter="${later.toISOString()}" Recipient="http://app.test/api/auth/sso/saml/acs"/></saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${new Date(now.getTime() - 60_000).toISOString()}" NotOnOrAfter="${later.toISOString()}"><saml:AudienceRestriction><saml:Audience>${opts.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${now.toISOString()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
    + `<saml:AttributeStatement><saml:Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"><saml:AttributeValue>${opts.email}</saml:AttributeValue></saml:Attribute>`
    + `<saml:Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"><saml:AttributeValue>Anita Rao</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>`
    + `</saml:Assertion>`;
  const sig = new SignedXml({ privateKey: pem.key, canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#', signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256' });
  sig.addReference({ xpath: "//*[local-name(.)='Assertion']", transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'], digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' });
  sig.computeSignature(assertion, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
  let signed = sig.getSignedXml();
  if (opts.tamper) signed = signed.replace(`>${opts.email}</saml:NameID>`, '>intruder@acme.test</saml:NameID>');
  const response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r${crypto.randomUUID().replace(/-/g, '')}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="http://app.test/api/auth/sso/saml/acs" InResponseTo="${opts.inResponseTo}">`
    + `<saml:Issuer>https://idp.example.com</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signed}</samlp:Response>`;
  return Buffer.from(response).toString('base64');
}

describe('single sign-on: SAML 2.0 (AD FS, Okta / Entra SAML apps, Ping…)', () => {
  beforeAll(async () => {
    // Start from password sign-in (the OIDC tests switched it off).
    const t = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
    await db.update(schema.tenants).set({ settings: { ...t.settings, sso: undefined } }).where(eq(schema.tenants.id, t.id));
    const g: any = await (selfsigned as any).generate([{ name: 'commonName', value: 'idp.example.com' }], { keySize: 2048, days: 30, algorithm: 'sha256' });
    pem = { key: g.private, cert: g.cert };
  });

  async function samlStart() {
    const b = client();
    const start = await b.get('/api/auth/sso/start?workspace=acme');
    expect(start.status).toBe(303);
    const url = new URL(start.headers.location);
    expect(url.origin).toBe('https://idp.example.com');
    const xml = zlib.inflateRawSync(Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64')).toString();
    return { b, requestId: /ID="([^"]+)"/.exec(xml)![1], relay: url.searchParams.get('RelayState')! };
  }

  test('a signed response signs the user in; a tampered or replayed one is refused', async () => {
    const admin = await login('admin@acme.test');
    const put = await admin.put('/api/admin/sso', { enabled: true, provider: 'saml', samlEntryPoint: 'https://idp.example.com/sso', samlIdpIssuer: 'https://idp.example.com', samlCert: pem.cert, allowedDomains: ['acme.test'], passwordLogin: 'everyone', autoCreate: false });
    expect(put.status).toBe(200);
    const audience = put.body.provider.samlEntityId;
    expect(audience).toBe('http://app.test/api/auth/sso/saml/acme');
    expect((await client().get('/api/auth/sso/saml/acme/metadata')).text).toMatch(/AssertionConsumerService[^>]+Location="http:\/\/app\.test\/api\/auth\/sso\/saml\/acs"/);

    const { b, requestId, relay } = await samlStart();
    const SAMLResponse = await samlResponse({ inResponseTo: requestId, email: 'admin@acme.test', audience });
    // Posted by the browser from the identity provider: no X-Requested-With header.
    const acs = await b.agent.post('/api/auth/sso/saml/acs').type('form').send({ SAMLResponse, RelayState: relay });
    expect(acs.status).toBe(303);
    expect(acs.headers.location).toBe('http://app.test/staff/vendors');
    expect((await b.get('/api/auth/me')).body.user.email).toBe('admin@acme.test');

    // The same response again (replay) is refused: the request it answered has been used.
    const again = await client().agent.post('/api/auth/sso/saml/acs').type('form').send({ SAMLResponse, RelayState: relay });
    expect(msg(again.headers.location)).toMatch(/ssoError/);

    // A response whose content was changed after signing is refused.
    const s2 = await samlStart();
    const forged = await samlResponse({ inResponseTo: s2.requestId, email: 'admin@acme.test', audience, tamper: true });
    const bad = await s2.b.agent.post('/api/auth/sso/saml/acs').type('form').send({ SAMLResponse: forged, RelayState: s2.relay });
    expect(msg(bad.headers.location)).toMatch(/ssoError/);
    expect((await s2.b.get('/api/auth/me')).status).toBe(401);
  });
});
