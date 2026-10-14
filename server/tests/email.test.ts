import crypto from 'node:crypto';
import { afterAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { desc, eq } from 'drizzle-orm';
import { app, login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import { env } from '../src/lib/env.js';
import { sendMail } from '../src/lib/mailer.js';
import { senderFor } from '../src/integrations/email/index.js';
import { setResendFetch, verifySvix } from '../src/integrations/email/resend.js';

const SECRET = `whsec_${Buffer.from('test-signing-secret-1234567890').toString('base64')}`;
const sign = (id: string, ts: number, body: string, secret = SECRET) =>
  `v1,${crypto.createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64')).update(`${id}.${ts}.${body}`).digest('base64')}`;
const saved = { secret: env.int.RESEND_WEBHOOK_SECRET, provider: env.int.EMAIL_PROVIDER, key: env.int.RESEND_API_KEY };
afterAll(() => { env.int.RESEND_WEBHOOK_SECRET = saved.secret; (env.int as any).EMAIL_PROVIDER = saved.provider; env.int.RESEND_API_KEY = saved.key; });

async function acmeVendor() {
  const admin = await login('admin@acme.test');
  const email = `bounce+${Date.now()}@supplier.test`;
  const r = await admin.post('/api/staff/vendors', { name: `Bounce Co ${Date.now()}`, vendorType: 'DOMESTIC', contactFirstName: 'B', contactLastName: 'C', contactEmail: email, contactMobile: '9876543210' });
  expect(r.status).toBe(201);
  return { admin, email, id: r.body.vendor.id as string };
}

describe('email delivery', () => {
  test('sender: workspace name by default; own sender name, reply-to and verified domain', () => {
    const t = { name: 'Acme Industries Ltd', branding: {}, settings: {} } as any;
    expect(senderFor(t).from).toMatch(/^"Acme Industries Ltd via VendorGate" </);
    const own = senderFor({ ...t, settings: { email: { fromName: 'Acme "Procurement"', replyTo: 'buy@acme.test', domain: { name: 'mail.acme.test', status: 'verified', fromLocal: 'suppliers' } } } });
    expect(own).toEqual({ from: '"Acme Procurement" <suppliers@mail.acme.test>', replyTo: 'buy@acme.test' });
    expect(senderFor({ ...t, settings: { email: { domain: { name: 'mail.acme.test', status: 'pending' } } } }).from).not.toContain('mail.acme.test');
  });

  test('Svix signatures: valid, tampered, stale', () => {
    const now = Date.now(), ts = Math.floor(now / 1000), body = '{"type":"email.delivered"}';
    const h = { 'svix-id': 'msg_1', 'svix-timestamp': String(ts), 'svix-signature': `v1,bogus ${sign('msg_1', ts, body)}` };
    expect(verifySvix(h, body, SECRET, now)).toBe(true);
    expect(verifySvix(h, body + ' ', SECRET, now)).toBe(false);
    expect(verifySvix(h, body, SECRET, now + 10 * 60_000)).toBe(false);
    expect(verifySvix({}, body, SECRET, now)).toBe(false);
  });

  test('a hard bounce stops sending to the address, flags the supplier, and can be cleared', async () => {
    env.int.RESEND_WEBHOOK_SECRET = SECRET;
    const { admin, email, id } = await acmeVendor();
    const out = await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, email), orderBy: desc(schema.emailOutbox.createdAt) });
    await db.update(schema.emailOutbox).set({ providerMessageId: 'em_123', status: 'SENT' }).where(eq(schema.emailOutbox.id, out!.id));

    const body = JSON.stringify({ type: 'email.bounced', created_at: new Date().toISOString(), data: { email_id: 'em_123', to: [email], bounce: { type: 'Permanent', message: 'Mailbox does not exist' } } });
    const ts = Math.floor(Date.now() / 1000);
    expect((await request(app).post('/api/webhooks/resend').set('Content-Type', 'application/json').set({ 'svix-id': 'm1', 'svix-timestamp': String(ts), 'svix-signature': 'v1,wrong' }).send(body)).status).toBe(401);
    const ok = await request(app).post('/api/webhooks/resend').set('Content-Type', 'application/json').set({ 'svix-id': 'm1', 'svix-timestamp': String(ts), 'svix-signature': sign('m1', ts, body) }).send(body);
    expect(ok.body).toMatchObject({ ok: true, result: 'bounced' });

    expect((await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.id, out!.id) }))).toMatchObject({ bounceType: 'PERMANENT', error: 'Mailbox does not exist' });
    const detail = (await admin.get(`/api/staff/vendors/${id}`)).body;
    expect(detail.flags.map((f: any) => f.code)).toContain('EMAIL_BOUNCING');
    expect((await admin.get('/api/admin/email')).body.bounced.map((b: any) => b.email)).toContain(email);

    await sendMail({ tenantId: null, to: email.toUpperCase(), subject: 'After bounce', body: 'x' });
    expect((await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.subject, 'After bounce') }))).toMatchObject({ status: 'FAILED' });

    expect((await admin.post('/api/admin/email/unsuppress', { address: email })).status).toBe(200);
    expect((await admin.get(`/api/staff/vendors/${id}`)).body.flags.map((f: any) => f.code)).not.toContain('EMAIL_BOUNCING');
    expect(await db.query.emailSuppressions.findFirst({ where: eq(schema.emailSuppressions.address, email) })).toBeUndefined();
  });

  test('changing the contact email clears the bounce, tells the old address, and re-sends the invite', async () => {
    const { admin, email, id } = await acmeVendor();
    await db.update(schema.vendors).set({ emailBouncedAt: new Date(), emailBounceReason: 'Bounced' }).where(eq(schema.vendors.id, id));
    expect((await admin.post(`/api/staff/vendors/${id}/contact`, { email: 'x', reason: 'new' })).status).toBe(400);
    const next = `new+${Date.now()}@supplier.test`;
    expect((await admin.post(`/api/staff/vendors/${id}/contact`, { email: next, reason: 'old address bounced; confirmed by phone' })).status).toBe(200);
    const v = await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) });
    expect(v).toMatchObject({ contactEmail: next, emailBouncedAt: null });
    expect(await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, email), orderBy: desc(schema.emailOutbox.createdAt) })).toMatchObject({ subject: expect.stringContaining('contact email was changed') });
    expect(await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, next) })).toMatchObject({ subject: expect.stringContaining('invitation') });
    expect((await (await login('tax@acme.test')).post(`/api/staff/vendors/${id}/contact`, { email: 'z@z.test', reason: 'test' })).status).toBe(403);
  });

  test('sender settings and own domain (Resend Domains API)', async () => {
    const admin = await login('admin@acme.test');
    expect((await admin.patch('/api/admin/tenant', { email: { fromName: 'Acme Procurement', replyTo: 'not-an-email' } })).status).toBe(400);
    expect((await admin.patch('/api/admin/tenant', { email: { fromName: 'Acme Procurement', replyTo: 'buy@acme.test' } })).status).toBe(200);
    expect((await admin.get('/api/admin/email')).body.sender).toMatchObject({ from: expect.stringMatching(/^"Acme Procurement"/), replyTo: 'buy@acme.test' });

    expect((await admin.post('/api/admin/email/domain', { name: 'mail.acme.test' })).status).toBe(409); // not on Resend
    (env.int as any).EMAIL_PROVIDER = 'resend'; env.int.RESEND_API_KEY = 're_test';
    const calls: string[] = [];
    let status = 'not_started';
    setResendFetch((async (url: string, init: RequestInit) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      const body = { id: 'dom_1', name: 'mail.acme.test', status, records: [{ record: 'SPF', type: 'TXT', name: 'send.mail', value: 'v=spf1 include:amazonses.com ~all', status: 'not_started' }] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch);
    const add = await admin.post('/api/admin/email/domain', { name: 'Mail.Acme.test', fromLocal: 'suppliers' });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    expect(add.body.domain).toMatchObject({ name: 'mail.acme.test', status: 'pending', fromLocal: 'suppliers' });
    expect(add.body.domain.records[0]).toMatchObject({ type: 'TXT', name: 'send.mail' });
    status = 'verified';
    expect((await admin.post('/api/admin/email/domain/check')).body.domain.status).toBe('verified');
    expect((await admin.get('/api/admin/email')).body.sender.from).toBe('"Acme Procurement" <suppliers@mail.acme.test>');
    expect((await admin.del('/api/admin/email/domain')).status).toBe(200);
    expect(calls).toEqual(['POST https://api.resend.com/domains', 'POST https://api.resend.com/domains/dom_1/verify', 'GET https://api.resend.com/domains/dom_1', 'DELETE https://api.resend.com/domains/dom_1']);
    await admin.patch('/api/admin/tenant', { email: { fromName: '', replyTo: '' } });
  });

  test('two-factor sign-in enforced by the platform cannot be switched off by the workspace', async () => {
    const t = await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') });
    await db.update(schema.tenants).set({ settings: { ...t!.settings, mfaEnforcedByPlatform: true } }).where(eq(schema.tenants.id, t!.id));
    const admin = await login('admin@acme.test');
    const r = await admin.patch('/api/admin/tenant', { settings: { requireMfa: false } });
    expect(r.status).toBe(409);
    expect(r.body.error ?? r.body.message).toMatch(/required for this workspace/);
    await db.update(schema.tenants).set({ settings: t!.settings }).where(eq(schema.tenants.id, t!.id));
  });
});
