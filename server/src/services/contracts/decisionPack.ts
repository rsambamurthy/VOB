/**
 * Contract watch step 2: the decision pack behind a suggestion, the written summary and drafts to the other party.
 *
 * The pack gathers what an owner needs to decide (term and notice, spend, prices above the contract, obligations kept,
 * supplier risk, scorecard and holds, amendments, earlier decisions) and makes a rule-based recommendation with
 * reasons. The summary is written by VendorGate's rules, or — with the `watchSummary` option and an AI provider — by
 * the AI from general facts only (bands, counts, yes/no; [CONTRACT] / [PARTY]), checked by `leaks()` before sending
 * and stored as "What the AI saw". Drafts are written locally with the real names, for a person to edit and send from
 * their own email; VendorGate never sends them.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import type { Contract, ContractSuggestion, Tenant } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { hasFeature } from '../limits.js';
import { leaks, reidentify } from '../aiPrivacy.js';
import { rulesWriter, watchWriter, type PackFacts, type Recommendation } from '../../integrations/ai/watchWriter.js';
import { companyDetails, optionOn, ruleDefaults, typeInfo } from './config.js';
import { money } from './fields.js';
import { addDays, longDate, today } from './manage.js';
import { priceBreaches } from './reports.js';
import { contractOrders, WATCH_KINDS, type WatchKind } from './watch.js';

const { contracts: C, contractSuggestions: S, parties: P, vendors: V, users: U } = schema;
type By = { id: string; name: string; ip?: string };
const rows = async <T>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: T[] }).rows;

/** Everything known about the contract, with real values (shown to the owner only). */
export interface Pack {
  contract: { number: string; title: string; type: string; direction: string; party: string; startDate: string | null; endDate: string | null; noticeBy: string | null; autoRenew: boolean; renewalTermMonths: number | null; value: number | null; currency: string; daysToNotice: number | null };
  orders: { spend: number; spend12: number; count: number; last: string | null; pctOfValue: number | null } | null;
  prices: { linesAbove: number; linesChecked: number; excess: number } | null;
  obligations: { done12: number; onTime12: number; onTimePct: number | null; overdueTheirs: number; overdueOurs: number };
  supplier: { linked: boolean; riskBand: string | null; riskScore: number | null; onHold: boolean; holdReason: string | null; scorecard: number | null; grade: string | null } | null;
  amendments: number;
  earlier: { kind: string; title: string; did: string | null; note: string | null; when: string | null }[];
  recommendation: Recommendation;
  reasons: string[];
}

/* ---------------- the pack ---------------- */

export async function buildPack(t: Tenant, sg: ContractSuggestion): Promise<Pack> {
  const c = (await db.query.contracts.findFirst({ where: and(eq(C.tenantId, t.id), eq(C.id, sg.contractId)) }))!;
  const party = (await db.query.parties.findFirst({ where: eq(P.id, c.partyId) }))!;
  const now = today();
  const noticeBy = c.endDate ? (c.noticeDays ? addDays(c.endDate, -c.noticeDays) : c.endDate) : null;
  const o = (await contractOrders(t, [c.id], now)).get(c.id);
  const value = c.value === null ? null : Number(c.value);
  const pr = optionOn(t, 'priceCompliance') ? (await priceBreaches(t)).per.get(c.id) : undefined;
  const [ob] = await rows<{ done12: number; ontime12: number; theirs: number; ours: number }>(sql`select
      count(*) filter (where status = 'DONE' and done_at >= now() - interval '365 days')::int done12,
      count(*) filter (where status = 'DONE' and done_at >= now() - interval '365 days' and done_at::date <= due_date)::int ontime12,
      count(*) filter (where status = 'OPEN' and due_date < ${now}::date and side = 'PARTY')::int theirs,
      count(*) filter (where status = 'OPEN' and due_date < ${now}::date and side = 'US')::int ours
    from contract_obligations where contract_id = ${c.id}`);
  let supplier: Pack['supplier'] = null;
  if (party.kind === 'SUPPLIER') {
    const v = party.vendorId ? await db.query.vendors.findFirst({ where: eq(V.id, party.vendorId) }) : undefined;
    let card: { score: number | null; grade: string | null } | null = null;
    if (v && hasFeature(t, 'collab')) {
      try { const s = (await (await import('../scorecards.js')).scorecardFor(t, v.id, 365)); card = { score: s.score ?? null, grade: s.grade ?? null }; } catch (err) { logger.warn({ err }, 'scorecard for a decision pack failed'); }
    }
    supplier = { linked: !!v, riskBand: v?.riskBand ?? null, riskScore: v?.riskScore ?? null, onHold: !!v?.blockedAt, holdReason: v?.blockedAt ? (v.blockSource === 'EXPIRY' ? 'a required document has expired' : v.blockedReason ?? 'held by your team') : null, scorecard: card?.score ?? null, grade: card?.grade ?? null };
  }
  const [{ n: amendments }] = await rows<{ n: number }>(sql`select count(*)::int n from contracts where parent_id = ${c.id} and type = 'amendment' and status = 'ACTIVE'`);
  const earlier = (await db.select().from(S).where(and(eq(S.contractId, c.id), inArray(S.status, ['USED', 'DISMISSED']))).orderBy(desc(S.decidedAt)).limit(5))
    .filter((x) => x.id !== sg.id).map((x) => ({ kind: x.kind, title: x.title, did: x.status === 'DISMISSED' ? 'Dismissed' : (WATCH_KINDS[x.kind as WatchKind]?.actions as Record<string, string> | undefined)?.[x.action ?? ''] ?? x.action, note: x.note, when: x.decidedAt?.toISOString() ?? null }));
  // Orders only count when the workspace's purchase orders come into VendorGate.
  const usesOrders = hasFeature(t, 'collab') && (await rows<{ n: number }>(sql`select count(*)::int n from purchase_orders where tenant_id = ${t.id} limit 1`))[0]?.n > 0;
  const pack: Omit<Pack, 'recommendation' | 'reasons'> = {
    contract: { number: c.number, title: c.title, type: typeInfo(c.type).label, direction: c.direction, party: party.name, startDate: c.startDate, endDate: c.endDate, noticeBy, autoRenew: c.autoRenew, renewalTermMonths: c.renewalTermMonths, value, currency: c.currency,
      daysToNotice: noticeBy ? Math.round((Date.parse(noticeBy) - Date.parse(now)) / 86_400_000) : null },
    orders: o ? { spend: o.spend, spend12: o.spend12, count: o.count, last: o.last, pctOfValue: value ? Math.round((o.spend / value) * 100) : null } : usesOrders && party.vendorId ? { spend: 0, spend12: 0, count: 0, last: null, pctOfValue: value ? 0 : null } : null,
    prices: pr ? { linesAbove: pr.above, linesChecked: pr.lines, excess: pr.excess } : null,
    obligations: { done12: ob.done12, onTime12: ob.ontime12, onTimePct: ob.done12 ? Math.round((ob.ontime12 / ob.done12) * 100) : null, overdueTheirs: ob.theirs, overdueOurs: ob.ours },
    supplier, amendments, earlier,
  };
  return { ...pack, ...recommend(t, sg.kind as WatchKind, c, pack) };
}

/** The rule-based recommendation and its reasons (real values — for the owner). */
export function recommend(t: Tenant, kind: WatchKind, c: Pick<Contract, 'direction'>, p: Omit<Pack, 'recommendation' | 'reasons'>): { recommendation: Recommendation; reasons: string[] } {
  if (!['DECIDE', 'IDLE', 'SUPPLIER'].includes(kind)) return { recommendation: 'ACT', reasons: actReasons(kind, p) };
  const idleMonths = Number(ruleDefaults(t).idleMonths ?? 6);
  const end: string[] = [], reneg: string[] = [], keep: string[] = [];
  const s = p.supplier, o = p.orders, cur = p.contract.currency;
  if (c.direction === 'BUY' && o && p.contract.startDate && (!o.last || o.last < addDays(today(), -30 * idleMonths))) end.push(o.last ? `No orders since ${longDate(o.last)}.` : 'No orders since it started.');
  if (s?.onHold && !/document/.test(s.holdReason ?? '')) end.push(`The supplier is on hold: ${s.holdReason}.`);
  if (s?.riskBand === 'HIGH') (p.obligations.onTimePct !== null && p.obligations.onTimePct < 70 ? end : reneg).push('The supplier’s risk is high.');
  if (p.prices?.linesAbove) reneg.push(`${p.prices.linesAbove} order line${p.prices.linesAbove === 1 ? '' : 's'} were above the contract price (${money(p.prices.excess, cur)} over) — agree the prices again.`);
  if (o?.pctOfValue !== null && o?.pctOfValue !== undefined && o.pctOfValue >= 100) reneg.push(`Orders have reached ${o.pctOfValue}% of the contract value — the value needs to change.`);
  if (p.obligations.onTimePct !== null && p.obligations.done12 >= 3 && p.obligations.onTimePct < 80) reneg.push(`Only ${p.obligations.onTimePct}% of obligations were done on time in the last year.`);
  if (p.obligations.overdueTheirs) reneg.push(p.obligations.overdueTheirs === 1 ? 'One of their obligations is overdue now.' : `${p.obligations.overdueTheirs} of their obligations are overdue now.`);
  if (s?.riskBand === 'MEDIUM') reneg.push('The supplier’s risk is medium.');
  if (s?.scorecard !== null && s?.scorecard !== undefined && s.scorecard < 60) reneg.push(`The supplier’s scorecard is ${Math.round(s.scorecard)} (grade ${s.grade}).`);
  if (o?.count) keep.push(`${o.count} order${o.count === 1 ? '' : 's'} so far (${money(o.spend12, cur)} in the last 12 months) — it is in use.`);
  if (p.obligations.onTimePct !== null && p.obligations.onTimePct >= 90) keep.push(`${p.obligations.onTimePct}% of obligations done on time.`);
  if (s?.scorecard !== null && s?.scorecard !== undefined && s.scorecard >= 75) keep.push(`Good supplier scorecard: ${Math.round(s.scorecard)} (grade ${s.grade}).`);
  const timing = p.contract.daysToNotice !== null ? [p.contract.daysToNotice < 0 ? `The notice date (${longDate(p.contract.noticeBy!)}) has passed — check whether notice can still be given.` : `${p.contract.daysToNotice} days left to give notice (by ${longDate(p.contract.noticeBy!)}).`] : [];
  if (end.length) return { recommendation: 'END', reasons: [...end, ...reneg, ...timing] };
  if (reneg.length) return { recommendation: 'RENEGOTIATE', reasons: [...reneg, ...keep, ...timing] };
  return { recommendation: 'RENEW', reasons: [...(keep.length ? keep : ['Nothing in VendorGate’s data argues against renewing.']), ...timing] };
}
function actReasons(kind: WatchKind, p: Omit<Pack, 'recommendation' | 'reasons'>) {
  const cur = p.contract.currency, out: string[] = [];
  if (kind === 'PRICE' && p.prices) out.push(`Ask ${p.contract.party} to credit or correct ${p.prices.linesAbove} order line${p.prices.linesAbove === 1 ? '' : 's'} above the contract price (${money(p.prices.excess, cur)} over).`);
  if (kind === 'SPEND' && p.orders) out.push(`Orders are at ${p.orders.pctOfValue}% of the value. Raise the value with an amendment, or start a new contract, before more orders go out.`);
  if (kind === 'OVERDUE') out.push(`Chase ${p.contract.party} for ${p.obligations.overdueTheirs} overdue obligation${p.obligations.overdueTheirs === 1 ? '' : 's'}, and agree new dates in writing.`);
  if (kind === 'OWNER') out.push('Give the contract an owner so its reminders and decisions reach someone.');
  return out;
}

/* ---------------- what the AI is given (general facts only) ---------------- */

const band = (n: number | null | undefined, cuts: [number, string][], none = 'unknown') => { if (n === null || n === undefined) return none; for (const [max, label] of cuts) if (n <= max) return label; return cuts[cuts.length - 1][1]; };
/** Reasons rewritten without names, dates or amounts — the only reason text the AI gets. */
function aiReasons(kind: WatchKind, p: Pack) {
  const out: string[] = [];
  const s = p.supplier, o = p.orders;
  if (o && (!o.last || o.last < addDays(today(), -180))) out.push('No recent orders under [CONTRACT].');
  if (s?.onHold) out.push('[PARTY] is on hold.');
  if (s?.riskBand) out.push(`[PARTY] risk is ${s.riskBand.toLowerCase()}.`);
  if (p.prices?.linesAbove) out.push('Some orders were above the contract price.');
  if (o?.pctOfValue !== null && o?.pctOfValue !== undefined && o.pctOfValue >= 80) out.push('Spend is near or over the contract value.');
  if (p.obligations.overdueTheirs) out.push('[PARTY] has overdue obligations.');
  if (kind === 'OWNER') out.push('[CONTRACT] has no owner.');
  return out;
}
export function aiFactsOf(kind: WatchKind, p: Pack): PackFacts {
  const val = p.contract.value;
  return {
    kind, kindLabel: WATCH_KINDS[kind].label, recommendation: p.recommendation, reasons: aiReasons(kind, p),
    facts: {
      contractType: p.contract.type, weBuy: p.contract.direction === 'BUY', autoRenew: p.contract.autoRenew, renewalTermMonths: p.contract.renewalTermMonths,
      noticeIn: band(p.contract.daysToNotice, [[-1, 'already passed'], [14, 'within 2 weeks'], [30, 'within a month'], [90, 'within 3 months'], [100000, 'more than 3 months away']], 'no end date'),
      valueSize: band(val, [[100000, 'small'], [2500000, 'medium'], [25000000, 'large'], [1e15, 'very large']], 'no value set'),
      spendAgainstValue: band(p.orders?.pctOfValue, [[0, 'no orders'], [50, 'under half'], [79, 'half to 80%'], [99, '80–99%'], [100000, '100% or more']], p.orders ? 'no value set' : 'orders not tracked'),
      ordersLast12Months: p.orders ? band(p.orders.count, [[0, 'none'], [5, '1–5'], [25, '6–25'], [1e9, 'more than 25']]) : 'not tracked',
      linesAbovePrice: p.prices ? band(p.prices.linesAbove, [[0, 'none'], [3, '1–3'], [10, '4–10'], [1e9, 'more than 10']]) : 'not checked',
      excessAgainstValue: p.prices && val ? band((p.prices.excess / val) * 100, [[1, 'under 1% of the value'], [5, '1–5% of the value'], [100000, 'over 5% of the value']]) : 'not known',
      obligationsOnTime: p.obligations.onTimePct === null ? 'none done in the last year' : band(p.obligations.onTimePct, [[59, 'under 60%'], [79, '60–79%'], [94, '80–94%'], [100, '95% or more']]),
      theirOverdueObligations: band(p.obligations.overdueTheirs, [[0, 'none'], [2, '1–2'], [1e9, '3 or more']]),
      supplierRisk: p.supplier?.riskBand ?? (p.supplier ? 'not rated' : 'not a supplier'), supplierOnHold: p.supplier?.onHold ?? false,
      scorecard: p.supplier?.scorecard === null || p.supplier?.scorecard === undefined ? 'no scorecard' : band(p.supplier.scorecard, [[59, 'weak'], [74, 'fair'], [100, 'good']]),
      amendmentsSoFar: p.amendments, earlierDecisions: p.earlier.map((e) => e.did ?? '').filter(Boolean).join('; ') || 'none',
    },
  };
}

/** Identifying values that must never reach the AI. */
async function identifiers(t: Tenant, c: Contract, p: Pack) {
  const ids = new Set<string>([c.number, c.title, p.contract.party, t.name, companyDetails(t).legalName ?? ''].filter((x) => x && x.length >= 3));
  const party = await db.query.parties.findFirst({ where: eq(P.id, c.partyId) });
  for (const x of [party?.legalName, party?.code, party?.taxNo, party?.registrationNo, party?.email, ...(party?.contacts ?? []).flatMap((k) => [k.name, k.email])]) if (x && x.length >= 3) ids.add(x);
  if (c.ownerId) { const u = await db.query.users.findFirst({ where: eq(U.id, c.ownerId) }); if (u) { ids.add(u.name); ids.add(u.email); } }
  for (const n of [p.contract.value, p.orders?.spend, p.orders?.spend12, p.prices?.excess]) if (n) { ids.add(String(n)); ids.add(n.toLocaleString('en-IN')); ids.add(n.toLocaleString('en-US')); }
  // Same form as identifiersOf: lower case, four characters or more.
  return new Set([...ids].map((x) => x.trim().toLowerCase()).filter((x) => x.length >= 4));
}

/** Build the pack and its summary, store them on the suggestion, and return the view. */
export async function packFor(t: Tenant, id: string) {
  const sg = await db.query.contractSuggestions.findFirst({ where: and(eq(S.tenantId, t.id), eq(S.id, id)) });
  if (!sg) throw new HttpError(404, 'Not found');
  const c = (await db.query.contracts.findFirst({ where: eq(C.id, sg.contractId) }))!;
  const pack = await buildPack(t, sg);
  const facts = aiFactsOf(sg.kind as WatchKind, pack);
  const w = watchWriter();
  let summaryBy: 'rules' | 'anthropic' = 'rules', sentToAi: string | null = null, written = await rulesWriter.write({ ...facts, reasons: pack.reasons });
  if (w.live && optionOn(t, 'watchSummary') && hasFeature(t, 'ai')) {
    const payload = JSON.stringify(facts);
    if (leaks(payload, await identifiers(t, c, pack), 'contract watch summary')) logger.warn({ suggestion: sg.id }, 'contract watch summary not sent to the AI: identifying data in the facts');
    else {
      try {
        const out = await w.write(facts);
        const tokens = { '[CONTRACT]': c.number, '[PARTY]': pack.contract.party };
        written = { summary: reidentify(out.summary, tokens), points: out.points.map((x) => reidentify(x, tokens)) };
        summaryBy = 'anthropic'; sentToAi = payload;
      } catch (err) { logger.warn({ err }, 'contract watch summary: AI failed, rules used'); }
    }
  }
  const summary = [written.summary, ...written.points.map((x) => `• ${x}`)].join('\n');
  await db.update(S).set({ pack: pack as unknown as Record<string, unknown>, summary, summaryBy, sentToAi, packAt: new Date() }).where(eq(S.id, sg.id));
  return { pack, summary: written.summary, points: written.points, summaryBy, sentToAi, drafts: draftKinds(sg) };
}

/* ---------------- drafts to the other party ---------------- */

const DRAFTS = {
  chase: 'Chase the overdue obligations',
  priceQuery: 'Query the prices above the contract',
  renegotiate: 'Ask to renegotiate before renewal',
  nonRenewal: 'Notice that we will not renew',
} as const;
type DraftKey = keyof typeof DRAFTS;
function draftKinds(sg: ContractSuggestion): { key: DraftKey; label: string }[] {
  const keys: DraftKey[] = sg.kind === 'OVERDUE' ? ['chase'] : sg.kind === 'PRICE' ? ['priceQuery'] : sg.kind === 'DECIDE' ? ['renegotiate', 'nonRenewal'] : sg.kind === 'SUPPLIER' || sg.kind === 'IDLE' ? ['nonRenewal'] : [];
  return keys.map((key) => ({ key, label: DRAFTS[key] }));
}

/** A draft letter with real names, for a person to edit and send themselves. */
export async function draftFor(t: Tenant, id: string, key: string, by: By) {
  const sg = await db.query.contractSuggestions.findFirst({ where: and(eq(S.tenantId, t.id), eq(S.id, id)) });
  if (!sg) throw new HttpError(404, 'Not found');
  if (!draftKinds(sg).some((d) => d.key === key)) throw new HttpError(400, 'There is no such draft for this.');
  const c = (await db.query.contracts.findFirst({ where: eq(C.id, sg.contractId) }))!;
  const party = (await db.query.parties.findFirst({ where: eq(P.id, c.partyId) }))!;
  const us = companyDetails(t).legalName || t.name;
  const contact = party.contacts.find((k) => k.signatory && k.email) ?? party.contacts.find((k) => k.email);
  const ref = `${c.title} (our reference ${c.number}${c.reference ? `, your reference ${c.reference}` : ''})`;
  const hello = `Dear ${contact?.name ?? party.name},`;
  const sign = `\n\nKind regards,\n${by.name}\n${us}`;
  let subject = '', body = '';
  if (key === 'chase') {
    const late = await db.select().from(schema.contractObligations).where(and(eq(schema.contractObligations.contractId, c.id), eq(schema.contractObligations.status, 'OPEN'), eq(schema.contractObligations.side, 'PARTY'), sql`${schema.contractObligations.dueDate} < ${today()}::date`)).orderBy(schema.contractObligations.dueDate);
    subject = `Overdue under ${c.number}: ${late.length} item${late.length === 1 ? '' : 's'}`;
    body = `${hello}\n\nUnder ${ref}, the following ${late.length === 1 ? 'is' : 'are'} overdue:\n\n${late.map((o) => `- ${o.title} — due ${longDate(o.dueDate)}`).join('\n')}\n\nPlease send ${late.length === 1 ? 'it' : 'them'} or let us know by return when we can expect ${late.length === 1 ? 'it' : 'them'}.${sign}`;
  } else if (key === 'priceQuery') {
    const lines = await rows<{ po: string; item: string; price: string; qty: string; agreed: string }>(sql`select po.po_number po, l.item_code item, l.unit_price::text price, l.quantity::text qty, cp.price::text agreed
      from po_lines l join purchase_orders po on po.id = l.po_id join contract_prices cp on cp.contract_id = ${c.id} and lower(cp.item_code) = lower(l.item_code)
      where po.tenant_id = ${t.id} and po.vendor_id = ${party.vendorId ?? ''} and po.currency = ${c.currency} and po.created_at >= now() - interval '90 days' and l.unit_price > cp.price * (1 + ${Number(ruleDefaults(t).priceTolerance ?? 0)} / 100.0)
      order by po.po_number limit 20`);
    subject = `Prices above the agreed rates — ${c.number}`;
    body = `${hello}\n\nWe have found order lines priced above the rates agreed in ${ref}:\n\n${lines.map((l) => `- PO ${l.po}, item ${l.item}: ${money(Number(l.price), c.currency)} against the agreed ${money(Number(l.agreed), c.currency)} (quantity ${Number(l.qty)})`).join('\n') || '- (see attached list)'}\n\nPlease confirm the agreed rates will be applied and send a credit note for the difference.${sign}`;
  } else if (key === 'renegotiate') {
    subject = `Renewal of ${c.number} — terms to review`;
    body = `${hello}\n\n${ref} ${c.autoRenew ? `renews on ${longDate(c.endDate!)}` : `ends on ${longDate(c.endDate!)}`}. Before ${c.autoRenew ? 'it renews' : 'we agree a renewal'}, we would like to review the terms with you, in particular the prices and service levels.\n\nCould we meet in the next two weeks? Please suggest a time.${sign}`;
  } else {
    const noticeBy = c.endDate && c.noticeDays ? addDays(c.endDate, -c.noticeDays) : null;
    subject = `Notice of non-renewal — ${c.number}`;
    body = `${hello}\n\nWe write to give notice under ${ref} that ${us} does not wish to renew it. ${c.endDate ? `The agreement will end on ${longDate(c.endDate)}` : 'Please treat the agreement as ending at the end of its current term'}${c.noticeDays ? `, and this notice is given at least ${c.noticeDays} days before that date as the agreement requires` : ''}.\n\nPlease let us know of anything needed for an orderly hand-over.${sign}\n\n[Check the agreement's notice clause for how notice must be given — some require a signed letter or a particular address.${noticeBy ? ` The last day to give notice is ${longDate(noticeBy)}.` : ''}]`;
  }
  await audit({ tenantId: t.id, actor: by.name, action: 'CONTRACT_WATCH_DRAFTED', ip: by.ip, detail: { subjectId: c.id, number: c.number, draft: DRAFTS[key as DraftKey] } });
  return { to: contact?.email ?? party.email ?? '', toName: contact?.name ?? party.name, subject, body, label: DRAFTS[key as DraftKey] };
}

/* ---------------- what watch achieved (reports) ---------------- */

/** Decisions in the last 12 months: how many before the notice date, renewals stopped, price excess taken up. */
export async function watchOutcomes(t: Tenant) {
  const [r] = await rows<{ decided: number; dismissed: number; decides: number; ontime: number; ended: number; endedvalue: string; raised: number; raisedexcess: string; amended: number }>(sql`select
      count(*) filter (where s.status = 'USED')::int decided,
      count(*) filter (where s.status = 'DISMISSED')::int dismissed,
      count(*) filter (where s.status = 'USED' and s.kind = 'DECIDE')::int decides,
      count(*) filter (where s.status = 'USED' and s.kind = 'DECIDE' and s.decided_at::date <= s.key::date)::int ontime,
      count(*) filter (where s.status = 'USED' and s.kind = 'DECIDE' and s.action = 'end')::int ended,
      coalesce(sum(c.value) filter (where s.status = 'USED' and s.kind = 'DECIDE' and s.action = 'end'), 0)::text endedvalue,
      count(*) filter (where s.status = 'USED' and s.kind = 'PRICE' and s.action = 'raised')::int raised,
      coalesce(sum((s.facts->>'excess')::numeric) filter (where s.status = 'USED' and s.kind = 'PRICE' and s.action = 'raised'), 0)::text raisedexcess,
      count(*) filter (where s.status = 'USED' and s.action in ('renew', 'amend'))::int amended
    from contract_suggestions s join contracts c on c.id = s.contract_id
    where s.tenant_id = ${t.id} and s.decided_at >= now() - interval '365 days'`);
  return { decided: r.decided, dismissed: r.dismissed, renewalDecisions: r.decides, beforeNotice: r.ontime, beforeNoticePct: r.decides ? Math.round((r.ontime / r.decides) * 100) : null,
    ended: r.ended, endedValue: Number(r.endedvalue), pricesRaised: r.raised, priceExcessRaised: Number(r.raisedexcess), amendments: r.amended };
}
