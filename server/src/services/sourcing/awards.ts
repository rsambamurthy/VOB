/**
 * Sourcing step 5: the award.
 *
 * - Results per lot: from the live auction (each bidder's best valid bid) or, without live bids, from the opened
 *   sealed prices. Rank 1 = best price.
 * - The buyer proposes the award: each lot to one bidder or split between bidders by share (%), or not awarded.
 *   Awarding any share to someone other than the best price needs a reason (option `awardReason`).
 * - The proposal goes through the award approval flow (services/approvalFlow.ts, levels in Administration →
 *   Sourcing; conditions on the awarded value and on "not the best price"). Nobody approves their own proposal.
 * - On approval: award and regret letters (option `resultLetters`); new suppliers who won (outside bidders) start
 *   full onboarding; each winner's award goes to the ERP as an "award" message through the order-message channel
 *   (services/orders/outbound.ts) — for new suppliers once they are approved (releaseAwardsFor).
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../lib/db.js';
import type { Tenant } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../lib/env.js';
import { mailSupplier, langForVendor } from '../../i18n/emails.js';
import { portalLink, sendInvite } from '../vendors.js';
import { cancelFlow, flowView, registerFlowSubject, startFlow } from '../approvalFlow.js';
import { queueAwardMessage, messageView, type AwardMessage } from '../orders/outbound.js';
import { approvalLevels, awardRuleContext } from './config.js';
import { getEvent, tellOwner, type SourcingEvent } from './events.js';
import { envelopesOf, openedOffers } from './submissions.js';
import { syncLive } from './live.js';

const { sourcingAwards: A, sourcingBidders: B, sourcingEvents: E, sourcingLots: L, sourcingLines: LN, sourcingBids: BD, vendors: V } = schema;
type By = { id: string; name: string; ip?: string };
const round2 = (n: number) => Math.round(n * 100) / 100;

/* ---------------- results ---------------- */

export interface Candidate { bidderId: string; alias: string; vendor: string; vendorId: string; amount: number; rank: number; unitPrices: Record<string, number> | null; paymentTerms: string | null; deliveryDays: number | null; taxPct: number | null }

/** Each lot's candidates, best first: live bids if there were any, otherwise the opened sealed prices. */
export async function resultsFor(e: SourcingEvent) {
  const lots = await db.select().from(L).where(eq(L.eventId, e.id)).orderBy(asc(L.position));
  const people = await db.select({ id: B.id, alias: B.alias, vendor: V.name, vendorId: V.id }).from(B).innerJoin(V, eq(V.id, B.vendorId)).where(eq(B.eventId, e.id));
  const who = (id: string) => people.find((p) => p.id === id)!;
  const sealed = e.bidDeadline ? await openedOffers(e) : null;
  const terms = (bidderId: string) => {
    const o = sealed?.comparison.flatMap((l) => l.quotes).find((q) => q.bidderId === bidderId);
    return { paymentTerms: o?.paymentTerms || null, deliveryDays: o?.deliveryDays ?? null, taxPct: o?.taxPct ?? null };
  };
  const bids = e.format === 'rfq' ? [] : await db.select().from(BD).where(eq(BD.eventId, e.id));
  const source: 'live' | 'sealed' = bids.some((b) => !b.invalidatedAt) ? 'live' : 'sealed';
  return {
    source,
    lots: lots.map((l) => {
      let list: Omit<Candidate, 'rank'>[];
      if (source === 'live') {
        const best = new Map<string, (typeof bids)[number]>();
        for (const b of bids) if (b.lotId === l.id && !b.invalidatedAt) { const c = best.get(b.bidderId); if (!c || Number(b.amount) < Number(c.amount) || (Number(b.amount) === Number(c.amount) && b.placedAt < c.placedAt)) best.set(b.bidderId, b); }
        list = [...best.values()].sort((a, b) => Number(a.amount) - Number(b.amount) || +a.placedAt - +b.placedAt)
          .map((b) => ({ bidderId: b.bidderId, alias: who(b.bidderId).alias, vendor: who(b.bidderId).vendor, vendorId: who(b.bidderId).vendorId, amount: Number(b.amount), unitPrices: b.lineAmounts ? Object.fromEntries(Object.entries(b.lineAmounts).map(([k, v]) => [k, Number(v)])) : null, ...terms(b.bidderId) }));
      } else {
        const lot = sealed?.comparison.find((c) => c.lotId === l.id);
        list = (lot?.quotes ?? []).map((q) => ({ bidderId: q.bidderId, alias: q.alias, vendor: q.vendor, vendorId: who(q.bidderId).vendorId, amount: q.total, unitPrices: q.lines ? Object.fromEntries(q.lines.map((x: { lineId: string; unitPrice: number }) => [x.lineId, x.unitPrice])) : null, paymentTerms: q.paymentTerms || null, deliveryDays: q.deliveryDays, taxPct: q.taxPct }));
      }
      return { lotId: l.id, position: l.position, title: l.title, bidMode: l.bidMode, startPrice: l.startPrice === null ? null : Number(l.startPrice), target: l.reservePrice === null ? null : Number(l.reservePrice), candidates: list.map((c, i) => ({ ...c, rank: i + 1 })) };
    }),
  };
}

/** Ready to award: prices are known (auction closed, or sealed prices opened). */
function assertCanPropose(e: SourcingEvent) {
  if (e.isTemplate) throw new HttpError(400, 'Templates aren’t awarded.');
  if (e.status === 'AWARD_PENDING') throw new HttpError(409, 'An award is already waiting for approval. Withdraw it to change it.');
  if (e.status === 'AWARDED') throw new HttpError(409, 'This event has been awarded.');
  const priceEnv = envelopesOf(e).includes('commercial') ? 'commercial' : 'single';
  const ready = e.format === 'rfq' ? e.status === 'EVALUATION' && !!e.opened[priceEnv] : e.status === 'CLOSED';
  if (!ready) throw new HttpError(409, e.format === 'rfq' ? 'Open the prices before awarding.' : 'The auction must close before awarding.');
}

/* ---------------- proposal ---------------- */

export const proposalSchema = z.object({
  note: z.string().trim().max(5000).optional(),
  lots: z.array(z.object({
    lotId: z.string(),
    splits: z.array(z.object({ bidderId: z.string(), sharePct: z.number().gt(0, 'Shares must be more than 0').max(100) })).max(10),
    reason: z.string().trim().max(2000).optional(),
  })),
});

export async function proposeAward(t: Tenant, eventId: string, raw: unknown, by: By) {
  const e = await syncLive(await getEvent(t.id, eventId));
  assertCanPropose(e);
  const input = proposalSchema.parse(raw);
  const res = await resultsFor(e);
  const rows: (typeof A.$inferInsert)[] = [];
  let notBest = false;
  for (const p of input.lots) {
    if (!p.splits.length) continue;
    const lot = res.lots.find((l) => l.lotId === p.lotId);
    if (!lot) throw new HttpError(400, 'A lot in the award isn’t in this event.');
    const total = p.splits.reduce((n, s) => n + s.sharePct, 0);
    if (Math.abs(total - 100) > 0.001) throw new HttpError(400, `Lot ${lot.position}: the shares must add up to 100%.`);
    if (new Set(p.splits.map((s) => s.bidderId)).size !== p.splits.length) throw new HttpError(400, `Lot ${lot.position}: a bidder appears twice.`);
    const lotNotBest = p.splits.some((s) => lot.candidates.find((c) => c.bidderId === s.bidderId)?.rank !== 1);
    if (lotNotBest && e.features.includes('awardReason') && !p.reason) throw new HttpError(400, `Lot ${lot.position}: give a reason for not awarding all of it to the best price.`);
    notBest ||= lotNotBest;
    for (const s of p.splits) {
      const c = lot.candidates.find((x) => x.bidderId === s.bidderId);
      if (!c) throw new HttpError(400, `Lot ${lot.position}: that bidder has no price for this lot.`);
      rows.push({ tenantId: t.id, eventId: e.id, lotId: lot.lotId, bidderId: c.bidderId, amount: String(round2((c.amount * s.sharePct) / 100)), sharePct: String(s.sharePct), lotPrice: String(c.amount), rank: c.rank, unitPrices: c.unitPrices, reason: p.reason || null, status: 'PROPOSED' });
    }
  }
  if (!rows.length) throw new HttpError(400, 'Award at least one lot.');
  const value = round2(rows.reduce((n, r) => n + Number(r.amount), 0));
  const [claimed] = await db.update(E).set({ status: 'AWARD_PENDING', awardFromStatus: e.status, awardNote: input.note || null, awardProposedById: by.id, awardProposedByName: by.name, updatedAt: new Date() })
    .where(and(eq(E.id, e.id), eq(E.status, e.status))).returning();
  if (!claimed) throw new HttpError(409, 'The event was just changed by someone else — refresh the page');
  await db.delete(A).where(and(eq(A.eventId, e.id), inArray(A.status, ['PROPOSED', 'RETURNED', 'REJECTED'])));
  await db.insert(A).values(rows);
  await audit({ tenantId: t.id, actor: by.name, action: 'SOURCING_AWARD_PROPOSED', detail: { eventId: e.id, number: e.number, value, lots: input.lots.filter((l) => l.splits.length).length, notBest }, ip: by.ip });
  try {
    const { steps } = await startFlow(t, 'sourcing_award', e.id, approvalLevels(t, 'award'), awardRuleContext(e, value, notBest), by);
    if (!steps.length) { await finalizeAward(t.id, e.id, by.name); return { status: 'AWARDED' as const, levels: [] as string[] }; }
    return { status: 'AWARD_PENDING' as const, levels: steps.map((s) => s.label) };
  } catch (err) {
    await db.update(E).set({ status: e.status, awardFromStatus: null }).where(eq(E.id, e.id));
    await db.update(A).set({ status: 'RETURNED' }).where(and(eq(A.eventId, e.id), eq(A.status, 'PROPOSED')));
    throw err;
  }
}

export async function withdrawAward(t: Tenant, eventId: string, by: By) {
  const e = await getEvent(t.id, eventId);
  if (e.status !== 'AWARD_PENDING') throw new HttpError(409, 'No award is waiting for approval.');
  await cancelFlow(t.id, 'sourcing_award', e.id);
  await returnToEvaluation(e, 'RETURNED');
  await audit({ tenantId: t.id, actor: by.name, action: 'SOURCING_AWARD_WITHDRAWN', detail: { eventId: e.id, number: e.number }, ip: by.ip });
}

async function returnToEvaluation(e: SourcingEvent, rowStatus: 'RETURNED' | 'REJECTED') {
  await db.update(E).set({ status: e.awardFromStatus ?? (e.format === 'rfq' ? 'EVALUATION' : 'CLOSED'), awardFromStatus: null, updatedAt: new Date() }).where(eq(E.id, e.id));
  await db.update(A).set({ status: rowStatus }).where(and(eq(A.eventId, e.id), eq(A.status, 'PROPOSED')));
}

/* ---------------- approved: letters, onboarding, ERP ---------------- */

async function awardMessage(e: SourcingEvent, vendorId: string, bidderId: string): Promise<AwardMessage> {
  const v = (await db.query.vendors.findFirst({ where: eq(V.id, vendorId) }))!;
  const rows = await db.select({ a: A, lot: L }).from(A).innerJoin(L, eq(L.id, A.lotId)).where(and(eq(A.eventId, e.id), eq(A.bidderId, bidderId), eq(A.status, 'APPROVED'))).orderBy(asc(L.position));
  const lines = await db.select().from(LN).where(eq(LN.eventId, e.id)).orderBy(asc(LN.position));
  const terms = (await resultsFor(e)).lots.flatMap((l) => l.candidates).find((c) => c.bidderId === bidderId);
  const out: AwardMessage['lines'] = [];
  for (const { a, lot } of rows) {
    const share = Number(a.sharePct) / 100;
    const ls = lines.filter((x) => x.lotId === lot.id);
    // Per-item prices when quoted; for a single lot price, spread it over the lot's quantity value (one PO line per item, same total).
    const qtyTotal = ls.reduce((n, x) => n + Number(x.quantity), 0) || 1;
    for (const x of ls) {
      const quantity = Math.round(Number(x.quantity) * share * 1000) / 1000;
      const unitPrice = a.unitPrices?.[x.id] ?? round2(Number(a.lotPrice ?? a.amount) / (ls.length === 1 ? Number(x.quantity) || 1 : qtyTotal));
      out.push({ lot: lot.position, lotTitle: lot.title, lineNo: x.position, itemCode: x.itemCode, description: x.description, quantity, unit: x.unit, unitPrice, amount: round2(quantity * unitPrice), sharePct: Number(a.sharePct) });
    }
  }
  return { eventNumber: e.number, title: e.title, format: e.format, currency: e.currency, supplierCode: v.erpVendorId ?? v.code, supplierName: v.name, vendorId: v.id, awardedAt: (e.awardedAt ?? new Date()).toISOString(),
    paymentTerms: terms?.paymentTerms ?? null, deliveryDays: terms?.deliveryDays ?? null, total: round2(rows.reduce((n, r) => n + Number(r.a.amount), 0)), lines: out };
}

async function sendToErp(e: SourcingEvent, vendorId: string, bidderId: string, by: string) {
  if (!e.features.includes('awardToErp')) { await db.update(A).set({ erpStatus: 'NOT_SENT' }).where(and(eq(A.eventId, e.id), eq(A.bidderId, bidderId), eq(A.status, 'APPROVED'))); return; }
  const m = await queueAwardMessage(e.tenantId, e.id, vendorId, await awardMessage(e, vendorId, bidderId), by);
  await db.update(A).set({ erpStatus: m.status === 'NO_CONNECTOR' ? 'NOT_SENT' : 'QUEUED' }).where(and(eq(A.eventId, e.id), eq(A.bidderId, bidderId), eq(A.status, 'APPROVED')));
}

export async function finalizeAward(tenantId: string, eventId: string, by: string) {
  const now = new Date();
  const [e] = await db.update(E).set({ status: 'AWARDED', awardedAt: now, awardFromStatus: null, updatedAt: now }).where(and(eq(E.tenantId, tenantId), eq(E.id, eventId))).returning();
  await db.update(A).set({ status: 'APPROVED', approvedAt: now }).where(and(eq(A.eventId, e.id), eq(A.status, 'PROPOSED')));
  const t = (await db.query.tenants.findFirst({ where: eq(schema.tenants.id, tenantId) }))!;
  const awards = await db.select({ a: A, lot: L }).from(A).innerJoin(L, eq(L.id, A.lotId)).where(and(eq(A.eventId, e.id), eq(A.status, 'APPROVED'))).orderBy(asc(L.position));
  const winners = [...new Set(awards.map((x) => x.a.bidderId))];
  const everyone = await db.select({ b: B, v: V }).from(B).innerJoin(V, eq(V.id, B.vendorId)).where(and(eq(B.eventId, e.id), inArray(B.status, ['ACCEPTED', 'QUALIFIED', 'DISQUALIFIED'])));
  const letters = e.features.includes('resultLetters');
  for (const { b, v } of everyone) {
    const lang = await langForVendor(v, t);
    const won = winners.includes(b.id);
    if (letters) {
      if (won) {
        const mine = awards.filter((x) => x.a.bidderId === b.id).map((x) => `- ${lang === 'ar' ? 'المجموعة' : 'Lot'} ${x.lot.position} ${x.lot.title}${Number(x.a.sharePct) < 100 ? ` (${Number(x.a.sharePct)}%)` : ''}: ${Number(x.a.amount).toFixed(2)} ${e.currency}`).join('\n');
        await mailSupplier(lang, { tenantId: t.id, to: v.contactEmail, link: portalLink(v) }, v.bidderOnly ? 'sourcingAwardWinNew' : 'sourcingAwardWin', { first: v.contactFirstName, buyer: t.name, number: e.number, title: e.title, lines: mine });
      } else await mailSupplier(lang, { tenantId: t.id, to: v.contactEmail }, 'sourcingAwardRegret', { first: v.contactFirstName, buyer: t.name, number: e.number, title: e.title });
    }
    if (!won) continue;
    if (letters) await db.update(A).set({ letterSentAt: now }).where(and(eq(A.eventId, e.id), eq(A.bidderId, b.id)));
    if (v.bidderOnly || v.status !== 'APPROVED') {
      // A new supplier won: full onboarding now; the award goes to the ERP once they are approved.
      if (v.bidderOnly) {
        await db.update(V).set({ bidderOnly: false }).where(eq(V.id, v.id));
        if (!letters) await sendInvite(t, v);
        await audit({ tenantId: t.id, vendorId: v.id, actor: 'system', action: 'INVITE_SENT', detail: { to: v.contactEmail, reason: `Won ${e.number}` } });
      }
      await db.update(A).set({ erpStatus: 'WAITING_ONBOARDING' }).where(and(eq(A.eventId, e.id), eq(A.bidderId, b.id)));
    } else await sendToErp(e, v.id, b.id, by);
  }
  await audit({ tenantId, actor: 'system', action: 'SOURCING_AWARDED', detail: { eventId: e.id, number: e.number, suppliers: winners.length, value: round2(awards.reduce((n, x) => n + Number(x.a.amount), 0)) } });
  await tellOwner(e, `Awarded: ${e.number} ${e.title}`, `The award for ${e.number} “${e.title}” is approved.${letters ? ' Award and regret letters were sent.' : ''}`);
}

/** A supplier who won as an outside bidder has just been approved: send their waiting awards to the ERP. */
export async function releaseAwardsFor(vendorId: string) {
  const waiting = await db.select({ a: A, b: B }).from(A).innerJoin(B, eq(B.id, A.bidderId)).where(and(eq(B.vendorId, vendorId), eq(A.status, 'APPROVED'), eq(A.erpStatus, 'WAITING_ONBOARDING')));
  for (const id of [...new Set(waiting.map((w) => w.a.eventId))]) {
    const e = (await db.query.sourcingEvents.findFirst({ where: eq(E.id, id) }))!;
    await sendToErp(e, vendorId, waiting.find((w) => w.a.eventId === id)!.b.id, 'system (supplier approved)');
  }
}

registerFlowSubject('sourcing_award', {
  async describe(tenantId, id) {
    const e = await db.query.sourcingEvents.findFirst({ where: and(eq(E.tenantId, tenantId), eq(E.id, id)) });
    return e ? { title: e.title, ref: e.number, link: `${env.appBaseUrl}/staff/sourcing/events/${e.id}`, kind: 'The award for' } : null;
  },
  async approved(tenantId, id, by) { await finalizeAward(tenantId, id, by.name); },
  async returned(tenantId, id, decision, remarks) {
    const e = await getEvent(tenantId, id);
    await returnToEvaluation(e, decision === 'REJECT' ? 'REJECTED' : 'RETURNED');
    await tellOwner(e, `Award ${decision === 'SEND_BACK' ? 'sent back' : 'rejected'}: ${e.number}`, `The award for ${e.number} “${e.title}” was ${decision === 'SEND_BACK' ? 'sent back' : 'rejected'}:\n\n${remarks}\n\nChange it and propose it again.`);
  },
  async blockedFor(tenantId, id, userId) {
    const e = await db.query.sourcingEvents.findFirst({ where: and(eq(E.tenantId, tenantId), eq(E.id, id)) });
    return e?.awardProposedById === userId ? 'You can’t approve an award you proposed. Another approver has to.' : null;
  },
});

/* ---------------- the award section on the event page ---------------- */

export async function awardView(t: Tenant, e: SourcingEvent, userId: string) {
  const priceEnv = envelopesOf(e).includes('commercial') ? 'commercial' : 'single';
  const pricesKnown = e.format === 'rfq' ? !!e.opened[priceEnv] : ['CLOSED', 'AWARD_PENDING', 'AWARDED'].includes(e.status);
  if (!pricesKnown) return null;
  const results = await resultsFor(e);
  const rows = await db.select().from(A).where(eq(A.eventId, e.id));
  const current = rows.filter((r) => ['PROPOSED', 'APPROVED'].includes(r.status));
  const last = current.length ? current : rows.filter((r) => r.status === 'RETURNED' || r.status === 'REJECTED');
  const lots = results.lots.map((l) => {
    const mine = last.filter((r) => r.lotId === l.lotId);
    return { ...l, award: mine.map((r) => ({ bidderId: r.bidderId, sharePct: Number(r.sharePct), amount: Number(r.amount), rank: r.rank, reason: r.reason, erpStatus: r.erpStatus, letterSentAt: r.letterSentAt, status: r.status })) };
  });
  const awardedTotal = round2(current.reduce((n, r) => n + Number(r.amount), 0));
  const awardedLots = lots.filter((l) => l.award.length && current.length);
  const startTotal = awardedLots.every((l) => l.startPrice !== null) ? awardedLots.reduce((n, l) => n + l.startPrice!, 0) : null;
  const estimate = e.estimatedValue === null ? null : Number(e.estimatedValue);
  const messages = await db.select().from(schema.poMessages).where(and(eq(schema.poMessages.eventId, e.id), eq(schema.poMessages.kind, 'AWARD')));
  const vendors = messages.length ? await db.select({ id: V.id, name: V.name }).from(V).where(inArray(V.id, messages.map((m) => m.vendorId!).filter(Boolean))) : [];
  const winners = await db.select({ b: B, v: V }).from(B).innerJoin(V, eq(V.id, B.vendorId)).where(inArray(B.id, current.length ? [...new Set(current.map((r) => r.bidderId))] : ['-']));
  return {
    source: results.source, lots, status: e.status, note: e.awardNote, proposedBy: e.awardProposedByName, awardedAt: e.awardedAt,
    canPropose: !['AWARD_PENDING', 'AWARDED'].includes(e.status), returned: !current.length && last.length ? last[0].status : null,
    savings: current.length ? { awardedTotal, estimate, vsEstimatePct: estimate ? round2(((estimate - awardedTotal) / estimate) * 100) : null, startTotal, vsStartPct: startTotal ? round2(((startTotal - awardedTotal) / startTotal) * 100) : null } : null,
    approval: await flowView(t.id, 'sourcing_award', e.id, userId),
    winners: winners.map(({ b, v }) => ({ bidderId: b.id, alias: b.alias, vendorId: v.id, vendor: v.name, vendorStatus: v.status, newSupplier: v.status !== 'APPROVED' })),
    erp: messages.map((m) => ({ ...messageView(m), vendor: vendors.find((x) => x.id === m.vendorId)?.name ?? '' })),
  };
}

/** For the bidder's event page once awarded: what (if anything) they won. Never other bidders' results. */
export async function bidderResult(e: SourcingEvent, bidderId: string) {
  if (e.status !== 'AWARDED') return null;
  const mine = await db.select({ a: A, lot: L }).from(A).innerJoin(L, eq(L.id, A.lotId)).where(and(eq(A.eventId, e.id), eq(A.bidderId, bidderId), eq(A.status, 'APPROVED'))).orderBy(asc(L.position));
  return { awarded: mine.map(({ a, lot }) => ({ position: lot.position, title: lot.title, sharePct: Number(a.sharePct), amount: Number(a.amount) })) };
}
