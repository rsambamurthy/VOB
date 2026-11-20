/** Sourcing step 3: sealed offers, receipts, committee opening, two envelopes with technical scoring, start prices. */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { login } from './helpers.js';
import { closeBidding, eventWithBidders, inHours, lastMail } from './sourcingHelpers.js';
import { db, schema } from '../src/lib/db.js';
import type { Tenant } from '../src/db/schema.js';

let acme: Tenant;
let original: Pick<Tenant, 'settings' | 'limits'>;
const PDF = '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF';

beforeAll(async () => {
  acme = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
  original = { settings: acme.settings, limits: acme.limits };
  await db.update(schema.tenants).set({ limits: { features: { sourcing: true } } }).where(eq(schema.tenants.id, acme.id));
  const admin = await login('admin@acme.test');
  await admin.put('/api/admin/sourcing', { enabled: true, formats: { rfq: true, reverse: true } });
  await admin.put('/api/admin/sourcing/approval', { levels: [] });
});
afterAll(async () => { await db.update(schema.tenants).set(original).where(eq(schema.tenants.id, acme.id)); });

describe('sealed bids: one envelope', () => {
  test('offers stay sealed until the committee opens them after the deadline; revisions, receipts and ranking', async () => {
    const { e, buyer, portals } = await eventWithBidders(
      { title: 'Sealed valves', format: 'rfq', estimatedValue: 500000, bidDeadline: inHours(48) },
      [{ title: 'Valves', bidMode: 'line', reservePrice: 300000, lines: [{ description: 'Valve A', quantity: 10, unit: 'Nos' }, { description: 'Valve B', quantity: 5, unit: 'Nos' }] }, { title: 'Spares', bidMode: 'lot', lines: [{ description: 'Kit', quantity: 1, unit: 'Set' }] }],
      ['Alpha', 'Beta', 'Gamma']);
    const { Alpha, Beta, Gamma } = portals;
    const mine = (await Alpha.get(`/api/vendor/events/${e.id}/offer`)).body;
    expect(mine).toMatchObject({ envelopes: ['single'], canBid: true, canRevise: true });
    const [valves, spares] = mine.items;
    const lineIds = valves.lines.map((l: any) => l.id);

    // Validation: every item of a per-item lot, a price for a per-lot lot, at least one lot.
    expect((await Alpha.post(`/api/vendor/events/${e.id}/offer/single`, { lots: [] })).body.error).toMatch(/at least one lot/);
    expect((await Alpha.post(`/api/vendor/events/${e.id}/offer/single`, { lots: [{ lotId: valves.id, lines: [{ lineId: lineIds[0], unitPrice: 100 }] }] })).body.error).toMatch(/every item of lot 1/);
    const file = (await Alpha.upload(`/api/vendor/events/${e.id}/offer/files`, 'x', PDF)).body;
    const a1 = await Alpha.post(`/api/vendor/events/${e.id}/offer/single`, { lots: [{ lotId: valves.id, lines: [{ lineId: lineIds[0], unitPrice: 1000 }, { lineId: lineIds[1], unitPrice: 2000 }] }, { lotId: spares.id, price: 5000 }], taxPct: 18, deliveryDays: 21, validityDays: 90, paymentTerms: 'Net 45', attachments: [file.documentId] });
    expect(a1.status).toBe(201);
    expect(a1.body.offers.single).toMatchObject({ version: 1, content: { lots: [{ total: 20000 }, { total: 5000 }] } });
    const receipt = a1.body.offers.single.receipt;
    const alpha = (await db.query.sourcingBidders.findFirst({ where: and(eq(schema.sourcingBidders.eventId, e.id), eq(schema.sourcingBidders.alias, 'Bidder 1')) }))!;
    const mail = (await lastMail((await db.query.vendors.findFirst({ where: eq(schema.vendors.id, alpha.vendorId) }))!.contactEmail))!;
    expect(mail.body).toContain(receipt);
    expect(mail.body).toContain('stays sealed');

    await Beta.post(`/api/vendor/events/${e.id}/offer/single`, { lots: [{ lotId: valves.id, lines: [{ lineId: lineIds[0], unitPrice: 900 }, { lineId: lineIds[1], unitPrice: 1900 }] }] });
    const b2 = await Beta.post(`/api/vendor/events/${e.id}/offer/single`, { lots: [{ lotId: valves.id, lines: [{ lineId: lineIds[0], unitPrice: 950 }, { lineId: lineIds[1], unitPrice: 1950 }] }] });
    expect(b2.body.offers.single.version).toBe(2);
    await Gamma.post(`/api/vendor/events/${e.id}/offer/single`, { lots: [{ lotId: spares.id, price: 4000 }] });
    expect((await Gamma.del(`/api/vendor/events/${e.id}/offer/single`)).body.offers.single.withdrawnAt).toBeTruthy();

    // The buyer sees who sent what, never the content or files.
    const before = (await buyer.get(`/api/staff/sourcing/events/${e.id}`)).body.sealed;
    expect(before.received.map((r: any) => [r.alias, r.version, r.withdrawn])).toEqual(expect.arrayContaining([['Bidder 1', 1, false], ['Bidder 2', 2, false], ['Bidder 3', 1, true]]));
    expect(JSON.stringify(before)).not.toMatch(/20000|1950|Net 45/);
    expect(before.opening).toBeNull();
    expect((await buyer.get(`/api/documents/${file.documentId}`)).status).toBe(403);
    expect((await (await login('finance@acme.test')).post(`/api/staff/sourcing/events/${e.id}/open`)).body.error).toMatch(/after the deadline/);

    await closeBidding(e.id);
    expect((await Alpha.post(`/api/vendor/events/${e.id}/offer/single`, { lots: [{ lotId: spares.id, price: 1 }] })).body.error).toMatch(/deadline has passed/);
    expect((await buyer.post(`/api/staff/sourcing/events/${e.id}/open`)).status).toBe(403); // buyers aren't on the committee
    const f = await (await login('finance@acme.test')).post(`/api/staff/sourcing/events/${e.id}/open`);
    expect(f.body).toMatchObject({ opened: false, confirmations: 1, quorum: 2, event: { status: 'OPENING' } });
    expect(f.body.sealed.opening).toMatchObject({ envelope: 'single', confirmed: [expect.objectContaining({ name: 'Meera Nair' })], canConfirm: false });
    const o = await (await login('admin@acme.test')).post(`/api/staff/sourcing/events/${e.id}/open`);
    expect(o.body).toMatchObject({ opened: true, event: { status: 'EVALUATION' } });

    const cmp = o.body.sealed.offers.comparison;
    expect(cmp[0].quotes.map((q: any) => [q.rank, q.alias, q.total])).toEqual([['L1', 'Bidder 2', 19250], ['L2', 'Bidder 1', 20000]]);
    expect(cmp[1].quotes.map((q: any) => [q.rank, q.alias])).toEqual([['L1', 'Bidder 1']]); // Gamma withdrew
    expect(cmp[0].quotes[1]).toMatchObject({ taxPct: 18, deliveryDays: 21, paymentTerms: 'Net 45' });
    expect((await buyer.get(`/api/documents/${file.documentId}`)).status).toBe(200);
  });
});

describe('sealed bids: two envelopes and a reverse auction', () => {
  test('technical first, scored against a pass mark; only qualified commercial envelopes open; best price becomes the start price', async () => {
    const buyer = await login('buyer@acme.test');
    // Two envelopes need the scoring sheet before submitting.
    const draft = (await buyer.post('/api/staff/sourcing/events', { title: 'Check scoring', format: 'reverse', estimatedValue: 100000, bidDeadline: inHours(3), liveStartsAt: inHours(50), liveEndsAt: inHours(51), ruleChoices: { envelope: 'two' } })).body.event;
    expect((await buyer.get(`/api/staff/sourcing/events/${draft.id}`)).body.issues.map((i: any) => i.field)).toContain('scoring');
    expect((await buyer.patch(`/api/staff/sourcing/events/${draft.id}`, { scoring: { criteria: [{ id: 'q', label: 'Quality', weight: 50 }], passMark: 60 } })).body.error).toMatch(/add up to 100/);

    const scoring = { criteria: [{ id: 'quality', label: 'Quality', weight: 60 }, { id: 'delivery', label: 'Delivery', weight: 40 }], passMark: 60 };
    const { e, portals } = await eventWithBidders(
      { title: 'Cement RA', format: 'reverse', estimatedValue: 900000, bidDeadline: inHours(3), liveStartsAt: inHours(50), liveEndsAt: inHours(51), ruleChoices: { envelope: 'two' }, scoring },
      [{ title: 'Cement', bidMode: 'lot', startPrice: 1000000, lines: [{ description: 'OPC 53', quantity: 2000, unit: 'Bags' }] }],
      ['Delta', 'Echo']);
    const { Delta, Echo } = portals;
    const lot = (await Delta.get(`/api/vendor/events/${e.id}/offer`)).body.items[0];
    expect((await Delta.get(`/api/vendor/events/${e.id}/offer`)).body.envelopes).toEqual(['technical', 'commercial']);
    for (const [c, price] of [[Delta, 850000], [Echo, 800000]] as const) {
      expect((await c.post(`/api/vendor/events/${e.id}/offer/technical`, { remarks: 'ISI marked, own fleet' })).status).toBe(201);
      expect((await c.post(`/api/vendor/events/${e.id}/offer/commercial`, { lots: [{ lotId: lot.id, price }] })).status).toBe(201);
    }
    await closeBidding(e.id);
    const fin = await login('finance@acme.test'), admin = await login('admin@acme.test');
    await fin.post(`/api/staff/sourcing/events/${e.id}/open`);
    const t = await admin.post(`/api/staff/sourcing/events/${e.id}/open`);
    expect(t.body).toMatchObject({ opened: true, envelope: 'technical' });
    expect(t.body.sealed.offers.comparison[0].quotes).toEqual([]); // prices still sealed
    expect((await fin.post(`/api/staff/sourcing/events/${e.id}/open`)).body.error).toMatch(/Finish the technical evaluation/);

    const [d, x] = t.body.sealed.scoring.bidders;
    expect((await (await login('tax@acme.test')).put(`/api/staff/sourcing/events/${e.id}/scores/${d.id}`, { scores: { quality: 8, delivery: 7 } })).status).toBe(403);
    expect((await admin.put(`/api/staff/sourcing/events/${e.id}/scores/${d.id}`, { scores: { quality: 8 } })).body.error).toMatch(/Score “Delivery”/);
    await admin.put(`/api/staff/sourcing/events/${e.id}/scores/${d.id}`, { scores: { quality: 8, delivery: 7 } });
    const sc = await admin.put(`/api/staff/sourcing/events/${e.id}/scores/${x.id}`, { scores: { quality: 4, delivery: 5 }, comment: 'No ISI certificate' });
    expect(sc.body.sealed.scoring.bidders.map((b: any) => b.score)).toEqual([76, 44]);

    const buyer2 = await login('buyer@acme.test');
    expect((await buyer2.post(`/api/staff/sourcing/events/${e.id}/technical/finish`, { decisions: [{ bidderId: x.id, qualified: true }] })).body.error).toMatch(/reason for Bidder 2/);
    const done = await buyer2.post(`/api/staff/sourcing/events/${e.id}/technical/finish`, {});
    expect(done.body.bidders.map((b: any) => [b.alias, b.status])).toEqual([['Bidder 1', 'QUALIFIED'], ['Bidder 2', 'DISQUALIFIED']]);
    expect((await Echo.get(`/api/vendor/events/${e.id}/offer`)).body.technicalResult).toBe('DISQUALIFIED');

    await fin.post(`/api/staff/sourcing/events/${e.id}/open`);
    const c = await admin.post(`/api/staff/sourcing/events/${e.id}/open`);
    expect(c.body).toMatchObject({ opened: true, envelope: 'commercial' });
    // Echo's (lower) price stays sealed: they didn't qualify.
    expect(c.body.sealed.offers.comparison[0].quotes.map((q: any) => [q.alias, q.total])).toEqual([['Bidder 1', 850000]]);
    const sealedEcho = await db.query.sourcingSubmissions.findFirst({ where: eq(schema.sourcingSubmissions.bidderId, x.id), orderBy: desc(schema.sourcingSubmissions.version) });
    expect(sealedEcho!.envelope === 'commercial' ? sealedEcho!.openedAt : null).toBeNull();

    const sp = await buyer2.post(`/api/staff/sourcing/events/${e.id}/start-prices`);
    expect(sp.body.set).toEqual([{ lot: 1, price: 850000 }]);
    expect(Number(sp.body.lots[0].startPrice)).toBe(850000);
  });
});
