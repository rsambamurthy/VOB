/**
 * Contract watch — the contract-watching agent (step 1: signals and the suggestions queue).
 *
 * Every night (job `contracts.daily`) and when purchase orders arrive, VendorGate looks at each workspace's active
 * contracts for things that need a decision and keeps one suggestion per contract, kind and period
 * (`contract_suggestions`). People decide: Use (with what they did), Dismiss (with a reason) or Snooze. A suggestion
 * whose reason has gone is resolved by itself. Our own owners are emailed about urgent ones straight away and get a
 * weekly digest; nothing is ever sent to the other party from here.
 *
 * All signals come from data VendorGate already holds (dates, obligations, purchase orders, price checks, supplier
 * holds and risk) — no contract text and no AI.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../lib/db.js';
import type { Contract, ContractSuggestion, Tenant } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { sendMail } from '../../lib/mailer.js';
import { hasFeature } from '../limits.js';
import { contractsOn, optionOn, ruleDefaults } from './config.js';
import { money } from './fields.js';
import { addDays, longDate, mailUser, today } from './manage.js';
import { priceBreaches } from './reports.js';

const { contracts: C, contractSuggestions: S, contractObligations: O, parties: P, users: U, vendors: V } = schema;
type By = { id: string; name: string; ip?: string };

/** What each kind is about, and what "Use" can record for it. */
export const WATCH_KINDS = {
  DECIDE: { label: 'Renew, renegotiate or end', actions: { renew: 'Renew or extend (amendment)', renegotiate: 'Renegotiate', end: 'Let it end / give notice' } },
  PRICE: { label: 'Prices above the contract', actions: { raised: 'Taken up with the supplier', accepted: 'Accepted (price change agreed)' } },
  SPEND: { label: 'Spend against the contract value', actions: { amend: 'Increase the value (amendment)', new: 'Start a new contract', ok: 'No action needed' } },
  OVERDUE: { label: 'The other party is late', actions: { chased: 'Chased the other party', waived: 'Agreed a new date / waived' } },
  SUPPLIER: { label: 'Supplier on hold or high risk', actions: { reviewed: 'Reviewed — keep the contract', end: 'Plan to end the contract' } },
  OWNER: { label: 'No owner', actions: { assigned: 'Owner assigned' } },
  IDLE: { label: 'Not used', actions: { keep: 'Keep it', end: 'Plan to end it' } },
} as const;
export type WatchKind = keyof typeof WATCH_KINDS;
export const WATCH_KIND_KEYS = Object.keys(WATCH_KINDS) as [WatchKind, ...WatchKind[]];

export interface Signal { contractId: string; kind: WatchKind; key: string; severity: 'URGENT' | 'NORMAL'; title: string; reasons: string[]; facts: Record<string, string | number | boolean | null> }

export const watchOn = (t: Tenant) => contractsOn(t) && optionOn(t, 'watch');
const monthKey = (d: string) => d.slice(0, 7);
const quarterKey = (d: string) => `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
const monthsAgo = (d: string, m: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() - m); return x.toISOString().slice(0, 10); };
const rows = async <T>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: T[] }).rows;

/* ---------------- signals ---------------- */

/** Everything that needs a decision on a workspace's active contracts (optionally only some contracts). */
export async function watchSignals(t: Tenant, now = today(), only?: string[]): Promise<Signal[]> {
  const r = ruleDefaults(t);
  const decisionDays = Number(r.decisionDays ?? 90), urgentDays = Number(r.noticeReminderDays ?? 14), warnPct = Number(r.spendWarnPct ?? 80), idleMonths = Number(r.idleMonths ?? 6);
  const where = [eq(C.tenantId, t.id), eq(C.status, 'ACTIVE'), sql`${C.type} <> 'amendment'`];
  if (only) { if (!only.length) return []; where.push(inArray(C.id, only)); }
  const list = await db.select({ c: C, partyName: P.name, vendorId: P.vendorId }).from(C).innerJoin(P, eq(P.id, C.partyId)).where(and(...where));
  if (!list.length) return [];
  const ids = list.map((x) => x.c.id);
  const idList = sql.join(ids.map((i) => sql`${i}`), sql`, `);

  // Spend and the last order per contract: purchase orders from the linked supplier, in the contract's currency, since it started.
  const orders = hasFeature(t, 'collab') ? await rows<{ id: string; spend: string; last: string | null; recent: number }>(sql`select c.id, coalesce(sum(po.total), 0)::text spend,
      max(coalesce(po.po_date, po.created_at::date))::text last, count(*) filter (where coalesce(po.po_date, po.created_at::date) >= ${addDays(now, -90)}::date)::int recent
    from contracts c join parties p on p.id = c.party_id join purchase_orders po on po.vendor_id = p.vendor_id and po.tenant_id = c.tenant_id and po.currency = c.currency
      and po.status <> 'CANCELLED' and coalesce(po.po_date, po.created_at::date) >= coalesce(c.start_date, c.created_at::date)
    where c.id in (${idList}) group by c.id`) : [];
  const spendOf = new Map(orders.map((o) => [o.id, o]));
  const usesOrders = hasFeature(t, 'collab') && (await rows<{ n: number }>(sql`select count(*)::int n from purchase_orders where tenant_id = ${t.id} limit 1`))[0]?.n > 0;

  const overdue = await rows<{ id: string; n: number; oldest: string }>(sql`select contract_id id, count(*)::int n, min(due_date)::text oldest from contract_obligations
    where contract_id in (${idList}) and status = 'OPEN' and side = 'PARTY' and due_date < ${now}::date group by 1`);
  const overdueOf = new Map(overdue.map((o) => [o.id, o]));

  const prices = optionOn(t, 'priceCompliance') ? (await priceBreaches(t)).per : new Map();

  const vendorIds = [...new Set(list.map((x) => x.vendorId).filter((v): v is string => !!v))];
  const health = vendorIds.length ? await db.select({ id: V.id, name: V.name, blockedAt: V.blockedAt, blockSource: V.blockSource, blockedReason: V.blockedReason, riskBand: V.riskBand }).from(V).where(inArray(V.id, vendorIds)) : [];
  const healthOf = new Map(health.map((v) => [v.id, v]));

  const ownerIds = [...new Set(list.map((x) => x.c.ownerId).filter((v): v is string => !!v))];
  const owners = ownerIds.length ? await db.select({ id: U.id, name: U.name, status: U.status }).from(U).where(inArray(U.id, ownerIds)) : [];
  const ownerOf = new Map(owners.map((u) => [u.id, u]));

  const out: Signal[] = [];
  for (const { c, partyName, vendorId } of list) {
    const base = { number: c.number, title: c.title, party: partyName };
    const value = c.value === null ? null : Number(c.value);
    const s = spendOf.get(c.id);
    const spend = s ? Number(s.spend) : 0;
    const add = (kind: WatchKind, key: string, severity: Signal['severity'], title: string, reasons: string[], facts: Signal['facts']) =>
      out.push({ contractId: c.id, kind, key, severity, title, reasons, facts: { ...base, ...facts } });

    // 1. A renew / renegotiate / end decision before the last day to give notice.
    if (c.endDate && c.endDate >= now) {
      const noticeBy = c.noticeDays ? addDays(c.endDate, -c.noticeDays) : c.endDate;
      if (noticeBy <= addDays(now, decisionDays)) {
        const missed = noticeBy < now;
        const reasons = [missed ? `The last day to give ${c.noticeDays} days’ notice (${longDate(noticeBy)}) has passed.` : `The last day to give notice is ${longDate(noticeBy)}.`,
          c.autoRenew ? `It renews automatically on ${longDate(c.endDate)} for ${c.renewalTermMonths ?? 12} months unless notice is given.` : `It ends on ${longDate(c.endDate)}.`];
        if (s?.recent) reasons.push(`${s.recent} purchase order${s.recent === 1 ? '' : 's'} in the last 90 days — it is still in use.`);
        if (prices.get(c.id)) reasons.push('Some orders were above the contract price — a reason to renegotiate.');
        add('DECIDE', noticeBy, missed || noticeBy <= addDays(now, urgentDays) ? 'URGENT' : 'NORMAL',
          c.autoRenew ? `Decide before it renews: ${c.number}` : `Decide before it ends: ${c.number}`, reasons,
          { endDate: c.endDate, noticeBy, autoRenew: c.autoRenew, value, currency: c.currency, spend: s ? spend : null, ordersLast90: s?.recent ?? 0 });
      }
    }
    // 2. Orders above the contract price (last 90 days).
    const p = prices.get(c.id);
    if (p?.above) add('PRICE', monthKey(now), 'NORMAL', `${p.above} order line${p.above === 1 ? '' : 's'} above the contract price: ${c.number}`,
      [`${p.above} of ${p.lines} matched order lines in the last 90 days were above the agreed price (after your tolerance).`, `About ${money(p.excess, c.currency)} paid over the contract price.`],
      { linesAbove: p.above, linesChecked: p.lines, excess: p.excess, currency: c.currency });
    // 3. Spend near or over the contract value.
    if (value && value > 0 && spend >= (value * warnPct) / 100) {
      const over = spend >= value;
      const pct = Math.round((spend / value) * 100);
      add('SPEND', over ? '100' : String(warnPct), over ? 'URGENT' : 'NORMAL', `${over ? 'Spend is over' : `Spend is at ${pct}% of`} the contract value: ${c.number}`,
        [`Orders since ${longDate(c.startDate ?? c.createdAt.toISOString().slice(0, 10))} total ${money(spend, c.currency)} against a value of ${money(value, c.currency)} (${pct}%).`],
        { spend, value, pct, currency: c.currency });
    }
    // 4. The other party's obligations are overdue.
    const od = overdueOf.get(c.id);
    if (od) {
      const late = Math.round((Date.parse(now) - Date.parse(od.oldest)) / 86_400_000);
      add('OVERDUE', monthKey(now), late > 30 ? 'URGENT' : 'NORMAL', `${partyName} is late on ${od.n} obligation${od.n === 1 ? '' : 's'}: ${c.number}`,
        [`${od.n} obligation${od.n === 1 ? '' : 's'} for the other party ${od.n === 1 ? 'is' : 'are'} overdue, the oldest since ${longDate(od.oldest)} (${late} days).`], { overdue: od.n, oldest: od.oldest, daysLate: late });
    }
    // 5. The supplier is on hold or high risk.
    const v = vendorId ? healthOf.get(vendorId) : undefined;
    if (v && (v.blockedAt || v.riskBand === 'HIGH')) {
      const reasons: string[] = [];
      if (v.blockedAt) reasons.push(v.blockSource === 'EXPIRY' ? 'The supplier is on hold because a required document has expired.' : `The supplier is on hold${v.blockedReason ? `: ${v.blockedReason}` : '.'}`);
      if (v.riskBand === 'HIGH') reasons.push('The supplier’s risk is high.');
      add('SUPPLIER', `${v.blockedAt ? 'hold' : 'risk'}-${monthKey(now)}`, v.blockedAt && v.blockSource !== 'EXPIRY' ? 'URGENT' : 'NORMAL', `Supplier ${v.blockedAt ? 'on hold' : 'at high risk'}: ${c.number}`, reasons,
        { onHold: !!v.blockedAt, holdReason: v.blockSource, riskBand: v.riskBand });
    }
    // 6. Nobody owns it.
    const owner = c.ownerId ? ownerOf.get(c.ownerId) : undefined;
    if (!c.ownerId || !owner || owner.status === 'DISABLED') add('OWNER', 'owner', 'NORMAL', `No owner: ${c.number}`,
      [c.ownerId ? `The owner (${owner?.name ?? 'a removed user'}) no longer has access, so nobody gets its reminders.` : 'Nobody owns this contract, so nobody gets its reminders.'], { formerOwner: owner?.name ?? null });
    // 7. An active supplier contract with no orders for a while.
    if (usesOrders && c.direction === 'BUY' && vendorId && (c.startDate ?? c.createdAt.toISOString().slice(0, 10)) <= monthsAgo(now, idleMonths) && (!s?.last || s.last < monthsAgo(now, idleMonths)))
      add('IDLE', quarterKey(now), 'NORMAL', `No orders for ${idleMonths} months: ${c.number}`,
        [s?.last ? `The last purchase order from this supplier under the contract was on ${longDate(s.last)}.` : 'There have been no purchase orders from this supplier since the contract started.'], { lastOrder: s?.last ?? null, months: idleMonths });
  }
  return out;
}

/* ---------------- keeping the suggestions ---------------- */

/** Bring a workspace's suggestions in line with its signals: add new ones, refresh open ones, resolve the ones whose reason has gone, wake snoozed ones. */
export async function syncWatch(t: Tenant, now = today(), only?: string[]) {
  const signals = await watchSignals(t, now, only);
  const where = [eq(S.tenantId, t.id), inArray(S.status, ['OPEN', 'SNOOZED'])];
  if (only) { if (!only.length) return { added: 0, resolved: 0, urgent: [] as ContractSuggestion[] }; where.push(inArray(S.contractId, only)); }
  const current = await db.select().from(S).where(and(...where));
  const byKey = new Map(current.map((x) => [`${x.contractId}|${x.kind}|${x.key}`, x]));
  const seen = new Set<string>();
  let added = 0, resolved = 0;
  const urgent: ContractSuggestion[] = [];
  for (const sg of signals) {
    const k = `${sg.contractId}|${sg.kind}|${sg.key}`; seen.add(k);
    const have = byKey.get(k);
    if (have) {
      const wake = have.status === 'SNOOZED' && have.snoozeUntil && have.snoozeUntil <= now;
      const upgraded = have.severity !== 'URGENT' && sg.severity === 'URGENT';
      await db.update(S).set({ title: sg.title, reasons: sg.reasons, facts: sg.facts, severity: sg.severity, updatedAt: new Date(), ...(wake ? { status: 'OPEN', snoozeUntil: null } : {}), ...(upgraded ? { notifiedAt: null } : {}) }).where(eq(S.id, have.id));
      if ((wake || upgraded) && sg.severity === 'URGENT') urgent.push({ ...have, ...sg, status: 'OPEN' } as ContractSuggestion);
      continue;
    }
    // Decided before (used / dismissed / resolved) for this same period: never raised again.
    const [row] = await db.insert(S).values({ tenantId: t.id, ...sg }).onConflictDoNothing().returning();
    if (row) { added++; if (row.severity === 'URGENT') urgent.push(row); }
  }
  for (const x of current) {
    if (seen.has(`${x.contractId}|${x.kind}|${x.key}`)) continue;
    await db.update(S).set({ status: 'RESOLVED', resolvedAt: new Date(), updatedAt: new Date() }).where(eq(S.id, x.id));
    resolved++;
  }
  return { added, resolved, urgent };
}

/** Email owners about urgent suggestions they haven't been told about: one email per owner per run (never a flood), each suggestion once. */
async function notifyUrgent(t: Tenant, items: ContractSuggestion[]) {
  const ids = [...new Set(items.map((x) => x.id))];
  if (!ids.length) return 0;
  const fresh = await db.select({ s: S, ownerId: C.ownerId, createdById: C.createdById }).from(S).innerJoin(C, eq(C.id, S.contractId))
    .where(and(inArray(S.id, ids), eq(S.status, 'OPEN'), sql`${S.notifiedAt} is null`));
  const byOwner = new Map<string, typeof fresh>();
  for (const x of fresh) { const o = x.ownerId ?? x.createdById; if (o) byOwner.set(o, [...(byOwner.get(o) ?? []), x]); }
  let sent = 0;
  for (const [userId, list] of byOwner) {
    const first = list[0].s;
    const ok = list.length === 1
      ? await mailUser(t.id, userId, `Needs a decision: ${first.title}`, `${first.reasons.join('\n')}\n\nOpen the contract to decide — record what you did, or dismiss it with a reason.`, first.contractId)
      : await mailWatch(t.id, userId, `Contract watch: ${list.length} urgent decisions`, `These contracts need a decision soon:\n\n${list.slice(0, 30).map((x) => `- ${x.s.title}`).join('\n')}${list.length > 30 ? `\n…and ${list.length - 30} more.` : ''}\n\nOpen Contracts → Watch to decide.`);
    if (ok) sent++;
  }
  if (fresh.length) await db.update(S).set({ notifiedAt: new Date() }).where(inArray(S.id, fresh.map((x) => x.s.id)));
  return sent;
}

/** An email to one of our users pointing at the Watch list (active users only). */
async function mailWatch(tenantId: string, userId: string, subject: string, body: string) {
  const u = await db.query.users.findFirst({ where: eq(U.id, userId) });
  if (u?.status !== 'ACTIVE') return false;
  await sendMail({ tenantId, to: u.email, subject, body: `Hello ${u.name},\n\n${body}`, link: `${env.appBaseUrl}/staff/contract-watch?mine=1` });
  return true;
}

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** The weekly digest: each owner gets what is open for them, once on the chosen day. */
export async function sendDigest(t: Tenant, now = today()) {
  const day = String(ruleDefaults(t).digestDay ?? 'mon');
  if (day === 'off' || DAYS[new Date(`${now}T00:00:00Z`).getUTCDay()] !== day) return 0;
  const done = await db.select({ id: schema.auditLogs.id }).from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, t.id), eq(schema.auditLogs.action, 'CONTRACT_WATCH_DIGEST'), sql`${schema.auditLogs.detail}->>'day' = ${now}`)).limit(1);
  if (done.length) return 0;
  const open = await db.select({ s: S, ownerId: C.ownerId, createdById: C.createdById }).from(S).innerJoin(C, eq(C.id, S.contractId))
    .where(and(eq(S.tenantId, t.id), eq(S.status, 'OPEN'))).orderBy(desc(S.severity), asc(S.createdAt));
  const byOwner = new Map<string, typeof open>();
  for (const x of open) { const o = x.ownerId ?? x.createdById; if (o) byOwner.set(o, [...(byOwner.get(o) ?? []), x]); }
  let sent = 0;
  for (const [userId, items] of byOwner) {
    const urgentN = items.filter((x) => x.s.severity === 'URGENT').length;
    const lines = items.slice(0, 30).map((x) => `- ${x.s.severity === 'URGENT' ? 'URGENT — ' : ''}${x.s.title}`);
    if (await mailWatch(t.id, userId, `Contract watch: ${items.length} waiting for you${urgentN ? ` (${urgentN} urgent)` : ''}`,
      `These contracts need a decision from you:\n\n${lines.join('\n')}${items.length > 30 ? `\n…and ${items.length - 30} more.` : ''}\n\nOpen Contracts → Watch to decide.`)) sent++;
  }
  await audit({ tenantId: t.id, actor: 'system (contract watch)', action: 'CONTRACT_WATCH_DIGEST', detail: { day: now, owners: sent } });
  return sent;
}

/** One workspace now: suggestions, urgent emails, digest. */
export async function runWatchFor(t: Tenant, now = today()) {
  if (!watchOn(t)) return { added: 0, resolved: 0, emailed: 0, digests: 0 };
  const r = await syncWatch(t, now);
  const emailed = await notifyUrgent(t, r.urgent);
  const digests = await sendDigest(t, now);
  return { added: r.added, resolved: r.resolved, emailed, digests };
}

/** Every workspace (job `contracts.daily`). */
export async function runWatch(now = today()) {
  const tenants = await db.select().from(schema.tenants).where(eq(schema.tenants.status, 'ACTIVE'));
  const total = { added: 0, resolved: 0, emailed: 0, digests: 0 };
  for (const t of tenants) {
    if (!watchOn(t)) continue;
    try { const r = await runWatchFor(t, now); for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += r[k]; }
    catch (err) { logger.warn({ err, tenant: t.slug }, 'contract watch failed for a workspace'); }
  }
  return total;
}

/** New or changed purchase orders: look again at the contracts with these suppliers (prices, spend, unused). */
export async function watchSuppliers(t: Tenant, vendorIds: string[]) {
  if (!watchOn(t) || !vendorIds.length) return;
  const ids = (await db.select({ id: C.id }).from(C).innerJoin(P, eq(P.id, C.partyId)).where(and(eq(C.tenantId, t.id), eq(C.status, 'ACTIVE'), inArray(P.vendorId, vendorIds)))).map((x) => x.id);
  if (!ids.length) return;
  const r = await syncWatch(t, today(), ids);
  await notifyUrgent(t, r.urgent);
}

/* ---------------- views and decisions ---------------- */

const view = (x: ContractSuggestion) => ({ id: x.id, contractId: x.contractId, kind: x.kind, kindLabel: WATCH_KINDS[x.kind as WatchKind]?.label ?? x.kind, severity: x.severity, title: x.title, reasons: x.reasons,
  facts: x.facts, status: x.status, action: x.action, actionLabel: x.action ? (WATCH_KINDS[x.kind as WatchKind]?.actions as Record<string, string> | undefined)?.[x.action] ?? x.action : null, note: x.note,
  snoozeUntil: x.snoozeUntil, decidedByName: x.decidedByName, decidedAt: x.decidedAt, createdAt: x.createdAt, updatedAt: x.updatedAt });
export type SuggestionView = ReturnType<typeof view>;
const actionsOf = () => Object.fromEntries(WATCH_KIND_KEYS.map((k) => [k, WATCH_KINDS[k].actions]));

/** Contracts → Watch: open (or decided) suggestions, urgent first, with filters. */
export async function listSuggestions(t: Tenant, q: { status?: string; kind?: string; mine?: string; page?: string | number; pageSize?: string | number }, userId: string) {
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50)), page = Math.max(1, Number(q.page) || 1);
  const status = q.status === 'decided' ? ['USED', 'DISMISSED'] : q.status === 'snoozed' ? ['SNOOZED'] : ['OPEN'];
  const where = [eq(S.tenantId, t.id), inArray(S.status, status)];
  if (q.kind && (WATCH_KIND_KEYS as string[]).includes(q.kind)) where.push(eq(S.kind, q.kind));
  if (q.mine === '1') where.push(sql`coalesce(${C.ownerId}, ${C.createdById}) = ${userId}`);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(S).innerJoin(C, eq(C.id, S.contractId)).where(and(...where));
  const list = await db.select({ s: S, owner: U.name, status: C.status }).from(S).innerJoin(C, eq(C.id, S.contractId)).leftJoin(U, eq(U.id, C.ownerId)).where(and(...where))
    .orderBy(status[0] === 'OPEN' ? sql`case when ${S.severity} = 'URGENT' then 0 else 1 end` : desc(S.decidedAt), desc(S.updatedAt)).limit(pageSize).offset((page - 1) * pageSize);
  const counts = await rows<{ kind: string; severity: string; n: number }>(sql`select kind, severity, count(*)::int n from contract_suggestions where tenant_id = ${t.id} and status = 'OPEN' group by 1, 2`);
  return { suggestions: list.map((x) => ({ ...view(x.s), owner: x.owner })), total: n, page, pageSize, counts, kinds: Object.fromEntries(WATCH_KIND_KEYS.map((k) => [k, WATCH_KINDS[k].label])), actions: actionsOf(), on: watchOn(t) };
}

/** The "For your review" card on a contract: open and snoozed ones, plus the last few decisions. */
export async function contractSuggestions(t: Tenant, c: Pick<Contract, 'id'>) {
  if (!watchOn(t)) return { on: false, open: [], decided: [], actions: actionsOf() };
  const list = await db.select().from(S).where(and(eq(S.tenantId, t.id), eq(S.contractId, c.id), inArray(S.status, ['OPEN', 'SNOOZED', 'USED', 'DISMISSED']))).orderBy(desc(S.updatedAt)).limit(30);
  return { on: true, open: list.filter((x) => x.status === 'OPEN' || x.status === 'SNOOZED').map(view), decided: list.filter((x) => x.status === 'USED' || x.status === 'DISMISSED').slice(0, 5).map(view), actions: actionsOf() };
}

/** How many open suggestions there are (menu badge, reports tile). */
export async function openCount(t: Tenant) {
  if (!watchOn(t)) return { open: 0, urgent: 0 };
  const [r] = await rows<{ open: number; urgent: number }>(sql`select count(*)::int open, count(*) filter (where severity = 'URGENT')::int urgent from contract_suggestions where tenant_id = ${t.id} and status = 'OPEN'`);
  return r;
}

const decision = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('USE'), action: z.string().min(1, 'Choose what you did'), note: z.string().trim().max(1000).optional() }),
  z.object({ decision: z.literal('DISMISS'), note: z.string().trim().min(3, 'Say why it can be dismissed').max(1000) }),
  z.object({ decision: z.literal('SNOOZE'), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date'), note: z.string().trim().max(1000).optional() }),
  z.object({ decision: z.literal('REOPEN') }),
]);
const AUDIT = { USE: 'CONTRACT_WATCH_USED', DISMISS: 'CONTRACT_WATCH_DISMISSED', SNOOZE: 'CONTRACT_WATCH_SNOOZED', REOPEN: 'CONTRACT_WATCH_REOPENED' } as const;

export async function decideSuggestion(t: Tenant, id: string, raw: unknown, by: By) {
  const sg = await db.query.contractSuggestions.findFirst({ where: and(eq(S.tenantId, t.id), eq(S.id, id)) });
  if (!sg) throw new HttpError(404, 'Not found');
  const c = await db.query.contracts.findFirst({ where: eq(C.id, sg.contractId) });
  if (!c) throw new HttpError(404, 'Not found');
  const d = decision.parse(raw);
  if (d.decision === 'REOPEN') { if (!['USED', 'DISMISSED', 'SNOOZED'].includes(sg.status)) throw new HttpError(409, 'It is already open.'); }
  else if (sg.status !== 'OPEN' && !(sg.status === 'SNOOZED' && d.decision !== 'SNOOZE')) throw new HttpError(409, sg.status === 'RESOLVED' ? 'This no longer applies — its reason has gone.' : 'This has already been decided.');
  let set: Partial<typeof S.$inferInsert>;
  if (d.decision === 'USE') {
    const actions = WATCH_KINDS[sg.kind as WatchKind]?.actions as Record<string, string> | undefined;
    if (!actions?.[d.action]) throw new HttpError(400, 'Choose one of the listed actions.');
    set = { status: 'USED', action: d.action, note: d.note || null };
  } else if (d.decision === 'DISMISS') set = { status: 'DISMISSED', note: d.note, action: null };
  else if (d.decision === 'SNOOZE') {
    if (d.until <= today() || d.until > addDays(today(), 180)) throw new HttpError(400, 'Snooze until a date in the next 180 days.');
    set = { status: 'SNOOZED', snoozeUntil: d.until, note: d.note || null };
  } else set = { status: 'OPEN', action: null, snoozeUntil: null, notifiedAt: new Date() };
  await db.update(S).set({ ...set, decidedByName: by.name, decidedAt: new Date(), updatedAt: new Date() }).where(eq(S.id, sg.id));
  const label = d.decision === 'USE' ? (WATCH_KINDS[sg.kind as WatchKind].actions as Record<string, string>)[d.action] : undefined;
  await audit({ tenantId: t.id, actor: by.name, action: AUDIT[d.decision], ip: by.ip,
    detail: { subjectId: c.id, number: c.number, title: sg.title, ...(label ? { did: label } : {}), ...(d.decision === 'SNOOZE' ? { until: d.until } : {}), ...('note' in d && d.note ? { note: d.note } : {}) } });
  return view((await db.query.contractSuggestions.findFirst({ where: eq(S.id, sg.id) }))!);
}
