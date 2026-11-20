/** Sourcing step 4: live reverse auction — bid rules, ties, confirmation, auto-extension, controls, integrity, closing. */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { login, portalAs } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import type { Tenant } from '../src/db/schema.js';
import { runLiveSweep } from '../src/services/sourcing/live.js';
import { publishLive, subscribeLive } from '../src/lib/liveHub.js';

let acme: Tenant;
let original: Pick<Tenant, 'settings' | 'limits'>;
const inMin = (m: number) => new Date(Date.now() + m * 60_000);
const E = schema.sourcingEvents;
const setTimes = (id: string, start: Date, end: Date) => db.update(E).set({ liveStartsAt: start, liveEndsAt: end }).where(eq(E.id, id));
const lastMail = (to: string) => db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, to), orderBy: desc(schema.emailOutbox.createdAt) });

/** A reverse auction (no sealed round) with three outside bidders who accepted. */
async function auction() {
  const buyer = await login('buyer@acme.test');
  const e = (await buyer.post('/api/staff/sourcing/events', { title: 'Live steel', format: 'reverse', estimatedValue: 900000, liveStartsAt: inMin(120).toISOString(), liveEndsAt: inMin(180).toISOString() })).body.event;
  await buyer.put(`/api/staff/sourcing/events/${e.id}/items`, { lots: [
    { title: 'Plates', bidMode: 'lot', startPrice: 1000, reservePrice: 800, lines: [{ description: 'Plate', quantity: 1, unit: 'Lot' }] },
    { title: 'Bolts', bidMode: 'line', startPrice: 500, lines: [{ description: 'Bolt M10', quantity: 10, unit: 'Nos' }, { description: 'Bolt M12', quantity: 5, unit: 'Nos' }] }] });
  expect((await buyer.post(`/api/staff/sourcing/events/${e.id}/submit`)).body.status).toBe('APPROVED');
  const bidders: { c: Awaited<ReturnType<typeof portalAs>>; email: string }[] = [];
  for (const n of ['Ann', 'Ben', 'Cal']) {
    const email = `${n.toLowerCase()}+${Date.now()}@live.test`;
    const r = await buyer.post(`/api/staff/sourcing/events/${e.id}/outside-bidders`, { name: `${n} Steel ${Date.now()}`, vendorType: 'IMPORT', contactFirstName: n, contactLastName: 'T', contactEmail: email, contactMobile: '+44 7700 900123' });
    bidders.push({ c: await portalAs(r.body.bidders[r.body.bidders.length - 1].vendor.id), email });
  }
  await buyer.post(`/api/staff/sourcing/events/${e.id}/invitations`);
  for (const { c } of bidders) { await c.post('/api/vendor/bidder-registration', { supplies: 'Steel' }); await c.post(`/api/vendor/events/${e.id}/response`, { accept: true, noConflict: true }); }
  const lots = (await bidders[0].c.get(`/api/vendor/events/${e.id}/live`)).body.lots;
  return { e, buyer, A: bidders[0].c, B: bidders[1].c, C: bidders[2].c, emails: bidders.map((b) => b.email), plates: lots[0], bolts: lots[1] };
}

beforeAll(async () => {
  acme = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
  original = { settings: acme.settings, limits: acme.limits };
  await db.update(schema.tenants).set({ limits: { features: { sourcing: true } } }).where(eq(schema.tenants.id, acme.id));
  const admin = await login('admin@acme.test');
  await admin.put('/api/admin/sourcing', { enabled: true, formats: { rfq: true, reverse: true } });
  await admin.put('/api/admin/sourcing/approval', { levels: [] });
});
afterAll(async () => { await db.update(schema.tenants).set(original).where(eq(schema.tenants.id, acme.id)); });

describe('live reverse auction', () => {
  test('bids: start price, own-bid step, ties to the earlier bid, large drops confirmed, ranks only for bidders', async () => {
    const { e, buyer, A, B, C, plates, bolts } = await auction();
    const bid = (c: typeof A, body: object) => c.post(`/api/vendor/events/${e.id}/bids`, { lotId: plates.id, ...body });
    expect((await bid(A, { amount: 1000 })).body.error).toMatch(/hasn’t started/);
    await setTimes(e.id, inMin(-1), inMin(30));

    expect((await bid(A, { amount: 1100 })).body.code).toBe('BID_TOO_HIGH');
    expect((await bid(A, { amount: 1000 })).body.placed).toMatchObject({ rank: 1, amount: 1000 });
    expect((await (await login('buyer@acme.test')).get(`/api/staff/sourcing/events/${e.id}`)).body.event.status).toBe('LIVE');
    expect((await bid(B, { amount: 990 })).body.placed.rank).toBe(1);
    const tooHigh = await bid(A, { amount: 996 });
    expect(tooHigh.body).toMatchObject({ code: 'BID_TOO_HIGH', details: { maxBid: 995 } });
    expect((await bid(A, { amount: 995 })).body.placed.rank).toBe(2);
    expect((await bid(C, { amount: 990 })).body.placed.rank).toBe(2); // same as B, but later
    const big = await bid(A, { amount: 700 });
    expect(big.status).toBe(409);
    expect(big.body.code).toBe('CONFIRM_BID');
    const conf = await bid(A, { amount: 700, confirm: true });
    expect(conf.body.placed.rank).toBe(1);

    // What a bidder sees with "rank only": own rank and bids, nobody else's amounts or names.
    const view = conf.body.live;
    expect(view.lots[0]).toMatchObject({ myRank: 1, myBest: 700, best: null, ladder: null, maxNext: 696.5, bidders: 3 });
    const bView = (await B.get(`/api/vendor/events/${e.id}/live`)).body;
    expect(bView.lots[0]).toMatchObject({ myRank: 2, myBest: 990, best: null });
    expect(JSON.stringify(bView)).not.toMatch(/[:,]700\b|[:,]995\b|Ann|Cal/); // amounts as JSON values (ids may contain the digits)
    expect(bView.alias).toBe('Bidder 2');

    // Per-item lot: every item priced; the total is quantity × price.
    expect((await B.post(`/api/vendor/events/${e.id}/bids`, { lotId: bolts.id, lines: [{ lineId: bolts.lines[0].id, unitPrice: 20 }] })).body.error).toMatch(/every item of lot 2/);
    expect((await B.post(`/api/vendor/events/${e.id}/bids`, { lotId: bolts.id, lines: [{ lineId: bolts.lines[0].id, unitPrice: 20 }, { lineId: bolts.lines[1].id, unitPrice: 50 }] })).body.placed).toMatchObject({ amount: 450, rank: 1 });

    // The buyer sees names, ranking, savings and every bid.
    const live = (await buyer.get(`/api/staff/sourcing/events/${e.id}/live`)).body.live;
    expect(live.phase).toBe('live');
    expect(live.lots[0].ranking.map((r: any) => [r.rank, r.alias, r.amount])).toEqual([[1, 'Bidder 1', 700], [2, 'Bidder 2', 990], [3, 'Bidder 3', 990]]);
    expect(live.lots[0].savingPct).toBe(30);
    expect(live.log[0]).toMatchObject({ seq: 6, lot: 2, alias: 'Bidder 2', amount: 450 });
    expect(live.eligible).toHaveLength(3);

    // Strike out a mistaken bid: one asks, another confirms; A's best goes back to 995.
    const typo = live.log.find((x: any) => x.amount === 700);
    expect((await buyer.post(`/api/staff/sourcing/events/${e.id}/bids/${typo.id}/strike`, {})).body.error).toMatch(/reason/);
    await buyer.post(`/api/staff/sourcing/events/${e.id}/bids/${typo.id}/strike`, { reason: 'Bidder phoned: meant 970' });
    expect((await buyer.post(`/api/staff/sourcing/events/${e.id}/bids/${typo.id}/strike/confirm`)).body.error).toMatch(/different person/);
    const struck = (await (await login('admin@acme.test')).post(`/api/staff/sourcing/events/${e.id}/bids/${typo.id}/strike/confirm`)).body.live;
    expect(struck.lots[0].ranking.map((r: any) => [r.alias, r.amount])).toEqual([['Bidder 2', 990], ['Bidder 3', 990], ['Bidder 1', 995]]);
    expect(struck.log.find((x: any) => x.id === typo.id).struck).toMatchObject({ reason: 'Bidder phoned: meant 970', requestedBy: 'Rahul Verma' });
    expect((await A.get(`/api/vendor/events/${e.id}/live`)).body.lots[0]).toMatchObject({ myBest: 995, myRank: 3, maxNext: 990.02 });
    // The struck bid stays in the history and the chain still verifies.
    expect((await buyer.get(`/api/staff/sourcing/events/${e.id}/verify`)).body).toMatchObject({ ok: true, bids: 6 });
    const csv = (await buyer.get(`/api/staff/sourcing/events/${e.id}/bids.csv`)).text;
    expect(csv.trim().split(/\r?\n/)).toHaveLength(7);
    expect(csv).toContain('Bidder phoned: meant 970');
  });

  test('auto-extension, pause/resume, manual extension, messages, closing', async () => {
    const { e, buyer, A, B, plates, emails } = await auction();
    await setTimes(e.id, inMin(-10), inMin(2));
    const r = (await A.post(`/api/vendor/events/${e.id}/bids`, { lotId: plates.id, amount: 1000 })).body;
    expect(new Date(r.placed.extendedTo).getTime()).toBeGreaterThan(inMin(4.9).getTime());
    expect(r.live.extensionsUsed).toBe(1);
    // A bid earlier than the last 5 minutes doesn't extend.
    expect((await B.post(`/api/vendor/events/${e.id}/bids`, { lotId: plates.id, amount: 980 })).body.placed.extendedTo).toBeTruthy(); // still in the last 5 minutes
    await setTimes(e.id, inMin(-10), inMin(20));
    expect((await A.post(`/api/vendor/events/${e.id}/bids`, { lotId: plates.id, amount: 970 })).body.placed.extendedTo).toBeNull();

    expect((await (await login('tax@acme.test')).post(`/api/staff/sourcing/events/${e.id}/pause`, { reason: 'x' })).status).toBe(403);
    expect((await buyer.post(`/api/staff/sourcing/events/${e.id}/pause`, {})).body.error).toMatch(/reason/);
    const before = (await db.query.sourcingEvents.findFirst({ where: eq(E.id, e.id) }))!.liveEndsAt!;
    expect((await buyer.post(`/api/staff/sourcing/events/${e.id}/pause`, { reason: 'Bidder 2 lost power' })).body.live.phase).toBe('paused');
    expect((await B.post(`/api/vendor/events/${e.id}/bids`, { lotId: plates.id, amount: 900 })).body.error).toMatch(/paused/);
    await db.update(E).set({ pausedAt: inMin(-3) }).where(eq(E.id, e.id)); // paused for three minutes
    const resumed = (await buyer.post(`/api/staff/sourcing/events/${e.id}/resume`)).body.live;
    expect(resumed.phase).toBe('live');
    expect(new Date(resumed.endsAt).getTime() - before.getTime()).toBeGreaterThan(179_000);
    const ext = (await buyer.post(`/api/staff/sourcing/events/${e.id}/extend`, { minutes: 10, reason: 'Requested by two bidders' })).body.live;
    expect(new Date(ext.endsAt).getTime() - new Date(resumed.endsAt).getTime()).toBe(600_000);

    expect((await buyer.post(`/api/staff/sourcing/events/${e.id}/message`, { message: 'Prices are for delivery at Pune plant.' })).body.told).toBe(3);
    expect((await B.get(`/api/vendor/events/${e.id}/live`)).body.messages[0].text).toBe('Prices are for delivery at Pune plant.');
    expect((await lastMail(emails[1]))!.body).toContain('Prices are for delivery at Pune plant.');

    await setTimes(e.id, inMin(-30), inMin(-0.1));
    const closed = (await buyer.get(`/api/staff/sourcing/events/${e.id}/live`)).body.live;
    expect(closed.phase).toBe('closed');
    expect((await db.query.sourcingEvents.findFirst({ where: eq(E.id, e.id) }))!.status).toBe('CLOSED');
    expect((await A.post(`/api/vendor/events/${e.id}/bids`, { lotId: plates.id, amount: 100 })).body.error).toMatch(/closed/);
    expect((await lastMail(emails[0]))!.subject).toMatch(/has closed/);
    expect((await lastMail('buyer@acme.test'))!.subject).toMatch(/Auction closed/);
    const hist = (await buyer.get(`/api/staff/sourcing/events/${e.id}`)).body.history.map((h: any) => h.action);
    expect(hist).toEqual(expect.arrayContaining(['SOURCING_AUCTION_STARTED', 'SOURCING_AUCTION_EXTENDED', 'SOURCING_AUCTION_PAUSED', 'SOURCING_AUCTION_RESUMED', 'SOURCING_AUCTION_CLOSED']));
  });

  test('many bids at once are placed one at a time; tampering breaks the chain', async () => {
    const { e, buyer, A, B, C, plates } = await auction();
    await setTimes(e.id, inMin(-1), inMin(60));
    const results = await Promise.all([A, B, C].flatMap((c, i) => [0, 1, 2].map((k) => c.post(`/api/vendor/events/${e.id}/bids`, { lotId: plates.id, amount: 1000 - i * 3 - k * 50, confirm: true }))));
    const ok = results.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(3);
    const seqs = (await db.select({ seq: schema.sourcingBids.seq }).from(schema.sourcingBids).where(eq(schema.sourcingBids.eventId, e.id))).map((r) => r.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect((await buyer.get(`/api/staff/sourcing/events/${e.id}/verify`)).body.ok).toBe(true);
    await db.update(schema.sourcingBids).set({ amount: '1.00' }).where(and(eq(schema.sourcingBids.eventId, e.id), eq(schema.sourcingBids.seq, 2)));
    expect((await buyer.get(`/api/staff/sourcing/events/${e.id}/verify`)).body).toMatchObject({ ok: false, brokenAt: 2 });
  });

  test('only qualified bidders bid after a sealed round; start reminders; live updates reach subscribers', async () => {
    const { e, A, plates, emails } = await auction();
    await db.update(E).set({ bidDeadline: inMin(-120) }).where(eq(E.id, e.id));
    await setTimes(e.id, inMin(-1), inMin(30));
    expect((await A.post(`/api/vendor/events/${e.id}/bids`, { lotId: plates.id, amount: 900 })).body.error).toMatch(/qualified in the sealed round/);

    await db.update(E).set({ bidDeadline: null, status: 'PUBLISHED', liveStartsAt: inMin(30), liveEndsAt: inMin(90), reminders: [] }).where(eq(E.id, e.id));
    await runLiveSweep();
    expect((await lastMail(emails[2]))!.subject).toMatch(/starts/);
    const n = (await db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, emails[2]))).length;
    await runLiveSweep();
    expect((await db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, emails[2]))).length).toBe(n);

    const written: string[] = [];
    const fake: any = { writeHead: () => {}, write: (s: string) => { written.push(s); return true; }, on: () => {} };
    subscribeLive(`event:${e.id}`, fake);
    publishLive(`event:${e.id}`, { seq: 42 });
    await new Promise((r) => setTimeout(r, 400));
    expect(written[0]).toContain('event: hello');
    expect(written.some((w) => w.startsWith('event: update') && w.includes('"seq":42'))).toBe(true);
  });
});
