import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { app, login } from './helpers.js';
import { gstinCheckChar } from '../src/lib/validators.js';
import { db, schema } from '../src/lib/db.js';
import { env } from '../src/lib/env.js';
import { createTenant } from '../src/services/tenants.js';
import { getPlatformSettings } from '../src/platform/settings.js';
import { amountInWords, financialYear, invoicePdf, issueInvoice, runBillingDaily, setRazorpayFetch, taxFor, validGstin } from '../src/services/billing.js';

const gstin = (pan: string, state: string) => { const base = `${state}${pan}1Z`; return base + gstinCheckChar(base); };
const SELLER_GSTIN = gstin('AAFCI1234K', '33');
const saved = { id: env.int.RAZORPAY_KEY_ID, secret: env.int.RAZORPAY_KEY_SECRET, wh: env.int.RAZORPAY_WEBHOOK_SECRET };

beforeAll(async () => {
  await getPlatformSettings();
  await db.update(schema.platformSettings).set({ billing: {
    seller: { name: 'Integratatech.ai Pvt Ltd', gstin: SELLER_GSTIN, address: '12 Anna Salai, Chennai 600002', stateCode: '33', email: 'accounts@integratatech.ai' },
    prices: { INR: { standard: { monthly: 25000, yearly: 250000 } }, USD: { standard: { monthly: 300, yearly: 3000 } } },
    gstRate: 18, sac: '997331', dueDays: 15, prefix: 'VGT',
  } }).where(eq(schema.platformSettings.id, 'default'));
});
afterAll(() => { env.int.RAZORPAY_KEY_ID = saved.id; env.int.RAZORPAY_KEY_SECRET = saved.secret; env.int.RAZORPAY_WEBHOOK_SECRET = saved.wh; });

async function trialWorkspace(slug: string, country = 'IN') {
  await createTenant({ slug, name: `${slug} Ltd`, adminName: 'Bill Admin', adminEmail: `admin@${slug}.test`, adminPassword: 'Demo@12345', country });
  await db.update(schema.tenants).set({ plan: 'trial', trialEndsAt: new Date(Date.now() + 5 * 86_400_000) }).where(eq(schema.tenants.slug, slug));
  return login(`admin@${slug}.test`, slug, 'Demo@12345');
}

describe('billing', () => {
  test('helpers: financial year, GST split, words, GSTIN', () => {
    expect(financialYear(new Date('2026-04-01T00:00:00+05:30'))).toBe('2026-27');
    expect(financialYear(new Date('2026-03-31T23:00:00+05:30'))).toBe('2025-26');
    expect(taxFor(2_500_000, '33', { country: 'IN', stateCode: '33' }, 18)).toMatchObject({ taxMode: 'INTRA', cgst: 225_000, sgst: 225_000, igst: 0 });
    expect(taxFor(2_500_000, '33', { country: 'IN', stateCode: '27' }, 18)).toMatchObject({ taxMode: 'INTER', igst: 450_000 });
    expect(taxFor(30_000, '33', { country: 'AE' }, 18)).toMatchObject({ taxMode: 'EXPORT', igst: 0 });
    expect(amountInWords(29_500_000, 'INR')).toBe('Rupees Two Lakh Ninety Five Thousand only');
    expect(amountInWords(30_050, 'USD')).toBe('USD Three Hundred and Fifty Cents only');
    expect(validGstin(SELLER_GSTIN)).toBe(true);
    expect(validGstin(SELLER_GSTIN.slice(0, 14) + (SELLER_GSTIN[14] === 'A' ? 'B' : 'A'))).toBe(false);
  });

  test('upgrade from trial: details → invoice with CGST+SGST → pay → Standard plan and next renewal date', async () => {
    const admin = await trialWorkspace('bill-tn');
    const first = (await admin.get('/api/admin/billing')).body;
    expect(first).toMatchObject({ plan: 'trial', currency: 'INR', sellerReady: true, testPay: true });
    expect(first.prices.standard).toEqual({ monthly: 25000, yearly: 250000 });
    expect((await admin.post('/api/admin/billing/upgrade', { cycle: 'yearly' })).status).toBe(409); // no billing details yet

    const buyerGstin = gstin('AAFCB1234K', '33');
    const wrong = buyerGstin.slice(0, 14) + (buyerGstin[14] === 'A' ? 'B' : 'A');
    expect((await admin.put('/api/admin/billing/details', { legalName: 'Bill TN Pvt Ltd', gstin: wrong, address: '1 Mount Road', email: 'accounts@bill-tn.test', country: 'IN' })).status).toBe(422);
    const saved = await admin.put('/api/admin/billing/details', { legalName: 'Bill TN Pvt Ltd', gstin: buyerGstin, address: '1 Mount Road', city: 'Chennai', postalCode: '600002', email: 'accounts@bill-tn.test', country: 'IN' });
    expect(saved.body.billing).toMatchObject({ stateCode: '33', gstin: buyerGstin });

    const up = await admin.post('/api/admin/billing/upgrade', { cycle: 'yearly' });
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const inv = up.body.invoice;
    expect(inv.number).toMatch(new RegExp(`^VGT/${financialYear(new Date())}/\\d{4}$`));
    expect(inv).toMatchObject({ currency: 'INR', subtotal: 25_000_000, tax: 4_500_000, total: 29_500_000, taxMode: 'INTRA', status: 'DUE', activatesPlan: true });
    expect((await admin.post('/api/admin/billing/upgrade', { cycle: 'monthly' })).body.invoice.id).toBe(inv.id); // same open invoice

    const pdf = await admin.agent.get(`/api/admin/billing/invoices/${inv.id}/pdf`).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

    expect((await admin.post(`/api/admin/billing/invoices/${inv.id}/test-pay`)).body.invoice.status).toBe('PAID');
    const t = await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'bill-tn') });
    expect(t).toMatchObject({ plan: 'standard', trialEndsAt: null });
    expect(t!.billing).toMatchObject({ cycle: 'yearly', autoInvoice: true, nextInvoiceOn: new Date(inv.periodEnd).toISOString().slice(0, 10) });
    expect((await admin.get('/api/auth/me')).body.plan.key).toBe('standard');
  });

  test('a Gulf customer is invoiced in USD as a zero-rated export; IGST for another Indian state', async () => {
    await trialWorkspace('bill-ae', 'AE');
    const ae = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'bill-ae') }))!;
    await db.update(schema.tenants).set({ billing: { legalName: 'Dunes LLC', address: 'Bay Square, Dubai', country: 'AE', email: 'ap@dunes.test' } }).where(eq(schema.tenants.id, ae.id));
    const inv = await issueInvoice((await db.query.tenants.findFirst({ where: eq(schema.tenants.id, ae.id) }))!, { plan: 'standard', cycle: 'monthly', actor: 'test' });
    expect(inv).toMatchObject({ currency: 'USD', subtotal: 30_000, igst: 0, total: 30_000, taxMode: 'EXPORT' });
    expect((await invoicePdf(inv)).subarray(0, 4).toString()).toBe('%PDF');

    await trialWorkspace('bill-mh');
    const mh = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'bill-mh') }))!;
    await db.update(schema.tenants).set({ billing: { legalName: 'MH Co', address: 'Pune', country: 'IN', stateCode: '27', email: 'ap@mh.test' } }).where(eq(schema.tenants.id, mh.id));
    const i2 = await issueInvoice((await db.query.tenants.findFirst({ where: eq(schema.tenants.id, mh.id) }))!, { plan: 'standard', cycle: 'monthly', actor: 'test' });
    expect(i2).toMatchObject({ taxMode: 'INTER', igst: 450_000, cgst: 0, total: 2_950_000 });
    expect(Number(i2.number.slice(-4))).toBe(Number(inv.number.slice(-4)) + 1);
  });

  test('Razorpay: payment link on issue; signed webhook marks it paid', async () => {
    env.int.RAZORPAY_KEY_ID = 'rzp_test_x'; env.int.RAZORPAY_KEY_SECRET = 'secret'; env.int.RAZORPAY_WEBHOOK_SECRET = 'whsecret';
    const sent: any[] = [];
    setRazorpayFetch((async (_url: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ id: 'plink_123', short_url: 'https://rzp.io/i/abc' }), { status: 200 }); }) as unknown as typeof fetch);
    await trialWorkspace('bill-rzp');
    const t = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'bill-rzp') }))!;
    await db.update(schema.tenants).set({ billing: { legalName: 'RZP Co', address: 'Chennai', country: 'IN', stateCode: '33', email: 'ap@rzp.test' } }).where(eq(schema.tenants.id, t.id));
    const inv = await issueInvoice((await db.query.tenants.findFirst({ where: eq(schema.tenants.id, t.id) }))!, { plan: 'standard', cycle: 'monthly', actor: 'test', activatesPlan: true });
    expect(inv).toMatchObject({ paymentLinkId: 'plink_123', paymentLinkUrl: 'https://rzp.io/i/abc' });
    expect(sent[0]).toMatchObject({ amount: 2_950_000, currency: 'INR', reference_id: inv.number });

    const body = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_123', status: 'paid' } }, payment: { entity: { id: 'pay_999', method: 'upi' } } } });
    expect((await request(app).post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', 'bad').send(body)).status).toBe(401);
    const sig = crypto.createHmac('sha256', 'whsecret').update(body).digest('hex');
    expect((await request(app).post('/api/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', sig).send(body)).body).toMatchObject({ result: 'paid' });
    expect(await db.query.invoices.findFirst({ where: eq(schema.invoices.id, inv.id) })).toMatchObject({ status: 'PAID', paymentRef: 'pay_999', paymentMethod: 'razorpay (upi)' });
    expect((await db.query.tenants.findFirst({ where: eq(schema.tenants.id, t.id) }))!.plan).toBe('standard');
    const admin = await login('admin@bill-rzp.test', 'bill-rzp', 'Demo@12345');
    expect((await admin.post(`/api/admin/billing/invoices/${inv.id}/test-pay`)).status).toBe(403); // live payments: no test button
    env.int.RAZORPAY_KEY_ID = saved.id; env.int.RAZORPAY_KEY_SECRET = saved.secret;
  });

  test('daily run: renewal invoice on the due date, then overdue reminders', async () => {
    await trialWorkspace('bill-renew');
    const t = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'bill-renew') }))!;
    const today = new Date().toISOString().slice(0, 10);
    await db.update(schema.tenants).set({ plan: 'standard', trialEndsAt: null, billing: { legalName: 'Renew Co', address: 'Chennai', country: 'IN', stateCode: '33', email: 'ap@renew.test', cycle: 'monthly', autoInvoice: true, nextInvoiceOn: today } }).where(eq(schema.tenants.id, t.id));
    const r = await runBillingDaily();
    expect(r.issued).toBeGreaterThanOrEqual(1);
    const inv = await db.query.invoices.findFirst({ where: eq(schema.invoices.tenantId, t.id) });
    expect(inv).toMatchObject({ plan: 'standard', cycle: 'monthly', status: 'DUE' });
    expect((await db.query.tenants.findFirst({ where: eq(schema.tenants.id, t.id) }))!.billing.nextInvoiceOn).not.toBe(today);
    expect((await runBillingDaily()).issued).toBe(0); // not twice

    await db.update(schema.invoices).set({ dueAt: new Date(Date.now() - 8 * 86_400_000) }).where(eq(schema.invoices.id, inv!.id));
    await runBillingDaily();
    expect((await db.query.invoices.findFirst({ where: eq(schema.invoices.id, inv!.id) }))!.remindersSent).toBe(2);
    expect(await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.subject, `Reminder: invoice ${inv!.number} is overdue`) })).toBeTruthy();
  });
});
