/**
 * Supplier performance scorecards, worked out from what VendorGate already holds:
 *   on-time delivery   receipts on or before the line's promised (else need-by) date, plus grace days
 *   fill rate          quantity received ÷ quantity ordered, on goods lines that fell due in the period
 *   acknowledgement    orders the supplier accepted themselves (auto-accepted / never answered don't count)
 *   invoice accuracy   invoices that matched first time (no blocking check, not rejected)
 *   shipment notices   receipts that came with an ASN (only in workspaces that use ASNs)
 *   buyer rating       buyers' 1–5 ratings of quality, delivery, service and communication
 * Each measure is 0–1; the score is their weighted average × 100 over the measures that have data.
 */
import { and, desc, eq, gte, lt, ne, sql } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import type { Tenant } from '../db/schema.js';

export type MetricKey = 'onTime' | 'fillRate' | 'acknowledgement' | 'invoiceAccuracy' | 'asn' | 'rating';
export const METRICS: { key: MetricKey; label: string; help: string; weight: number }[] = [
  { key: 'onTime', label: 'On-time delivery', help: 'Deliveries received on or before the promised date (need-by date if none was promised).', weight: 30 },
  { key: 'fillRate', label: 'Fill rate', help: 'Quantity received against quantity ordered, on goods lines that fell due in the period.', weight: 20 },
  { key: 'acknowledgement', label: 'Order acknowledgement', help: 'Orders the supplier accepted themselves. Orders accepted automatically or still unanswered don’t count.', weight: 15 },
  { key: 'invoiceAccuracy', label: 'Invoice accuracy', help: 'Invoices that matched the order and receipts first time.', weight: 15 },
  { key: 'asn', label: 'Shipment notices', help: 'Deliveries that came with a shipment notice (ASN) in VendorGate.', weight: 10 },
  { key: 'rating', label: 'Buyer rating', help: 'Average of buyers’ 1–5 ratings for quality, delivery, service and communication.', weight: 10 },
];
/** Below this many data points in total, no overall score is given. */
export const MIN_POINTS = 3;

export interface Metric { key: MetricKey; label: string; help: string; weight: number; value: number | null; numerator: number; denominator: number; note?: string }
export interface Scorecard { vendorId: string; score: number | null; grade: 'A' | 'B' | 'C' | 'D' | null; points: number; metrics: Metric[] }

export const gradeOf = (s: number | null) => (s === null ? null : s >= 90 ? 'A' : s >= 80 ? 'B' : s >= 70 ? 'C' : 'D');
const iso = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: unknown) => Number(v ?? 0) || 0;

export function weightsFor(t: Tenant): Record<MetricKey, number> {
  const w = t.settings.scorecard?.weights ?? {};
  return Object.fromEntries(METRICS.map((m) => [m.key, Math.max(0, Math.min(100, w[m.key] ?? m.weight))])) as Record<MetricKey, number>;
}

/** Raw counts per vendor and measure for one period. */
type Tally = Record<MetricKey, { n: number; d: number }> & { ackHours: number[] };
const empty = (): Tally => ({ onTime: { n: 0, d: 0 }, fillRate: { n: 0, d: 0 }, acknowledgement: { n: 0, d: 0 }, invoiceAccuracy: { n: 0, d: 0 }, asn: { n: 0, d: 0 }, rating: { n: 0, d: 0 }, ackHours: [] });

async function tally(tenant: Tenant, from: Date, to: Date, vendorIds?: string[]) {
  const T = tenant.id; const fromD = iso(from); const toD = iso(to);
  const now = new Date(); const dueUntil = iso(to < now ? to : now);
  const grace = Math.max(0, Math.min(30, tenant.settings.scorecard?.graceDays ?? 0));
  const out = new Map<string, Tally>();
  const t = (v: string | null) => { if (!v) return null; if (vendorIds && !vendorIds.includes(v)) return null; let x = out.get(v); if (!x) out.set(v, (x = empty())); return x; };
  const { purchaseOrders: po, poLines: line, poReceipts: rcpt, supplierInvoices: inv, supplierRatings: rating, shipments } = schema;

  // Deliveries (receipts) in the period, against the line's promised / need-by date.
  const receipts = await db.select({ vendorId: po.vendorId, receiptDate: rcpt.receiptDate, shipmentId: rcpt.shipmentId, promised: line.promisedDate, needBy: line.needByDate, lineType: line.lineType })
    .from(rcpt).innerJoin(po, eq(po.id, rcpt.poId)).leftJoin(line, eq(line.id, rcpt.lineId))
    .where(and(eq(rcpt.tenantId, T), gte(rcpt.receiptDate, fromD), lt(rcpt.receiptDate, toD)));
  const usesAsn = !!(await db.select({ id: shipments.id }).from(shipments).where(eq(shipments.tenantId, T)).limit(1)).length;
  for (const r of receipts) {
    const x = t(r.vendorId); if (!x || !r.receiptDate) continue;
    const due = r.promised ?? r.needBy;
    if (due) {
      const late = (Date.parse(r.receiptDate) - Date.parse(due)) / 86_400_000 > grace;
      x.onTime.d += 1; if (!late) x.onTime.n += 1;
    }
    if (usesAsn && r.lineType !== 'SERVICE') { x.asn.d += 1; if (r.shipmentId) x.asn.n += 1; }
  }

  // Fill rate: goods lines that fell due in the period (and up to today).
  const due = sql`coalesce(${line.promisedDate}, ${line.needByDate})`;
  const lines = await db.select({ vendorId: po.vendorId, quantity: line.quantity, received: line.receivedQty })
    .from(line).innerJoin(po, eq(po.id, line.poId))
    .where(and(eq(line.tenantId, T), ne(line.status, 'CANCELLED'), ne(po.status, 'CANCELLED'), ne(line.lineType, 'SERVICE'), sql`${due} >= ${fromD}`, sql`${due} < ${dueUntil}`));
  for (const l of lines) {
    const x = t(l.vendorId); const q = num(l.quantity); if (!x || q <= 0) continue;
    x.fillRate.d += q; x.fillRate.n += Math.min(num(l.received), q);
  }

  // Acknowledgement: orders received in the period whose answer is in (or overdue).
  const orders = await db.select({ vendorId: po.vendorId, acceptance: po.acceptance, acceptedAt: po.acceptedAt, firstSeenAt: po.firstSeenAt, acceptDueAt: po.acceptDueAt })
    .from(po).where(and(eq(po.tenantId, T), ne(po.status, 'CANCELLED'), gte(po.firstSeenAt, from), lt(po.firstSeenAt, to)));
  for (const o of orders) {
    const x = t(o.vendorId); if (!x) continue;
    const bySupplier = (o.acceptance === 'ACCEPTED' || o.acceptance === 'PARTIAL') && !!o.acceptedAt;
    const settled = bySupplier || o.acceptance === 'AUTO_ACCEPTED' || (o.acceptDueAt && o.acceptDueAt < now) || now.getTime() - o.firstSeenAt.getTime() > 7 * 86_400_000;
    if (!settled) continue;
    x.acknowledgement.d += 1;
    if (bySupplier) { x.acknowledgement.n += 1; x.ackHours.push((o.acceptedAt!.getTime() - o.firstSeenAt.getTime()) / 3_600_000); }
  }

  // Invoice accuracy: submitted in the period, first-time match.
  const invoices = await db.select({ vendorId: inv.vendorId, status: inv.status, checks: inv.checks })
    .from(inv).where(and(eq(inv.tenantId, T), ne(inv.status, 'CANCELLED'), gte(inv.createdAt, from), lt(inv.createdAt, to)));
  for (const i of invoices) {
    const x = t(i.vendorId); if (!x) continue;
    x.invoiceAccuracy.d += 1;
    if (i.status !== 'REJECTED' && i.status !== 'EXCEPTION' && !(i.checks ?? []).some((c) => c.level === 'error')) x.invoiceAccuracy.n += 1;
  }

  // Buyer ratings: each criterion 1–5 → 0–1 (5 = 1.0, 1 = 0.2).
  const ratings = await db.select().from(rating).where(and(eq(rating.tenantId, T), gte(rating.createdAt, from), lt(rating.createdAt, to)));
  for (const r of ratings) {
    const x = t(r.vendorId); if (!x) continue;
    for (const v of [r.quality, r.delivery, r.service, r.communication]) if (v) { x.rating.d += 1; x.rating.n += v / 5; }
  }
  return out;
}

function toCard(vendorId: string, x: Tally | undefined, w: Record<MetricKey, number>): Scorecard {
  const metrics: Metric[] = METRICS.map((m) => {
    const c = x?.[m.key] ?? { n: 0, d: 0 };
    const value = c.d > 0 ? c.n / c.d : null;
    const note = m.key === 'acknowledgement' && x?.ackHours.length ? `Average ${fmtHours(x.ackHours.reduce((a, b) => a + b, 0) / x.ackHours.length)} to accept` : undefined;
    return { ...m, weight: w[m.key], value, numerator: Math.round(c.n * 100) / 100, denominator: Math.round(c.d * 100) / 100, note };
  });
  const scored = metrics.filter((m) => m.value !== null && m.weight > 0);
  const weightSum = scored.reduce((a, m) => a + m.weight, 0);
  // Ratings count once per rating, not per criterion, towards "enough data".
  const points = metrics.reduce((a, m) => a + (m.key === 'rating' ? Math.ceil(m.denominator / 4) : m.key === 'fillRate' ? (m.denominator > 0 ? 1 : 0) : m.denominator), 0);
  const score = weightSum > 0 && points >= MIN_POINTS ? Math.round((scored.reduce((a, m) => a + m.weight * m.value!, 0) / weightSum) * 1000) / 10 : null;
  return { vendorId, score, grade: gradeOf(score), points, metrics };
}
const fmtHours = (h: number) => (h < 1 ? 'under an hour' : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`);

export function periodOf(days: number, end = new Date()) {
  const to = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1));
  const from = new Date(to.getTime() - days * 86_400_000);
  return { from, to };
}

/** Scorecards for every supplier with data or approved, this period and the one before (for the trend). */
export async function scorecards(tenant: Tenant, days: number) {
  const w = weightsFor(tenant);
  const { from, to } = periodOf(days);
  const prev = periodOf(days, new Date(from.getTime() - 86_400_000));
  const [cur, before] = await Promise.all([tally(tenant, from, to), tally(tenant, prev.from, prev.to)]);
  const vendors = await db.select({ id: schema.vendors.id, name: schema.vendors.name, code: schema.vendors.code, status: schema.vendors.status })
    .from(schema.vendors).where(eq(schema.vendors.tenantId, tenant.id));
  return {
    period: { from: iso(from), to: iso(new Date(to.getTime() - 1)), days }, weights: w,
    rows: vendors.filter((v) => v.status === 'APPROVED' || cur.has(v.id)).map((v) => {
      const card = toCard(v.id, cur.get(v.id), w);
      const last = toCard(v.id, before.get(v.id), w).score;
      return { ...card, name: v.name, code: v.code, status: v.status, previousScore: last, change: card.score !== null && last !== null ? Math.round((card.score - last) * 10) / 10 : null };
    }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.name.localeCompare(b.name)),
  };
}

/** One supplier: the scorecard, six months of trend, late deliveries and recent ratings. */
export async function scorecardFor(tenant: Tenant, vendorId: string, days: number) {
  const w = weightsFor(tenant);
  const { from, to } = periodOf(days);
  const card = toCard(vendorId, (await tally(tenant, from, to, [vendorId])).get(vendorId), w);
  const trend: { month: string; score: number | null }[] = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const a = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const b = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1));
    trend.push({ month: iso(a).slice(0, 7), score: toCard(vendorId, (await tally(tenant, a, b, [vendorId])).get(vendorId), w).score });
  }
  const { purchaseOrders: po, poLines: line, poReceipts: rcpt } = schema;
  const grace = tenant.settings.scorecard?.graceDays ?? 0;
  const late = (await db.select({ poId: po.id, poNumber: po.poNumber, lineNo: line.lineNo, description: line.description, promised: line.promisedDate, needBy: line.needByDate, receiptDate: rcpt.receiptDate, quantity: rcpt.quantity })
    .from(rcpt).innerJoin(po, eq(po.id, rcpt.poId)).innerJoin(line, eq(line.id, rcpt.lineId))
    .where(and(eq(rcpt.tenantId, tenant.id), eq(po.vendorId, vendorId), gte(rcpt.receiptDate, iso(from)), lt(rcpt.receiptDate, iso(to))))
    .orderBy(desc(rcpt.receiptDate)))
    .map((r) => ({ ...r, due: r.promised ?? r.needBy, daysLate: r.receiptDate && (r.promised ?? r.needBy) ? Math.round((Date.parse(r.receiptDate) - Date.parse((r.promised ?? r.needBy)!)) / 86_400_000) : 0 }))
    .filter((r) => r.daysLate > grace).slice(0, 10);
  const ratings = await db.select().from(schema.supplierRatings).where(and(eq(schema.supplierRatings.tenantId, tenant.id), eq(schema.supplierRatings.vendorId, vendorId))).orderBy(desc(schema.supplierRatings.createdAt)).limit(10);
  return { period: { from: iso(from), to: iso(new Date(to.getTime() - 1)), days }, ...card, trend, late, ratings };
}

