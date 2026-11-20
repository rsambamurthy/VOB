/**
 * Sourcing step 2: bidders and clarifications.
 *
 * - Approved suppliers are suggested by category, risk and scorecard; outside bidders are created as VendorGate
 *   suppliers marked `bidderOnly` (services/vendors.createVendor) and complete a short bidder registration in the
 *   portal (registration number checked like "Become a supplier", services/applications).
 * - Bidders can be picked while drafting; the buyer sends the invitations once the event is approved, and can add
 *   more until bidding closes.
 * - Bidders accept the event terms (an Agreement used for sourcing) and declare any conflict of interest, or decline.
 * - Clarifications: questions from bidders and the buyer's answers, shared with every bidder without saying who asked.
 */
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../lib/db.js';
import type { Tenant, Vendor } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { formatDeadline } from '../../lib/calendar.js';
import { validators } from '../../lib/validators.js';
import { packFor } from '../../countries/registry.js';
import { mailSupplier, snippet, langForVendor } from '../../i18n/emails.js';
import { createSchema, createVendor, portalLink, nameTaken } from '../vendors.js';
import { registrationIdFor, prefillOf } from '../applications.js';
import { getPublished } from '../config.js';
import { withIdentity, duplicatesOf, duplicateText } from '../duplicates.js';
import { actionCounts } from '../correctiveActions.js';
import { scorecards } from '../scorecards.js';
import { featureOn } from './config.js';
import { getEvent, tellOwner, type SourcingEvent } from './events.js';

const { sourcingBidders: B, sourcingQuestions: Q, sourcingEvents: E, vendors: V } = schema;
type By = { id: string; name: string; ip?: string };

/** When bidding closes for invitations, questions and responses: the bid deadline, else the auction start. */
export const closesAt = (e: Pick<SourcingEvent, 'format' | 'bidDeadline' | 'liveStartsAt'>) => (e.format === 'rfq' ? e.bidDeadline : e.bidDeadline ?? e.liveStartsAt);
const isOpen = (e: SourcingEvent, now = new Date()) => { const c = closesAt(e); return !c || c > now; };
/** Still going for the bidder: before bidding closes, or (auctions) until the live auction ends. */
const running = (e: SourcingEvent, now = new Date()) => !['CANCELLED', 'REJECTED', 'CLOSED', 'AWARD_PENDING', 'AWARDED'].includes(e.status) && (isOpen(e, now) || (e.format !== 'rfq' && !!e.liveEndsAt && (e.liveEndsAt > now || !!e.pausedAt)));
const BIDDER_CHANGE = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED'];
function assertCanChangeBidders(e: SourcingEvent) {
  if (e.isTemplate) throw new HttpError(400, 'Templates don’t have bidders.');
  if (!BIDDER_CHANGE.includes(e.status)) throw new HttpError(409, 'Bidders can’t be changed at this stage.');
  if (!isOpen(e)) throw new HttpError(409, 'Bidding has closed for this event.');
}
/** A sub-feature as it was when the event was submitted (drafts follow the current settings). */
const eventHas = (t: Tenant, e: SourcingEvent, k: Parameters<typeof featureOn>[1]) => (e.status === 'DRAFT' ? featureOn(t, k) : e.features.includes(k));

/* ---------------- choosing bidders ---------------- */

/** Approved suppliers, best matches first: same category, lower risk, better scorecard. */
export async function suggestBidders(t: Tenant, eventId: string, q = '') {
  const e = await getEvent(t.id, eventId);
  const already = new Set((await db.select({ v: B.vendorId }).from(B).where(eq(B.eventId, e.id))).map((r) => r.v));
  const rows = (await db.select({ id: V.id, code: V.code, name: V.name, vendorType: V.vendorType, profile: V.profile, riskBand: V.riskBand, riskScore: V.riskScore, blockedAt: V.blockedAt })
    .from(V).where(and(eq(V.tenantId, t.id), eq(V.status, 'APPROVED'), eq(V.bidderOnly, false), isNull(V.erasedAt))))
    .filter((v) => !q || `${v.name} ${v.code}`.toLowerCase().includes(q.toLowerCase()));
  const counts = await actionCounts(t.id, rows.map((r) => r.id));
  const cards = new Map((await scorecards(t, 180)).rows.map((r) => [r.vendorId, r.score]));
  const category = e.categories[0] ?? null;
  const block = eventHas(t, e, 'blockOverdueActions');
  const RISK: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  return rows.map((v) => {
    const cat = String((v.profile as Record<string, Record<string, unknown>>).basic?.supplyCategory ?? '') || null;
    const overdue = counts.get(v.id)?.overdue ?? 0;
    const why = v.blockedAt ? 'On hold' : block && overdue ? 'Overdue corrective action' : null;
    return { id: v.id, code: v.code, name: v.name, vendorType: v.vendorType, category: cat, categoryMatch: !!category && cat === category, riskBand: v.riskBand, riskScore: v.riskScore, score: cards.get(v.id) ?? null, overdueActions: overdue, invited: already.has(v.id), blocked: why };
  }).sort((a, b) => Number(!!a.blocked) - Number(!!b.blocked) || Number(b.categoryMatch) - Number(a.categoryMatch) || (RISK[a.riskBand ?? ''] ?? 1) - (RISK[b.riskBand ?? ''] ?? 1) || (b.score ?? -1) - (a.score ?? -1) || a.name.localeCompare(b.name)).slice(0, 300);
}

async function nextAliases(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], eventId: string, n: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`bidders:${eventId}`}))`);
  const [{ last }] = await tx.select({ last: sql<number | null>`max(nullif(regexp_replace(${B.alias}, '\\D', '', 'g'), '')::int)` }).from(B).where(eq(B.eventId, eventId));
  return Array.from({ length: n }, (_, i) => `Bidder ${Number(last ?? 0) + i + 1}`);
}

export async function addBidders(t: Tenant, eventId: string, vendorIds: string[], by: By) {
  const e = await getEvent(t.id, eventId);
  assertCanChangeBidders(e);
  const ids = [...new Set(vendorIds)];
  if (!ids.length) throw new HttpError(400, 'Choose at least one supplier');
  const list = await db.select().from(V).where(and(eq(V.tenantId, t.id), inArray(V.id, ids)));
  const counts = await actionCounts(t.id, ids);
  const block = eventHas(t, e, 'blockOverdueActions');
  for (const v of list) {
    if (v.status !== 'APPROVED' || v.bidderOnly) throw new HttpError(400, `${v.name} isn’t an approved supplier. Invite them as an outside bidder instead.`);
    if (v.blockedAt) throw new HttpError(400, `${v.name} is on hold and can’t be invited.`);
    if (block && (counts.get(v.id)?.overdue ?? 0) > 0) throw new HttpError(400, `${v.name} has an overdue corrective action and can’t be invited.`);
  }
  if (list.length !== ids.length) throw new HttpError(404, 'Supplier not found');
  const existing = new Set((await db.select({ v: B.vendorId }).from(B).where(eq(B.eventId, e.id))).map((r) => r.v));
  const fresh = list.filter((v) => !existing.has(v.id));
  if (fresh.length) await db.transaction(async (tx) => {
    const aliases = await nextAliases(tx, e.id, fresh.length);
    await tx.insert(B).values(fresh.map((v, i) => ({ tenantId: t.id, eventId: e.id, vendorId: v.id, alias: aliases[i], invitedByName: by.name })));
  });
  if (fresh.length) await audit({ tenantId: t.id, actor: by.name, action: 'SOURCING_BIDDERS_ADDED', detail: { eventId: e.id, number: e.number, suppliers: fresh.map((v) => v.name) }, ip: by.ip });
  return fresh.length;
}

export const outsideBidderSchema = createSchema.omit({ notify: true });
/** A company that isn't a supplier yet: created as a supplier marked bidder-only (onboarding only if they win). */
export async function addOutsideBidder(t: Tenant, eventId: string, raw: unknown, by: By) {
  const e = await getEvent(t.id, eventId);
  assertCanChangeBidders(e);
  if (!eventHas(t, e, 'outsideBidders')) throw new HttpError(400, 'Inviting outside bidders is switched off in Administration → Sourcing.');
  const input = outsideBidderSchema.parse(raw);
  const same = await nameTaken(t.id, input.name) ?? await db.query.vendors.findFirst({ where: and(eq(V.tenantId, t.id), eq(V.contactEmail, input.contactEmail.toLowerCase())) });
  if (same) throw new HttpError(409, `${same.name} (${same.code}) is already in VendorGate. ${same.status === 'APPROVED' ? 'Pick them from the suggestions.' : 'Finish their onboarding, or pick them once approved.'}`);
  const vendor = await createVendor(t, { ...input, notify: false }, by, { ip: by.ip, source: `Outside bidder for ${e.number}` });
  await db.update(V).set({ bidderOnly: true }).where(eq(V.id, vendor.id));
  await db.transaction(async (tx) => {
    const [alias] = await nextAliases(tx, e.id, 1);
    await tx.insert(B).values({ tenantId: t.id, eventId: e.id, vendorId: vendor.id, alias, outside: true, invitedByName: by.name });
  });
  await audit({ tenantId: t.id, vendorId: vendor.id, actor: by.name, action: 'SOURCING_OUTSIDE_BIDDER_ADDED', detail: { eventId: e.id, number: e.number, company: vendor.name }, ip: by.ip });
  return vendor;
}

async function bidderOf(t: Tenant, eventId: string, bidderId: string) {
  const b = await db.query.sourcingBidders.findFirst({ where: and(eq(B.tenantId, t.id), eq(B.eventId, eventId), eq(B.id, bidderId)) });
  if (!b) throw new HttpError(404, 'Bidder not found');
  return b;
}

/** Not sent yet: taken off the list. Already invited: the invitation is withdrawn and the bidder told. */
export async function removeBidder(t: Tenant, eventId: string, bidderId: string, by: By) {
  const e = await getEvent(t.id, eventId);
  assertCanChangeBidders(e);
  const b = await bidderOf(t, e.id, bidderId);
  const v = (await db.query.vendors.findFirst({ where: eq(V.id, b.vendorId) }))!;
  if (!b.sentAt) await db.delete(B).where(eq(B.id, b.id));
  else {
    await db.update(B).set({ status: 'REMOVED' }).where(eq(B.id, b.id));
    await mailSupplier(await langForVendor(v, t), { tenantId: t.id, to: v.contactEmail }, 'sourcingInviteWithdrawn', { first: v.contactFirstName, buyer: t.name, vendor: v.name, number: e.number, title: e.title });
  }
  await audit({ tenantId: t.id, vendorId: v.id, actor: by.name, action: b.sentAt ? 'SOURCING_INVITATION_WITHDRAWN' : 'SOURCING_BIDDER_REMOVED', detail: { eventId: e.id, number: e.number, supplier: v.name }, ip: by.ip });
}

/** Email every bidder not invited yet. The event becomes Published; more bidders can be added until bidding closes. */
export async function sendInvitations(t: Tenant, eventId: string, by: By) {
  const e = await getEvent(t.id, eventId);
  if (!['APPROVED', 'PUBLISHED'].includes(e.status)) throw new HttpError(409, e.status === 'PENDING_APPROVAL' ? 'The event is waiting for approval. Invitations can go once it is approved.' : 'Invitations can be sent once the event is approved.');
  if (!isOpen(e)) throw new HttpError(409, 'Bidding has closed for this event.');
  const pending = await db.select({ b: B, v: V }).from(B).innerJoin(V, eq(V.id, B.vendorId)).where(and(eq(B.eventId, e.id), isNull(B.sentAt), eq(B.status, 'INVITED')));
  if (!pending.length) throw new HttpError(400, 'Everyone on the list has been invited. Add bidders first.');
  const when = closesAt(e);
  for (const { b, v } of pending) {
    const lang = await langForVendor(v, t);
    const kind = snippet(lang, e.format === 'rfq' ? 'sourcingKindRfq' : 'sourcingKindAuction');
    const closes = when ? snippet(lang, e.format === 'rfq' ? 'sourcingClosesRfq' : 'sourcingClosesAuction', { when: formatDeadline(e.format === 'rfq' ? when : e.liveStartsAt ?? when, t) }) : '';
    await mailSupplier(lang, { tenantId: t.id, to: v.contactEmail, link: portalLink(v) }, 'sourcingInvite', { first: v.contactFirstName, buyer: t.name, vendor: v.name, kind, number: e.number, title: e.title, closes });
    await db.update(B).set({ sentAt: new Date() }).where(eq(B.id, b.id));
  }
  if (e.status === 'APPROVED') await db.update(E).set({ status: 'PUBLISHED', publishedAt: new Date(), updatedAt: new Date() }).where(eq(E.id, e.id));
  await audit({ tenantId: t.id, actor: by.name, action: 'SOURCING_INVITATIONS_SENT', detail: { eventId: e.id, number: e.number, count: pending.length, suppliers: pending.map((p) => p.v.name) }, ip: by.ip });
  return pending.length;
}

/** The bidder list for the buyer: names (never shown to other bidders), status, declarations, duplicates for outside bidders. */
export async function biddersOf(t: Tenant, e: SourcingEvent) {
  const rows = await db.select({ b: B, v: V }).from(B).innerJoin(V, eq(V.id, B.vendorId)).where(eq(B.eventId, e.id)).orderBy(asc(B.invitedAt));
  return Promise.all(rows.map(async ({ b, v }) => ({
    id: b.id, alias: b.alias, status: b.status, outside: b.outside, sentAt: b.sentAt, respondedAt: b.respondedAt, declaration: b.declaration, declineReason: b.declineReason, invitedByName: b.invitedByName,
    vendor: { id: v.id, code: v.code, name: v.name, status: v.status, riskBand: v.riskBand, contactEmail: v.contactEmail, bidderOnly: v.bidderOnly, registered: !v.bidderOnly || !!v.bidderRegisteredAt },
    duplicates: v.bidderOnly && v.bidderRegisteredAt ? duplicateText(await duplicatesOf(v)) : null,
  })));
}

/* ---------------- the bidder's side (supplier portal) ---------------- */

/** Events this supplier was invited to (invitation sent, not withdrawn). */
export async function myEvents(v: Vendor) {
  const rows = await db.select({ b: B, e: E }).from(B).innerJoin(E, eq(E.id, B.eventId))
    .where(and(eq(B.vendorId, v.id), ne(B.status, 'REMOVED'), sql`${B.sentAt} is not null`)).orderBy(sql`${E.createdAt} desc`);
  return rows.map(({ b, e }) => ({ id: e.id, number: e.number, title: e.title, format: e.format, status: e.status, myStatus: b.status, closesAt: closesAt(e), liveStartsAt: e.liveStartsAt, liveEndsAt: e.liveEndsAt, open: running(e) }));
}

async function myBid(v: Vendor, eventId: string) {
  const row = await db.select({ b: B, e: E }).from(B).innerJoin(E, eq(E.id, B.eventId))
    .where(and(eq(B.vendorId, v.id), eq(B.eventId, eventId), ne(B.status, 'REMOVED'), sql`${B.sentAt} is not null`)).limit(1);
  if (!row.length) throw new HttpError(404, 'Event not found');
  return row[0];
}

/** What a bidder sees: the event without the buyer's estimate, target prices or other bidders. */
export async function eventForBidder(t: Tenant, v: Vendor, eventId: string, lang: 'en' | 'ar') {
  const { b, e } = await myBid(v, eventId);
  const lots = await db.select().from(schema.sourcingLots).where(eq(schema.sourcingLots.eventId, e.id)).orderBy(asc(schema.sourcingLots.position));
  const lines = await db.select().from(schema.sourcingLines).where(eq(schema.sourcingLines.eventId, e.id)).orderBy(asc(schema.sourcingLines.position));
  const terms = await termsOf(e, lang);
  const qs = await db.select().from(Q).where(eq(Q.eventId, e.id)).orderBy(asc(Q.createdAt));
  return {
    event: { id: e.id, number: e.number, title: e.title, description: e.description, format: e.format, status: e.status, currency: e.currency, bidDeadline: e.bidDeadline, liveStartsAt: e.liveStartsAt, liveEndsAt: e.liveEndsAt, closesAt: closesAt(e), open: isOpen(e) && !['CANCELLED', 'REJECTED'].includes(e.status), running: running(e), termsNote: e.termsNote,
      clarifications: e.features.includes('clarifications'), conflictDeclaration: e.features.includes('conflictDeclaration') },
    lots: lots.map((l) => ({ position: l.position, title: l.title, bidMode: l.bidMode, startPrice: e.format === 'rfq' ? null : l.startPrice,
      lines: lines.filter((x) => x.lotId === l.id).map((x) => ({ position: x.position, itemCode: x.itemCode, description: x.description, quantity: x.quantity, unit: x.unit, specification: x.specification })) })),
    terms,
    me: { alias: b.alias, status: b.status, respondedAt: b.respondedAt, declaration: b.declaration, declineReason: b.declineReason, bidderOnly: v.bidderOnly, registered: !v.bidderOnly || !!v.bidderRegisteredAt },
    result: await (await import('./awards.js')).bidderResult(e, b.id),
    questions: qs.filter((q) => q.publishedAt || q.bidderId === b.id).map((q) => ({ id: q.id, question: q.question, answer: q.publishedAt ? q.answer : null, mine: q.bidderId === b.id, publishedAt: q.publishedAt, createdAt: q.createdAt })),
  };
}

async function termsOf(e: SourcingEvent, lang: 'en' | 'ar') {
  if (!e.termsAgreementId) return null;
  const ag = await db.query.agreements.findFirst({ where: eq(schema.agreements.id, e.termsAgreementId) });
  const [cur] = await db.select().from(schema.agreementVersions).where(eq(schema.agreementVersions.agreementId, e.termsAgreementId)).orderBy(sql`${schema.agreementVersions.version} desc`).limit(1);
  if (!ag || !cur) return null;
  return { title: (lang === 'ar' && ag.titleAr) || ag.title, version: cur.version, versionId: cur.id, kind: cur.kind, body: cur.kind === 'TEXT' ? ((lang === 'ar' && cur.bodyAr) || cur.body) : null, fileName: cur.fileName };
}

export const responseSchema = z.object({
  accept: z.boolean(),
  /** The terms version the bidder read and accepts (when the event has terms). */
  termsVersion: z.number().int().optional(),
  noConflict: z.boolean().optional(),
  conflictNote: z.string().trim().max(2000).optional(),
  declineReason: z.string().trim().max(1000).optional(),
});

/** Accept (with terms and declaration) or decline the invitation; can be changed until bidding closes. */
export async function respond(t: Tenant, v: Vendor, eventId: string, raw: unknown, by: { name: string; ip?: string }) {
  const input = responseSchema.parse(raw);
  const { b, e } = await myBid(v, eventId);
  if (!isOpen(e) || ['CANCELLED', 'REJECTED'].includes(e.status)) throw new HttpError(409, 'This event is closed.');
  if (v.bidderOnly && !v.bidderRegisteredAt) throw new HttpError(400, 'Complete the bidder registration first.');
  if (input.accept) {
    const terms = await termsOf(e, 'en');
    if (terms && input.termsVersion !== terms.version) throw new HttpError(400, 'Read and accept the event terms first.');
    if (e.features.includes('conflictDeclaration') && !input.noConflict && !input.conflictNote) throw new HttpError(400, 'Confirm that you have no conflict of interest, or describe it.');
    await db.update(B).set({ status: 'ACCEPTED', respondedAt: new Date(), declineReason: null, declaration: { acceptedTermsVersion: terms?.version, noConflict: !!input.noConflict, conflictNote: input.conflictNote || undefined, at: new Date().toISOString(), by: by.name } }).where(eq(B.id, b.id));
  } else {
    if (!input.declineReason) throw new HttpError(400, 'Tell the buyer why you are declining.');
    await db.update(B).set({ status: 'DECLINED', respondedAt: new Date(), declineReason: input.declineReason }).where(eq(B.id, b.id));
  }
  await audit({ tenantId: t.id, vendorId: v.id, actor: by.name, action: input.accept ? 'SOURCING_INVITATION_ACCEPTED' : 'SOURCING_INVITATION_DECLINED', detail: { eventId: e.id, number: e.number, ...(input.conflictNote ? { conflict: input.conflictNote } : {}), ...(input.declineReason ? { reason: input.declineReason } : {}) }, ip: by.ip });
  await tellOwner(e, `${v.name} ${input.accept ? 'accepted' : 'declined'} ${e.number}`,
    `${v.name} ${input.accept ? 'accepted the invitation' : `declined the invitation: ${input.declineReason}`} for ${e.number} “${e.title}”.${input.accept && input.conflictNote ? `\n\nThey declared a possible conflict of interest:\n${input.conflictNote}` : ''}`);
}

/** Outside bidders: registration number (checked like "Become a supplier"), website and what they supply. */
export const registrationSchema = z.object({ registrationId: z.string().trim().max(40).optional(), website: z.string().trim().max(200).optional(), supplies: z.string().trim().min(2, 'Tell the buyer what you supply').max(500) });
export async function registerBidder(t: Tenant, v: Vendor, raw: unknown, by: { name: string; ip?: string }) {
  if (!v.bidderOnly) throw new HttpError(400, 'Only outside bidders register here.');
  const input = registrationSchema.parse(raw);
  const { config } = await getPublished(t.id);
  const reg = v.vendorType === 'IMPORT' ? null : registrationIdFor(t, config);
  const registrationId = input.registrationId ? input.registrationId.toUpperCase().replace(/\s+/g, '') : undefined;
  if (reg && !registrationId) throw new HttpError(400, `Enter your ${reg.label}.`, [{ path: ['registrationId'], message: `Enter your ${reg.label}.` }]);
  if (registrationId && reg?.validator && validators[reg.validator]) {
    const err = validators[reg.validator](registrationId, { country: packFor(t.country).name });
    if (err) throw new HttpError(400, err, [{ path: ['registrationId'], message: err }]);
  }
  const extra = prefillOf({ registrationId: registrationId ?? null, website: input.website || null, supplies: input.supplies }, reg?.fieldId, v.vendorType === 'IMPORT' ? '' : packFor(t.country).name);
  const profile = structuredClone(v.profile as Record<string, Record<string, unknown>>);
  for (const [s, vals] of Object.entries(extra)) for (const [k, x] of Object.entries(vals)) if (x !== '' && x !== null && x !== undefined) profile[s] = { ...(profile[s] ?? {}), [k]: x };
  await db.update(V).set({ ...withIdentity(profile), bidderRegisteredAt: new Date() }).where(eq(V.id, v.id));
  await audit({ tenantId: t.id, vendorId: v.id, actor: by.name, action: 'SOURCING_BIDDER_REGISTERED', detail: { registrationId: registrationId ? 'given' : 'not needed' }, ip: by.ip });
}

/* ---------------- clarifications ---------------- */

export async function askQuestion(t: Tenant, v: Vendor, eventId: string, text: string, by: { name: string; ip?: string }) {
  const { b, e } = await myBid(v, eventId);
  if (!e.features.includes('clarifications')) throw new HttpError(400, 'Questions aren’t taken for this event.');
  if (!isOpen(e) || ['CANCELLED', 'REJECTED'].includes(e.status)) throw new HttpError(409, 'This event is closed.');
  if (b.status === 'DECLINED') throw new HttpError(409, 'You declined this invitation.');
  const question = z.string().trim().min(5, 'Write your question').max(4000).parse(text);
  await db.insert(Q).values({ tenantId: t.id, eventId: e.id, bidderId: b.id, question, askedByName: by.name });
  await audit({ tenantId: t.id, vendorId: v.id, actor: by.name, action: 'SOURCING_QUESTION_ASKED', detail: { eventId: e.id, number: e.number }, ip: by.ip });
  await tellOwner(e, `Question on ${e.number} from ${v.name}`, `${v.name} asked a question about ${e.number} “${e.title}”:\n\n${question}\n\nYour answer goes to every bidder without saying who asked.`);
}

/** For the buyer: every question with who asked, and announcements. */
export async function questionsOf(e: SourcingEvent) {
  const rows = await db.select({ q: Q, alias: B.alias, vendor: V.name }).from(Q).leftJoin(B, eq(B.id, Q.bidderId)).leftJoin(V, eq(V.id, B.vendorId)).where(eq(Q.eventId, e.id)).orderBy(asc(Q.createdAt));
  return rows.map(({ q, alias, vendor }) => ({ id: q.id, question: q.question, answer: q.answer, askedBy: vendor ? `${vendor} (${alias})` : null, askedByName: q.askedByName, answeredByName: q.answeredByName, publishedAt: q.publishedAt, createdAt: q.createdAt }));
}

/** Answer a question (or post an announcement when questionId is null): shared with every bidder. */
export async function publishAnswer(t: Tenant, eventId: string, questionId: string | null, answer: string, by: By, opts: { email?: 'sourcingClarification' | 'sourcingLiveMessage' } = {}) {
  const e = await getEvent(t.id, eventId);
  if (!['PUBLISHED', 'APPROVED', 'OPENING', 'EVALUATION', 'LIVE'].includes(e.status)) throw new HttpError(409, 'Clarifications can be published while the event is open.');
  const text = z.string().trim().min(2, 'Write the answer').max(8000).parse(answer);
  if (questionId) {
    const q = await db.query.sourcingQuestions.findFirst({ where: and(eq(Q.tenantId, t.id), eq(Q.eventId, e.id), eq(Q.id, questionId)) });
    if (!q) throw new HttpError(404, 'Question not found');
    await db.update(Q).set({ answer: text, answeredByName: by.name, publishedAt: new Date() }).where(eq(Q.id, q.id));
  } else {
    await db.insert(Q).values({ tenantId: t.id, eventId: e.id, answer: text, answeredByName: by.name, publishedAt: new Date() });
  }
  const to = await db.select({ v: V }).from(B).innerJoin(V, eq(V.id, B.vendorId)).where(and(eq(B.eventId, e.id), inArray(B.status, ['INVITED', 'ACCEPTED', 'QUALIFIED']), sql`${B.sentAt} is not null`));
  for (const { v } of to) await mailSupplier(await langForVendor(v, t), { tenantId: t.id, to: v.contactEmail, link: portalLink(v) }, opts.email ?? 'sourcingClarification', { first: v.contactFirstName, buyer: t.name, number: e.number, title: e.title, message: text });
  (await import('../../lib/liveHub.js')).publishLive(`event:${e.id}`);
  await audit({ tenantId: t.id, actor: by.name, action: questionId ? 'SOURCING_QUESTION_ANSWERED' : 'SOURCING_ANNOUNCEMENT', detail: { eventId: e.id, number: e.number, bidders: to.length }, ip: by.ip });
  return to.length;
}


/** For the portal menu: how many open invitations this supplier has. */
export async function invitationCount(vendorId: string) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(B).innerJoin(E, eq(E.id, B.eventId))
    .where(and(eq(B.vendorId, vendorId), inArray(B.status, ['INVITED', 'ACCEPTED']), sql`${B.sentAt} is not null`, inArray(E.status, ['PUBLISHED'])));
  return r.n;
}
