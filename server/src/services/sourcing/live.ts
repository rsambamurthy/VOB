/**
 * Sourcing step 4: the live reverse auction.
 *
 * Rules (frozen in the event's `rules` when it was submitted):
 * - Each bid must beat the bidder's OWN previous bid on the lot by at least `minStepPct`; the first bid must not be
 *   above the lot's start (ceiling) price. Bidders can improve their rank without having to become L1.
 * - Ranking per lot: lowest amount first; equal amounts → the earlier bid (server time, to the millisecond) ranks higher.
 * - A bid more than `confirmDropPct` below the current best must be confirmed (guards against typing mistakes).
 * - Auto-extension (option `autoExtension`): a bid in the last `extensionMinutes` moves the end to now + extensionMinutes,
 *   up to `maxExtensions` times.
 * - Who may bid: bidders who accepted; if the event had a sealed round, only those who QUALIFIED in it.
 *
 * Integrity: bids are placed one at a time per event (the event row is locked in the transaction) and append-only;
 * each bid's hash = SHA-256(previous hash | seq | lot | bidder | amount | time), so the history can be verified.
 * A mistaken bid can be struck out (reason + a second person), never deleted.
 *
 * The auction's state (upcoming → live → closed) follows the server clock: `syncLive` moves the status on every read,
 * bid and minute sweep (job `sourcing.live`). Screens get "changed" signals through lib/liveHub.ts.
 */
import crypto from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../lib/db.js';
import type { Tenant, Vendor } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { formatDeadline } from '../../lib/calendar.js';
import { publishLive } from '../../lib/liveHub.js';
import { toCsv } from '../../lib/erpMapper.js';
import { mailSupplier, langForVendor } from '../../i18n/emails.js';
import { defineJob } from '../../jobs/queue.js';
import { portalLink } from '../vendors.js';
import { getEvent, tellOwner, type SourcingEvent } from './events.js';

const { sourcingEvents: E, sourcingLots: L, sourcingLines: LN, sourcingBids: BD, sourcingBidders: B, vendors: V } = schema;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const key = (eventId: string) => `event:${eventId}`;
const cents = (n: number | string) => Math.round(Number(n) * 100);
const fromCents = (c: number) => c / 100;
const LIVE_FROM = ['PUBLISHED', 'OPENING', 'EVALUATION'];

export type Phase = 'upcoming' | 'live' | 'paused' | 'closed' | 'none';
export function phaseOf(e: Pick<SourcingEvent, 'format' | 'status' | 'liveStartsAt' | 'liveEndsAt' | 'pausedAt'>, now = new Date()): Phase {
  if (e.format === 'rfq' || !e.liveStartsAt || !e.liveEndsAt) return 'none';
  if (['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(e.status)) return 'none';
  if (e.status === 'CLOSED' || ['AWARD_PENDING', 'AWARDED'].includes(e.status)) return 'closed';
  if (now < e.liveStartsAt) return 'upcoming';
  if (e.pausedAt) return 'paused';
  return now < e.liveEndsAt ? 'live' : 'closed';
}

/** Move the status along with the clock: → LIVE at the start, → CLOSED at the end. Returns the fresh event. */
export async function syncLive(e: SourcingEvent, now = new Date()): Promise<SourcingEvent> {
  const phase = phaseOf(e, now);
  if ((phase === 'live' || phase === 'paused') && LIVE_FROM.includes(e.status)) {
    const [u] = await db.update(E).set({ status: 'LIVE', liveStartedAt: e.liveStartedAt ?? now, updatedAt: now }).where(and(eq(E.id, e.id), inArray(E.status, LIVE_FROM))).returning();
    if (u) { await audit({ tenantId: e.tenantId, actor: 'system', action: 'SOURCING_AUCTION_STARTED', detail: { eventId: e.id, number: e.number } }); publishLive(key(e.id)); return u; }
  }
  if (phase === 'closed' && (e.status === 'LIVE' || LIVE_FROM.includes(e.status))) {
    const [u] = await db.update(E).set({ status: 'CLOSED', closedAt: now, updatedAt: now }).where(and(eq(E.id, e.id), inArray(E.status, ['LIVE', ...LIVE_FROM]))).returning();
    if (u) await closed(u);
    return u ?? (await getEvent(e.tenantId, e.id));
  }
  return e;
}

async function closed(e: SourcingEvent) {
  const n = (await db.select({ n: sql<number>`count(*)::int` }).from(BD).where(and(eq(BD.eventId, e.id), isNull(BD.invalidatedAt))))[0].n;
  await audit({ tenantId: e.tenantId, actor: 'system', action: 'SOURCING_AUCTION_CLOSED', detail: { eventId: e.id, number: e.number, bids: n, extensions: e.extensionsUsed } });
  publishLive(key(e.id));
  await tellOwner(e, `Auction closed: ${e.number} ${e.title}`, `The auction ${e.number} “${e.title}” has closed with ${n} bid${n === 1 ? '' : 's'}. Open it to see the result and prepare the award.`);
  const t = (await db.query.tenants.findFirst({ where: eq(schema.tenants.id, e.tenantId) }))!;
  for (const { v } of await eligible(e)) await mailSupplier(await langForVendor(v, t), { tenantId: t.id, to: v.contactEmail, link: portalLink(v) }, 'sourcingAuctionClosed', { first: v.contactFirstName, buyer: t.name, number: e.number, title: e.title });
}

/** Bidders allowed in the auction. */
async function eligible(e: SourcingEvent) {
  const statuses = e.bidDeadline ? ['QUALIFIED'] : ['ACCEPTED', 'QUALIFIED'];
  return db.select({ b: B, v: V }).from(B).innerJoin(V, eq(V.id, B.vendorId)).where(and(eq(B.eventId, e.id), inArray(B.status, statuses)));
}

/* ---------------- ranking ---------------- */

type BidRow = typeof BD.$inferSelect;
/** Each bidder's best valid bid on a lot, ranked: lowest first, earlier first on equal amounts. */
function rank(bids: BidRow[]) {
  const best = new Map<string, BidRow>();
  for (const b of bids) {
    if (b.invalidatedAt) continue;
    const cur = best.get(b.bidderId);
    if (!cur || cents(b.amount) < cents(cur.amount) || (cents(b.amount) === cents(cur.amount) && b.placedAt < cur.placedAt)) best.set(b.bidderId, b);
  }
  return [...best.values()].sort((a, b) => cents(a.amount) - cents(b.amount) || +a.placedAt - +b.placedAt).map((b, i) => ({ bid: b, rank: i + 1 }));
}

/**
 * Each bidder's best valid bid per lot, worked out in the database: what ranking needs, without loading the whole
 * bid history (an auction can collect thousands of bids, and every bid and every refresh asks for the ranking).
 */
async function bestBids(where: { eventId?: string; lotId?: string }, q: Pick<typeof db, 'execute'> = db): Promise<BidRow[]> {
  const cond = where.lotId ? sql`${BD.lotId} = ${where.lotId}` : sql`${BD.eventId} = ${where.eventId!}`;
  const r = await q.execute(sql`select distinct on (${BD.lotId}, ${BD.bidderId}) * from ${BD} where ${cond} and ${BD.invalidatedAt} is null
    order by ${BD.lotId}, ${BD.bidderId}, ${BD.amount} asc, ${BD.placedAt} asc`);
  return (r as unknown as { rows: Record<string, unknown>[] }).rows.map((x) => ({
    id: x.id, tenantId: x.tenant_id, eventId: x.event_id, lotId: x.lot_id, bidderId: x.bidder_id, seq: x.seq, amount: x.amount, lineAmounts: x.line_amounts,
    placedAt: new Date(x.placed_at as string), prevHash: x.prev_hash, hash: x.hash, placedByName: x.placed_by_name, invalidatedAt: null,
  }) as unknown as BidRow);
}

/* ---------------- placing a bid ---------------- */

export const bidSchema = z.object({
  lotId: z.string(),
  amount: z.number({ invalid_type_error: 'Enter your bid' }).positive('Bids must be more than 0').max(1e13).optional(),
  lines: z.array(z.object({ lineId: z.string(), unitPrice: z.number().positive('Prices must be more than 0').max(1e13) })).optional(),
  confirm: z.boolean().optional(),
});
const hashOf = (prev: string, b: { seq: number; lotId: string; bidderId: string; amount: string; placedAt: Date }) =>
  crypto.createHash('sha256').update(`${prev}|${b.seq}|${b.lotId}|${b.bidderId}|${b.amount}|${b.placedAt.toISOString()}`).digest('hex');
const genesis = (eventId: string) => crypto.createHash('sha256').update(`GENESIS|${eventId}`).digest('hex');

export async function placeBid(t: Tenant, v: Vendor, eventId: string, raw: unknown, by: { name: string; ip?: string }) {
  const input = bidSchema.parse(raw);
  const pre = await db.query.sourcingEvents.findFirst({ where: and(eq(E.tenantId, t.id), eq(E.id, eventId)) });
  if (!pre) throw new HttpError(404, 'Event not found');
  // Someone who wasn't invited learns nothing about the event — not even whether it is running.
  const invited = await db.query.sourcingBidders.findFirst({ where: and(eq(B.eventId, pre.id), eq(B.vendorId, v.id)) });
  if (!invited || !invited.sentAt || invited.status === 'REMOVED') throw new HttpError(404, 'Event not found');
  await syncLive(pre);
  const result = await db.transaction(async (tx) => {
    // One bid at a time per event: every rule below sees the latest state.
    const [e] = await tx.select().from(E).where(eq(E.id, eventId)).for('update');
    const now = new Date();
    const phase = phaseOf(e, now);
    if (phase !== 'live') throw new HttpError(409, phase === 'upcoming' ? 'The auction hasn’t started yet.' : phase === 'paused' ? 'The auction is paused.' : 'The auction has closed.');
    const [me] = await tx.select().from(B).where(and(eq(B.eventId, e.id), eq(B.vendorId, v.id)));
    const allowed = e.bidDeadline ? ['QUALIFIED'] : ['ACCEPTED', 'QUALIFIED'];
    if (!me || !me.sentAt || !allowed.includes(me.status)) throw new HttpError(403, e.bidDeadline ? 'Only bidders who qualified in the sealed round can bid.' : 'Accept the invitation first.');
    const [lot] = await tx.select().from(L).where(and(eq(L.eventId, e.id), eq(L.id, input.lotId)));
    if (!lot) throw new HttpError(400, 'An offer refers to a lot that isn’t in this event');

    let amountC: number;
    let lineAmounts: Record<string, string> | null = null;
    if (lot.bidMode === 'line') {
      const lines = await tx.select().from(LN).where(eq(LN.lotId, lot.id));
      const given = input.lines ?? [];
      if (given.length !== lines.length || lines.some((l) => !given.find((g) => g.lineId === l.id))) throw new HttpError(400, `Quote a unit price for every item of lot ${lot.position}, or leave the whole lot out.`);
      amountC = Math.round(lines.reduce((n, l) => n + Number(l.quantity) * given.find((g) => g.lineId === l.id)!.unitPrice * 100, 0));
      lineAmounts = Object.fromEntries(given.map((g) => [g.lineId, String(g.unitPrice)]));
    } else {
      if (input.amount === undefined) throw new HttpError(400, 'Enter your bid');
      amountC = cents(input.amount);
    }
    const lotBids = await bestBids({ lotId: lot.id }, tx);
    const mine = lotBids.find((b) => b.bidderId === me.id);
    const step = Number(e.rules.minStepPct ?? 0.5);
    if (mine) {
      const ceiling = Math.floor(cents(mine.amount) * (1 - step / 100));
      if (amountC > ceiling) throw new HttpError(400, `Your bid must be at most ${fromCents(ceiling).toFixed(2)} (${step}% below your last bid).`, { maxBid: fromCents(ceiling) }, 'BID_TOO_HIGH');
    } else if (lot.startPrice !== null && amountC > cents(lot.startPrice)) {
      throw new HttpError(400, `Your first bid must not be above the start price ${Number(lot.startPrice).toFixed(2)}.`, { maxBid: Number(lot.startPrice) }, 'BID_TOO_HIGH');
    }
    const ranked = rank(lotBids);
    const confirmPct = Number(e.rules.confirmDropPct ?? 20);
    if (ranked.length && !input.confirm && amountC < cents(ranked[0].bid.amount) * (1 - confirmPct / 100)) {
      throw new HttpError(409, `This bid is more than ${confirmPct}% below the current best bid. Check the amount and confirm.`, { amount: fromCents(amountC) }, 'CONFIRM_BID');
    }

    const [last] = await tx.select({ seq: BD.seq, hash: BD.hash }).from(BD).where(eq(BD.eventId, e.id)).orderBy(desc(BD.seq)).limit(1);
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? genesis(e.id);
    const amount = fromCents(amountC).toFixed(2);
    const row = { tenantId: t.id, eventId: e.id, lotId: lot.id, bidderId: me.id, seq, amount, lineAmounts, placedAt: now, prevHash, placedByName: by.name };
    const [bid] = await tx.insert(BD).values({ ...row, hash: hashOf(prevHash, row) }).returning();

    const newRank = rank([...lotBids, bid]);
    await tx.update(L).set({ bestAmount: newRank[0].bid.amount, bestBidderId: newRank[0].bid.bidderId }).where(eq(L.id, lot.id));

    let extendedTo: Date | null = null;
    const extMin = Number(e.rules.extensionMinutes ?? 0);
    if (e.features.includes('autoExtension') && extMin > 0 && e.liveEndsAt!.getTime() - now.getTime() < extMin * 60_000 && e.extensionsUsed < Number(e.rules.maxExtensions ?? 20)) {
      extendedTo = new Date(now.getTime() + extMin * 60_000);
      await tx.update(E).set({ liveEndsAt: extendedTo, extensionsUsed: e.extensionsUsed + 1, updatedAt: now }).where(eq(E.id, e.id));
    }
    return { e, bid, rank: newRank.find((r) => r.bid.bidderId === me.id)!.rank, extendedTo, lot };
  });
  await audit({ tenantId: t.id, vendorId: v.id, actor: by.name, action: 'SOURCING_BID_PLACED', detail: { eventId, number: result.e.number, lot: result.lot.position, seq: result.bid.seq, amount: result.bid.amount, ...(result.extendedTo ? { extendedTo: result.extendedTo.toISOString() } : {}) }, ip: by.ip });
  if (result.extendedTo) await audit({ tenantId: t.id, actor: 'system', action: 'SOURCING_AUCTION_EXTENDED', detail: { eventId, number: result.e.number, to: result.extendedTo.toISOString(), reason: 'auto-extension' } });
  publishLive(key(eventId), { seq: result.bid.seq });
  return { seq: result.bid.seq, amount: Number(result.bid.amount), rank: result.rank, extendedTo: result.extendedTo };
}

/* ---------------- views ---------------- */

async function lotsWithBids(eventId: string) {
  const lots = await db.select().from(L).where(eq(L.eventId, eventId)).orderBy(asc(L.position));
  const lines = await db.select().from(LN).where(eq(LN.eventId, eventId)).orderBy(asc(LN.position));
  const best = await bestBids({ eventId });
  return { lots, lines, best };
}
const timing = (e: SourcingEvent, now = new Date()) => ({ phase: phaseOf(e, now), serverTime: now.toISOString(), startsAt: e.liveStartsAt, endsAt: e.liveEndsAt, pausedAt: e.pausedAt, extensionsUsed: e.extensionsUsed, maxExtensions: Number(e.rules.maxExtensions ?? 0), extensionMinutes: e.features.includes('autoExtension') ? Number(e.rules.extensionMinutes ?? 0) : 0, minStepPct: Number(e.rules.minStepPct ?? 0.5), confirmDropPct: Number(e.rules.confirmDropPct ?? 20) });

/** What a bidder sees: their own bids and rank; the best price or all prices only if the event's visibility allows; never names. */
export async function bidderLive(t: Tenant, v: Vendor, eventId: string) {
  let e = await db.query.sourcingEvents.findFirst({ where: and(eq(E.tenantId, t.id), eq(E.id, eventId)) });
  if (!e || e.format === 'rfq') throw new HttpError(404, 'Event not found');
  e = await syncLive(e);
  const me = await db.query.sourcingBidders.findFirst({ where: and(eq(B.eventId, e.id), eq(B.vendorId, v.id)) });
  if (!me || !me.sentAt || me.status === 'REMOVED') throw new HttpError(404, 'Event not found');
  const allowed = e.bidDeadline ? ['QUALIFIED'] : ['ACCEPTED', 'QUALIFIED'];
  const { lots, lines, best } = await lotsWithBids(e.id);
  const mineAll = await db.select({ lotId: BD.lotId, seq: BD.seq, amount: BD.amount, placedAt: BD.placedAt, invalidatedAt: BD.invalidatedAt }).from(BD)
    .where(and(eq(BD.eventId, e.id), eq(BD.bidderId, me.id))).orderBy(desc(BD.seq));
  const visibility = String(e.rules.visibility ?? 'rank');
  const step = Number(e.rules.minStepPct ?? 0.5);
  const messages = await db.select({ answer: schema.sourcingQuestions.answer, at: schema.sourcingQuestions.publishedAt }).from(schema.sourcingQuestions)
    .where(and(eq(schema.sourcingQuestions.eventId, e.id), isNull(schema.sourcingQuestions.bidderId), sql`${schema.sourcingQuestions.publishedAt} is not null`)).orderBy(desc(schema.sourcingQuestions.publishedAt)).limit(20);
  return {
    ...timing(e), canBid: allowed.includes(me.status), visibility, currency: e.currency, alias: me.alias,
    messages: messages.map((m) => ({ text: m.answer, at: m.at })),
    lots: lots.map((l) => {
      const ranked = rank(best.filter((b) => b.lotId === l.id));
      const myRank = ranked.find((r) => r.bid.bidderId === me.id);
      const myBest = myRank?.bid;
      const maxNext = myBest ? fromCents(Math.floor(cents(myBest.amount) * (1 - step / 100))) : l.startPrice !== null ? Number(l.startPrice) : null;
      return {
        id: l.id, position: l.position, title: l.title, bidMode: l.bidMode, startPrice: l.startPrice === null ? null : Number(l.startPrice),
        lines: lines.filter((x) => x.lotId === l.id).map((x) => ({ id: x.id, description: x.description, quantity: Number(x.quantity), unit: x.unit })),
        myBest: myBest ? Number(myBest.amount) : null, myRank: myRank?.rank ?? null, bidders: ranked.length, maxNext,
        best: visibility !== 'rank' && ranked.length ? Number(ranked[0].bid.amount) : null,
        ladder: visibility === 'ladder' ? ranked.map((r) => ({ rank: r.rank, amount: Number(r.bid.amount), mine: r.bid.bidderId === me.id })) : null,
        myBids: mineAll.filter((b) => b.lotId === l.id).map((b) => ({ seq: b.seq, amount: Number(b.amount), at: b.placedAt, struck: !!b.invalidatedAt })),
      };
    }),
  };
}

/** The buyer's live monitor: every bid with names, rankings, savings, participation and pending strike requests. */
export async function buyerLive(t: Tenant, eventId: string, userId: string) {
  let e = await getEvent(t.id, eventId);
  if (e.format === 'rfq') return null;
  e = await syncLive(e);
  if (phaseOf(e) === 'none') return null;
  const { lots, best } = await lotsWithBids(e.id);
  // Counts per bidder and lot, and the latest 300 bids for the log — never the whole history.
  const counts = await db.select({ lotId: BD.lotId, bidderId: BD.bidderId, n: sql<number>`count(*)::int` }).from(BD)
    .where(and(eq(BD.eventId, e.id), isNull(BD.invalidatedAt))).groupBy(BD.lotId, BD.bidderId);
  const recent = await db.select().from(BD).where(eq(BD.eventId, e.id)).orderBy(desc(BD.seq)).limit(300);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(BD).where(eq(BD.eventId, e.id));
  const nBids = (bidderId: string, lotId?: string) => counts.filter((c) => c.bidderId === bidderId && (!lotId || c.lotId === lotId)).reduce((a, c) => a + c.n, 0);
  const people = await db.select({ id: B.id, alias: B.alias, status: B.status, vendor: V.name }).from(B).innerJoin(V, eq(V.id, B.vendorId)).where(eq(B.eventId, e.id));
  const who = (id: string) => people.find((p) => p.id === id);
  const elig = await eligible(e);
  return {
    ...timing(e),
    eligible: elig.map(({ b, v }) => ({ alias: b.alias, vendor: v.name, bids: nBids(b.id) })),
    lots: lots.map((l) => {
      const ranked = rank(best.filter((b) => b.lotId === l.id));
      const top = ranked[0] ? Number(ranked[0].bid.amount) : null;
      const start = l.startPrice === null ? null : Number(l.startPrice);
      return {
        id: l.id, position: l.position, title: l.title, startPrice: start, target: l.reservePrice === null ? null : Number(l.reservePrice), best: top,
        savingPct: top !== null && start ? Math.round(((start - top) / start) * 1000) / 10 : null,
        ranking: ranked.map((r) => ({ rank: r.rank, alias: who(r.bid.bidderId)?.alias, vendor: who(r.bid.bidderId)?.vendor, amount: Number(r.bid.amount), at: r.bid.placedAt, bids: nBids(r.bid.bidderId, l.id) })),
      };
    }),
    log: recent.map((b) => ({ id: b.id, seq: b.seq, lot: lots.find((l) => l.id === b.lotId)?.position, alias: who(b.bidderId)?.alias, vendor: who(b.bidderId)?.vendor, amount: Number(b.amount), at: b.placedAt, by: b.placedByName, hash: b.hash.slice(0, 12),
      struck: b.invalidatedAt ? { reason: b.invalidatedReason, by: b.invalidatedByName, requestedBy: b.strikeRequestedByName } : null,
      strikeRequest: !b.invalidatedAt && b.strikeRequestedById ? { by: b.strikeRequestedByName, reason: b.strikeReason, mine: b.strikeRequestedById === userId } : null })),
    totalBids: total,
  };
}

/** Check the whole bid history: every hash follows from the one before. */
export async function verifyChain(t: Tenant, eventId: string) {
  const e = await getEvent(t.id, eventId);
  const bids = await db.select().from(BD).where(eq(BD.eventId, e.id)).orderBy(asc(BD.seq));
  let prev = genesis(e.id);
  for (const b of bids) {
    if (b.prevHash !== prev || hashOf(prev, { seq: b.seq, lotId: b.lotId, bidderId: b.bidderId, amount: Number(b.amount).toFixed(2), placedAt: b.placedAt }) !== b.hash) return { ok: false, bids: bids.length, brokenAt: b.seq };
    prev = b.hash;
  }
  return { ok: true, bids: bids.length, brokenAt: null, lastHash: prev };
}

/** The bid history as CSV (for the audit file). */
export async function bidLogCsv(t: Tenant, eventId: string) {
  const e = await getEvent(t.id, eventId);
  const rows = await db.select({ b: BD, alias: B.alias, vendor: V.name, lot: L.position }).from(BD).innerJoin(B, eq(B.id, BD.bidderId)).innerJoin(V, eq(V.id, B.vendorId)).innerJoin(L, eq(L.id, BD.lotId)).where(eq(BD.eventId, e.id)).orderBy(asc(BD.seq));
  // The shared CSV writer: names typed by suppliers (e.g. "=HYPERLINK(…)") never become spreadsheet formulas.
  const head = ['Seq', 'Time (UTC)', 'Lot', 'Bidder', 'Supplier', 'Placed by', 'Amount', 'Struck out', 'Reason', 'Previous hash', 'Hash'];
  return toCsv([head, ...rows.map(({ b, alias, vendor, lot }) => [b.seq, b.placedAt.toISOString(), lot, alias, vendor, b.placedByName, b.amount, b.invalidatedAt ? 'yes' : '', b.invalidatedReason, b.prevHash, b.hash].map((x) => String(x ?? '')))]);
}

/* ---------------- auctioneer controls ---------------- */

async function liveEvent(t: Tenant, eventId: string) {
  const e = await syncLive(await getEvent(t.id, eventId));
  if (e.format === 'rfq') throw new HttpError(400, 'This isn’t an auction.');
  return e;
}

export async function pauseAuction(t: Tenant, eventId: string, reason: string, by: { name: string; ip?: string }) {
  const e = await liveEvent(t, eventId);
  if (phaseOf(e) !== 'live') throw new HttpError(409, 'Only a running auction can be paused.');
  if (!reason.trim()) throw new HttpError(400, 'Give a reason for pausing');
  await db.update(E).set({ pausedAt: new Date(), updatedAt: new Date() }).where(eq(E.id, e.id));
  await audit({ tenantId: t.id, actor: by.name, action: 'SOURCING_AUCTION_PAUSED', detail: { eventId: e.id, number: e.number, reason: reason.trim() }, ip: by.ip });
  publishLive(key(e.id));
}

export async function resumeAuction(t: Tenant, eventId: string, by: { name: string; ip?: string }) {
  const e = await liveEvent(t, eventId);
  if (!e.pausedAt) throw new HttpError(409, 'The auction isn’t paused.');
  const now = new Date();
  const endsAt = new Date(e.liveEndsAt!.getTime() + (now.getTime() - e.pausedAt.getTime()));
  await db.update(E).set({ pausedAt: null, liveEndsAt: endsAt, updatedAt: now }).where(eq(E.id, e.id));
  await audit({ tenantId: t.id, actor: by.name, action: 'SOURCING_AUCTION_RESUMED', detail: { eventId: e.id, number: e.number, endsAt: endsAt.toISOString() }, ip: by.ip });
  publishLive(key(e.id));
}

export async function extendAuction(t: Tenant, eventId: string, minutes: number, reason: string, by: { name: string; ip?: string }) {
  const e = await liveEvent(t, eventId);
  const ph = phaseOf(e);
  if (ph !== 'live' && ph !== 'paused' && ph !== 'upcoming') throw new HttpError(409, 'The auction has closed.');
  const m = z.number().int().min(1, 'Extend by at least a minute').max(24 * 60, 'Extend by at most a day').parse(minutes);
  if (!reason.trim()) throw new HttpError(400, 'Give a reason for extending');
  const endsAt = new Date(e.liveEndsAt!.getTime() + m * 60_000);
  await db.update(E).set({ liveEndsAt: endsAt, updatedAt: new Date() }).where(eq(E.id, e.id));
  await audit({ tenantId: t.id, actor: by.name, action: 'SOURCING_AUCTION_EXTENDED', detail: { eventId: e.id, number: e.number, minutes: m, to: endsAt.toISOString(), reason: reason.trim() }, ip: by.ip });
  publishLive(key(e.id));
}

/** Strike out an obviously mistaken bid: one person asks (with a reason), a different person confirms. */
export async function requestStrike(t: Tenant, eventId: string, bidId: string, reason: string, by: { id: string; name: string; ip?: string }) {
  const e = await liveEvent(t, eventId);
  if (!reason.trim()) throw new HttpError(400, 'Give a reason for striking out the bid');
  const [b] = await db.select().from(BD).where(and(eq(BD.eventId, e.id), eq(BD.id, bidId)));
  if (!b) throw new HttpError(404, 'Bid not found');
  if (b.invalidatedAt) throw new HttpError(409, 'This bid is already struck out.');
  await db.update(BD).set({ strikeRequestedById: by.id, strikeRequestedByName: by.name, strikeReason: reason.trim() }).where(eq(BD.id, b.id));
  await audit({ tenantId: t.id, actor: by.name, action: 'SOURCING_BID_STRIKE_REQUESTED', detail: { eventId: e.id, number: e.number, seq: b.seq, amount: b.amount, reason: reason.trim() }, ip: by.ip });
  publishLive(key(e.id));
}

export async function confirmStrike(t: Tenant, eventId: string, bidId: string, by: { id: string; name: string; ip?: string }) {
  const e = await liveEvent(t, eventId);
  const [b] = await db.select().from(BD).where(and(eq(BD.eventId, e.id), eq(BD.id, bidId)));
  if (!b || !b.strikeRequestedById) throw new HttpError(404, 'No strike-out was asked for on this bid.');
  if (b.invalidatedAt) throw new HttpError(409, 'This bid is already struck out.');
  if (b.strikeRequestedById === by.id) throw new HttpError(403, 'A different person has to confirm striking out a bid.');
  await db.transaction(async (tx) => {
    await tx.update(BD).set({ invalidatedAt: new Date(), invalidatedReason: b.strikeReason, invalidatedByName: by.name }).where(eq(BD.id, b.id));
    const rest = rank(await bestBids({ lotId: b.lotId }, tx));
    await tx.update(L).set({ bestAmount: rest[0]?.bid.amount ?? null, bestBidderId: rest[0]?.bid.bidderId ?? null }).where(eq(L.id, b.lotId));
  });
  await audit({ tenantId: t.id, actor: by.name, action: 'SOURCING_BID_STRUCK_OUT', detail: { eventId: e.id, number: e.number, seq: b.seq, amount: b.amount, reason: b.strikeReason, requestedBy: b.strikeRequestedByName }, ip: by.ip });
  publishLive(key(e.id));
}

export async function cancelStrike(t: Tenant, eventId: string, bidId: string, by: { name: string; ip?: string }) {
  const e = await liveEvent(t, eventId);
  const [b] = await db.select().from(BD).where(and(eq(BD.eventId, e.id), eq(BD.id, bidId)));
  if (!b || !b.strikeRequestedById || b.invalidatedAt) throw new HttpError(404, 'No open strike-out request on this bid.');
  await db.update(BD).set({ strikeRequestedById: null, strikeRequestedByName: null, strikeReason: null }).where(eq(BD.id, b.id));
  await audit({ tenantId: t.id, actor: by.name, action: 'SOURCING_BID_STRIKE_CANCELLED', detail: { eventId: e.id, number: e.number, seq: b.seq }, ip: by.ip });
  publishLive(key(e.id));
}

/* ---------------- the clock: start, close, reminders ---------------- */

/** Every minute: move auctions along and send start reminders (a day and an hour before). */
export async function runLiveSweep(now = new Date()) {
  const rows = await db.select().from(E).where(and(sql`${E.format} <> 'rfq'`, inArray(E.status, [...LIVE_FROM, 'LIVE']), sql`${E.liveStartsAt} is not null`));
  for (const row of rows) {
    const e = await syncLive(row, now);
    if (phaseOf(e, now) !== 'upcoming' || !e.features.includes('startReminders')) continue;
    const left = e.liveStartsAt!.getTime() - now.getTime();
    const due = left <= 60 * 60_000 ? 'hour' : left <= 24 * 3_600_000 ? 'day' : null;
    if (!due || e.reminders.includes(due)) continue;
    await db.update(E).set({ reminders: [...e.reminders, due, ...(due === 'hour' && !e.reminders.includes('day') ? ['day'] : [])] }).where(eq(E.id, e.id));
    const t = (await db.query.tenants.findFirst({ where: eq(schema.tenants.id, e.tenantId) }))!;
    for (const { v } of await eligible(e)) {
      await mailSupplier(await langForVendor(v, t), { tenantId: t.id, to: v.contactEmail, link: portalLink(v) }, 'sourcingAuctionReminder', { first: v.contactFirstName, buyer: t.name, number: e.number, title: e.title, when: formatDeadline(e.liveStartsAt!, t), ends: formatDeadline(e.liveEndsAt!, t) });
    }
  }
}
defineJob('sourcing.live', async () => { await runLiveSweep(); }, { retryLimit: 0, expireInSeconds: 50 });
