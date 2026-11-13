/** Supplier performance scorecards: each measure, weights, the overall score, ratings and the supplier's view. */
import { beforeAll, describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { client, login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';

const day = (offset: number) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
let tenantId = ''; let vendorId = '';

beforeAll(async () => {
  const t = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'globex') }))!;
  tenantId = t.id;
  // A dedicated approved supplier with known history.
  const creator = (await db.query.users.findFirst({ where: eq(schema.users.tenantId, tenantId) }))!;
  const [v] = await db.insert(schema.vendors).values({ tenantId, code: 'VND-SC-1', name: 'Scorecard Steel', vendorType: 'DOMESTIC', contactFirstName: 'S', contactLastName: 'C', contactEmail: 'sc@steel.test', contactMobile: '9800000001', status: 'APPROVED', inviteToken: 'sc-token-1', createdById: creator.id, profile: { basic: { vendorName: 'Scorecard Steel' } } } as any).returning();
  vendorId = v.id;
  const P = schema.purchaseOrders, L = schema.poLines, R = schema.poReceipts;
  const mkPo = async (n: number, acceptance: string, acceptedHoursAfter: number | null) => {
    const seen = new Date(Date.now() - 20 * 86_400_000);
    const [po] = await db.insert(P).values({ tenantId, erpId: `SC-${n}`, poNumber: `PO-SC-${n}`, vendorId, supplierCode: 'SC1', currency: 'INR', source: 'demo', acceptance, firstSeenAt: seen, acceptedAt: acceptedHoursAfter === null ? null : new Date(seen.getTime() + acceptedHoursAfter * 3_600_000), acceptDueAt: new Date(seen.getTime() + 3 * 86_400_000) }).returning();
    return po;
  };
  // 4 orders: 3 accepted by the supplier (2 h, 4 h, 6 h), 1 auto-accepted → acknowledgement 3/4.
  const pos = [await mkPo(1, 'ACCEPTED', 2), await mkPo(2, 'ACCEPTED', 4), await mkPo(3, 'ACCEPTED', 6), await mkPo(4, 'AUTO_ACCEPTED', null)];
  // Lines due 10 days ago: 100 ordered / 100 received, 100 / 50 → fill rate 150/200 = 75 %.
  const [l1] = await db.insert(L).values({ tenantId, poId: pos[0].id, erpId: 'l1', lineNo: 1, description: 'Steel rod', quantity: '100', unitPrice: '10', amount: '1000', promisedDate: day(-10), receivedQty: '100' }).returning();
  const [l2] = await db.insert(L).values({ tenantId, poId: pos[1].id, erpId: 'l2', lineNo: 1, description: 'Steel plate', quantity: '100', unitPrice: '10', amount: '1000', promisedDate: day(-10), receivedQty: '50' }).returning();
  // Deliveries: 3 on time (one with an ASN), 1 five days late → on-time 3/4, ASN 1/4.
  const [shp] = await db.insert(schema.shipments).values({ tenantId, vendorId, poId: pos[0].id, number: 'ASN-SC-1', shipDate: day(-12), createdBy: 'sc' }).returning();
  await db.insert(R).values([
    { tenantId, poId: pos[0].id, lineId: l1.id, erpId: 'r1', receiptNumber: 'GRN1', receiptDate: day(-11), quantity: '50', shipmentId: shp.id },
    { tenantId, poId: pos[0].id, lineId: l1.id, erpId: 'r2', receiptNumber: 'GRN2', receiptDate: day(-10), quantity: '50' },
    { tenantId, poId: pos[1].id, lineId: l2.id, erpId: 'r3', receiptNumber: 'GRN3', receiptDate: day(-12), quantity: '25' },
    { tenantId, poId: pos[1].id, lineId: l2.id, erpId: 'r4', receiptNumber: 'GRN4', receiptDate: day(-5), quantity: '25' },
  ]);
  // Invoices: one clean, one with a blocking price mismatch → accuracy 1/2.
  await db.insert(schema.supplierInvoices).values([
    { tenantId, vendorId, poId: pos[0].id, invoiceNumber: 'INV-1', invoiceDate: day(-9), currency: 'INR', subtotal: '1000', taxAmount: '180', total: '1180', status: 'APPROVED', checks: [{ code: 'MATCH', level: 'ok', message: 'ok' }], submittedBy: 'sc' },
    { tenantId, vendorId, poId: pos[1].id, invoiceNumber: 'INV-2', invoiceDate: day(-4), currency: 'INR', subtotal: '600', taxAmount: '108', total: '708', status: 'EXCEPTION', checks: [{ code: 'PRICE', level: 'error', message: 'price' }], submittedBy: 'sc' },
  ] as any);
});

describe('supplier performance scorecards', () => {
  test('each measure and the weighted score', async () => {
    const admin = await login('admin@globex.test', 'globex');
    // A buyer rates: quality 5, delivery 3 (service and communication left out) → (1.0 + 0.6) / 2 = 80 %.
    expect((await admin.post(`/api/scorecards/${vendorId}/ratings`, {})).status).toBe(400);
    expect((await admin.post(`/api/scorecards/${vendorId}/ratings`, { quality: 5, delivery: 3, comment: 'Good steel, slow trucks' })).status).toBe(201);

    const card = (await admin.get(`/api/scorecards/${vendorId}?days=90`)).body;
    const m = Object.fromEntries(card.metrics.map((x: any) => [x.key, x]));
    expect(m.onTime).toMatchObject({ value: 0.75, numerator: 3, denominator: 4 });
    expect(m.fillRate).toMatchObject({ value: 0.75, numerator: 150, denominator: 200 });
    expect(m.acknowledgement).toMatchObject({ value: 0.75, numerator: 3, denominator: 4, note: 'Average 4 h to accept' });
    expect(m.invoiceAccuracy).toMatchObject({ value: 0.5 });
    expect(m.asn).toMatchObject({ value: 0.25 });
    expect(m.rating.value).toBeCloseTo(0.8);
    // (30×.75 + 20×.75 + 15×.75 + 15×.5 + 10×.25 + 10×.8) / 100 = 66.75 → 66.8
    expect(card.score).toBe(66.8);
    expect(card.grade).toBe('D');
    expect(card.late).toHaveLength(1);
    expect(card.late[0]).toMatchObject({ poNumber: 'PO-SC-2', daysLate: 5 });
    expect(card.trend).toHaveLength(6);
    expect(card.ratings[0]).toMatchObject({ quality: 5, delivery: 3, service: null, comment: 'Good steel, slow trucks' });

    const list = (await admin.get('/api/scorecards?days=90')).body;
    expect(list.rows.find((r: any) => r.vendorId === vendorId)).toMatchObject({ score: 66.8, grade: 'D', name: 'Scorecard Steel' });
    expect((await admin.get('/api/scorecards/export.xlsx?days=90')).headers['content-type']).toMatch(/spreadsheetml/);
  });

  test('weights and grace days change the score; a measure at weight 0 is left out', async () => {
    const admin = await login('admin@globex.test', 'globex');
    expect((await admin.put('/api/scorecards/settings', { weights: { onTime: 0, fillRate: 0, acknowledgement: 0, invoiceAccuracy: 0, asn: 0, rating: 0 }, graceDays: 0, showToSuppliers: false })).status).toBe(400);
    // Only on-time counts, with 5 grace days: the 5-day-late delivery is now on time → 100.
    await admin.put('/api/scorecards/settings', { weights: { onTime: 100, fillRate: 0, acknowledgement: 0, invoiceAccuracy: 0, asn: 0, rating: 0 }, graceDays: 5, showToSuppliers: false });
    const card = (await admin.get(`/api/scorecards/${vendorId}`)).body;
    expect(card.score).toBe(100);
    expect(card.grade).toBe('A');
    expect(card.late).toHaveLength(0);
  });

  test('suppliers see their own scorecard only when the buyer shares it, without buyer names or comments', async () => {
    const admin = await login('admin@globex.test', 'globex');
    // Give the supplier a portal sign-in.
    const v = (await db.query.vendors.findFirst({ where: and(eq(schema.vendors.id, vendorId), eq(schema.vendors.tenantId, tenantId)) }))!;
    const s = client();
    const { devOtp } = (await s.post('/api/vendor-auth/request-otp', { token: v.inviteToken })).body;
    await s.post('/api/vendor-auth/verify-otp', { token: v.inviteToken, code: devOtp });
    expect((await s.get('/api/vendor/scorecard')).status).toBe(404);
    await admin.put('/api/scorecards/settings', { weights: { onTime: 30, fillRate: 20, acknowledgement: 15, invoiceAccuracy: 15, asn: 10, rating: 10 }, graceDays: 0, showToSuppliers: true });
    expect((await s.get('/api/vendor')).body.scorecard).toBe(true);
    const mine = (await s.get('/api/vendor/scorecard')).body;
    expect(mine.score).toBe(66.8);
    expect(mine.ratings).toBeUndefined();
    expect(JSON.stringify(mine)).not.toMatch(/slow trucks|Rohan/);
  });
});
