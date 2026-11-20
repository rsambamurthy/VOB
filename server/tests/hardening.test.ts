/** Load and security findings (November 2026): each fix keeps a test so it can't come back. */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { app, client, invitedSupplier, lastLinkTo, login, tokenOf } from './helpers.js';
import { eventWithBidders, inHours } from './sourcingHelpers.js';
import { db, schema } from '../src/lib/db.js';
import { decrypt, encrypt } from '../src/lib/crypto.js';
import { canonicalPo } from '../src/services/orders/model.js';

describe('vendor list (load)', () => {
  test('is paged, with totals; "needs attention" and status counts cover the whole workspace', async () => {
    const admin = await login('admin@acme.test');
    const all = (await admin.get('/api/staff/vendors?pageSize=200')).body;
    expect(all.total).toBe(all.vendors.length);
    const p1 = (await admin.get('/api/staff/vendors?pageSize=2')).body, p2 = (await admin.get('/api/staff/vendors?pageSize=2&page=2')).body;
    expect(p1).toMatchObject({ page: 1, pageSize: 2, total: all.total });
    expect(p1.vendors).toHaveLength(2);
    expect(p2.vendors.map((v: any) => v.id)).not.toContain(p1.vendors[0].id);
    const attention = (await admin.get('/api/staff/vendors?attention=true&pageSize=200')).body;
    expect(attention.total).toBe(all.attentionCount);
    expect(Object.values(all.counts as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(all.total);
    expect(all.vendors[0]).not.toHaveProperty('profile');
    const opts = (await admin.get('/api/staff/vendors/options?status=APPROVED')).body.vendors;
    expect(opts.length).toBeGreaterThan(0);
    expect(Object.keys(opts[0]).sort()).toEqual(['code', 'id', 'name']);
  });

  test('opening a supplier does not change its "updated" time (risk recalculation is not an edit)', async () => {
    const admin = await login('admin@acme.test');
    const v = (await db.query.vendors.findFirst({ where: eq(schema.vendors.name, 'Precision Valves Pvt Ltd') }))!;
    await admin.get(`/api/staff/vendors/${v.id}`);
    await admin.get(`/api/staff/vendors/${v.id}`);
    const after = (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, v.id) }))!;
    expect(after.updatedAt.getTime()).toBe(v.updatedAt.getTime());
  });
});

describe('input handling', () => {
  test('bad bodies are 400/413, not 500; NUL characters are dropped; API answers are not cached', async () => {
    const admin = await login('admin@acme.test');
    expect((await admin.patch('/api/admin/tenant', {})).status).toBe(400);
    const bad = await request(app).post('/api/auth/login').set('X-Requested-With', 'fetch').set('Content-Type', 'application/json').send('{bad');
    expect(bad.status).toBe(400);
    const big = await request(app).post('/api/auth/login').set('X-Requested-With', 'fetch').set('Content-Type', 'application/json').send(`{"a":"${'x'.repeat(1_100_000)}"}`);
    expect(big.status).toBe(413);
    const nul = await admin.get('/api/staff/vendors?q=Prec%00ision');
    expect(nul.status).toBe(200);
    expect(nul.headers['cache-control']).toBe('no-store');
    expect((await admin.get('/api/admin/config/versions/abc')).status).toBe(404);
  });

  test('a huge invalid body gives a short error (at most 20 problems listed)', async () => {
    const admin = await login('admin@acme.test');
    const r = await admin.put('/api/admin/sourcing/approval', { levels: Array.from({ length: 5000 }, () => ({ id: 1 })) });
    expect(r.status).toBe(400);
    expect(r.body.details.length).toBeLessThanOrEqual(20);
  });

  test('links supplied from outside must be web links', () => {
    const po = { erpId: '1', poNumber: 'P1', supplierCode: 'S', currency: 'INR', lines: [{ erpId: 'L1', lineNo: 1, description: 'x', quantity: 1, unitPrice: 1 }] };
    expect(canonicalPo.safeParse({ ...po, attachments: [{ name: 'a', url: 'javascript:alert(1)' }] }).success).toBe(false);
    const ok = canonicalPo.safeParse({ ...po, attachments: [{ name: 'a', url: 'https://erp.example.com/a.pdf' }] });
    expect(ok.success, JSON.stringify(!ok.success && ok.error.issues)).toBe(true);
  });

  test('the workspace logo must be an https address', async () => {
    const admin = await login('admin@acme.test');
    expect((await admin.patch('/api/admin/tenant', { branding: { logoUrl: 'javascript:alert(1)' } })).status).toBe(400);
  });

  test('encrypted values with a shortened authentication tag are rejected', () => {
    const [iv, tag, ct] = encrypt('secret').split('.');
    expect(() => decrypt([iv, Buffer.from(tag, 'base64').subarray(0, 4).toString('base64'), ct].join('.'))).toThrow();
  });
});

describe('supplier sign-in codes', () => {
  test('wrong codes across many new codes are cut off after 20 in a day', async () => {
    const { id } = await invitedSupplier('Guess Co', 'guess@guess.test');
    const admin = await login('admin@acme.test');
    await admin.post(`/api/staff/vendors/${id}/invite`);
    const token = tokenOf((await lastLinkTo('guess@guess.test'))!);
    const v = client();
    // Pretend 20 wrong guesses were already made today on earlier codes.
    await v.post('/api/vendor-auth/request-otp', { token });
    await db.update(schema.otpCodes).set({ attempts: 20 }).where(eq(schema.otpCodes.vendorId, id));
    const { devOtp } = (await v.post('/api/vendor-auth/request-otp', { token })).body;
    const r = await v.post('/api/vendor-auth/verify-otp', { token, code: devOtp });
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/Too many wrong codes/);
  });
});

describe('sourcing', () => {
  let original: { settings: unknown; limits: unknown };
  beforeAll(async () => {
    const acme = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
    original = { settings: acme.settings, limits: acme.limits };
    await db.update(schema.tenants).set({ limits: { features: { sourcing: true } } }).where(eq(schema.tenants.id, acme.id));
    const admin = await login('admin@acme.test');
    await admin.put('/api/admin/sourcing', { enabled: true, formats: { rfq: true, reverse: true } });
    await admin.put('/api/admin/sourcing/approval', { levels: [] });
  });
  afterAll(async () => { await db.update(schema.tenants).set(original as any).where(eq(schema.tenants.slug, 'acme')); });
  test('a supplier not invited to an auction learns nothing from bidding in it; bid log CSV neutralises formulas', async () => {
    const { e, portals } = await eventWithBidders({ title: 'Hardening RA', format: 'reverse', estimatedValue: 1000, liveStartsAt: inHours(2), liveEndsAt: inHours(3) },
      [{ title: 'X', bidMode: 'lot', startPrice: 1000, lines: [{ description: 'X', quantity: 1, unit: 'Nos' }] }], ['Alpha']);
    await db.update(schema.sourcingEvents).set({ liveStartsAt: new Date(Date.now() - 60_000), liveEndsAt: new Date(Date.now() + 600_000) }).where(eq(schema.sourcingEvents.id, e.id));
    const live = (await portals.Alpha.get(`/api/vendor/events/${e.id}/live`)).body;
    const lot = live.lots[0];
    expect(lot, JSON.stringify(live)).toBeDefined();
    // A supplier's name as typed (outside bidders type their own) ends up in the bid log's Supplier column.
    const alpha = (await db.select({ vendorId: schema.sourcingBidders.vendorId }).from(schema.sourcingBidders).where(eq(schema.sourcingBidders.eventId, e.id)))[0];
    await db.update(schema.vendors).set({ name: '=HYPERLINK("http://evil.example")' }).where(eq(schema.vendors.id, alpha.vendorId));
    expect((await portals.Alpha.post(`/api/vendor/events/${e.id}/bids`, { lotId: lot.id, amount: 900 })).status).toBe(201);
    const csv = (await (await login('buyer@acme.test')).get(`/api/staff/sourcing/events/${e.id}/bids.csv`)).text;
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toMatch(/(^|,)"?=HYPERLINK/m);
    const { v: outsider } = await invitedSupplier('Outsider Co', 'outsider@out.test');
    const r = await outsider.post(`/api/vendor/events/${e.id}/bids`, { lotId: lot.id, amount: 800 });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('Event not found');
    expect(await db.query.sourcingBids.findFirst({ where: and(eq(schema.sourcingBids.eventId, e.id), eq(schema.sourcingBids.amount, '800.00')) })).toBeUndefined();
  });
});
