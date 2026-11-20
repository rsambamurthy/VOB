/** Sourcing step 5: award — results, splits, reasons, award approval, letters, new-supplier onboarding, ERP award message. */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { login } from './helpers.js';
import { closeBidding, eventWithBidders, inHours, lastMail } from './sourcingHelpers.js';
import { db, schema } from '../src/lib/db.js';
import type { Tenant } from '../src/db/schema.js';
import { releaseAwardsFor } from '../src/services/sourcing/awards.js';

let acme: Tenant;
let original: Pick<Tenant, 'settings' | 'limits'>;

beforeAll(async () => {
  acme = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
  original = { settings: acme.settings, limits: acme.limits };
  await db.update(schema.tenants).set({ limits: { features: { sourcing: true } } }).where(eq(schema.tenants.id, acme.id));
  const admin = await login('admin@acme.test');
  await admin.put('/api/admin/sourcing', { enabled: true, formats: { rfq: true, reverse: true } });
  await admin.put('/api/admin/sourcing/approval', { levels: [] }); // events: no approval in these tests
  expect((await admin.put('/api/admin/erp', { kind: 'webhook', testMode: true, autoPush: false, config: { url: 'https://erp.example.com/hook' }, secrets: { signingSecret: 'x'.repeat(24) } })).status).toBe(200);
});
afterAll(async () => {
  await db.update(schema.tenants).set(original).where(eq(schema.tenants.id, acme.id));
  await (await login('admin@acme.test')).put('/api/admin/erp', { kind: 'none', testMode: false, autoPush: false, config: {}, secrets: {} });
});

describe('award', () => {
  test('RFQ: split award with a reason, approval because it isn’t all to the best price, letters, onboarding and ERP', async () => {
    const { e, buyer, portals, emails } = await eventWithBidders(
      { title: 'Award valves', format: 'rfq', estimatedValue: 400000, bidDeadline: inHours(48) },
      [{ title: 'Valves', bidMode: 'line', lines: [{ itemCode: 'V1', description: 'Valve DN50', quantity: 10, unit: 'Nos' }] }, { title: 'Spares', bidMode: 'lot', lines: [{ description: 'Spare kit', quantity: 2, unit: 'Set' }] }],
      ['Alpha', 'Beta', 'Delta', 'Hotel']);
    const { Alpha, Beta, Delta } = portals;
    const P = portals.Hotel;
    // Hotel is already an approved supplier (not bidder-only).
    await db.update(schema.vendors).set({ status: 'APPROVED', bidderOnly: false }).where(eq(schema.vendors.contactEmail, emails.Hotel));
    const items = (await Alpha.get(`/api/vendor/events/${e.id}/offer`)).body.items;
    const [valves, spares] = items;
    const line = valves.lines[0].id;
    await Alpha.post(`/api/vendor/events/${e.id}/offer/single`, { lots: [{ lotId: valves.id, lines: [{ lineId: line, unitPrice: 1000 }] }], paymentTerms: 'Net 30', deliveryDays: 20 });
    await Beta.post(`/api/vendor/events/${e.id}/offer/single`, { lots: [{ lotId: valves.id, lines: [{ lineId: line, unitPrice: 950 }] }] });
    await Delta.post(`/api/vendor/events/${e.id}/offer/single`, { lots: [{ lotId: spares.id, price: 9000 }] });
    await P.post(`/api/vendor/events/${e.id}/offer/single`, { lots: [{ lotId: spares.id, price: 8000 }], paymentTerms: 'Net 45', deliveryDays: 14 });

    // Not ready until the prices are open.
    expect((await buyer.post(`/api/staff/sourcing/events/${e.id}/award`, { lots: [] })).body.error).toMatch(/Open the prices/);
    await closeBidding(e.id);
    await (await login('finance@acme.test')).post(`/api/staff/sourcing/events/${e.id}/open`);
    const opened = await (await login('admin@acme.test')).post(`/api/staff/sourcing/events/${e.id}/open`);
    const res = opened.body.award;
    expect(res.source).toBe('sealed');
    expect(res.lots[0].candidates.map((c: any) => [c.rank, c.alias, c.amount])).toEqual([[1, 'Bidder 2', 9500], [2, 'Bidder 1', 10000]]);
    const [a1, b2] = [res.lots[0].candidates[1], res.lots[0].candidates[0]];
    const pv = res.lots[1].candidates[0];
    const hotelName = (await db.query.vendors.findFirst({ where: eq(schema.vendors.contactEmail, emails.Hotel) }))!.name;
    expect(pv.vendor).toBe(hotelName);

    const proposal = (reason?: string) => ({ note: 'Split to keep two sources', lots: [{ lotId: valves.id, splits: [{ bidderId: b2.bidderId, sharePct: 60 }, { bidderId: a1.bidderId, sharePct: 40 }], reason }, { lotId: spares.id, splits: [{ bidderId: pv.bidderId, sharePct: 100 }] }] });
    expect((await buyer.post(`/api/staff/sourcing/events/${e.id}/award`, { lots: [{ lotId: valves.id, splits: [{ bidderId: b2.bidderId, sharePct: 60 }] }] })).body.error).toMatch(/add up to 100/);
    expect((await buyer.post(`/api/staff/sourcing/events/${e.id}/award`, proposal())).body.error).toMatch(/give a reason/);
    const p = await buyer.post(`/api/staff/sourcing/events/${e.id}/award`, proposal('Second source for supply security'));
    expect(p.body).toMatchObject({ status: 'AWARD_PENDING', levels: ['Senior management approval'], event: { status: 'AWARD_PENDING' } });
    expect(p.body.award.savings).toMatchObject({ awardedTotal: 5700 + 4000 + 8000, estimate: 400000 });
    expect(p.body.award.lots[0].award.map((x: any) => [x.sharePct, x.amount])).toEqual([[60, 5700], [40, 4000]]);
    expect((await buyer.post(`/api/staff/sourcing/events/${e.id}/award`, proposal('x'))).status).toBe(409);

    // Send back → evaluation again; propose again; approve.
    const admin = await login('admin@acme.test');
    expect((await admin.post(`/api/staff/sourcing/events/${e.id}/award/decision`, { action: 'SEND_BACK', remarks: 'Check the split' })).body.event.status).toBe('EVALUATION');
    expect((await lastMail('buyer@acme.test'))!.body).toContain('Check the split');
    await buyer.post(`/api/staff/sourcing/events/${e.id}/award`, proposal('Second source for supply security'));
    const ok = await admin.post(`/api/staff/sourcing/events/${e.id}/award/decision`, { action: 'APPROVE' });
    expect(ok.body).toMatchObject({ status: 'APPROVED', event: { status: 'AWARDED' } });

    // Letters: winners (new suppliers are asked to register), the loser a regret.
    expect((await lastMail(emails.Beta))!.subject).toMatch(/complete your registration/);
    expect((await lastMail(emails.Beta))!.body).toContain('Lot 1 Valves (60%): 5700.00');
    expect((await lastMail(emails.Delta))!.subject).toMatch(/result of/);
    expect((await lastMail(emails.Hotel))!.subject).toMatch(/award for/);
    const beta = (await db.query.vendors.findFirst({ where: eq(schema.vendors.contactEmail, emails.Beta) }))!;
    expect(beta.bidderOnly).toBe(false);

    // ERP: Hotel (approved) now; the new suppliers wait for onboarding.
    const view = ok.body.award;
    expect(view.lots[1].award[0].erpStatus).toBe('QUEUED');
    expect(view.lots[0].award.map((x: any) => x.erpStatus)).toEqual(['WAITING_ONBOARDING', 'WAITING_ONBOARDING']);
    expect(view.erp).toHaveLength(1);
    expect(view.erp[0]).toMatchObject({ kind: 'AWARD', status: 'TEST', vendor: hotelName });
    const sent = view.erp[0].request.body;
    expect(sent).toMatchObject({ event: 'sourcing.award.approved', award: { eventNumber: e.number, currency: 'INR', supplierName: hotelName, paymentTerms: 'Net 45', deliveryDays: 14, total: 8000 } });
    expect(sent.award.lines).toEqual([expect.objectContaining({ description: 'Spare kit', quantity: 2, unitPrice: 4000, amount: 8000 })]);

    // Once Beta is approved as a supplier, the waiting award goes.
    await db.update(schema.vendors).set({ status: 'APPROVED' }).where(eq(schema.vendors.id, beta.id));
    await releaseAwardsFor(beta.id);
    const after = (await buyer.get(`/api/staff/sourcing/events/${e.id}`)).body.award;
    const betaMsg = after.erp.find((m: any) => m.vendor === beta.name);
    expect(betaMsg.request.body.award.lines).toEqual([expect.objectContaining({ itemCode: 'V1', quantity: 6, unitPrice: 950, amount: 5700, sharePct: 60 })]);

    // Bidders see only their own result.
    expect((await Beta.get(`/api/vendor/events/${e.id}`)).body.result).toEqual({ awarded: [{ position: 1, title: 'Valves', sharePct: 60, amount: 5700 }] });
    expect((await Delta.get(`/api/vendor/events/${e.id}`)).body.result).toEqual({ awarded: [] });
    expect(JSON.stringify((await Delta.get(`/api/vendor/events/${e.id}`)).body)).not.toMatch(/5700|Beta/);
  });

  test('auction: results from live bids; all to L1 under 10 lakh needs no approval; the proposer can’t approve their own', async () => {
    const { e, buyer, portals } = await eventWithBidders(
      { title: 'Award RA', format: 'reverse', estimatedValue: 900000, liveStartsAt: inHours(2), liveEndsAt: inHours(3) },
      [{ title: 'Cement', bidMode: 'lot', startPrice: 1000, lines: [{ description: 'OPC', quantity: 100, unit: 'Bags' }] }],
      ['Echo', 'Fox']);
    await db.update(schema.sourcingEvents).set({ liveStartsAt: new Date(Date.now() - 60_000), liveEndsAt: new Date(Date.now() + 600_000) }).where(eq(schema.sourcingEvents.id, e.id));
    const lot = (await portals.Echo.get(`/api/vendor/events/${e.id}/live`)).body.lots[0];
    await portals.Echo.post(`/api/vendor/events/${e.id}/bids`, { lotId: lot.id, amount: 950 });
    await portals.Fox.post(`/api/vendor/events/${e.id}/bids`, { lotId: lot.id, amount: 930 });
    expect((await buyer.post(`/api/staff/sourcing/events/${e.id}/award`, { lots: [] })).body.error).toMatch(/must close/);
    await db.update(schema.sourcingEvents).set({ liveEndsAt: new Date(Date.now() - 1000) }).where(eq(schema.sourcingEvents.id, e.id));
    const d = (await buyer.get(`/api/staff/sourcing/events/${e.id}`)).body;
    expect(d.event.status).toBe('CLOSED');
    expect(d.award.source).toBe('live');
    const [fox] = d.award.lots[0].candidates;
    expect(fox).toMatchObject({ rank: 1, amount: 930 });
    const r = await buyer.post(`/api/staff/sourcing/events/${e.id}/award`, { lots: [{ lotId: lot.id, splits: [{ bidderId: fox.bidderId, sharePct: 100 }] }] });
    expect(r.body).toMatchObject({ status: 'AWARDED', levels: [] });
    expect(r.body.award.savings).toMatchObject({ awardedTotal: 930, startTotal: 1000, vsStartPct: 7 });

    // Award approval flow is configurable; the proposer can't approve their own.
    const admin = await login('admin@acme.test');
    const setup = (await admin.get('/api/admin/sourcing')).body.awardApproval;
    expect(setup.catalog.map((c: any) => c.id)).toEqual(['award.value', 'award.notBest', 'award.format', 'award.category']);
    await admin.put('/api/admin/sourcing/approval?kind=award', { levels: [{ id: 'all', label: 'Award check', roleKey: 'ADMIN' }] });
    const { e: e2, portals: p2 } = await eventWithBidders({ title: 'Own award', format: 'reverse', estimatedValue: 1000, liveStartsAt: inHours(2), liveEndsAt: inHours(3) }, [{ title: 'X', bidMode: 'lot', lines: [{ description: 'X', quantity: 1, unit: 'Nos' }] }], ['Golf']);
    await db.update(schema.sourcingEvents).set({ liveStartsAt: new Date(Date.now() - 60_000), liveEndsAt: new Date(Date.now() + 600_000) }).where(eq(schema.sourcingEvents.id, e2.id));
    const l2 = (await p2.Golf.get(`/api/vendor/events/${e2.id}/live`)).body.lots[0];
    await p2.Golf.post(`/api/vendor/events/${e2.id}/bids`, { lotId: l2.id, amount: 100 });
    await db.update(schema.sourcingEvents).set({ liveEndsAt: new Date(Date.now() - 1000) }).where(eq(schema.sourcingEvents.id, e2.id));
    const golf = (await admin.get(`/api/staff/sourcing/events/${e2.id}`)).body.award.lots[0].candidates[0];
    expect((await admin.post(`/api/staff/sourcing/events/${e2.id}/award`, { lots: [{ lotId: l2.id, splits: [{ bidderId: golf.bidderId, sharePct: 100 }] }] })).body.levels).toEqual(['Award check']);
    expect((await admin.post(`/api/staff/sourcing/events/${e2.id}/award/decision`, { action: 'APPROVE' })).body.error).toMatch(/can’t approve an award you proposed/);
    expect((await admin.post(`/api/staff/sourcing/events/${e2.id}/award/withdraw`)).body.event.status).toBe('CLOSED');
    await admin.put('/api/admin/sourcing/approval?kind=award', { levels: [{ id: 'finance', label: 'Finance approval', roleKey: 'FINANCE_MANAGER', rule: { match: 'all', conditions: [{ field: 'award.value', op: 'gt', value: 1000000 }] } }] });
  });
});
