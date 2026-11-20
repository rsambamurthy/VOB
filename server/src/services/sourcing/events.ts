/**
 * Sourcing events (step 1): create and edit drafts, lots and lines (screen or Excel), templates, checks before
 * submitting, and approval through the generic approval flow (services/approvalFlow.ts).
 *
 * Status: DRAFT → PENDING_APPROVAL → APPROVED (ready to invite bidders) · sent back → DRAFT · REJECTED · CANCELLED.
 * Rules and options are resolved and frozen when the event is submitted (config.resolveRules).
 */
import { and, asc, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../lib/db.js';
import type { Tenant } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../lib/env.js';
import { sendMail } from '../../lib/mailer.js';
import { readSheet, sheetTemplate, type RowError } from '../../lib/excel.js';
import { nextYearlyNumber } from '../../lib/numbering.js';
import { localeFor } from '../../countries/registry.js';
import { SOURCING_FORMATS, SOURCING_FORMAT_KEYS, type SourcingFormat } from '../../lib/features.js';
import { assertFormatOn, eventApprovalLevels, eventRuleContext, featureOn, resolveRules, RULE_KEYS, SUB_FEATURE_KEYS } from './config.js';
import { cancelFlow, flowView, registerFlowSubject, startFlow } from '../approvalFlow.js';

const { sourcingEvents: E, sourcingLots: L, sourcingLines: LN } = schema;
export type SourcingEvent = typeof E.$inferSelect;
type By = { id: string; name: string; ip?: string };

/** Number prefixes, one per format; numbers restart each year (RFQ-2026-0001). Templates: TPL-2026-0001. */
export const NUMBER_PREFIX: Record<SourcingFormat, string> = { rfq: 'RFQ', reverse: 'RA', forward: 'FA', japanese: 'JA', dutch: 'DA' };
export const EVENT_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;

const nextNumber = (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], tenantId: string, prefix: string) =>
  nextYearlyNumber(tx, { table: E, tenantCol: E.tenantId, numberCol: E.number }, tenantId, prefix);

/* ---------------- input ---------------- */

const when = z.string().datetime({ offset: true, message: 'Use a valid date and time' }).nullable().optional();
const money = z.number({ invalid_type_error: 'Enter an amount' }).min(0).max(1e13).nullable().optional();
export const eventInput = z.object({
  title: z.string().trim().min(3, 'Give the event a title').max(200),
  description: z.string().trim().max(10_000).nullable().optional(),
  format: z.enum(SOURCING_FORMAT_KEYS as [SourcingFormat, ...SourcingFormat[]]),
  estimatedValue: money,
  category: z.string().trim().max(120).nullable().optional(),
  termsAgreementId: z.string().nullable().optional(),
  termsNote: z.string().trim().max(10_000).nullable().optional(),
  bidDeadline: when, liveStartsAt: when, liveEndsAt: when,
  ruleChoices: z.record(z.union([z.string(), z.number(), z.null()])).optional(),
  scoring: z.object({
    criteria: z.array(z.object({ id: z.string().regex(/^[\w-]{1,40}$/), label: z.string().trim().min(2, 'Name each criterion').max(120), weight: z.number().positive('Weights must be more than 0').max(100) })).min(1, 'Add at least one criterion').max(20),
    passMark: z.number().min(0).max(100),
  }).refine((x) => Math.abs(x.criteria.reduce((n, c) => n + c.weight, 0) - 100) < 0.01, 'The criteria weights must add up to 100').nullable().optional(),
});
export type EventInput = z.infer<typeof eventInput>;

const lineInput = z.object({
  itemCode: z.string().trim().max(60).nullable().optional(),
  description: z.string().trim().min(1, 'Every line needs a description').max(500),
  quantity: z.number({ invalid_type_error: 'Quantity must be a number' }).positive('Quantity must be more than 0').max(1e12),
  unit: z.string().trim().min(1, 'Every line needs a unit').max(20),
  specification: z.string().trim().max(5000).nullable().optional(),
  targetPrice: money,
});
const lotInput = z.object({
  title: z.string().trim().min(1, 'Every lot needs a title').max(200),
  bidMode: z.enum(['lot', 'line']).default('lot'),
  startPrice: money, reservePrice: money,
  lines: z.array(lineInput).max(1000),
});
export const itemsInput = z.object({ lots: z.array(lotInput).max(200, 'At most 200 lots') });
export type LotInput = z.infer<typeof lotInput>;

const num = (v: number | null | undefined) => (v === null || v === undefined ? null : String(v));
const date = (v: string | null | undefined) => (v ? new Date(v) : v === null ? null : undefined);

async function checkTerms(tenantId: string, id: string | null | undefined) {
  if (!id) return;
  const ag = await db.query.agreements.findFirst({ where: and(eq(schema.agreements.tenantId, tenantId), eq(schema.agreements.id, id)) });
  if (!ag || ag.status !== 'ACTIVE' || ag.purpose !== 'sourcing') throw new HttpError(400, 'Choose active sourcing terms (Administration → Agreements, used for sourcing events)');
}

function fieldsOf(input: Partial<EventInput>) {
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description || null } : {}),
    ...(input.estimatedValue !== undefined ? { estimatedValue: num(input.estimatedValue) } : {}),
    ...(input.category !== undefined ? { categories: input.category ? [input.category] : [] } : {}),
    ...(input.termsAgreementId !== undefined ? { termsAgreementId: input.termsAgreementId || null } : {}),
    ...(input.termsNote !== undefined ? { termsNote: input.termsNote || null } : {}),
    ...(input.bidDeadline !== undefined ? { bidDeadline: date(input.bidDeadline) } : {}),
    ...(input.liveStartsAt !== undefined ? { liveStartsAt: date(input.liveStartsAt) } : {}),
    ...(input.liveEndsAt !== undefined ? { liveEndsAt: date(input.liveEndsAt) } : {}),
    ...(input.ruleChoices !== undefined ? { ruleChoices: input.ruleChoices } : {}),
    ...(input.scoring !== undefined ? { scoring: input.scoring } : {}),
  };
}

/** Buyer's rule choices: only known rules, checked against locks and ranges. */
function checkChoices(t: Tenant, choices: Record<string, unknown> | undefined, estimatedValue?: number | null) {
  if (!choices) return;
  const clean = Object.fromEntries(Object.entries(choices).filter(([, v]) => v !== null && v !== ''));
  resolveRules(t, clean, { estimatedValue });
}

/* ---------------- create / edit ---------------- */

export async function getEvent(tenantId: string, id: string) {
  const e = await db.query.sourcingEvents.findFirst({ where: and(eq(E.tenantId, tenantId), eq(E.id, id)) });
  if (!e) throw new HttpError(404, 'Event not found');
  return e;
}
const editable = (e: SourcingEvent) => e.isTemplate || e.status === 'DRAFT';
function assertEditable(e: SourcingEvent) {
  if (!editable(e)) throw new HttpError(409, e.status === 'PENDING_APPROVAL' ? 'The event is waiting for approval. Withdraw it to make changes.' : 'Only draft events can be changed.');
}

export async function createEvent(t: Tenant, input: EventInput, by: By, opts: { template?: boolean } = {}) {
  assertFormatOn(t, input.format);
  checkChoices(t, input.ruleChoices, input.estimatedValue);
  await checkTerms(t.id, input.termsAgreementId);
  const e = await db.transaction(async (tx) => {
    const number = await nextNumber(tx, t.id, opts.template ? 'TPL' : NUMBER_PREFIX[input.format]);
    const [row] = await tx.insert(E).values({ tenantId: t.id, number, format: input.format, currency: localeFor(t.country).currency, ownerId: by.id, createdByName: by.name, isTemplate: !!opts.template, title: input.title, ...fieldsOf(input) }).returning();
    return row;
  });
  await audit({ tenantId: t.id, actor: by.name, action: opts.template ? 'SOURCING_TEMPLATE_CREATED' : 'SOURCING_EVENT_CREATED', detail: { eventId: e.id, number: e.number, title: e.title }, ip: by.ip });
  return e;
}

export async function updateEvent(t: Tenant, id: string, input: Partial<EventInput>, by: By) {
  const e = await getEvent(t.id, id);
  assertEditable(e);
  if (input.format && input.format !== e.format) throw new HttpError(400, 'The format can’t be changed. Create a new event (or copy this one) instead.');
  checkChoices(t, input.ruleChoices ?? e.ruleChoices, input.estimatedValue !== undefined ? input.estimatedValue : e.estimatedValue === null ? null : Number(e.estimatedValue));
  if (input.termsAgreementId !== undefined) await checkTerms(t.id, input.termsAgreementId);
  const [row] = await db.update(E).set({ ...fieldsOf(input), updatedAt: new Date() }).where(eq(E.id, e.id)).returning();
  await audit({ tenantId: t.id, actor: by.name, action: 'SOURCING_EVENT_UPDATED', detail: { eventId: e.id, number: e.number, fields: Object.keys(input) }, ip: by.ip });
  return row;
}

/** Replace all lots and lines of a draft (the screen and the Excel import both send the whole list). */
export async function saveItems(t: Tenant, id: string, lots: LotInput[], by: By, how: 'screen' | 'excel' = 'screen') {
  const e = await getEvent(t.id, id);
  assertEditable(e);
  await db.transaction(async (tx) => {
    await tx.delete(L).where(eq(L.eventId, e.id));
    for (const [i, lot] of lots.entries()) {
      const [l] = await tx.insert(L).values({ tenantId: t.id, eventId: e.id, position: i + 1, title: lot.title, bidMode: lot.bidMode, startPrice: num(lot.startPrice), reservePrice: num(lot.reservePrice) }).returning();
      if (lot.lines.length) await tx.insert(LN).values(lot.lines.map((x, j) => ({ tenantId: t.id, eventId: e.id, lotId: l.id, position: j + 1, itemCode: x.itemCode || null, description: x.description, quantity: String(x.quantity), unit: x.unit, specification: x.specification || null, targetPrice: num(x.targetPrice) })));
    }
    await tx.update(E).set({ updatedAt: new Date() }).where(eq(E.id, e.id));
  });
  await audit({ tenantId: t.id, actor: by.name, action: 'SOURCING_ITEMS_SAVED', detail: { eventId: e.id, number: e.number, lots: lots.length, lines: lots.reduce((n, l) => n + l.lines.length, 0), from: how }, ip: by.ip });
}

export async function itemsOf(eventId: string) {
  const lots = await db.select().from(L).where(eq(L.eventId, eventId)).orderBy(asc(L.position));
  const lines = lots.length ? await db.select().from(LN).where(eq(LN.eventId, eventId)).orderBy(asc(LN.position)) : [];
  return lots.map((l) => ({ ...l, lines: lines.filter((x) => x.lotId === l.id) }));
}
type Items = Awaited<ReturnType<typeof itemsOf>>;

/** Copy an event or template into a new draft (or into a template). */
export async function copyEvent(t: Tenant, sourceId: string, by: By, opts: { template?: boolean; title?: string } = {}) {
  const src = await getEvent(t.id, sourceId);
  const e = await createEvent(t, {
    title: opts.title ?? (opts.template ? src.title : src.isTemplate ? src.title : `${src.title} (copy)`), description: src.description, format: src.format as SourcingFormat,
    estimatedValue: src.estimatedValue === null ? null : Number(src.estimatedValue), category: src.categories[0] ?? null,
    termsAgreementId: src.termsAgreementId && (await db.query.agreements.findFirst({ where: and(eq(schema.agreements.id, src.termsAgreementId), eq(schema.agreements.status, 'ACTIVE')) })) ? src.termsAgreementId : null,
    termsNote: src.termsNote, ruleChoices: src.ruleChoices, scoring: src.scoring,
  }, by, { template: opts.template });
  const items = await itemsOf(src.id);
  if (items.length) await saveItems(t, e.id, items.map((l) => ({ title: l.title, bidMode: l.bidMode as 'lot' | 'line', startPrice: l.startPrice === null ? null : Number(l.startPrice), reservePrice: l.reservePrice === null ? null : Number(l.reservePrice),
    lines: l.lines.map((x) => ({ itemCode: x.itemCode, description: x.description, quantity: Number(x.quantity), unit: x.unit, specification: x.specification, targetPrice: x.targetPrice === null ? null : Number(x.targetPrice) })) })), by);
  await audit({ tenantId: t.id, actor: by.name, action: 'SOURCING_EVENT_COPIED', detail: { eventId: e.id, number: e.number, from: src.number }, ip: by.ip });
  return e;
}

export async function deleteEvent(t: Tenant, id: string, by: By) {
  const e = await getEvent(t.id, id);
  if (!e.isTemplate && (e.status !== 'DRAFT' || e.approvalCycle > 0)) throw new HttpError(409, 'Only drafts that were never submitted can be deleted. Cancel the event instead.');
  await db.delete(E).where(eq(E.id, e.id));
  await audit({ tenantId: t.id, actor: by.name, action: e.isTemplate ? 'SOURCING_TEMPLATE_DELETED' : 'SOURCING_EVENT_DELETED', detail: { eventId: e.id, number: e.number, title: e.title }, ip: by.ip });
}

/* ---------------- checks and submitting ---------------- */

export interface EventIssue { field: string; message: string }
/** What stops an event from being submitted for approval. */
export function eventIssues(t: Tenant, e: SourcingEvent, items: Items, now = new Date()): EventIssue[] {
  const out: EventIssue[] = [];
  const add = (field: string, message: string) => out.push({ field, message });
  const f = e.format as SourcingFormat;
  const fmt = SOURCING_FORMATS[f];
  try { assertFormatOn(t, f); } catch (err) { add('format', (err as Error).message); }
  if (!e.estimatedValue || Number(e.estimatedValue) <= 0) add('estimatedValue', 'Enter the estimated value (it decides who approves the event).');
  const soon = (d: Date | null) => !!d && d.getTime() - now.getTime() < 60 * 60_000;
  if (f === 'rfq') {
    if (!e.bidDeadline) add('bidDeadline', 'Set the bid deadline.');
    else if (soon(e.bidDeadline)) add('bidDeadline', 'The bid deadline must be at least an hour from now (approval and invitations take time).');
  } else {
    if (!e.liveStartsAt || !e.liveEndsAt) add('liveStartsAt', `Set when the ${fmt.label.toLowerCase()} starts and ends.`);
    else {
      if (soon(e.liveStartsAt)) add('liveStartsAt', 'The auction must start at least an hour from now.');
      if (e.liveEndsAt.getTime() - e.liveStartsAt.getTime() < 10 * 60_000) add('liveEndsAt', 'The auction must run for at least 10 minutes.');
      if (e.liveEndsAt.getTime() - e.liveStartsAt.getTime() > 7 * 24 * 3_600_000) add('liveEndsAt', 'The auction can run for at most 7 days.');
    }
    if (e.bidDeadline && e.liveStartsAt && e.bidDeadline >= e.liveStartsAt) add('bidDeadline', 'The sealed (qualification) round must close before the auction starts.');
    if (e.bidDeadline && soon(e.bidDeadline)) add('bidDeadline', 'The sealed round must close at least an hour from now.');
  }
  if (!items.length) add('items', 'Add at least one lot with its items (on screen or from Excel).');
  for (const l of items) {
    if (!l.lines.length) add('items', `Lot ${l.position} “${l.title}” has no items.`);
    if (l.reservePrice !== null && l.startPrice !== null && f !== 'forward' && Number(l.reservePrice) > Number(l.startPrice)) add('items', `Lot ${l.position}: the target price can’t be above the start (ceiling) price.`);
  }
  try {
    const r = resolveRules(t, cleanChoices(e.ruleChoices), { estimatedValue: e.estimatedValue === null ? null : Number(e.estimatedValue) });
    // Two envelopes with technical scoring need the scoring sheet.
    if (e.bidDeadline && r.envelope === 'two' && featureOn(t, 'technicalScoring') && !e.scoring?.criteria.length) add('scoring', 'Add the technical scoring criteria and pass mark (two envelopes).');
  } catch (err) { add('rules', (err as Error).message); }
  return out;
}
const cleanChoices = (c: Record<string, unknown>) => Object.fromEntries(Object.entries(c).filter(([k, v]) => v !== null && v !== '' && (RULE_KEYS as string[]).includes(k)));

export async function submitEvent(t: Tenant, id: string, by: By) {
  const e = await getEvent(t.id, id);
  if (e.isTemplate) throw new HttpError(400, 'Templates aren’t submitted. Create an event from the template.');
  if (e.status !== 'DRAFT') throw new HttpError(409, 'Only draft events can be submitted.');
  const issues = eventIssues(t, e, await itemsOf(e.id));
  if (issues.length) throw new HttpError(400, `Fix these first: ${issues.map((i) => i.message).join(' ')}`, { issues });
  const rules = resolveRules(t, cleanChoices(e.ruleChoices), { estimatedValue: Number(e.estimatedValue) });
  const features = SUB_FEATURE_KEYS.filter((k) => featureOn(t, k));
  // Claim the draft so two submissions can't both start a flow.
  const [claimed] = await db.update(E).set({ status: 'PENDING_APPROVAL', rules: rules as Record<string, string | number | null>, features, submittedAt: new Date(), approvalCycle: e.approvalCycle + 1, updatedAt: new Date() })
    .where(and(eq(E.id, e.id), eq(E.status, 'DRAFT'))).returning();
  if (!claimed) throw new HttpError(409, 'The event was just changed by someone else — refresh the page');
  await audit({ tenantId: t.id, actor: by.name, action: 'SOURCING_EVENT_SUBMITTED', detail: { eventId: e.id, number: e.number }, ip: by.ip });
  try {
    const { steps } = await startFlow(t, 'sourcing_event', e.id, eventApprovalLevels(t), eventRuleContext(claimed), by);
    if (!steps.length) {
      await markApproved(t.id, e.id, 'No approval needed for this value');
      return { status: 'APPROVED' as const, levels: [] as string[] };
    }
    return { status: 'PENDING_APPROVAL' as const, levels: steps.map((s) => s.label) };
  } catch (err) {
    await db.update(E).set({ status: 'DRAFT', approvalCycle: e.approvalCycle }).where(eq(E.id, e.id));
    throw err;
  }
}

async function markApproved(tenantId: string, id: string, note?: string) {
  const [e] = await db.update(E).set({ status: 'APPROVED', approvedAt: new Date(), updatedAt: new Date() }).where(and(eq(E.tenantId, tenantId), eq(E.id, id))).returning();
  await audit({ tenantId, actor: 'system', action: 'SOURCING_EVENT_APPROVED', detail: { eventId: e.id, number: e.number, ...(note ? { note } : {}) } });
  return e;
}

export async function withdrawEvent(t: Tenant, id: string, by: By) {
  const e = await getEvent(t.id, id);
  if (e.status !== 'PENDING_APPROVAL') throw new HttpError(409, 'Only an event waiting for approval can be withdrawn.');
  await cancelFlow(t.id, 'sourcing_event', e.id);
  await db.update(E).set({ status: 'DRAFT', updatedAt: new Date() }).where(eq(E.id, e.id));
  await audit({ tenantId: t.id, actor: by.name, action: 'SOURCING_EVENT_WITHDRAWN', detail: { eventId: e.id, number: e.number }, ip: by.ip });
}

export async function cancelEvent(t: Tenant, id: string, reason: string, by: By) {
  const e = await getEvent(t.id, id);
  if (e.isTemplate) throw new HttpError(400, 'Delete the template instead.');
  if (!['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED'].includes(e.status)) throw new HttpError(409, 'This event can no longer be cancelled.');
  if (!reason.trim()) throw new HttpError(400, 'Give a reason for cancelling');
  await cancelFlow(t.id, 'sourcing_event', e.id);
  await db.update(E).set({ status: 'CANCELLED', cancelledReason: reason.trim(), updatedAt: new Date() }).where(eq(E.id, e.id));
  // Tell everyone who was invited and hasn't declined.
  const { mailSupplier, langForVendor } = await import('../../i18n/emails.js');
  const told = await db.select({ v: schema.vendors }).from(schema.sourcingBidders).innerJoin(schema.vendors, eq(schema.vendors.id, schema.sourcingBidders.vendorId))
    .where(and(eq(schema.sourcingBidders.eventId, e.id), inArray(schema.sourcingBidders.status, ['INVITED', 'ACCEPTED']), sql`${schema.sourcingBidders.sentAt} is not null`));
  for (const { v } of told) await mailSupplier(await langForVendor(v, t), { tenantId: t.id, to: v.contactEmail }, 'sourcingCancelled', { first: v.contactFirstName, buyer: t.name, number: e.number, title: e.title });
  await audit({ tenantId: t.id, actor: by.name, action: 'SOURCING_EVENT_CANCELLED', detail: { eventId: e.id, number: e.number, reason: reason.trim() }, ip: by.ip });
}

/* ---------------- approval flow handler ---------------- */

const eventLink = (id: string) => `${env.appBaseUrl}/staff/sourcing/events/${id}`;
export async function tellOwner(e: SourcingEvent, subject: string, body: string) {
  if (!e.ownerId) return;
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, e.ownerId) });
  if (u?.status === 'ACTIVE') await sendMail({ tenantId: e.tenantId, to: u.email, subject, body: `Hello ${u.name},\n\n${body}`, link: eventLink(e.id) });
}

registerFlowSubject('sourcing_event', {
  async describe(tenantId, id) {
    const e = await db.query.sourcingEvents.findFirst({ where: and(eq(E.tenantId, tenantId), eq(E.id, id)) });
    return e ? { title: e.title, ref: e.number, link: eventLink(e.id), kind: 'Sourcing event' } : null;
  },
  async approved(tenantId, id) {
    const e = await markApproved(tenantId, id);
    await tellOwner(e, `Approved: ${e.number} ${e.title}`, `${e.number} “${e.title}” is approved. You can now invite bidders.`);
  },
  async returned(tenantId, id, decision, remarks) {
    const [e] = await db.update(E).set({ status: decision === 'SEND_BACK' ? 'DRAFT' : 'REJECTED', updatedAt: new Date() }).where(and(eq(E.tenantId, tenantId), eq(E.id, id))).returning();
    await tellOwner(e, `${decision === 'SEND_BACK' ? 'Sent back' : 'Rejected'}: ${e.number} ${e.title}`,
      decision === 'SEND_BACK' ? `${e.number} “${e.title}” was sent back for changes:\n\n${remarks}\n\nMake the changes and submit it again.` : `${e.number} “${e.title}” was rejected:\n\n${remarks}`);
  },
  async blockedFor(tenantId, id, userId) {
    const e = await db.query.sourcingEvents.findFirst({ where: and(eq(E.tenantId, tenantId), eq(E.id, id)) });
    return e?.ownerId === userId ? 'You can’t approve an event you own. Another approver has to.' : null;
  },
});

/* ---------------- reading ---------------- */

export async function eventDetail(t: Tenant, id: string, userId: string, perms: Set<string> = new Set()) {
  const e = await (await import('./live.js')).syncLive(await getEvent(t.id, id));
  const items = await itemsOf(e.id);
  const terms = e.termsAgreementId ? await db.query.agreements.findFirst({ where: eq(schema.agreements.id, e.termsAgreementId) }) : null;
  const owner = e.ownerId ? await db.query.users.findFirst({ where: eq(schema.users.id, e.ownerId) }) : null;
  const history = await db.select({ actor: schema.auditLogs.actor, action: schema.auditLogs.action, detail: schema.auditLogs.detail, createdAt: schema.auditLogs.createdAt }).from(schema.auditLogs)
    .where(and(eq(schema.auditLogs.tenantId, t.id), sql`(${schema.auditLogs.detail}->>'eventId' = ${e.id} or ${schema.auditLogs.detail}->>'subjectId' = ${e.id})`)).orderBy(desc(schema.auditLogs.createdAt)).limit(100);
  return {
    event: { ...e, category: e.categories[0] ?? null, owner: owner?.name ?? e.createdByName, editable: editable(e) },
    lots: items,
    terms: terms && { id: terms.id, title: terms.title, status: terms.status },
    issues: editable(e) && !e.isTemplate ? eventIssues(t, e, items) : [],
    approval: await flowView(t.id, 'sourcing_event', e.id, userId),
    history,
    ...(e.isTemplate ? {} : await (async () => {
      const { biddersOf, questionsOf, closesAt } = await import('./bidders.js');
      const { sealedView } = await import('./submissions.js');
      const { awardView } = await import('./awards.js');
      return { bidders: await biddersOf(t, e), questions: await questionsOf(e), closesAt: closesAt(e), outsideBidders: e.status === 'DRAFT' ? featureOn(t, 'outsideBidders') : e.features.includes('outsideBidders'), sealed: await sealedView(t, e, userId, perms), award: await awardView(t, e, userId) };
    })()),
  };
}

export type EventFilter = 'all' | 'drafts' | 'approval' | 'approved' | 'templates' | 'mine';
export async function listEvents(t: Tenant, filter: EventFilter, userId: string) {
  const where = [eq(E.tenantId, t.id), eq(E.isTemplate, filter === 'templates')];
  if (filter === 'drafts') where.push(eq(E.status, 'DRAFT'));
  if (filter === 'approval') where.push(eq(E.status, 'PENDING_APPROVAL'));
  if (filter === 'approved') where.push(inArray(E.status, ['APPROVED', 'PUBLISHED']));
  if (filter === 'mine') where.push(eq(E.ownerId, userId));
  const rows = await db.select().from(E).where(and(...where)).orderBy(desc(E.createdAt)).limit(300);
  const ids = rows.map((r) => r.id);
  const counts = ids.length ? await db.select({ eventId: L.eventId, lots: sql<number>`count(distinct ${L.id})::int`, lines: sql<number>`count(${LN.id})::int` }).from(L).leftJoin(LN, eq(LN.lotId, L.id)).where(inArray(L.eventId, ids)).groupBy(L.eventId) : [];
  const bidders = ids.length ? await db.select({ eventId: schema.sourcingBidders.eventId, n: sql<number>`count(*)::int` }).from(schema.sourcingBidders).where(inArray(schema.sourcingBidders.eventId, ids)).groupBy(schema.sourcingBidders.eventId) : [];
  const { waitingFor } = await import('../approvalFlow.js');
  const mineIds = new Set((await waitingFor(t.id, userId, 'sourcing_event')).map((s) => s.subjectId));
  return rows.map((e) => ({
    id: e.id, number: e.number, title: e.title, format: e.format, status: e.status, currency: e.currency, estimatedValue: e.estimatedValue, category: e.categories[0] ?? null,
    bidDeadline: e.bidDeadline, liveStartsAt: e.liveStartsAt, createdAt: e.createdAt, owner: e.createdByName,
    lots: counts.find((c) => c.eventId === e.id)?.lots ?? 0, lines: counts.find((c) => c.eventId === e.id)?.lines ?? 0,
    bidders: bidders.find((b) => b.eventId === e.id)?.n ?? 0, waitingForMe: mineIds.has(e.id),
  }));
}

/* ---------------- Excel: lots and lines ---------------- */

const ITEM_COLUMNS = (currency = '') => [
  { header: 'Lot', width: 8, required: true }, { header: 'Lot title', width: 28 }, { header: 'Item code', width: 14 }, { header: 'Description', width: 40, required: true },
  { header: 'Quantity', width: 12, required: true }, { header: 'Unit', width: 10, required: true }, { header: 'Specification', width: 40 }, { header: currency ? `Target price (${currency})` : 'Target price', width: 16 },
];
export function itemsTemplate(currency: string) {
  return sheetTemplate({
    sheet: 'Items', columns: ITEM_COLUMNS(currency),
    examples: [[1, 'Steel', 'ST-101', 'MS plate 10 mm', 20, 'MT', 'IS 2062 E250', 61000], [1, '', 'ST-102', 'MS angle 50x50x6', 8, 'MT', 'IS 2062 E250', ''], [2, 'Fasteners', 'FS-001', 'Hex bolt M12x50', 5000, 'Nos', 'Grade 8.8, zinc plated', 14]],
    help: [
      ['Items', 'One row per item. Rows with the same Lot number form one lot; the lot title is taken from the first row that has one.'],
      ['Required', 'Lot, Description, Quantity and Unit (the yellow columns).'],
      ['Target price', 'Optional: your expected unit price, never shown to bidders.'],
      ['Example rows', 'Rows 2–4 are examples — replace or delete them.'],
    ],
  });
}

export type { RowError };
/** Read lots and lines from the Excel template. Nothing is saved: the screen shows the result and saves it. */
export async function readItems(buffer: Buffer): Promise<{ lots: LotInput[]; errors: RowError[] }> {
  const rows = await readSheet(buffer, { sheet: 'Items', columns: ITEM_COLUMNS(), maxRows: 5000 });
  const lots = new Map<string, LotInput>();
  const errors: RowError[] = [];
  for (const { row: n, get } of rows) {
    const lot = get('Lot'), qty = Number(get('Quantity').replace(/,/g, '')), price = get('Target price').replace(/,/g, '');
    const line = lineInput.safeParse({ itemCode: get('Item code') || null, description: get('Description'), quantity: get('Quantity') === '' ? undefined : qty, unit: get('Unit'), specification: get('Specification') || null, targetPrice: price === '' ? null : Number(price) });
    if (!lot) { errors.push({ row: n, message: 'Lot is empty' }); continue; }
    if (!line.success) { errors.push({ row: n, message: line.error.issues.map((i) => (i.path[0] === 'quantity' && i.code === 'invalid_type' ? 'Quantity is empty or not a number' : i.path[0] === 'targetPrice' ? 'Target price must be a number' : i.message)).join('; ') }); continue; }
    const l = lots.get(lot) ?? { title: '', bidMode: 'lot' as const, startPrice: null, reservePrice: null, lines: [] };
    if (!l.title && get('Lot title')) l.title = get('Lot title');
    l.lines.push(line.data);
    lots.set(lot, l);
  }
  const list = [...lots.entries()].map(([k, l]) => ({ ...l, title: l.title || `Lot ${k}` }));
  if (!list.length && !errors.length) errors.push({ row: 0, message: 'No items found in the sheet.' });
  if (list.length > 200) errors.push({ row: 0, message: 'At most 200 lots' });
  return { lots: list, errors };
}

/** Sourcing terms a buyer can pick (Agreements used for sourcing events). */
export async function sourcingTerms(tenantId: string) {
  return db.select({ id: schema.agreements.id, title: schema.agreements.title }).from(schema.agreements)
    .where(and(eq(schema.agreements.tenantId, tenantId), eq(schema.agreements.status, 'ACTIVE'), eq(schema.agreements.purpose, 'sourcing'))).orderBy(asc(schema.agreements.sortOrder));
}
