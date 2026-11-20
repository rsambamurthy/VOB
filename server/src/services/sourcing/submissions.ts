/**
 * Sourcing step 3: sealed bids.
 *
 * - Bidders who accepted send their offer before the deadline: prices per item or per lot (as the event says), tax,
 *   delivery, validity, payment terms, remarks and files. With two envelopes the technical envelope (remarks + files)
 *   and the commercial envelope (prices + terms) are separate. Content is encrypted at rest (sealedJson); a SHA-256
 *   of it is the bidder's receipt. Revisions (when allowed) make a new version; only the latest counts.
 * - Nobody — the buyer included — sees an offer or its files until the opening committee opens that envelope after
 *   the deadline: each member (permission sourcing.open) confirms; it opens when the event's quorum is reached.
 * - Two envelopes: technical first; evaluators (sourcing.evaluate) score each bidder 0–10 per weighted criterion;
 *   finishing the evaluation qualifies bidders at or above the pass mark (or by the buyer's decision, with a note).
 *   Only qualified bidders' commercial envelopes are ever opened.
 * - Reverse auctions with a sealed round: qualified bidders go into the auction; the best sealed price can become the
 *   lot's start price.
 */
import crypto from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../lib/db.js';
import type { Tenant, Vendor } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { storeUpload } from '../../integrations/storage/index.js';
import { mailSupplier, langForVendor } from '../../i18n/emails.js';
import { portalLink } from '../vendors.js';
import { usersWithPermission } from '../approvers.js';
import { closesAt } from './bidders.js';
import { getEvent, tellOwner, type SourcingEvent } from './events.js';

const { sourcingSubmissions: S, sourcingBidders: B, sourcingOpenings: O, sourcingScores: SC, sourcingEvents: E, sourcingLots: L, sourcingLines: LN } = schema;
export type Envelope = 'single' | 'technical' | 'commercial';

/** The envelopes an event uses: one, or technical then commercial. */
export const envelopesOf = (e: Pick<SourcingEvent, 'rules'>): Envelope[] => (e.rules.envelope === 'two' ? ['technical', 'commercial'] : ['single']);
const priced = (env: Envelope) => env !== 'technical';
const hasSealedRound = (e: SourcingEvent) => !!e.bidDeadline;
const pastDeadline = (e: SourcingEvent, now = new Date()) => { const c = closesAt(e); return !!c && c <= now; };

/** The envelope the committee opens next (null when everything that can be opened is open). */
export function nextEnvelope(e: SourcingEvent): Envelope | null {
  const envs = envelopesOf(e);
  if (envs[0] === 'single') return e.opened.single ? null : 'single';
  if (!e.opened.technical) return 'technical';
  if (!e.technicalDoneAt) return null; // waiting for the technical evaluation
  return e.opened.commercial ? null : 'commercial';
}

/* ---------------- the bidder's offer ---------------- */

const money = z.number({ invalid_type_error: 'Enter a number' }).positive('Prices must be more than 0').max(1e13);
export const offerSchema = z.object({
  lots: z.array(z.object({ lotId: z.string(), price: money.optional(), lines: z.array(z.object({ lineId: z.string(), unitPrice: money })).optional() })).default([]),
  taxPct: z.number().min(0).max(100).optional(),
  deliveryDays: z.number().int().min(0).max(3650).optional(),
  validityDays: z.number().int().min(1).max(3650).optional(),
  paymentTerms: z.string().trim().max(300).optional(),
  remarks: z.string().trim().max(10_000).optional(),
  attachments: z.array(z.string()).max(10).default([]),
});
export type Offer = z.infer<typeof offerSchema>;

async function myBidder(v: Vendor, eventId: string) {
  const b = await db.query.sourcingBidders.findFirst({ where: and(eq(B.vendorId, v.id), eq(B.eventId, eventId)) });
  if (!b || b.status === 'REMOVED' || !b.sentAt) throw new HttpError(404, 'Event not found');
  const e = (await db.query.sourcingEvents.findFirst({ where: eq(E.id, eventId) }))!;
  return { b, e };
}
async function itemsFor(eventId: string) {
  const lots = await db.select().from(L).where(eq(L.eventId, eventId)).orderBy(asc(L.position));
  const lines = await db.select().from(LN).where(eq(LN.eventId, eventId)).orderBy(asc(LN.position));
  return { lots, lines };
}

/** Check an offer against the event's lots and lines; returns the cleaned content with each lot's total. */
async function checkOffer(e: SourcingEvent, env: Envelope, raw: unknown) {
  const o = offerSchema.parse(raw);
  if (!priced(env)) return { remarks: o.remarks ?? '', attachments: o.attachments };
  const { lots, lines } = await itemsFor(e.id);
  const out: { lotId: string; price?: number; lines?: { lineId: string; unitPrice: number }[]; total: number }[] = [];
  for (const q of o.lots) {
    const lot = lots.find((l) => l.id === q.lotId);
    if (!lot) throw new HttpError(400, 'An offer refers to a lot that isn’t in this event');
    if (lot.bidMode === 'line') {
      const mine = lines.filter((x) => x.lotId === lot.id);
      const given = q.lines ?? [];
      if (given.length !== mine.length || mine.some((m) => !given.find((g) => g.lineId === m.id))) throw new HttpError(400, `Quote a unit price for every item of lot ${lot.position}, or leave the whole lot out.`);
      const total = mine.reduce((n, m) => n + Number(m.quantity) * given.find((g) => g.lineId === m.id)!.unitPrice, 0);
      out.push({ lotId: lot.id, lines: given.map((g) => ({ lineId: g.lineId, unitPrice: g.unitPrice })), total: Math.round(total * 100) / 100 });
    } else {
      if (q.price === undefined) throw new HttpError(400, `Enter the price for lot ${lot.position}, or leave the lot out.`);
      out.push({ lotId: lot.id, price: q.price, total: q.price });
    }
  }
  if (!out.length) throw new HttpError(400, 'Quote for at least one lot.');
  return { lots: out, taxPct: o.taxPct ?? null, deliveryDays: o.deliveryDays ?? null, validityDays: o.validityDays ?? null, paymentTerms: o.paymentTerms ?? '', remarks: o.remarks ?? '', attachments: o.attachments };
}

const hashOf = (content: unknown) => crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');

/** Latest version of each envelope this bidder sent (withdrawn included, so the receipt shows it). */
async function latest(bidderId: string) {
  const rows = await db.select().from(S).where(eq(S.bidderId, bidderId)).orderBy(desc(S.version));
  const out: Partial<Record<Envelope, typeof rows[number]>> = {};
  for (const r of rows) if (!out[r.envelope as Envelope]) out[r.envelope as Envelope] = r;
  return out;
}

/** Upload a file for an offer (PDF/PNG/JPG, scanned). It stays sealed with the envelope it is attached to. */
export async function uploadBidFile(v: Vendor, eventId: string, file: { buffer: Buffer; originalname: string }) {
  const { b, e } = await myBidder(v, eventId);
  assertCanBid(e, b);
  const stored = await storeUpload(v.tenantId, v.id, file);
  const [doc] = await db.insert(schema.documents).values({ tenantId: v.tenantId, vendorId: v.id, docType: 'SOURCING_BID', ...stored, status: 'ATTACHMENT' }).returning();
  return { documentId: doc.id, fileName: doc.fileName };
}

function assertCanBid(e: SourcingEvent, b: typeof B.$inferSelect) {
  if (e.status !== 'PUBLISHED' || !hasSealedRound(e)) throw new HttpError(409, 'This event isn’t taking sealed bids.');
  if (pastDeadline(e)) throw new HttpError(409, 'The bid deadline has passed.');
  if (b.status !== 'ACCEPTED') throw new HttpError(400, 'Accept the invitation first.');
}

export async function submitOffer(t: Tenant, v: Vendor, eventId: string, env: Envelope, raw: unknown, by: { name: string; ip?: string }) {
  const { b, e } = await myBidder(v, eventId);
  assertCanBid(e, b);
  if (!envelopesOf(e).includes(env)) throw new HttpError(400, 'This event doesn’t use that envelope.');
  const prev = (await latest(b.id))[env];
  if (prev && !prev.withdrawnAt && !e.features.includes('bidRevision')) throw new HttpError(409, 'Your offer is already in and can’t be changed for this event.');
  const content = await checkOffer(e, env, raw);
  const docs = content.attachments.length ? await db.select({ id: schema.documents.id, fileName: schema.documents.fileName }).from(schema.documents)
    .where(and(inArray(schema.documents.id, content.attachments), eq(schema.documents.vendorId, v.id), eq(schema.documents.docType, 'SOURCING_BID'))) : [];
  if (docs.length !== content.attachments.length) throw new HttpError(400, 'A file couldn’t be found. Upload it again.');
  const contentHash = hashOf({ envelope: env, content });
  const [row] = await db.insert(S).values({ tenantId: t.id, eventId: e.id, bidderId: b.id, envelope: env, version: (prev?.version ?? 0) + 1, content, attachments: docs.map((d) => ({ documentId: d.id, fileName: d.fileName })), contentHash, submittedByName: by.name }).returning();
  await audit({ tenantId: t.id, vendorId: v.id, actor: by.name, action: 'SOURCING_BID_SUBMITTED', detail: { eventId: e.id, number: e.number, envelope: env, version: row.version, receipt: contentHash.slice(0, 16) }, ip: by.ip });
  await mailSupplier(await langForVendor(v, t), { tenantId: t.id, to: v.contactEmail, link: portalLink(v) }, 'sourcingBidReceipt', { first: v.contactFirstName, buyer: t.name, number: e.number, title: e.title, version: row.version, receipt: contentHash.slice(0, 16).toUpperCase(), at: row.submittedAt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC' });
  return row;
}

export async function withdrawOffer(t: Tenant, v: Vendor, eventId: string, env: Envelope, by: { name: string; ip?: string }) {
  const { b, e } = await myBidder(v, eventId);
  assertCanBid(e, b);
  if (!e.features.includes('bidRevision')) throw new HttpError(409, 'Offers can’t be withdrawn for this event.');
  const prev = (await latest(b.id))[env];
  if (!prev || prev.withdrawnAt) throw new HttpError(404, 'There is no offer to withdraw.');
  await db.update(S).set({ withdrawnAt: new Date() }).where(eq(S.id, prev.id));
  await audit({ tenantId: t.id, vendorId: v.id, actor: by.name, action: 'SOURCING_BID_WITHDRAWN', detail: { eventId: e.id, number: e.number, envelope: env, version: prev.version }, ip: by.ip });
}

/** The bidder's own offers (they may always read what they sent) and the receipts. */
export async function myOffers(v: Vendor, eventId: string) {
  const { b, e } = await myBidder(v, eventId);
  const l = await latest(b.id);
  const { lots, lines } = await itemsFor(e.id);
  return {
    envelopes: envelopesOf(e), canBid: e.status === 'PUBLISHED' && hasSealedRound(e) && !pastDeadline(e) && b.status === 'ACCEPTED', canRevise: e.features.includes('bidRevision'),
    deadline: e.bidDeadline, technicalResult: b.status === 'QUALIFIED' || b.status === 'DISQUALIFIED' ? b.status : null,
    items: lots.map((lot) => ({ id: lot.id, position: lot.position, title: lot.title, bidMode: lot.bidMode, lines: lines.filter((x) => x.lotId === lot.id).map((x) => ({ id: x.id, position: x.position, description: x.description, quantity: x.quantity, unit: x.unit })) })),
    offers: Object.fromEntries(Object.entries(l).map(([env, s]) => [env, { version: s!.version, submittedAt: s!.submittedAt, withdrawnAt: s!.withdrawnAt, receipt: s!.contentHash.slice(0, 16).toUpperCase(), content: s!.content, attachments: s!.attachments }])),
  };
}

/* ---------------- the buyer: before and after opening ---------------- */

/** Who has sent what — without the content (sealed until opened). */
async function sealedStatus(e: SourcingEvent) {
  const rows = await db.select({ s: S, alias: B.alias, vendor: schema.vendors.name, bidderStatus: B.status }).from(S).innerJoin(B, eq(B.id, S.bidderId)).innerJoin(schema.vendors, eq(schema.vendors.id, B.vendorId))
    .where(eq(S.eventId, e.id)).orderBy(desc(S.version));
  const seen = new Set<string>();
  return rows.filter((r) => { const k = `${r.s.bidderId}:${r.s.envelope}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((r) => ({ bidderId: r.s.bidderId, alias: r.alias, vendor: r.vendor, envelope: r.s.envelope as Envelope, version: r.s.version, submittedAt: r.s.submittedAt, withdrawn: !!r.s.withdrawnAt, receipt: r.s.contentHash.slice(0, 16).toUpperCase(), opened: !!r.s.openedAt }));
}

/** Everything the event page needs for sealed bids. */
export async function sealedView(t: Tenant, e: SourcingEvent, userId: string, perms: Set<string>) {
  if (!hasSealedRound(e) || ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(e.status)) return null;
  const quorum = Number(e.rules.openingQuorum ?? 2);
  const next = nextEnvelope(e);
  const confirmations = next ? await db.select().from(O).where(and(eq(O.eventId, e.id), eq(O.envelope, next))).orderBy(asc(O.createdAt)) : [];
  const received = await sealedStatus(e);
  const opened = await openedOffers(e);
  const scoring = e.opened.technical ? await scoringView(e, userId) : null;
  return {
    envelopes: envelopesOf(e), deadline: e.bidDeadline, deadlinePassed: pastDeadline(e), opened: e.opened, technicalDoneAt: e.technicalDoneAt,
    received: received.map(({ vendor, ...r }) => ({ ...r, vendor })),
    opening: next && pastDeadline(e) ? { envelope: next, quorum, confirmed: confirmations.map((c) => ({ name: c.userName, at: c.createdAt })), canConfirm: perms.has('sourcing.open') && !confirmations.some((c) => c.userId === userId) } : null,
    scoring, offers: opened,
    committee: (await usersWithPermission(t.id, 'sourcing.open')).map((u) => u.name),
  };
}

/** A committee member confirms opening the next envelope; it opens when the quorum is reached. */
export async function confirmOpening(t: Tenant, eventId: string, user: { id: string; name: string; ip?: string }) {
  const e = await getEvent(t.id, eventId);
  if (!hasSealedRound(e) || !['PUBLISHED', 'OPENING', 'EVALUATION'].includes(e.status)) throw new HttpError(409, 'There is nothing to open for this event.');
  if (!pastDeadline(e)) throw new HttpError(409, 'Sealed bids can only be opened after the deadline.');
  const env = nextEnvelope(e);
  if (!env) throw new HttpError(409, e.opened.technical && !e.technicalDoneAt ? 'Finish the technical evaluation before opening the commercial envelopes.' : 'Everything has been opened.');
  await db.insert(O).values({ tenantId: t.id, eventId: e.id, envelope: env, userId: user.id, userName: user.name }).onConflictDoNothing();
  const n = (await db.select({ n: sql<number>`count(*)::int` }).from(O).where(and(eq(O.eventId, e.id), eq(O.envelope, env))))[0].n;
  const quorum = Number(e.rules.openingQuorum ?? 2);
  await audit({ tenantId: t.id, actor: user.name, action: 'SOURCING_OPENING_CONFIRMED', detail: { eventId: e.id, number: e.number, envelope: env, confirmations: n, quorum }, ip: user.ip });
  if (n < quorum) {
    if (e.status === 'PUBLISHED') await db.update(E).set({ status: 'OPENING', updatedAt: new Date() }).where(eq(E.id, e.id));
    return { opened: false, confirmations: n, quorum };
  }
  await openEnvelope(t, e, env);
  return { opened: true, envelope: env, confirmations: n, quorum };
}

async function openEnvelope(t: Tenant, e: SourcingEvent, env: Envelope) {
  const now = new Date();
  // Commercial envelopes of bidders who didn't qualify stay sealed for good.
  const allowed = env === 'commercial' ? (await db.select({ id: B.id }).from(B).where(and(eq(B.eventId, e.id), eq(B.status, 'QUALIFIED')))).map((r) => r.id) : null;
  const rows = (await db.select().from(S).where(and(eq(S.eventId, e.id), eq(S.envelope, env))).orderBy(desc(S.version)));
  const latestIds: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) if (!seen.has(r.bidderId)) { seen.add(r.bidderId); if (!r.withdrawnAt && (!allowed || allowed.includes(r.bidderId))) latestIds.push(r.id); }
  if (latestIds.length) await db.update(S).set({ openedAt: now }).where(inArray(S.id, latestIds));
  const opened = { ...e.opened, [env]: now.toISOString() };
  await db.update(E).set({ opened, status: 'EVALUATION', updatedAt: now }).where(eq(E.id, e.id));
  // Reverse auction sealed round (single envelope): everyone with an offer goes on to the auction.
  if (env === 'single' && e.format !== 'rfq') {
    const ids = (await db.select({ b: S.bidderId }).from(S).where(inArray(S.id, latestIds.length ? latestIds : ['-']))).map((r) => r.b);
    if (ids.length) await db.update(B).set({ status: 'QUALIFIED' }).where(inArray(B.id, ids));
  }
  await audit({ tenantId: t.id, actor: 'system', action: 'SOURCING_ENVELOPE_OPENED', detail: { eventId: e.id, number: e.number, envelope: env, offers: latestIds.length } });
  await tellOwner(e, `Opened: ${e.number} ${env === 'single' ? 'offers' : `${env} envelopes`}`, `The opening committee opened the ${env === 'single' ? 'offers' : `${env} envelopes`} for ${e.number} “${e.title}” (${latestIds.length}).`);
}

/** Opened offers with their content (prices only for priced envelopes), ranked per lot. */
export async function openedOffers(e: SourcingEvent) {
  const rows = await db.select({ s: S, alias: B.alias, vendor: schema.vendors.name, vendorId: schema.vendors.id }).from(S).innerJoin(B, eq(B.id, S.bidderId)).innerJoin(schema.vendors, eq(schema.vendors.id, B.vendorId))
    .where(and(eq(S.eventId, e.id), sql`${S.openedAt} is not null`));
  const offers = rows.map((r) => ({ bidderId: r.s.bidderId, alias: r.alias, vendor: r.vendor, vendorId: r.vendorId, envelope: r.s.envelope as Envelope, version: r.s.version, submittedAt: r.s.submittedAt, content: r.s.content as any, attachments: r.s.attachments }));
  const { lots } = await itemsFor(e.id);
  const priceEnv = offers.filter((o) => priced(o.envelope));
  const comparison = lots.map((lot) => {
    const quotes = priceEnv.flatMap((o) => { const q = (o.content.lots ?? []).find((x: any) => x.lotId === lot.id); return q ? [{ bidderId: o.bidderId, alias: o.alias, vendor: o.vendor, total: Number(q.total), lines: q.lines ?? null, taxPct: o.content.taxPct, deliveryDays: o.content.deliveryDays, validityDays: o.content.validityDays, paymentTerms: o.content.paymentTerms }] : []; })
      .sort((a, b) => (e.format === 'forward' ? b.total - a.total : a.total - b.total));
    return { lotId: lot.id, position: lot.position, title: lot.title, bidMode: lot.bidMode, startPrice: lot.startPrice, target: lot.reservePrice, quotes: quotes.map((q, i) => ({ ...q, rank: `${e.format === 'forward' ? 'H' : 'L'}${i + 1}` })) };
  });
  return { technical: offers.filter((o) => o.envelope === 'technical'), priced: priceEnv, comparison };
}

/* ---------------- technical evaluation ---------------- */

async function scoringView(e: SourcingEvent, userId: string) {
  const criteria = e.scoring?.criteria ?? [];
  const bidders = await db.select({ id: B.id, alias: B.alias, status: B.status, vendor: schema.vendors.name, technicalScore: B.technicalScore, note: B.qualificationNote }).from(B).innerJoin(schema.vendors, eq(schema.vendors.id, B.vendorId))
    .where(and(eq(B.eventId, e.id), inArray(B.status, ['ACCEPTED', 'QUALIFIED', 'DISQUALIFIED']))).orderBy(asc(B.invitedAt), asc(B.alias));
  const scores = await db.select().from(SC).where(eq(SC.eventId, e.id));
  const sent = new Set((await db.select({ b: S.bidderId }).from(S).where(and(eq(S.eventId, e.id), eq(S.envelope, 'technical'), sql`${S.openedAt} is not null`))).map((r) => r.b));
  return {
    criteria, passMark: e.scoring?.passMark ?? null, done: !!e.technicalDoneAt,
    bidders: bidders.map((b) => {
      const mine = scores.filter((s) => s.bidderId === b.id);
      return { id: b.id, alias: b.alias, vendor: b.vendor, status: b.status, submitted: sent.has(b.id), score: b.technicalScore === null ? averageScore(criteria, mine) : Number(b.technicalScore), note: b.note,
        evaluations: mine.map((s) => ({ evaluator: s.evaluatorName, scores: s.scores, comment: s.comment, total: weighted(criteria, s.scores) })), mine: mine.find((s) => s.evaluatorId === userId) ?? null };
    }),
  };
}
const weighted = (criteria: { id: string; weight: number }[], s: Record<string, number>) => Math.round(criteria.reduce((n, c) => n + (c.weight * (s[c.id] ?? 0)) / 10, 0) * 10) / 10;
function averageScore(criteria: { id: string; weight: number }[], rows: { scores: Record<string, number> }[]) {
  if (!rows.length || !criteria.length) return null;
  return Math.round((rows.reduce((n, r) => n + weighted(criteria, r.scores), 0) / rows.length) * 10) / 10;
}

export async function saveScores(t: Tenant, eventId: string, bidderId: string, raw: unknown, user: { id: string; name: string; ip?: string }) {
  const e = await getEvent(t.id, eventId);
  if (!e.opened.technical || e.technicalDoneAt) throw new HttpError(409, 'Technical scores can be entered after the technical envelopes are opened, until the evaluation is finished.');
  const criteria = e.scoring?.criteria ?? [];
  if (!criteria.length) throw new HttpError(400, 'This event has no scoring criteria.');
  const input = z.object({ scores: z.record(z.number().min(0, 'Scores are 0–10').max(10, 'Scores are 0–10')), comment: z.string().trim().max(2000).optional() }).parse(raw);
  for (const c of criteria) if (input.scores[c.id] === undefined) throw new HttpError(400, `Score “${c.label}”.`);
  const b = await db.query.sourcingBidders.findFirst({ where: and(eq(B.eventId, e.id), eq(B.id, bidderId)) });
  if (!b) throw new HttpError(404, 'Bidder not found');
  const scores = Object.fromEntries(criteria.map((c) => [c.id, input.scores[c.id]]));
  await db.insert(SC).values({ tenantId: t.id, eventId: e.id, bidderId: b.id, evaluatorId: user.id, evaluatorName: user.name, scores, comment: input.comment || null })
    .onConflictDoUpdate({ target: [SC.eventId, SC.bidderId, SC.evaluatorId], set: { scores, comment: input.comment || null, updatedAt: new Date() } });
  await audit({ tenantId: t.id, actor: user.name, action: 'SOURCING_TECHNICAL_SCORED', detail: { eventId: e.id, number: e.number, bidder: b.alias, total: weighted(criteria, scores) }, ip: user.ip });
}

/**
 * Finish the technical evaluation. With criteria: qualified = average score ≥ pass mark, unless the buyer decides
 * otherwise for a bidder (a note is required). Without criteria: the buyer decides each bidder (pass/fail with a note
 * for a fail). Bidders without a technical envelope don't qualify. Bidders are told the result.
 */
export async function finishTechnical(t: Tenant, eventId: string, raw: unknown, by: { id: string; name: string; ip?: string }) {
  const e = await getEvent(t.id, eventId);
  if (!e.opened.technical) throw new HttpError(409, 'Open the technical envelopes first.');
  if (e.technicalDoneAt) throw new HttpError(409, 'The technical evaluation is already finished.');
  const decisions = z.array(z.object({ bidderId: z.string(), qualified: z.boolean(), note: z.string().trim().max(1000).optional() })).default([]).parse((raw as any)?.decisions);
  const view = (await scoringView(e, by.id))!;
  const criteria = view.criteria;
  const results: { id: string; qualified: boolean; score: number | null; note: string | null }[] = [];
  for (const b of view.bidders) {
    const d = decisions.find((x) => x.bidderId === b.id);
    if (!b.submitted) { results.push({ id: b.id, qualified: false, score: null, note: 'No technical offer' }); continue; }
    const byMark = criteria.length && b.score !== null && view.passMark !== null ? b.score >= view.passMark : null;
    if (byMark === null && !d) throw new HttpError(400, `Decide whether ${b.alias} qualifies${criteria.length ? ' (no scores entered)' : ''}.`);
    const qualified = d ? d.qualified : byMark!;
    if (((byMark !== null && qualified !== byMark) || (byMark === null && !qualified)) && !d?.note) throw new HttpError(400, `Give a reason for ${b.alias}.`);
    results.push({ id: b.id, qualified, score: b.score, note: d?.note || null });
  }
  for (const r of results) await db.update(B).set({ status: r.qualified ? 'QUALIFIED' : 'DISQUALIFIED', technicalScore: r.score === null ? null : String(r.score), qualificationNote: r.note }).where(eq(B.id, r.id));
  await db.update(E).set({ technicalDoneAt: new Date(), updatedAt: new Date() }).where(eq(E.id, e.id));
  await audit({ tenantId: t.id, actor: by.name, action: 'SOURCING_TECHNICAL_FINISHED', detail: { eventId: e.id, number: e.number, qualified: results.filter((r) => r.qualified).length, notQualified: results.filter((r) => !r.qualified).length }, ip: by.ip });
  const people = await db.select({ b: B, v: schema.vendors }).from(B).innerJoin(schema.vendors, eq(schema.vendors.id, B.vendorId)).where(inArray(B.id, results.length ? results.map((r) => r.id) : ['-']));
  for (const { b, v } of people) await mailSupplier(await langForVendor(v, t), { tenantId: t.id, to: v.contactEmail, link: portalLink(v) }, b.status === 'QUALIFIED' ? 'sourcingQualified' : 'sourcingNotQualified', { first: v.contactFirstName, buyer: t.name, number: e.number, title: e.title });
  return results;
}

/* ---------------- sealed round → reverse auction ---------------- */

/** Set each lot's start price from the best sealed price among qualified bidders (reverse auctions). */
export async function startFromSealed(t: Tenant, eventId: string, by: { name: string; ip?: string }) {
  const e = await getEvent(t.id, eventId);
  if (e.format === 'rfq') throw new HttpError(400, 'Only auctions have a start price.');
  const priceEnv: Envelope = envelopesOf(e).includes('commercial') ? 'commercial' : 'single';
  if (!e.opened[priceEnv]) throw new HttpError(409, 'Open the sealed prices first.');
  const view = await openedOffers(e);
  const qualified = new Set((await db.select({ id: B.id }).from(B).where(and(eq(B.eventId, e.id), eq(B.status, 'QUALIFIED')))).map((r) => r.id));
  const set: { lot: number; price: number }[] = [];
  for (const lot of view.comparison) {
    const best = lot.quotes.find((q) => qualified.has(q.bidderId));
    if (!best) continue;
    await db.update(L).set({ startPrice: String(best.total) }).where(eq(L.id, lot.lotId));
    set.push({ lot: lot.position, price: best.total });
  }
  if (!set.length) throw new HttpError(400, 'No qualified bidder quoted a price.');
  await audit({ tenantId: t.id, actor: by.name, action: 'SOURCING_START_PRICES_SET', detail: { eventId: e.id, number: e.number, lots: set }, ip: by.ip });
  return set;
}

/** Bid files stay sealed: staff can download one only after its envelope is opened. */
export async function assertBidFileReadable(doc: { id: string; docType: string }, staff: boolean) {
  if (doc.docType !== 'SOURCING_BID' || !staff) return;
  const opened = await db.select({ id: S.id }).from(S).where(and(sql`${S.openedAt} is not null`, sql`${S.attachments} @> ${JSON.stringify([{ documentId: doc.id }])}::jsonb`)).limit(1);
  if (!opened.length) throw new HttpError(403, 'This file is part of a sealed bid and can only be opened after the committee opens the envelope.');
}
