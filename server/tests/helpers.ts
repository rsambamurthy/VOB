import request from 'supertest';
import { expect } from 'vitest';
import { gstinCheckChar } from '../src/lib/validators.js';
import { desc, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, schema } from '../src/lib/db.js';
import { DEMO_PASSWORD } from '../src/db/seed.js';

export const app = createApp();
export { DEMO_PASSWORD };

/** A cookie-keeping client that always sends the CSRF header. */
export function client() {
  const agent = request.agent(app);
  const h = { 'X-Requested-With': 'fetch' };
  return {
    agent,
    get: (url: string) => agent.get(url).set(h),
    post: (url: string, body?: object) => agent.post(url).set(h).send(body ?? {}),
    put: (url: string, body?: object) => agent.put(url).set(h).send(body ?? {}),
    patch: (url: string, body?: object) => agent.patch(url).set(h).send(body ?? {}),
    del: (url: string) => agent.delete(url).set(h),
    upload: (url: string, docType: string, content = '%PDF-1.4\n%%EOF', name = 'doc.pdf', type = 'application/pdf') =>
      agent.post(url).set(h).field('docType', docType).attach('file', Buffer.from(content), { filename: name, contentType: type }),
  };
}

export async function login(email: string, workspace = 'acme', password = DEMO_PASSWORD) {
  const c = client();
  const r = await c.post('/api/auth/login', { workspace, email, password });
  if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return c;
}

/** Latest email link sent to an address (the dev outbox stands in for a mailbox). */
export async function lastLinkTo(to: string) {
  const m = await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, to), orderBy: desc(schema.emailOutbox.createdAt) });
  return m?.link ?? undefined;
}

export const pathOf = (link: string) => new URL(link).pathname;
export const tokenOf = (link: string) => new URL(link).pathname.split('/').pop()!;

/** The auth tests turn on enforced 2FA for globex; reset that so other files can sign in with a password. */
export async function globexAdmin() {
  const t = await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'globex') });
  await db.update(schema.tenants).set({ settings: {} }).where(eq(schema.tenants.id, t!.id));
  await db.update(schema.users).set({ mfaEnabled: false, mfaSecretEnc: null }).where(eq(schema.users.email, 'admin@globex.test'));
  return login('admin@globex.test', 'globex');
}

/** Onboard a vendor all the way to APPROVED and return a signed-in vendor session. */
const PDF = '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF';
export async function approvedVendor(name: string, email: string) {
  const admin = await login('admin@acme.test');
  const id = (await admin.post('/api/staff/vendors', { name, vendorType: 'DOMESTIC', contactFirstName: 'Life', contactLastName: 'Cycle', contactEmail: email, contactMobile: '9800022233' })).body.vendor.id;
  const token = tokenOf((await lastLinkTo(email))!);
  const v = client();
  const { devOtp } = (await v.post('/api/vendor-auth/request-otp', { token })).body;
  await v.post('/api/vendor-auth/verify-otp', { token, code: devOtp });
  await v.post('/api/vendor/consent', { version: (await v.get('/api/vendor')).body.privacy.version });
  const pan = 'AAFCL1234Q'; const g = `27${pan}1Z`;
  await v.put('/api/vendor/profile/basic', { entityType: 'Company (Pvt / Public Ltd)', address: '1 Main Rd', region: 'Maharashtra', district: 'Pune', postalCode: '411001', msmeRegistered: 'No', supplyCategory: 'Goods' });
  await v.put('/api/vendor/profile/bank', { bankName: 'HDFC Bank', accountHolderName: name, accountNumber: '501000123456', bankBranch: 'Pune', ifsc: 'HDFC0000001' });
  await v.put('/api/vendor/profile/tax', { hasGst: 'Yes', gstin: g + gstinCheckChar(g), gstClassification: 'Regular', pan, cin: 'U74999MH2015PTC123456' });
  await v.put('/api/vendor/profile/risk', { fiscalYearEnd: 'March', currency: 'INR', turnoverYear: 'FY 2024-25', annualTurnover: '9000000', sourceOfInfo: 'Audited financial statements', hasRating: 'No', bankruptcy5y: 'No', litigation: 'No' });
  for (const t of ['PAN_CARD', 'GST_CERT', 'CANCELLED_CHEQUE', 'INCORPORATION_CERT']) expect((await v.upload('/api/vendor/documents', t, PDF)).status).toBe(201);
  expect((await v.post('/api/vendor/submit')).status).toBe(200);
  for (const u of ['tax@acme.test', 'finance@acme.test', 'mdm@acme.test']) expect((await (await login(u)).post(`/api/staff/vendors/${id}/decision`, { action: 'APPROVE' })).status).toBe(200);
  return { v, id, admin };
}

