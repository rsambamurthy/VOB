/**
 * Invoice reports (Invoices add-on): ageing of what is approved and unpaid, cycle time, exceptions, spend and the touchless
 * rate. Cached for a minute per workspace; Excel with text cells only (lib/excel conventions).
 */
import { sql } from 'drizzle-orm';
import { db } from '../../lib/db.js';
import type { Tenant } from '../../db/schema.js';
import { cached } from '../../lib/cache.js';

type Row = Record<string, unknown>;
const rows = async <T = Row>(q: ReturnType<typeof sql>) => (await db.execute(q)).rows as T[];
const n = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;

export const AGE_BUCKETS = ['Not yet due', '0–30 days', '31–60 days', '61–90 days', 'Over 90 days'];

export function invoiceReport(t: Tenant) {
  return cached(`invoices:${t.id}:report`, 60_000, async () => {
    // Open = approved invoices less what is paid and less credit / debit notes against them.
    const open = await rows<{ bucket: number; party: string; currency: string; amount: string; count: string }>(sql`
      with notes as (select related_invoice_id id, sum(total) amt from supplier_invoices where tenant_id = ${t.id} and kind <> 'INVOICE' and status not in ('DRAFT','REJECTED','CANCELLED') group by related_invoice_id),
      inv as (select i.*, coalesce(p.name, v.name, '—') party_name, greatest(0, i.total - i.paid_amount - coalesce(n.amt, 0)) open_amt from supplier_invoices i
        left join parties p on p.id = i.party_id left join vendors v on v.id = i.vendor_id left join notes n on n.id = i.id
        where i.tenant_id = ${t.id} and i.kind = 'INVOICE' and i.status in ('APPROVED','PARTLY_PAID'))
      select case when due_date is null or due_date >= current_date then 0 when current_date - due_date <= 30 then 1 when current_date - due_date <= 60 then 2 when current_date - due_date <= 90 then 3 else 4 end bucket,
        party_name party, currency, sum(open_amt) amount, count(*) count from inv where open_amt > 0 group by 1, 2, 3`);
    const currencies = [...new Set(open.map((r) => r.currency))];
    const ageing = currencies.map((c) => ({ currency: c, buckets: AGE_BUCKETS.map((label, i) => ({ label, amount: n(open.filter((r) => r.currency === c && Number(r.bucket) === i).reduce((s, r) => s + Number(r.amount), 0)), count: open.filter((r) => r.currency === c && Number(r.bucket) === i).reduce((s, r) => s + Number(r.count), 0) })) }));
    const byParty = new Map<string, { party: string; currency: string; overdue: number; total: number }>();
    for (const r of open) { const k = `${r.party}|${r.currency}`; const x = byParty.get(k) ?? { party: r.party, currency: r.currency, overdue: 0, total: 0 }; x.total += Number(r.amount); if (Number(r.bucket) > 0) x.overdue += Number(r.amount); byParty.set(k, x); }
    const topParties = [...byParty.values()].sort((a, b) => b.total - a.total).slice(0, 15).map((x) => ({ ...x, total: n(x.total), overdue: n(x.overdue) }));

    // Cycle time over 12 months: submitted → approved (days), approved → paid (last payment).
    const [cycle] = await rows<{ approve_median: string | null; approve_p90: string | null; pay_median: string | null; approved: string; touchless: string }>(sql`
      with a as (select i.id, extract(epoch from (i.decided_at - i.created_at)) / 86400 d, i.decided_by from supplier_invoices i where i.tenant_id = ${t.id} and i.kind = 'INVOICE' and i.decided_at > now() - interval '365 days' and i.status in ('APPROVED','PARTLY_PAID','PAID')),
      p as (select (al->>'invoiceId') id, max(sp.payment_date) paid from supplier_payments sp, jsonb_array_elements(sp.allocations) al where sp.tenant_id = ${t.id} group by 1),
      ap as (select (p.paid - i.decided_at::date) d from supplier_invoices i join p on p.id = i.id where i.tenant_id = ${t.id} and i.status = 'PAID' and i.decided_at > now() - interval '365 days')
      select percentile_cont(0.5) within group (order by a.d) approve_median, percentile_cont(0.9) within group (order by a.d) approve_p90,
        (select percentile_cont(0.5) within group (order by d) from ap) pay_median, count(*) approved, count(*) filter (where a.decided_by = 'VendorGate (touchless)') touchless from a`);

    // Exceptions in the last 90 days by check, and how they ended.
    const exceptions = await rows<{ code: string; message: string; count: string; approved: string; rejected: string; open: string }>(sql`
      select c->>'code' code, min(c->>'message') message, count(*) count, count(*) filter (where i.status in ('APPROVED','PARTLY_PAID','PAID')) approved,
        count(*) filter (where i.status = 'REJECTED') rejected, count(*) filter (where i.status in ('SUBMITTED','EXCEPTION','IN_APPROVAL')) open
      from supplier_invoices i, jsonb_array_elements(i.checks) c where i.tenant_id = ${t.id} and c->>'level' = 'warning' and i.created_at > now() - interval '90 days' group by 1 order by 3 desc limit 20`);

    // Spend (approved, 12 months, lines before tax) by supplier, GL account, cost centre; and by basis.
    const spend = await rows<{ dim: string; key: string; currency: string; amount: string }>(sql`
      with l as (select i.currency, coalesce(p.name, v.name, '—') party, l.gl_account, l.cost_centre, case when i.po_id is not null then 'PO' when i.contract_id is not null then 'Contract' else 'Non-PO' end basis,
        case when i.kind = 'INVOICE' then l.amount else -l.amount end amt
        from supplier_invoice_lines l join supplier_invoices i on i.id = l.invoice_id left join parties p on p.id = i.party_id left join vendors v on v.id = i.vendor_id
        where i.tenant_id = ${t.id} and i.status in ('APPROVED','PARTLY_PAID','PAID') and i.decided_at > now() - interval '365 days')
      select 'party' dim, party key, currency, sum(amt) amount from l group by 2, 3
      union all select 'account', coalesce(gl_account, '(PO lines)'), currency, sum(amt) from l group by 2, 3
      union all select 'costCentre', coalesce(cost_centre, '(none)'), currency, sum(amt) from l group by 2, 3
      union all select 'basis', basis, currency, sum(amt) from l group by 2, 3`);
    const top = (dim: string) => spend.filter((r) => r.dim === dim).map((r) => ({ key: r.key, currency: r.currency, amount: n(r.amount) })).sort((a, b) => b.amount - a.amount).slice(0, 15);

    const approved = Number(cycle?.approved ?? 0);
    return {
      ageing, topParties,
      cycle: { approveMedianDays: cycle?.approve_median === null ? null : n(cycle?.approve_median), approveP90Days: cycle?.approve_p90 === null ? null : n(cycle?.approve_p90), payMedianDays: cycle?.pay_median === null ? null : n(cycle?.pay_median), approved },
      touchless: { approved, touchless: Number(cycle?.touchless ?? 0), rate: approved ? Math.round((Number(cycle?.touchless ?? 0) / approved) * 1000) / 10 : null },
      exceptions: exceptions.map((e) => ({ code: e.code, example: e.message, count: Number(e.count), approved: Number(e.approved), rejected: Number(e.rejected), open: Number(e.open) })),
      spend: { party: top('party'), account: top('account'), costCentre: top('costCentre'), basis: top('basis') },
    };
  });
}

export async function invoiceReportXlsx(t: Tenant) {
  const r = await invoiceReport(t);
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const sheet = (name: string, header: string[], data: (string | number | null)[][]) => {
    const ws = wb.addWorksheet(name);
    ws.addRow(header).font = { bold: true };
    for (const d of data) ws.addRow(d.map((v) => (v === null ? '' : String(v))));
    ws.columns.forEach((c) => { c.width = 22; });
  };
  sheet('Ageing', ['Currency', ...AGE_BUCKETS], r.ageing.map((a) => [a.currency, ...a.buckets.map((b) => b.amount)]));
  sheet('Open by supplier', ['Supplier', 'Currency', 'Open', 'Overdue'], r.topParties.map((p) => [p.party, p.currency, p.total, p.overdue]));
  sheet('Cycle time', ['Measure', 'Days'], [['Submitted → approved (median)', r.cycle.approveMedianDays], ['Submitted → approved (90th percentile)', r.cycle.approveP90Days], ['Approved → paid (median)', r.cycle.payMedianDays], ['Touchless rate %', r.touchless.rate]]);
  sheet('Exceptions (90 days)', ['Check', 'Example', 'Invoices', 'Approved', 'Rejected', 'Open'], r.exceptions.map((e) => [e.code, e.example, e.count, e.approved, e.rejected, e.open]));
  sheet('Spend (12 months)', ['By', 'Value', 'Currency', 'Amount'], [...r.spend.party.map((x) => ['Supplier', x.key, x.currency, x.amount]), ...r.spend.account.map((x) => ['GL account', x.key, x.currency, x.amount]), ...r.spend.costCentre.map((x) => ['Cost centre', x.key, x.currency, x.amount]), ...r.spend.basis.map((x) => ['Basis', x.key, x.currency, x.amount])]);
  return wb.xlsx.writeBuffer();
}
