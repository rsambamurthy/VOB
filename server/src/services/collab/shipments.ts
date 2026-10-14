/**
 * Shipment notices (ASN): the supplier tells the buyer what is on the way, against accepted goods lines.
 * Partial shipments are fine; the total shipped per line may not go over the ordered quantity plus the
 * line's over-delivery tolerance. Receipts from the ERP are matched back to shipments.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, lt, ne, sql } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { sendMail } from '../../lib/mailer.js';
import { env } from '../../lib/env.js';
import type { PoLine, PurchaseOrder, Shipment, Tenant } from '../../db/schema.js';
import { defineJob } from '../../jobs/queue.js';
import { hasFeature } from '../limits.js';
import { queueMessage } from '../orders/outbound.js';
import { supplierLink, supplierRecipients } from '../orders/importer.js';

const { purchaseOrders, poLines, poReceipts, shipments, shipmentLines, buyingGroups } = schema;
const DAY = 86_400_000;
export const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const today = () => new Date().toISOString().slice(0, 10);
const ACCEPTED = ['ACCEPTED', 'AUTO_ACCEPTED'];

export interface ShippableLine {
  lineId: string; lineNo: number; itemCode: string | null; description: string; uom: string | null; needByDate: string | null;
  ordered: number; tolerancePct: number; shipped: number; received: number; available: number;
}

/** Accepted, open goods lines and how much can still be shipped on each. */
export async function shippableLines(poId: string, excludeShipmentId?: string): Promise<ShippableLine[]> {
  const lines = await db.select().from(poLines).where(eq(poLines.poId, poId)).orderBy(asc(poLines.lineNo));
  const shipped = await db.select({ lineId: shipmentLines.lineId, q: sql<string>`sum(${shipmentLines.quantity})` }).from(shipmentLines)
    .innerJoin(shipments, eq(shipments.id, shipmentLines.shipmentId))
    .where(and(eq(shipments.poId, poId), ne(shipments.status, 'CANCELLED'), ...(excludeShipmentId ? [ne(shipments.id, excludeShipmentId)] : []))).groupBy(shipmentLines.lineId);
  const sMap = new Map(shipped.map((s) => [s.lineId, Number(s.q)]));
  return lines.filter((l) => l.lineType === 'GOODS' && l.status === 'OPEN' && ACCEPTED.includes(l.acceptance)).map((l) => {
    const ordered = Number(l.quantity), tol = Number(l.tolerancePct ?? 0), s = sMap.get(l.id) ?? 0, rcv = Number(l.receivedQty);
    return { lineId: l.id, lineNo: l.lineNo, itemCode: l.itemCode, description: l.description, uom: l.uom, needByDate: l.needByDate,
      ordered, tolerancePct: tol, shipped: s, received: rcv, available: Math.max(0, r4(ordered * (1 + tol / 100) - Math.max(s, rcv))) };
  });
}

export interface ShipmentInput {
  shipDate: string; expectedDate?: string | null; supplierRef?: string | null; carrier?: string | null; trackingNo?: string | null;
  vehicleNo?: string | null; ewayBill?: string | null; packages?: number | null; notes?: string | null;
  lines: { lineId: string; quantity: number; batchNo?: string | null }[];
}

async function nextNumber(tx: any, tenantId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`asn:${tenantId}`}))`);
  const prefix = `ASN-${new Date().getUTCFullYear()}-`;
  const [last] = await tx.select({ number: shipments.number }).from(shipments).where(and(eq(shipments.tenantId, tenantId), like(shipments.number, `${prefix}%`))).orderBy(desc(shipments.number)).limit(1);
  return `${prefix}${String(last ? Number(last.number.slice(prefix.length)) + 1 : 1).padStart(6, '0')}`;
}

export async function createShipment(tenant: Tenant, po: PurchaseOrder, input: ShipmentInput, by: { name: string; email?: string | null }, ip?: string) {
  if (po.status !== 'OPEN') throw new HttpError(409, 'This purchase order is closed or cancelled');
  if (!po.vendorId) throw new HttpError(409, 'This purchase order isn’t linked to a supplier yet');
  if (input.shipDate > new Date(Date.now() + DAY).toISOString().slice(0, 10)) throw new HttpError(400, 'The ship date can’t be in the future');
  if (input.expectedDate && input.expectedDate < input.shipDate) throw new HttpError(400, 'The expected delivery date can’t be before the ship date');
  if (input.ewayBill && !/^\d{12}$/.test(input.ewayBill.replace(/\s/g, ''))) throw new HttpError(400, 'An e-way bill number has 12 digits');
  const wanted = input.lines.filter((l) => l.quantity > 0);
  if (!wanted.length) throw new HttpError(400, 'Enter a quantity for at least one line');
  if (new Set(wanted.map((l) => l.lineId)).size !== wanted.length) throw new HttpError(400, 'Each line can appear once');

  const row = await db.transaction(async (tx) => {
    await tx.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.id, po.id)).for('update');
    const avail = new Map((await shippableLines(po.id)).map((l) => [l.lineId, l]));
    for (const l of wanted) {
      const a = avail.get(l.lineId);
      if (!a) throw new HttpError(400, 'Only accepted, open goods lines can be shipped');
      if (r4(l.quantity) > a.available) throw new HttpError(400, `Line ${a.lineNo}: you can ship at most ${a.available}${a.uom ? ` ${a.uom}` : ''} more`);
    }
    const number = await nextNumber(tx, tenant.id);
    const [s] = await tx.insert(shipments).values({
      tenantId: tenant.id, vendorId: po.vendorId!, poId: po.id, number, supplierRef: input.supplierRef?.trim() || null, shipDate: input.shipDate, expectedDate: input.expectedDate || null,
      carrier: input.carrier?.trim() || null, trackingNo: input.trackingNo?.trim() || null, vehicleNo: input.vehicleNo?.trim().toUpperCase() || null,
      ewayBill: input.ewayBill?.replace(/\s/g, '') || null, packages: input.packages ?? null, notes: input.notes?.trim() || null, createdBy: by.email ? `${by.name} <${by.email}>` : by.name,
    }).returning();
    await tx.insert(shipmentLines).values(wanted.map((l) => ({ tenantId: tenant.id, shipmentId: s.id, lineId: l.lineId, quantity: String(r4(l.quantity)), batchNo: l.batchNo?.trim() || null })));
    return s;
  });
  await audit({ tenantId: tenant.id, vendorId: po.vendorId, actor: by.email ?? by.name, action: 'PO_SHIPPED', detail: { po: po.poNumber, asn: row.number, lines: wanted.length }, ip });
  await queueMessage(po, 'ASN', { shipmentId: row.id }, by.name).catch((err) => logger.error({ err }, 'could not queue ASN'));
  // Receipts that arrived before the notice may belong to it.
  await matchReceipts(po.id).catch((err) => logger.warn({ err }, 'receipt matching failed'));
  if (po.buyerEmail) {
    await sendMail({ tenantId: tenant.id, to: po.buyerEmail, subject: `Shipped: ${po.poNumber} (${row.number})`,
      body: `Hello ${po.buyerName ?? ''},\n\n${by.name} sent a shipment notice for purchase order ${po.poNumber}: ${wanted.length} line${wanted.length === 1 ? '' : 's'}, shipped ${row.shipDate}${row.expectedDate ? `, expected ${row.expectedDate}` : ''}.${row.carrier ? `\nCarrier: ${row.carrier}${row.trackingNo ? ` (${row.trackingNo})` : ''}` : ''}`,
      link: `${env.appBaseUrl}/staff/orders/${po.id}` }).catch(() => {});
  }
  return row;
}

export async function cancelShipment(tenant: Tenant, s: Shipment, reason: string, by: { name: string; email?: string | null; supplier: boolean }, ip?: string) {
  if (s.status !== 'SHIPPED') throw new HttpError(409, s.status === 'CANCELLED' ? 'This shipment notice is already cancelled' : 'Goods on this notice have been received, so it can’t be cancelled');
  const [row] = await db.update(shipments).set({ status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason }).where(and(eq(shipments.id, s.id), eq(shipments.status, 'SHIPPED'))).returning();
  if (!row) throw new HttpError(409, 'This shipment notice changed — reload and try again');
  const po = (await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, s.poId) }))!;
  await audit({ tenantId: tenant.id, vendorId: s.vendorId, actor: by.email ?? by.name, action: 'PO_SHIPMENT_CANCELLED', detail: { po: po.poNumber, asn: s.number, reason }, ip });
  await queueMessage(po, 'ASN_CANCEL', { shipmentId: s.id }, by.name).catch((err) => logger.error({ err }, 'could not queue ASN cancel'));
  if (by.supplier && po.buyerEmail) await sendMail({ tenantId: tenant.id, to: po.buyerEmail, subject: `Shipment notice cancelled: ${s.number}`, body: `${by.name} cancelled shipment notice ${s.number} for ${po.poNumber}.\n\nReason: ${reason}`, link: `${env.appBaseUrl}/staff/orders/${po.id}` }).catch(() => {});
  if (!by.supplier) for (const r of await supplierRecipients(s.vendorId)) await sendMail({ tenantId: tenant.id, to: r.email, subject: `Shipment notice ${s.number} was cancelled`, body: `Hello ${r.name},\n\n${tenant.name} cancelled your shipment notice ${s.number} for ${po.poNumber}.\n\nReason: ${reason}`, link: supplierLink(tenant, `/vendor/orders/${po.id}`) }).catch(() => {});
  return row;
}

/**
 * Match the PO's receipts to its shipment notices: receipts naming a notice go to it; the rest are
 * spread over the oldest open notices for that line. Updates received quantities and notice status.
 */
export async function matchReceipts(poId: string) {
  const ships = await db.select().from(shipments).where(and(eq(shipments.poId, poId), ne(shipments.status, 'CANCELLED'))).orderBy(asc(shipments.createdAt));
  if (!ships.length) return;
  const sl = await db.select().from(shipmentLines).where(inArray(shipmentLines.shipmentId, ships.map((s) => s.id)));
  const receipts = await db.select().from(poReceipts).where(eq(poReceipts.poId, poId)).orderBy(asc(poReceipts.receiptDate), asc(poReceipts.createdAt));
  const order = new Map(ships.map((s, i) => [s.id, i]));
  const got = new Map(sl.map((x) => [x.id, 0]));
  const linesFor = (lineId: string, shipmentId?: string) => sl.filter((x) => x.lineId === lineId && (!shipmentId || x.shipmentId === shipmentId)).sort((a, b) => order.get(a.shipmentId)! - order.get(b.shipmentId)!);
  const spread = (lineId: string, qty: number, shipmentId?: string) => {
    let left = qty;
    const cands = linesFor(lineId, shipmentId);
    for (const x of cands) { if (left <= 0) break; const room = Number(x.quantity) - got.get(x.id)!; if (room <= 0) continue; const take = Math.min(room, left); got.set(x.id, r4(got.get(x.id)! + take)); left = r4(left - take); }
    if (left > 0 && shipmentId && cands.length) got.set(cands[cands.length - 1].id, r4(got.get(cands[cands.length - 1].id)! + left)); // over-receipt on a named notice
  };
  for (const r of receipts.filter((r) => r.lineId && r.shipmentId)) spread(r.lineId!, Number(r.quantity), r.shipmentId!);
  for (const r of receipts.filter((r) => r.lineId && !r.shipmentId)) spread(r.lineId!, Number(r.quantity));
  for (const x of sl) if (Number(x.receivedQty) !== got.get(x.id)) await db.update(shipmentLines).set({ receivedQty: String(got.get(x.id)) }).where(eq(shipmentLines.id, x.id));
  const RANK: Record<string, number> = { SHIPPED: 0, PARTLY_RECEIVED: 1, RECEIVED: 2 };
  for (const s of ships) {
    const mine = sl.filter((x) => x.shipmentId === s.id);
    const all = mine.every((x) => got.get(x.id)! >= Number(x.quantity)), any = mine.some((x) => got.get(x.id)! > 0);
    const status = all ? 'RECEIVED' : any ? 'PARTLY_RECEIVED' : 'SHIPPED';
    if (status === s.status) continue;
    await db.update(shipments).set({ status }).where(eq(shipments.id, s.id));
    // Tell the supplier when goods on a notice arrive (first part, and when it is complete).
    if (RANK[status] > RANK[s.status]) {
      const lines = mine.map((x) => ({ ...x, got: got.get(x.id)! }));
      await notifyReceived(s, status as 'PARTLY_RECEIVED' | 'RECEIVED', lines).catch((err) => logger.warn({ err }, 'receipt email failed'));
    }
  }
}

async function notifyReceived(s: Shipment, status: 'PARTLY_RECEIVED' | 'RECEIVED', lines: { lineId: string; quantity: string; got: number }[]) {
  const [po, tenant] = await Promise.all([db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, s.poId) }), db.query.tenants.findFirst({ where: eq(schema.tenants.id, s.tenantId) })]);
  if (!po || !tenant) return;
  const poL = await db.select({ id: poLines.id, lineNo: poLines.lineNo, description: poLines.description, uom: poLines.uom }).from(poLines).where(eq(poLines.poId, po.id));
  const detail = lines.map((x) => { const l = poL.find((p) => p.id === x.lineId); return `- Line ${l?.lineNo ?? '?'} ${l?.description ?? ''}: ${x.got} of ${Number(x.quantity)}${l?.uom ? ` ${l.uom}` : ''} received`; }).join('\n');
  const done = status === 'RECEIVED';
  for (const r of await supplierRecipients(s.vendorId)) {
    await sendMail({ tenantId: tenant.id, to: r.email, subject: `${done ? 'Received' : 'Partly received'}: shipment ${s.number} (${po.poNumber})`,
      body: `Hello ${r.name},\n\n${tenant.name} has ${done ? 'received the goods' : 'received part of the goods'} on your shipment notice ${s.number} for purchase order ${po.poNumber}.\n\n${detail}${done ? '\n\nYou can now invoice for these goods from the order.' : ''}`,
      link: supplierLink(tenant, `/vendor/orders/${po.id}`) });
  }
}

/**
 * Once a day: notices whose expected delivery date has passed and that aren't fully received.
 * One reminder per notice, to the buyer (chase or record the receipt) and the supplier (confirm where it is).
 */
export async function remindOverdueShipments(now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const rows = await db.select().from(shipments).where(and(inArray(shipments.status, ['SHIPPED', 'PARTLY_RECEIVED']), isNotNull(shipments.expectedDate), lt(shipments.expectedDate, today), isNull(shipments.overdueNotifiedAt))).limit(500);
  let n = 0;
  for (const s of rows) {
    const [po, tenant] = await Promise.all([db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, s.poId) }), db.query.tenants.findFirst({ where: eq(schema.tenants.id, s.tenantId) })]);
    if (!po || !tenant || tenant.status !== 'ACTIVE' || !hasFeature(tenant, 'collab')) continue;
    const vendor = await db.query.vendors.findFirst({ where: eq(schema.vendors.id, s.vendorId), columns: { name: true } });
    const late = Math.round((new Date(today).getTime() - new Date(s.expectedDate!).getTime()) / DAY);
    const part = s.status === 'PARTLY_RECEIVED' ? 'Only part of it has been received.' : 'Nothing on it has been received yet.';
    if (po.buyerEmail) {
      await sendMail({ tenantId: tenant.id, to: po.buyerEmail, subject: `Overdue delivery: ${s.number} (${po.poNumber})`,
        body: `Hello ${po.buyerName ?? ''},\n\nShipment ${s.number} from ${vendor?.name ?? 'the supplier'} for ${po.poNumber} was expected on ${s.expectedDate} (${late} day${late === 1 ? '' : 's'} ago). ${part}\n\nIf the goods have arrived, record the receipt in your ERP so it reaches VendorGate. Otherwise check with the supplier.${s.carrier ? `\n\nCarrier: ${s.carrier}${s.trackingNo ? ` (${s.trackingNo})` : ''}` : ''}`,
        link: `${env.appBaseUrl}/staff/orders/${po.id}` }).catch(() => {});
    }
    for (const r of await supplierRecipients(s.vendorId)) {
      await sendMail({ tenantId: tenant.id, to: r.email, subject: `Delivery overdue: shipment ${s.number} (${po.poNumber})`,
        body: `Hello ${r.name},\n\nYour shipment ${s.number} for ${tenant.name}'s purchase order ${po.poNumber} was expected on ${s.expectedDate}. ${part}\n\nPlease check where it is and let the buyer${po.buyerEmail ? ` (${po.buyerEmail})` : ''} know. If it won't arrive, cancel the notice and send a new one.`,
        link: supplierLink(tenant, `/vendor/orders/${po.id}`) }).catch(() => {});
    }
    await db.update(shipments).set({ overdueNotifiedAt: now }).where(eq(shipments.id, s.id));
    await audit({ tenantId: tenant.id, vendorId: s.vendorId, actor: 'system', action: 'PO_SHIPMENT_OVERDUE', detail: { po: po.poNumber, asn: s.number, expected: s.expectedDate } });
    n++;
  }
  return n;
}

defineJob('shipments.daily', async () => {
  const n = await remindOverdueShipments();
  if (n) logger.info({ n }, 'overdue shipment reminders');
});

export interface ReceiptInput { erpId: string; poNumber?: string; poErpId?: string; lineErpId?: string | null; lineNo?: number | null; receiptNumber: string; receiptDate?: string | null; quantity: number; shipmentNumber?: string | null }

/** Receipts posted by the ERP (/api/v1/receipts): stored, line received quantities raised, matched to notices. */
export async function recordReceipts(tenant: Tenant, items: ReceiptInput[]) {
  const out = { recorded: 0, errors: [] as string[] };
  const touched = new Set<string>();
  for (const [i, r] of items.entries()) {
    const where = r.poErpId ? eq(purchaseOrders.erpId, r.poErpId) : r.poNumber ? eq(purchaseOrders.poNumber, r.poNumber) : undefined;
    if (!where) { out.errors.push(`#${i + 1}: give poNumber or poErpId`); continue; }
    const po = await db.query.purchaseOrders.findFirst({ where: and(eq(purchaseOrders.tenantId, tenant.id), where), orderBy: desc(purchaseOrders.revision) });
    if (!po) { out.errors.push(`#${i + 1}: no purchase order ${r.poNumber ?? r.poErpId}`); continue; }
    const lines = await db.select().from(poLines).where(eq(poLines.poId, po.id));
    const line = r.lineErpId ? lines.find((l) => l.erpId === r.lineErpId) : r.lineNo ? lines.find((l) => l.lineNo === r.lineNo) : lines.length === 1 ? lines[0] : undefined;
    if (!line) { out.errors.push(`#${i + 1}: line not found on ${po.poNumber} (give lineErpId or lineNo)`); continue; }
    let shipmentId: string | null = null;
    if (r.shipmentNumber) {
      const s = await db.query.shipments.findFirst({ where: and(eq(shipments.tenantId, tenant.id), eq(shipments.poId, po.id), eq(shipments.number, r.shipmentNumber)) });
      if (!s) { out.errors.push(`#${i + 1}: shipment notice ${r.shipmentNumber} isn’t on ${po.poNumber}`); continue; }
      shipmentId = s.id;
    }
    const v = { tenantId: tenant.id, poId: po.id, lineId: line.id, erpId: r.erpId, receiptNumber: r.receiptNumber, receiptDate: r.receiptDate ?? null, quantity: String(r4(r.quantity)), shipmentId };
    await db.insert(poReceipts).values(v).onConflictDoUpdate({ target: [poReceipts.tenantId, poReceipts.erpId], set: v });
    const [{ total }] = await db.select({ total: sql<string>`coalesce(sum(${poReceipts.quantity}), 0)` }).from(poReceipts).where(eq(poReceipts.lineId, line.id));
    if (Number(total) > Number(line.receivedQty)) await db.update(poLines).set({ receivedQty: String(r4(Number(total))) }).where(eq(poLines.id, line.id));
    touched.add(po.id); out.recorded++;
  }
  for (const id of touched) await matchReceipts(id).catch((err) => logger.warn({ err }, 'receipt matching failed'));
  if (out.recorded) await audit({ tenantId: tenant.id, vendorId: null, actor: 'API', action: 'PO_RECEIPTS_RECORDED', detail: { receipts: out.recorded, orders: touched.size } });
  return out;
}

/** Shipments on a PO, with lines, for the order screens. */
export async function shipmentsFor(poId: string) {
  const rows = await db.select().from(shipments).where(eq(shipments.poId, poId)).orderBy(desc(shipments.createdAt));
  if (!rows.length) return [];
  const lines = await db.select({ s: shipmentLines, lineNo: poLines.lineNo, itemCode: poLines.itemCode, description: poLines.description, uom: poLines.uom }).from(shipmentLines)
    .innerJoin(poLines, eq(poLines.id, shipmentLines.lineId)).where(inArray(shipmentLines.shipmentId, rows.map((r) => r.id))).orderBy(asc(poLines.lineNo));
  return rows.map((r) => ({ ...r, lines: lines.filter((l) => l.s.shipmentId === r.id).map((l) => ({ id: l.s.id, lineId: l.s.lineId, lineNo: l.lineNo, itemCode: l.itemCode, description: l.description, uom: l.uom, quantity: Number(l.s.quantity), receivedQty: Number(l.s.receivedQty), batchNo: l.s.batchNo })) }));
}

export async function asnRequiredFor(po: Pick<PurchaseOrder, 'buyingGroupId'>) {
  if (!po.buyingGroupId) return false;
  return !!(await db.query.buyingGroups.findFirst({ where: eq(buyingGroups.id, po.buyingGroupId), columns: { asnRequired: true } }))?.asnRequired;
}

export type { PoLine };
export { today };
