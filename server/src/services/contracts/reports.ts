/**
 * Contracts → Reports: what is under contract (by direction, type and party), the pipeline, what ends soon,
 * obligations kept on time, how long contracts take to sign, and order prices against contract prices.
 * Figures are cached for a minute per workspace; the Excel export writes text cells only.
 */
import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import type { Tenant } from '../../db/schema.js';
import { cached } from '../../lib/cache.js';
import { optionOn, ruleDefaults, typeInfo } from './config.js';

const { contracts: C, contractObligations: O, contractPrices: PR, parties: P } = schema;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const rows = async <T>(q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: T[] }).rows;

export function contractReport(t: Tenant) {
  return cached(`contracts:${t.id}:report`, 60_000, async () => {
    const now = today();
    const byDirection = await rows<{ direction: string; currency: string; n: number; value: string }>(sql`select direction, currency, count(*)::int n, coalesce(sum(value),0)::text value from contracts
      where tenant_id = ${t.id} and status = 'ACTIVE' and type <> 'amendment' group by 1, 2 order by 1, 4 desc`);
    const byType = await rows<{ type: string; n: number; value: string }>(sql`select type, count(*)::int n, coalesce(sum(value),0)::text value from contracts
      where tenant_id = ${t.id} and status = 'ACTIVE' and type <> 'amendment' group by 1 order by 3 desc`);
    const topParties = await rows<{ id: string; name: string; kind: string; n: number; value: string; currency: string }>(sql`select p.id, p.name, p.kind, count(*)::int n, coalesce(sum(c.value),0)::text value, min(c.currency) currency
      from contracts c join parties p on p.id = c.party_id where c.tenant_id = ${t.id} and c.status = 'ACTIVE' and c.type <> 'amendment' group by 1, 2, 3 order by sum(c.value) desc nulls last limit 10`);
    const pipeline = await rows<{ status: string; n: number }>(sql`select status, count(*)::int n from contracts where tenant_id = ${t.id} and type <> 'amendment' group by 1`);
    const expiring = await db.select({ id: C.id, number: C.number, title: C.title, endDate: C.endDate, autoRenew: C.autoRenew, value: C.value, currency: C.currency, party: P.name }).from(C).innerJoin(P, eq(P.id, C.partyId))
      .where(and(eq(C.tenantId, t.id), eq(C.status, 'ACTIVE'), isNotNull(C.endDate), gte(C.endDate, now), sql`${C.endDate} <= ${addDays(now, 90)}::date`)).orderBy(C.endDate).limit(25);
    const [ob] = await rows<{ open: number; overdue: number; soon: number; done90: number; onTime90: number }>(sql`select
      count(*) filter (where status = 'OPEN')::int open,
      count(*) filter (where status = 'OPEN' and due_date < ${now}::date)::int overdue,
      count(*) filter (where status = 'OPEN' and due_date between ${now}::date and ${addDays(now, 30)}::date)::int soon,
      count(*) filter (where status = 'DONE' and done_at >= now() - interval '90 days')::int "done90",
      count(*) filter (where status = 'DONE' and done_at >= now() - interval '90 days' and done_at::date <= due_date)::int "onTime90"
      from contract_obligations where tenant_id = ${t.id}`);
    const cycle = await rows<{ type: string; n: number; avg: number; median: number }>(sql`select c.type, count(*)::int n,
      round(avg(c.signed_date - c.created_at::date))::int avg, percentile_cont(0.5) within group (order by c.signed_date - c.created_at::date)::int median
      from contracts c where c.tenant_id = ${t.id} and c.signed_date >= ${addDays(now, -365)}::date and c.source in ('MANUAL', 'TEMPLATE') and c.signed_date >= c.created_at::date group by 1 order by 2 desc`);
    return {
      byDirection: byDirection.map((r) => ({ ...r, value: Number(r.value) })),
      byType: byType.map((r) => ({ type: r.type, label: typeInfo(r.type).label, n: r.n, value: Number(r.value) })),
      topParties: topParties.map((r) => ({ ...r, value: Number(r.value) })),
      pipeline: Object.fromEntries(pipeline.map((r) => [r.status, r.n])),
      expiring: expiring.map((e) => ({ ...e, value: e.value === null ? null : Number(e.value) })),
      obligations: { ...ob, onTimeRate: ob.done90 ? Math.round((ob.onTime90 / ob.done90) * 100) : null },
      cycle: cycle.map((r) => ({ ...r, label: typeInfo(r.type).label })),
      prices: optionOn(t, 'priceCompliance') ? await priceLeakage(t) : null,
    };
  });
}

/** Purchase order lines of the last 90 days against contract prices: lines above the price and the excess paid. */
async function priceLeakage(t: Tenant) {
  const active = await db.select({ id: C.id, number: C.number, currency: C.currency, vendorId: P.vendorId }).from(C).innerJoin(P, eq(P.id, C.partyId))
    .where(and(eq(C.tenantId, t.id), eq(C.status, 'ACTIVE'), isNotNull(P.vendorId)));
  if (!active.length) return { checked: 0, above: 0, excess: 0, byContract: [] as { id: string; number: string; above: number; excess: number }[] };
  const prices = await db.select().from(PR).where(inArray(PR.contractId, active.map((c) => c.id)));
  const priceOf = new Map<string, { price: number; contract: (typeof active)[number] }>();
  for (const p of prices) {
    const c = active.find((x) => x.id === p.contractId)!;
    if (p.itemCode) priceOf.set(`${c.vendorId}|${c.currency}|${p.itemCode.toLowerCase()}`, { price: Number(p.price), contract: c });
  }
  if (!priceOf.size) return { checked: 0, above: 0, excess: 0, byContract: [] };
  const lines = await rows<{ vendor_id: string; currency: string; item_code: string; unit_price: string; quantity: string }>(sql`select po.vendor_id, po.currency, l.item_code, l.unit_price::text, l.quantity::text
    from po_lines l join purchase_orders po on po.id = l.po_id where po.tenant_id = ${t.id} and po.vendor_id is not null and l.item_code is not null
    and po.created_at >= now() - interval '90 days' and po.vendor_id in (${sql.join([...new Set(active.map((c) => c.vendorId!))].map((v) => sql`${v}`), sql`, `)}) limit 20000`);
  const tol = Number(ruleDefaults(t).priceTolerance ?? 0);
  let checked = 0, above = 0, excess = 0;
  const per = new Map<string, { id: string; number: string; above: number; excess: number }>();
  for (const l of lines) {
    const hit = priceOf.get(`${l.vendor_id}|${l.currency}|${l.item_code.toLowerCase()}`);
    if (!hit) continue;
    checked++;
    const up = Number(l.unit_price);
    if (up > hit.price * (1 + tol / 100)) {
      above++;
      const x = (up - hit.price) * Number(l.quantity);
      excess += x;
      const row = per.get(hit.contract.id) ?? { id: hit.contract.id, number: hit.contract.number, above: 0, excess: 0 };
      row.above++; row.excess += x; per.set(hit.contract.id, row);
    }
  }
  return { checked, above, excess: Math.round(excess * 100) / 100, byContract: [...per.values()].sort((a, b) => b.excess - a.excess).slice(0, 10) };
}

/** The report as an Excel workbook (text cells only, like every export). */
export async function contractReportXlsx(t: Tenant) {
  const r = await contractReport(t);
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const sheet = (name: string, head: string[], data: (string | number | null)[][]) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(head).font = { bold: true };
    for (const d of data) ws.addRow(d.map((x) => (x === null ? '' : String(x))));
    head.forEach((_, i) => { ws.getColumn(i + 1).width = i === 0 ? 34 : 18; });
  };
  sheet('Under contract', ['Direction', 'Currency', 'Active contracts', 'Value'], r.byDirection.map((x) => [x.direction === 'SELL' ? 'Customer' : 'Supplier', x.currency, x.n, x.value]));
  sheet('By type', ['Type', 'Active contracts', 'Value'], r.byType.map((x) => [x.label, x.n, x.value]));
  sheet('Top parties', ['Party', 'Kind', 'Active contracts', 'Value', 'Currency'], r.topParties.map((x) => [x.name, x.kind, x.n, x.value, x.currency]));
  sheet('Ending in 90 days', ['Number', 'Title', 'Party', 'Ends', 'Renews automatically', 'Value'], r.expiring.map((x) => [x.number, x.title, x.party, x.endDate, x.autoRenew ? 'Yes' : 'No', x.value]));
  sheet('Time to sign', ['Type', 'Signed (12 months)', 'Average days', 'Median days'], r.cycle.map((x) => [x.label, x.n, x.avg, x.median]));
  if (r.prices) sheet('Prices vs contract', ['Contract', 'Lines above price', 'Excess paid'], r.prices.byContract.map((x) => [x.number, x.above, x.excess]));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
