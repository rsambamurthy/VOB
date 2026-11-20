/**
 * Managing signed contracts:
 *   amendments   — a contract of type 'amendment' under the one it changes; when it is signed its changes apply
 *   obligations  — what each side has to do, with owner, due date, recurrence and reminders
 *   alerts       — "ending soon" and "last day to give notice" emails to the owner (once each)
 *   prices       — agreed prices on a contract; purchase orders and supplier invoices are checked against them
 *   ERP          — a signed supplier contract goes to the ERP as a blanket agreement (order outbound pipeline)
 * onSigned() is the one hook every way of signing calls (mark as signed, e-signature).
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../lib/db.js';
import type { AmendmentChanges, Contract, ContractObligation, Tenant } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { sendMail } from '../../lib/mailer.js';
import { readSheet, sheetTemplate, type RowError, type SheetColumn } from '../../lib/excel.js';
import { messageView, queueStandaloneMessage } from '../orders/outbound.js';
import { contractRules, contractsOn, optionOn, ruleDefaults, typeInfo } from './config.js';
import { amountInWords } from './fields.js';
import { getParty } from './parties.js';

const { contracts: C, contractObligations: O, contractPrices: PR, users: U } = schema;
type By = { id: string; name: string; ip?: string };
export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const addMonths = (d: string, m: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); };
export const longDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const link = (id: string) => `${env.appBaseUrl}/staff/contracts/${id}`;
const cAudit = (t: Pick<Tenant, 'id'>, c: Pick<Contract, 'id' | 'number'>, actor: string, action: string, extra: Record<string, unknown> = {}, ip?: string) =>
  audit({ tenantId: t.id, actor, action, detail: { subjectId: c.id, number: c.number, ...extra }, ip });
async function getContract(tenantId: string, id: string) {
  const c = await db.query.contracts.findFirst({ where: and(eq(C.tenantId, tenantId), eq(C.id, id)) });
  if (!c) throw new HttpError(404, 'Contract not found');
  return c;
}
/** Email one of our users about a contract (active users only). Shared by reminders and contract watch. */
export async function mailUser(tenantId: string, userId: string | null, subject: string, body: string, contractId: string) {
  if (!userId) return false;
  const u = await db.query.users.findFirst({ where: eq(U.id, userId) });
  if (u?.status !== 'ACTIVE') return false;
  await sendMail({ tenantId, to: u.email, subject, body: `Hello ${u.name},\n\n${body}`, link: link(contractId) });
  return true;
}

/* ---------------- amendments ---------------- */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2027-03-31');
export const amendmentInput = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  endDate: day.nullable().optional(),
  value: z.number().min(0).max(1e13).nullable().optional(),
  noticeDays: z.number().int().min(0).max(730).nullable().optional(),
  autoRenew: z.boolean().optional(),
  renewalTermMonths: z.number().int().min(1).max(120).nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional(),
});
/** The changes in plain sentences (for the amendment's page and its document). */
export function amendmentLines(parent: Pick<Contract, 'endDate' | 'value' | 'currency' | 'noticeDays' | 'autoRenew' | 'renewalTermMonths'>, a: AmendmentChanges) {
  const out: string[] = [];
  if (a.endDate !== undefined) out.push(a.endDate ? `The end date is changed${parent.endDate ? ` from ${longDate(parent.endDate)}` : ''} to ${longDate(a.endDate)}.` : 'The contract has no fixed end date.');
  if (a.value !== undefined) out.push(a.value === null ? 'The contract value is removed.' : `The total consideration is changed to ${parent.currency} ${a.value.toLocaleString(parent.currency === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: 2 })} (${parent.currency} ${amountInWords(a.value, parent.currency)} only).`);
  if (a.autoRenew !== undefined) out.push(a.autoRenew ? `The contract renews automatically for further periods of ${a.renewalTermMonths ?? parent.renewalTermMonths ?? 12} months.` : 'The contract no longer renews automatically.');
  else if (a.renewalTermMonths !== undefined && a.renewalTermMonths !== null) out.push(`The renewal term is changed to ${a.renewalTermMonths} months.`);
  if (a.noticeDays !== undefined && a.noticeDays !== null) out.push(`The notice period is changed to ${a.noticeDays} days.`);
  if (a.description) out.push(a.description);
  return out;
}

export async function createAmendment(t: Tenant, parentId: string, raw: unknown, by: By) {
  const parent = await getContract(t.id, parentId);
  if (parent.type === 'amendment') throw new HttpError(409, 'Amend the contract itself, not an amendment.');
  if (parent.status !== 'ACTIVE' && parent.status !== 'EXPIRED') throw new HttpError(409, 'Only a signed contract can be amended. Change a draft directly.');
  const open = await db.select({ id: C.id }).from(C).where(and(eq(C.parentId, parent.id), eq(C.type, 'amendment'), ne(C.status, 'ACTIVE'), ne(C.status, 'TERMINATED'))).limit(1);
  if (open.length) throw new HttpError(409, 'An amendment to this contract is already being prepared. Finish or delete it first.');
  const input = amendmentInput.parse(raw);
  const changes: AmendmentChanges = {};
  if (input.endDate !== undefined && input.endDate !== parent.endDate) {
    if (input.endDate && parent.startDate && input.endDate < parent.startDate) throw new HttpError(400, 'The new end date is before the contract starts.');
    changes.endDate = input.endDate;
  }
  if (input.value !== undefined && (input.value === null ? null : input.value.toFixed(2)) !== parent.value) changes.value = input.value;
  if (input.autoRenew !== undefined && input.autoRenew !== parent.autoRenew) changes.autoRenew = input.autoRenew;
  if (input.renewalTermMonths !== undefined && input.renewalTermMonths !== parent.renewalTermMonths) changes.renewalTermMonths = input.renewalTermMonths;
  if (input.noticeDays !== undefined && input.noticeDays !== parent.noticeDays) {
    contractRules(t, { noticeDays: input.noticeDays ?? undefined });
    changes.noticeDays = input.noticeDays;
  }
  if (input.description) changes.description = input.description;
  if (!Object.keys(changes).length) throw new HttpError(400, 'Say what the amendment changes.');
  if ((changes.autoRenew ?? parent.autoRenew) && !(changes.endDate !== undefined ? changes.endDate : parent.endDate)) throw new HttpError(400, 'An automatically renewing contract needs an end date.');
  const n = (await db.select({ id: C.id }).from(C).where(and(eq(C.parentId, parent.id), eq(C.type, 'amendment')))).length + 1;
  const { createContract } = await import('./contracts.js');
  return createContract(t, {
    title: input.title ?? `Amendment ${n} to ${parent.number} — ${parent.title}`.slice(0, 200), direction: parent.direction, type: 'amendment', partyId: parent.partyId, currency: parent.currency,
    ownerId: parent.ownerId, parentId: parent.id, startDate: today(), description: amendmentLines(parent, changes).join('\n'), category: parent.category,
  }, by, { amends: changes });
}

/** A signed amendment changes its contract. */
async function applyAmendment(t: Tenant, a: Contract, actor: string) {
  if (!a.amends || a.amends.appliedAt || !a.parentId) return;
  const parent = await getContract(t.id, a.parentId);
  const ch = a.amends;
  const set: Partial<Contract> = {};
  if (ch.endDate !== undefined) set.endDate = ch.endDate;
  if (ch.value !== undefined) set.value = ch.value === null ? null : ch.value.toFixed(2);
  if (ch.noticeDays !== undefined) set.noticeDays = ch.noticeDays;
  if (ch.autoRenew !== undefined) { set.autoRenew = ch.autoRenew; set.renewalTermMonths = ch.autoRenew ? ch.renewalTermMonths ?? parent.renewalTermMonths ?? Number(ruleDefaults(t).renewalTermMonths ?? 12) : null; }
  else if (ch.renewalTermMonths !== undefined) set.renewalTermMonths = ch.renewalTermMonths;
  const end = set.endDate !== undefined ? set.endDate : parent.endDate;
  if (parent.status === 'EXPIRED' && (!end || end >= today())) set.status = 'ACTIVE';
  set.alerts = {};
  await db.update(C).set(set).where(eq(C.id, parent.id));
  await db.update(C).set({ amends: { ...ch, appliedAt: new Date().toISOString() } }).where(eq(C.id, a.id));
  await cAudit(t, parent, actor, 'CONTRACT_AMENDED', { amendment: a.number, changes: amendmentLines(parent, ch) });
}

/** Called whenever a contract becomes signed: amendments apply, supplier contracts go to the ERP. */
export async function onSigned(t: Tenant, c: Contract, actor: string) {
  if (c.type === 'amendment') { await applyAmendment(t, c, actor); return; }
  if (optionOn(t, 'contractToErp') && c.direction === 'BUY') await sendToErp(t, c, actor).catch((err) => logger.warn({ err, contract: c.id }, 'contract to ERP failed'));
}

/* ---------------- ERP ---------------- */

export async function sendToErp(t: Tenant, c: Contract, by: string) {
  const party = await getParty(t.id, c.partyId);
  const vendor = party.vendorId ? await db.query.vendors.findFirst({ where: eq(schema.vendors.id, party.vendorId) }) : null;
  if (!vendor) throw new HttpError(409, 'Only contracts with an onboarded supplier (with a supplier code) can go to the ERP. Link the party to its supplier first.');
  const prices = await db.select().from(PR).where(eq(PR.contractId, c.id)).orderBy(asc(PR.createdAt));
  return queueStandaloneMessage(t.id, 'CONTRACT', { contractId: c.id, vendorId: vendor.id }, { contract: {
    contractNumber: c.number, title: c.title, type: typeInfo(c.type).label, supplierCode: vendor.code, supplierName: vendor.name, vendorId: vendor.id, currency: c.currency,
    value: c.value === null ? null : Number(c.value), startDate: c.startDate, endDate: c.endDate, signedDate: c.signedDate, reference: c.reference,
    lines: prices.map((p, i) => ({ lineNo: i + 1, itemCode: p.itemCode, description: p.description, uom: p.uom, price: Number(p.price) })),
  } }, by);
}
export async function resendToErp(t: Tenant, id: string, by: By) {
  if (!optionOn(t, 'contractToErp')) throw new HttpError(409, 'Sending contracts to the ERP is switched off in Administration → Contracts.');
  const c = await getContract(t.id, id);
  if (c.status !== 'ACTIVE' || c.direction !== 'BUY' || c.type === 'amendment') throw new HttpError(409, 'Only active supplier contracts go to the ERP.');
  const m = await sendToErp(t, c, by.name);
  await cAudit(t, c, by.name, 'CONTRACT_SENT_TO_ERP', { status: m.status }, by.ip);
}

/* ---------------- obligations ---------------- */

export const OBLIGATION_KINDS = { DELIVERABLE: 'Deliverable', PAYMENT: 'Payment', SERVICE_LEVEL: 'Service level', REPORT: 'Report or certificate', COMPLIANCE: 'Compliance', OTHER: 'Other' } as const;
export const RECURRENCE = { NONE: 'Once', MONTHLY: 'Every month', QUARTERLY: 'Every quarter', YEARLY: 'Every year' } as const;
const MONTHS: Record<string, number> = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 };
const obligationInput = z.object({
  title: z.string().trim().min(3, 'Say what has to be done').max(300),
  kind: z.enum(Object.keys(OBLIGATION_KINDS) as [string, ...string[]]),
  side: z.enum(['US', 'PARTY']),
  ownerId: z.string().nullable().optional(),
  dueDate: day,
  recurrence: z.enum(Object.keys(RECURRENCE) as [string, ...string[]]).default('NONE'),
  amount: z.number().min(0).max(1e13).nullable().optional(),
  remindDays: z.number().int().min(0).max(180).default(7),
  note: z.string().trim().max(2000).nullable().optional(),
});
function assertObligations(t: Tenant) { if (!optionOn(t, 'obligations')) throw new HttpError(409, 'Obligations are switched off in Administration → Contracts.'); }
async function checkOwner(t: Tenant, ownerId?: string | null) {
  if (!ownerId) return;
  const u = await db.query.users.findFirst({ where: and(eq(U.tenantId, t.id), eq(U.id, ownerId)) });
  if (!u || u.status === 'DISABLED') throw new HttpError(400, 'Choose an owner from your team.');
}
export async function addObligation(t: Tenant, contractId: string, raw: unknown, by: By) {
  assertObligations(t);
  const c = await getContract(t.id, contractId);
  if (c.status === 'TERMINATED' || c.status === 'EXPIRED') throw new HttpError(409, 'This contract has ended.');
  const input = obligationInput.parse(raw);
  await checkOwner(t, input.ownerId);
  const [row] = await db.insert(O).values({ ...input, amount: input.amount == null ? null : input.amount.toFixed(2), ownerId: input.ownerId ?? c.ownerId, note: input.note ?? null, tenantId: t.id, contractId: c.id, createdByName: by.name }).returning();
  await cAudit(t, c, by.name, 'CONTRACT_OBLIGATION_ADDED', { title: row.title, due: row.dueDate }, by.ip);
  return row;
}
async function getObligation(t: Tenant, contractId: string, id: string) {
  const o = await db.query.contractObligations.findFirst({ where: and(eq(O.tenantId, t.id), eq(O.contractId, contractId), eq(O.id, id)) });
  if (!o) throw new HttpError(404, 'Obligation not found');
  return o;
}
export async function updateObligation(t: Tenant, contractId: string, id: string, raw: unknown, by: By) {
  assertObligations(t);
  const o = await getObligation(t, contractId, id);
  const input = obligationInput.parse({ ...o, amount: o.amount === null ? null : Number(o.amount), ...(raw as object) });
  await checkOwner(t, input.ownerId);
  const [row] = await db.update(O).set({ ...input, amount: input.amount == null ? null : input.amount.toFixed(2), note: input.note ?? null, ...(input.dueDate !== o.dueDate ? { remindedAt: null, overdueAt: null } : {}) }).where(eq(O.id, o.id)).returning();
  await cAudit(t, { id: contractId, number: '' }, by.name, 'CONTRACT_OBLIGATION_UPDATED', { title: row.title }, by.ip);
  return row;
}
/** Done (a recurring one gets its next due date), waived, or back to open. */
export async function setObligationStatus(t: Tenant, contractId: string, id: string, raw: unknown, by: By) {
  assertObligations(t);
  const { status, note } = z.object({ status: z.enum(['DONE', 'WAIVED', 'OPEN']), note: z.string().trim().max(2000).optional() }).parse(raw);
  const o = await getObligation(t, contractId, id);
  const c = await getContract(t.id, contractId);
  await db.update(O).set({ status, doneAt: status === 'OPEN' ? null : new Date(), doneByName: status === 'OPEN' ? null : by.name, ...(note ? { note } : {}) }).where(eq(O.id, o.id));
  if (status === 'DONE' && o.status === 'OPEN' && MONTHS[o.recurrence]) {
    const next = addMonths(o.dueDate, MONTHS[o.recurrence]);
    if (!c.endDate || next <= c.endDate) await db.insert(O).values({ tenantId: t.id, contractId, title: o.title, kind: o.kind, side: o.side, ownerId: o.ownerId, dueDate: next, recurrence: o.recurrence, amount: o.amount, remindDays: o.remindDays, note: o.note, createdByName: by.name });
  }
  await cAudit(t, c, by.name, `CONTRACT_OBLIGATION_${status}`, { title: o.title, due: o.dueDate }, by.ip);
}
export async function deleteObligation(t: Tenant, contractId: string, id: string, by: By) {
  const o = await getObligation(t, contractId, id);
  await db.delete(O).where(eq(O.id, o.id));
  await cAudit(t, { id: contractId, number: '' }, by.name, 'CONTRACT_OBLIGATION_REMOVED', { title: o.title }, by.ip);
}
const obligationView = (o: ContractObligation, names: Map<string, string>) => ({ ...o, amount: o.amount === null ? null : Number(o.amount), owner: o.ownerId ? names.get(o.ownerId) ?? null : null,
  overdue: o.status === 'OPEN' && o.dueDate < today(), dueSoon: o.status === 'OPEN' && o.dueDate >= today() && o.dueDate <= addDays(today(), o.remindDays) });
async function ownerNames(ids: (string | null)[]) {
  const list = [...new Set(ids.filter(Boolean))] as string[];
  return new Map((list.length ? await db.select({ id: U.id, name: U.name }).from(U).where(inArray(U.id, list)) : []).map((u) => [u.id, u.name]));
}
/** Contracts → Obligations: open ones across contracts (overdue first), or done ones. */
export async function listObligations(t: Tenant, q: { filter?: string; mine?: string; userId: string; page?: string }) {
  const page = Math.max(1, Number(q.page) || 1), size = 50;
  const where = and(eq(O.tenantId, t.id), q.filter === 'done' ? inArray(O.status, ['DONE', 'WAIVED']) : eq(O.status, 'OPEN'),
    q.filter === 'overdue' ? sql`${O.dueDate} < ${today()}` : q.filter === 'soon' ? lte(O.dueDate, addDays(today(), 30)) : undefined, q.mine === '1' ? eq(O.ownerId, q.userId) : undefined);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(O).where(where);
  const rows = await db.select({ o: O, number: C.number, title: C.title, partyId: C.partyId }).from(O).innerJoin(C, eq(C.id, O.contractId)).where(where)
    .orderBy(q.filter === 'done' ? desc(O.doneAt) : asc(O.dueDate)).limit(size).offset((page - 1) * size);
  const names = await ownerNames(rows.map((r) => r.o.ownerId));
  const parties = new Map((rows.length ? await db.select({ id: schema.parties.id, name: schema.parties.name }).from(schema.parties).where(inArray(schema.parties.id, [...new Set(rows.map((r) => r.partyId))])) : []).map((p) => [p.id, p.name]));
  const [{ overdue }] = await db.select({ overdue: sql<number>`count(*)::int` }).from(O).where(and(eq(O.tenantId, t.id), eq(O.status, 'OPEN'), sql`${O.dueDate} < ${today()}`));
  return { obligations: rows.map((r) => ({ ...obligationView(r.o, names), contract: { id: r.o.contractId, number: r.number, title: r.title, party: parties.get(r.partyId) ?? '' } })), total: n, page, pageSize: size, overdue, kinds: OBLIGATION_KINDS, recurrence: RECURRENCE };
}

/** Daily: remind owners before due dates and when overdue (once each); renewal and notice alerts. */
export async function runContractReminders(now = today()) {
  let reminded = 0, alerted = 0;
  const due = await db.select({ o: O, c: C }).from(O).innerJoin(C, eq(C.id, O.contractId)).where(and(eq(O.status, 'OPEN'),
    or(and(isNull(O.remindedAt), sql`${O.dueDate} - ${O.remindDays} <= ${now}::date`), and(isNull(O.overdueAt), sql`${O.dueDate} < ${now}::date`)))).limit(1000);
  const tenants = new Map<string, Tenant | undefined>();
  const tenantOf = async (id: string) => { if (!tenants.has(id)) tenants.set(id, await db.query.tenants.findFirst({ where: eq(schema.tenants.id, id) })); return tenants.get(id); };
  for (const { o, c } of due) {
    const t = await tenantOf(o.tenantId);
    if (!t || !contractsOn(t) || !optionOn(t, 'obligations')) continue;
    const overdue = o.dueDate < now;
    const who = o.side === 'US' ? 'We have' : 'The other party has';
    await mailUser(o.tenantId, o.ownerId ?? c.ownerId ?? c.createdById, `${overdue ? 'Overdue' : 'Due soon'}: ${o.title} (${c.number})`,
      `${who} to: ${o.title}\nContract: ${c.number} “${c.title}”\nDue: ${longDate(o.dueDate)}${overdue ? ' — this is overdue.' : '.'}\n\nOpen the contract to mark it done.`, c.id);
    await db.update(O).set(overdue ? { overdueAt: new Date(), remindedAt: o.remindedAt ?? new Date() } : { remindedAt: new Date() }).where(eq(O.id, o.id));
    reminded++;
  }
  const active = await db.select().from(C).where(and(eq(C.status, 'ACTIVE'), isNotNull(C.endDate), gte(C.endDate, now), ne(C.type, 'amendment'))).limit(5000);
  for (const c of active) {
    const t = await tenantOf(c.tenantId);
    // With contract watch on, renewal and notice dates become watch decisions instead (one email, not two).
    if (!t || !contractsOn(t) || !optionOn(t, 'renewalAlerts') || optionOn(t, 'watch')) continue;
    const r = ruleDefaults(t);
    const alerts = { ...(c.alerts ?? {}) };
    const sends: [string, string][] = [];
    if (c.endDate! <= addDays(now, Number(r.expiringDays ?? 90)) && alerts.expiring !== c.endDate) {
      alerts.expiring = c.endDate!;
      sends.push([`Ending soon: ${c.number} ${c.title}`, `${c.number} “${c.title}” ends on ${longDate(c.endDate!)}${c.autoRenew ? ' and then renews automatically' : ''}. Decide whether to renew, renegotiate or let it end — an amendment extends it.`]);
    }
    if (c.noticeDays) {
      const noticeBy = addDays(c.endDate!, -c.noticeDays);
      if (noticeBy >= now && noticeBy <= addDays(now, Number(r.noticeReminderDays ?? 14)) && alerts.notice !== noticeBy) {
        alerts.notice = noticeBy;
        sends.push([`Notice due by ${longDate(noticeBy)}: ${c.number}`, `The last day to give ${c.noticeDays} days’ notice on ${c.number} “${c.title}” is ${longDate(noticeBy)}. ${c.autoRenew ? 'Without notice it renews automatically.' : 'Give notice by then if you want to end it before the end date.'}`]);
      }
    }
    if (!sends.length) continue;
    for (const [subject, body] of sends) await mailUser(c.tenantId, c.ownerId ?? c.createdById, subject, body, c.id);
    await db.update(C).set({ alerts }).where(eq(C.id, c.id));
    alerted += sends.length;
  }
  return { reminded, alerted };
}

/* ---------------- prices and price checks ---------------- */

const priceRow = z.object({ itemCode: z.string().trim().max(60).nullable().optional().transform((v) => v || null), description: z.string().trim().min(1, 'Describe each item').max(300), uom: z.string().trim().max(20).nullable().optional().transform((v) => v || null), price: z.number({ invalid_type_error: 'Enter each price as a number' }).min(0).max(1e12) });
export async function savePrices(t: Tenant, contractId: string, raw: unknown, by: By) {
  const c = await getContract(t.id, contractId);
  if (c.status === 'TERMINATED' || c.status === 'EXPIRED' || c.status === 'SIGNING') throw new HttpError(409, c.status === 'SIGNING' ? 'The contract is out for signature.' : 'This contract has ended.');
  const rows = z.object({ prices: z.array(priceRow).max(2000) }).parse(raw).prices;
  const codes = rows.map((r) => r.itemCode?.toLowerCase()).filter(Boolean);
  if (new Set(codes).size !== codes.length) throw new HttpError(400, 'An item code is listed twice.');
  await db.transaction(async (tx) => {
    await tx.delete(PR).where(eq(PR.contractId, c.id));
    if (rows.length) await tx.insert(PR).values(rows.map((r) => ({ ...r, price: r.price.toFixed(4), tenantId: t.id, contractId: c.id })));
  });
  await cAudit(t, c, by.name, 'CONTRACT_PRICES_SAVED', { items: rows.length }, by.ip);
}
const PRICE_COLUMNS: SheetColumn[] = [{ header: 'Item code', width: 16 }, { header: 'Description', width: 40, required: true }, { header: 'Unit', width: 10 }, { header: 'Price', width: 14, required: true }];
export const pricesTemplate = () => sheetTemplate({ sheet: 'Prices', columns: PRICE_COLUMNS, examples: [['VLV-050', 'Ball valve 50 mm, SS316', 'NOS', 1450], ['', 'Annual maintenance visit', 'VISIT', 6500]], examplesOnOwnSheet: true,
  help: [['Prices', 'One row per item or service, at the price agreed in the contract (before tax).'], ['Item code', 'The ERP item code — purchase orders and invoices are matched on it. Leave empty for services without a code.'], ['Import', 'Importing replaces the contract’s whole price list.']] });
export async function importPrices(t: Tenant, contractId: string, buffer: Buffer, by: By, commit: boolean) {
  const rows = await readSheet(buffer, { sheet: 'Prices', columns: PRICE_COLUMNS });
  const ready: { row: number; itemCode: string | null; description: string; uom: string | null; price: number }[] = []; const errors: RowError[] = [];
  for (const r of rows) {
    const price = Number(r.get('Price').replace(/,/g, ''));
    const parsed = priceRow.safeParse({ itemCode: r.get('Item code'), description: r.get('Description'), uom: r.get('Unit'), price: Number.isFinite(price) && r.get('Price') ? price : undefined });
    if (!parsed.success) errors.push({ row: r.row, message: parsed.error.issues[0].message === 'Required' ? 'Enter the price' : parsed.error.issues[0].message }); else ready.push({ row: r.row, ...parsed.data });
  }
  if (commit && !errors.length) await savePrices(t, contractId, { prices: ready.map(({ row: _r, ...p }) => p) }, by);
  return { ready, errors, created: commit && !errors.length ? ready : [] };
}

/**
 * Check order or invoice prices against the supplier's active contracts (same currency, matched on item code).
 * Above the contract price plus the tolerance = ABOVE; no contract price for the item = NO_PRICE.
 */
export async function priceCheck(t: Tenant, vendorId: string | null, currency: string, lines: { key: string; itemCode: string | null; unitPrice: number }[]) {
  if (!vendorId || !contractsOn(t) || !optionOn(t, 'priceCompliance')) return null;
  const parties = await db.select({ id: schema.parties.id }).from(schema.parties).where(and(eq(schema.parties.tenantId, t.id), eq(schema.parties.vendorId, vendorId)));
  if (!parties.length) return null;
  const contracts = await db.select().from(C).where(and(eq(C.tenantId, t.id), inArray(C.partyId, parties.map((p) => p.id)), eq(C.status, 'ACTIVE'), eq(C.currency, currency))).orderBy(desc(C.signedDate));
  if (!contracts.length) return null;
  const prices = await db.select().from(PR).where(inArray(PR.contractId, contracts.map((c) => c.id)));
  if (!prices.length) return null;
  const tolerance = Number(ruleDefaults(t).priceTolerance ?? 0);
  const out = lines.map((l) => {
    const code = l.itemCode?.trim().toLowerCase();
    const hit = code ? contracts.map((c) => ({ c, p: prices.find((p) => p.contractId === c.id && p.itemCode?.toLowerCase() === code) })).find((x) => x.p) : undefined;
    if (!hit?.p) return { key: l.key, status: 'NO_PRICE' as const, contractPrice: null, contract: null, diffPct: null };
    const cp = Number(hit.p.price);
    const diffPct = cp ? Math.round(((l.unitPrice - cp) / cp) * 10000) / 100 : 0;
    return { key: l.key, status: (diffPct > tolerance ? 'ABOVE' : 'OK') as 'ABOVE' | 'OK', contractPrice: cp, contract: { id: hit.c.id, number: hit.c.number }, diffPct };
  });
  return { tolerance, above: out.filter((x) => x.status === 'ABOVE').length, lines: out };
}

/* ---------------- the contract page ---------------- */

export async function manageView(t: Tenant, c: Contract) {
  const obligations = await db.select().from(O).where(eq(O.contractId, c.id)).orderBy(asc(O.status), asc(O.dueDate));
  const names = await ownerNames(obligations.map((o) => o.ownerId));
  const prices = await db.select().from(PR).where(eq(PR.contractId, c.id)).orderBy(asc(PR.createdAt));
  const amendments = c.type === 'amendment' ? [] : await db.select().from(C).where(and(eq(C.parentId, c.id), eq(C.type, 'amendment'))).orderBy(asc(C.createdAt));
  const parent = c.type === 'amendment' && c.parentId ? await db.query.contracts.findFirst({ where: eq(C.id, c.parentId) }) : null;
  const messages = await db.select().from(schema.poMessages).where(and(eq(schema.poMessages.tenantId, t.id), eq(schema.poMessages.contractId, c.id))).orderBy(desc(schema.poMessages.createdAt)).limit(10);
  return {
    options: { obligations: optionOn(t, 'obligations'), prices: optionOn(t, 'priceCompliance') || optionOn(t, 'contractToErp'), erp: optionOn(t, 'contractToErp'), renewalAlerts: optionOn(t, 'renewalAlerts') },
    obligations: obligations.map((o) => obligationView(o, names)), kinds: OBLIGATION_KINDS, recurrence: RECURRENCE,
    prices: prices.map((p) => ({ id: p.id, itemCode: p.itemCode, description: p.description, uom: p.uom, price: Number(p.price) })),
    amendments: amendments.map((a) => ({ id: a.id, number: a.number, title: a.title, status: a.status, signedDate: a.signedDate, lines: a.amends ? amendmentLines(c, a.amends) : [], applied: !!a.amends?.appliedAt })),
    amends: parent && c.amends ? { parent: { id: parent.id, number: parent.number, title: parent.title }, lines: amendmentLines(parent, c.amends), applied: !!c.amends.appliedAt } : null,
    canAmend: c.type !== 'amendment' && (c.status === 'ACTIVE' || c.status === 'EXPIRED') && !amendments.some((a) => a.status !== 'ACTIVE' && a.status !== 'TERMINATED'),
    erpMessages: messages.map(messageView),
  };
}
