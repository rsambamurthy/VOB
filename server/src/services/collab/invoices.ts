/**
 * Supplier invoices against purchase orders, with matching:
 *  - quantity: never more than ordered (+ tolerance) minus what's already billed (including invoices still in review);
 *    goods billed beyond what has been received are flagged
 *  - price: unit price above the PO price by more than the workspace tolerance (default 2 %) is flagged
 *  - arithmetic, currency, duplicates (same number; same amount and date under another number)
 *  - India e-invoice: IRN format and the signed QR's details (seller GSTIN, number, IRN, value)
 * Clean invoices wait as SUBMITTED; flagged ones as EXCEPTION. Staff approve or reject; approval sends
 * the invoice to the ERP. Payments come back from the ERP as remittances.
 */
import { and, asc, desc, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { sendMail } from '../../lib/mailer.js';
import { env } from '../../lib/env.js';
import type { PurchaseOrder, SupplierInvoice, Tenant, Vendor } from '../../db/schema.js';
import { queueMessage } from '../orders/outbound.js';
import { supplierLink, supplierRecipients } from '../orders/importer.js';
import { usersWithPermission } from '../approvers.js';
import { r4 } from './shipments.js';
import { langForVendorId, mailDate, mailSupplier, snippet } from '../../i18n/emails.js';
import { matchVendor } from '../orders/importer.js';

const { purchaseOrders, poLines, shipments, shipmentLines, supplierInvoices, supplierInvoiceLines, supplierPayments, vendors } = schema;
const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
/** Invoices that count against the order (everything except rejected / cancelled). */
export const LIVE = ['SUBMITTED', 'EXCEPTION', 'APPROVED', 'PARTLY_PAID', 'PAID'];
const ACCEPTED = ['ACCEPTED', 'AUTO_ACCEPTED'];

export type Check = { code: string; level: 'error' | 'warning' | 'ok'; message: string };

export interface InvoiceableLine {
  lineId: string; lineNo: number; lineType: string; itemCode: string | null; description: string; uom: string | null; hsn: string | null;
  ordered: number; tolerancePct: number; received: number; billed: number; unitPrice: number; taxRate: number | null; available: number; availableReceived: number;
}

/** Accepted lines and how much can still be invoiced on each. */
export async function invoiceableLines(poId: string, excludeInvoiceId?: string): Promise<InvoiceableLine[]> {
  const lines = await db.select().from(poLines).where(eq(poLines.poId, poId)).orderBy(asc(poLines.lineNo));
  const billed = await db.select({ lineId: supplierInvoiceLines.lineId, q: sql<string>`sum(${supplierInvoiceLines.quantity})` }).from(supplierInvoiceLines)
    .innerJoin(supplierInvoices, eq(supplierInvoices.id, supplierInvoiceLines.invoiceId))
    .where(and(eq(supplierInvoices.poId, poId), inArray(supplierInvoices.status, LIVE), ...(excludeInvoiceId ? [ne(supplierInvoices.id, excludeInvoiceId)] : []))).groupBy(supplierInvoiceLines.lineId);
  const bMap = new Map(billed.map((b) => [b.lineId, Number(b.q)]));
  // Approved invoices are already in billedQty (we add them on approval); the rest are ours alone.
  const approved = await db.select({ lineId: supplierInvoiceLines.lineId, q: sql<string>`sum(${supplierInvoiceLines.quantity})` }).from(supplierInvoiceLines)
    .innerJoin(supplierInvoices, eq(supplierInvoices.id, supplierInvoiceLines.invoiceId))
    .where(and(eq(supplierInvoices.poId, poId), inArray(supplierInvoices.status, ['APPROVED', 'PARTLY_PAID', 'PAID']))).groupBy(supplierInvoiceLines.lineId);
  const aMap = new Map(approved.map((b) => [b.lineId, Number(b.q)]));
  return lines.filter((l) => l.status !== 'CANCELLED' && ACCEPTED.includes(l.acceptance)).map((l) => {
    const ordered = Number(l.quantity), tol = Number(l.tolerancePct ?? 0), received = Number(l.receivedQty);
    const ours = bMap.get(l.id) ?? 0, erpOnly = Math.max(0, Number(l.billedQty) - (aMap.get(l.id) ?? 0));
    const b = r4(ours + erpOnly);
    return { lineId: l.id, lineNo: l.lineNo, lineType: l.lineType, itemCode: l.itemCode, description: l.description, uom: l.uom, hsn: l.hsn, ordered, tolerancePct: tol, received, billed: b,
      unitPrice: Number(l.unitPrice), taxRate: l.taxRate === null ? null : Number(l.taxRate),
      available: Math.max(0, r4(ordered * (1 + tol / 100) - b)), availableReceived: Math.max(0, r4(received - b)) };
  });
}

export interface EInvoiceInput { irn?: string | null; ackNo?: string | null; ackDate?: string | null; signedQr?: string | null }
export interface InvoiceInput {
  invoiceNumber: string; invoiceDate: string; shipmentId?: string | null; currency?: string; total: number; notes?: string | null; documentId?: string | null;
  lines: { lineId: string; quantity: number; unitPrice: number; taxRate?: number | null; taxAmount?: number | null }[];
  einvoice?: EInvoiceInput | null;
}

/** Decode the payload of the e-invoice signed QR (a JWT from the IRP). The signature itself isn't verified here. */
export function decodeSignedQr(jwt: string): Record<string, unknown> | null {
  const parts = jwt.trim().split('.');
  if (parts.length !== 3) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof p?.data === 'string' ? JSON.parse(p.data) : p?.data && typeof p.data === 'object' ? p.data : p;
  } catch { return null; }
}

const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, '');

export function einvoiceChecks(e: EInvoiceInput | null | undefined, ctx: { supplierGstin: string | null; invoiceNumber: string; total: number; required: boolean }): Check[] {
  const out: Check[] = [];
  if (!e?.irn && !e?.signedQr) {
    if (ctx.required && ctx.supplierGstin) out.push({ code: 'EINVOICE_MISSING', level: 'warning', message: 'No e-invoice IRN given — needed if the supplier is required to e-invoice' });
    return out;
  }
  if (e.irn && !/^[0-9a-f]{64}$/i.test(e.irn.trim())) out.push({ code: 'IRN_FORMAT', level: 'error', message: 'The IRN should be 64 letters and digits (0–9, a–f)' });
  if (e.signedQr) {
    const q = decodeSignedQr(e.signedQr);
    if (!q) out.push({ code: 'QR_UNREADABLE', level: 'warning', message: 'The signed QR text couldn’t be read — paste the full text from the e-invoice QR' });
    else {
      const bad: string[] = [];
      if (ctx.supplierGstin && q.SellerGstin && norm(String(q.SellerGstin)) !== norm(ctx.supplierGstin)) bad.push(`seller GSTIN ${q.SellerGstin} isn’t the supplier’s (${ctx.supplierGstin})`);
      if (q.DocNo && norm(String(q.DocNo)) !== norm(ctx.invoiceNumber)) bad.push(`invoice number ${q.DocNo}`);
      if (e.irn && q.Irn && String(q.Irn).toLowerCase() !== e.irn.trim().toLowerCase()) bad.push('IRN');
      if (q.TotInvVal !== undefined && Math.abs(Number(q.TotInvVal) - ctx.total) > 1) bad.push(`value ${q.TotInvVal}`);
      if (bad.length) out.push({ code: 'QR_MISMATCH', level: 'warning', message: `E-invoice QR doesn’t match: ${bad.join('; ')}` });
      else out.push({ code: 'QR_OK', level: 'ok', message: `E-invoice QR matches${q.BuyerGstin ? ` (buyer GSTIN ${q.BuyerGstin})` : ''} — signature not verified` });
    }
  } else if (e.irn && !out.length) out.push({ code: 'IRN_OK', level: 'ok', message: 'IRN given' });
  return out;
}

/** Days from payment terms such as "Net 30", "30 days", "NET45". */
export function termDays(terms: string | null | undefined) {
  const m = /(\d{1,3})/.exec(terms ?? '');
  return m ? Number(m[1]) : null;
}

/** Run every check. Errors stop the invoice; warnings send it to review as an exception. */
export async function matchInvoice(tenant: Tenant, po: PurchaseOrder, vendor: Vendor, input: InvoiceInput, excludeInvoiceId?: string) {
  const checks: Check[] = [];
  const err = (code: string, message: string) => checks.push({ code, level: 'error', message });
  const warn = (code: string, message: string) => checks.push({ code, level: 'warning', message });
  const tol = tenant.settings.priceTolerancePct ?? 2;
  const avail = new Map((await invoiceableLines(po.id, excludeInvoiceId)).map((l) => [l.lineId, l]));
  const lines = input.lines.filter((l) => l.quantity > 0);
  if (!lines.length) err('NO_LINES', 'Enter a quantity for at least one line');
  if (new Set(lines.map((l) => l.lineId)).size !== lines.length) err('LINE_TWICE', 'Each order line can appear once');
  const currency = (input.currency ?? po.currency).toUpperCase();
  if (currency !== po.currency.toUpperCase()) err('CURRENCY', `The invoice must be in the order currency (${po.currency})`);
  if (input.invoiceDate > new Date(Date.now() + DAY).toISOString().slice(0, 10)) err('FUTURE_DATE', 'The invoice date can’t be in the future');
  else if (po.poDate && input.invoiceDate < po.poDate) warn('BEFORE_PO', `Invoice dated before the order (${po.poDate})`);

  let subtotal = 0, tax = 0, priceOk = true, qtyOk = true;
  const priced = lines.map((l) => {
    const a = avail.get(l.lineId);
    const amount = r2(l.quantity * l.unitPrice);
    const rate = l.taxRate ?? a?.taxRate ?? 0;
    const taxAmount = l.taxAmount ?? r2(amount * rate / 100);
    subtotal += amount; tax += taxAmount;
    if (!a) { err('LINE', 'One or more lines aren’t on this order or aren’t accepted'); return { ...l, amount, taxRate: rate, taxAmount }; }
    if (r4(l.quantity) > a.available) { err('QTY_OVER_ORDER', `Line ${a.lineNo}: only ${a.available}${a.uom ? ` ${a.uom}` : ''} is left to invoice (ordered ${a.ordered}, already invoiced ${a.billed})`); qtyOk = false; }
    else if (a.lineType === 'GOODS' && r4(l.quantity) > a.availableReceived) { warn('QTY_NOT_RECEIVED', `Line ${a.lineNo}: ${a.availableReceived} received and not yet invoiced, invoice says ${l.quantity}`); qtyOk = false; }
    if (l.unitPrice > a.unitPrice * (1 + tol / 100) + 0.0001) { warn('PRICE_OVER', `Line ${a.lineNo}: price ${l.unitPrice} is above the order price ${a.unitPrice} (tolerance ${tol}%)`); priceOk = false; }
    if (a.taxRate !== null && l.taxRate !== undefined && l.taxRate !== null && Math.abs(l.taxRate - a.taxRate) > 0.001) warn('TAX_RATE', `Line ${a.lineNo}: tax ${l.taxRate}% but the order says ${a.taxRate}%`);
    return { ...l, amount, taxRate: rate, taxAmount };
  });
  subtotal = r2(subtotal); tax = r2(tax);
  const total = r2(subtotal + tax);
  if (Math.abs(total - input.total) > 1) err('TOTAL', `The total doesn’t add up: lines and tax come to ${total.toFixed(2)}, the invoice says ${input.total.toFixed(2)}`);
  if (lines.length && qtyOk && !checks.some((c) => c.code.startsWith('QTY'))) checks.push({ code: 'QTY_OK', level: 'ok', message: 'Quantities match the order and receipts' });
  if (lines.length && priceOk) checks.push({ code: 'PRICE_OK', level: 'ok', message: 'Prices match the order' });

  // Shipment the invoice is for (optional).
  if (input.shipmentId) {
    const s = await db.query.shipments.findFirst({ where: and(eq(shipments.id, input.shipmentId), eq(shipments.poId, po.id)) });
    if (!s || s.status === 'CANCELLED') err('SHIPMENT', 'That shipment notice isn’t on this order');
    else {
      const sl = await db.select().from(shipmentLines).where(eq(shipmentLines.shipmentId, s.id));
      for (const l of lines) { const x = sl.find((y) => y.lineId === l.lineId); if (!x) warn('NOT_ON_SHIPMENT', `A line isn’t on shipment ${s.number}`); else if (l.quantity > Number(x.quantity)) warn('OVER_SHIPMENT', `More than shipped on ${s.number}`); }
    }
  }

  // Duplicates.
  const same = await db.select({ id: supplierInvoices.id, number: supplierInvoices.invoiceNumber, status: supplierInvoices.status, total: supplierInvoices.total, date: supplierInvoices.invoiceDate }).from(supplierInvoices)
    .where(and(eq(supplierInvoices.tenantId, tenant.id), eq(supplierInvoices.vendorId, vendor.id), inArray(supplierInvoices.status, LIVE), ...(excludeInvoiceId ? [ne(supplierInvoices.id, excludeInvoiceId)] : [])));
  if (same.some((x) => norm(x.number) === norm(input.invoiceNumber))) err('DUPLICATE', `Invoice ${input.invoiceNumber} has already been submitted`);
  const lookalike = same.find((x) => norm(x.number) !== norm(input.invoiceNumber) && x.date === input.invoiceDate && Math.abs(Number(x.total) - total) < 0.01);
  if (lookalike) warn('POSSIBLE_DUPLICATE', `Same date and amount as invoice ${lookalike.number}`);

  // Country rules.
  const gstin = String(((vendor.profile ?? {}) as any).tax?.gstin ?? '') || null;
  if (tenant.country === 'IN' || input.einvoice) checks.push(...einvoiceChecks(input.einvoice, { supplierGstin: gstin, invoiceNumber: input.invoiceNumber, total, required: tenant.country === 'IN' && !!tenant.settings.einvoiceRequired }));

  return { checks, lines: priced, subtotal, tax, total, currency };
}

export async function submitInvoice(tenant: Tenant, po: PurchaseOrder, vendor: Vendor, input: InvoiceInput, by: { name: string; email?: string | null }, ip?: string) {
  if (po.status === 'CANCELLED') throw new HttpError(409, 'This purchase order is cancelled');
  if (po.vendorId !== vendor.id) throw new HttpError(404, 'Purchase order not found');
  const inv = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`inv:${vendor.id}`}))`);
    const m = await matchInvoice(tenant, po, vendor, input);
    const errors = m.checks.filter((c) => c.level === 'error');
    if (errors.length) throw new HttpError(422, errors.map((e) => e.message).join('. '), { checks: m.checks }, 'INVOICE_CHECKS');
    const flagged = m.checks.some((c) => c.level === 'warning');
    const days = termDays(po.paymentTerms);
    const [row] = await tx.insert(supplierInvoices).values({
      tenantId: tenant.id, vendorId: vendor.id, poId: po.id, shipmentId: input.shipmentId || null, invoiceNumber: input.invoiceNumber.trim(), invoiceDate: input.invoiceDate,
      currency: m.currency, subtotal: String(m.subtotal), taxAmount: String(m.tax), total: String(m.total), status: flagged ? 'EXCEPTION' : 'SUBMITTED', checks: m.checks,
      einvoice: input.einvoice && (input.einvoice.irn || input.einvoice.signedQr) ? Object.fromEntries(Object.entries({ irn: input.einvoice.irn?.trim().toLowerCase(), ackNo: input.einvoice.ackNo?.trim(), ackDate: input.einvoice.ackDate?.trim(), signedQr: input.einvoice.signedQr?.trim() }).filter(([, v]) => v)) as Record<string, string> : null,
      documentId: input.documentId ?? null, notes: input.notes?.trim() || null, submittedBy: by.email ? `${by.name} <${by.email}>` : by.name,
      dueDate: days !== null ? new Date(new Date(input.invoiceDate).getTime() + days * DAY).toISOString().slice(0, 10) : null,
    }).returning();
    await tx.insert(supplierInvoiceLines).values(m.lines.map((l) => ({ tenantId: tenant.id, invoiceId: row.id, lineId: l.lineId, quantity: String(r4(l.quantity)), unitPrice: String(l.unitPrice), amount: String(l.amount), taxRate: String(l.taxRate), taxAmount: String(l.taxAmount) })));
    return row;
  });
  await audit({ tenantId: tenant.id, vendorId: vendor.id, actor: by.email ?? by.name, action: 'INVOICE_SUBMITTED', detail: { po: po.poNumber, invoice: inv.invoiceNumber, total: `${inv.currency} ${inv.total}`, ...(inv.status === 'EXCEPTION' ? { exception: inv.checks.filter((c) => c.level === 'warning').map((c) => c.code).join(', ') } : {}) }, ip });
  const to = new Set<string>([po.buyerEmail ?? '', ...(await usersWithPermission(tenant.id, 'invoices.manage')).map((u) => u.email)].filter(Boolean));
  for (const email of to) {
    await sendMail({ tenantId: tenant.id, to: email, subject: `${inv.status === 'EXCEPTION' ? 'Invoice needs review' : 'Invoice received'}: ${vendor.name} ${inv.invoiceNumber}`,
      body: `${vendor.name} submitted invoice ${inv.invoiceNumber} for ${inv.currency} ${Number(inv.total).toLocaleString('en-IN', { minimumFractionDigits: 2 })} against ${po.poNumber}.${inv.status === 'EXCEPTION' ? `\n\nIt doesn’t match cleanly:\n${inv.checks.filter((c) => c.level === 'warning').map((c) => `- ${c.message}`).join('\n')}` : ''}`,
      link: `${env.appBaseUrl}/staff/invoices/${inv.id}` }).catch(() => {});
  }
  return inv;
}

export async function decideInvoice(tenant: Tenant, inv: SupplierInvoice, decision: 'APPROVE' | 'REJECT', note: string | null, by: { name: string; email: string }, ip?: string) {
  if (inv.status !== 'SUBMITTED' && inv.status !== 'EXCEPTION') throw new HttpError(409, 'This invoice has already been decided');
  if (decision === 'REJECT' && !note) throw new HttpError(400, 'Say why the invoice is rejected — the supplier sees it');
  if (decision === 'APPROVE' && inv.status === 'EXCEPTION' && !note) throw new HttpError(400, 'This invoice has exceptions — add a note on why it can be approved');
  const po = (await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, inv.poId) }))!;
  const row = await db.transaction(async (tx) => {
    const [r] = await tx.update(supplierInvoices).set({ status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', decidedBy: by.name, decidedAt: new Date(), decisionNote: note })
      .where(and(eq(supplierInvoices.id, inv.id), inArray(supplierInvoices.status, ['SUBMITTED', 'EXCEPTION']))).returning();
    if (!r) throw new HttpError(409, 'This invoice changed — reload and try again');
    if (decision === 'APPROVE') {
      for (const l of await tx.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, inv.id))) {
        await tx.update(poLines).set({ billedQty: sql`${poLines.billedQty} + ${l.quantity}` }).where(eq(poLines.id, l.lineId));
      }
    }
    return r;
  });
  await audit({ tenantId: tenant.id, vendorId: inv.vendorId, actor: by.email, action: decision === 'APPROVE' ? 'INVOICE_APPROVED' : 'INVOICE_REJECTED', detail: { po: po.poNumber, invoice: inv.invoiceNumber, ...(note ? { note } : {}) }, ip });
  if (decision === 'APPROVE') await queueMessage(po, 'INVOICE', { invoiceId: inv.id }, by.name).catch((err) => logger.error({ err }, 'could not queue invoice message'));
  const lang = await langForVendorId(inv.vendorId);
  const due = row.dueDate ? snippet(lang, 'invoiceDue', { date: lang === 'ar' ? mailDate(row.dueDate, lang) : row.dueDate }) : '';
  for (const r of await supplierRecipients(inv.vendorId)) {
    await mailSupplier(lang, { tenantId: tenant.id, to: r.email, link: supplierLink(tenant, `/vendor/invoices/${inv.id}`) }, decision === 'APPROVE' ? 'invoiceApproved' : 'invoiceRejected',
      { name: r.name, buyer: tenant.name, inv: inv.invoiceNumber, amount: `${inv.currency} ${inv.total}`, po: po.poNumber, due, reason: note }).catch(() => {});
  }
  return row;
}

export async function cancelInvoice(tenant: Tenant, inv: SupplierInvoice, by: { name: string; email?: string | null }, ip?: string) {
  const [row] = await db.update(supplierInvoices).set({ status: 'CANCELLED', decidedBy: by.name, decidedAt: new Date(), decisionNote: 'Withdrawn by the supplier' })
    .where(and(eq(supplierInvoices.id, inv.id), inArray(supplierInvoices.status, ['SUBMITTED', 'EXCEPTION']))).returning();
  if (!row) throw new HttpError(409, 'Only invoices still in review can be withdrawn');
  await audit({ tenantId: tenant.id, vendorId: inv.vendorId, actor: by.email ?? by.name, action: 'INVOICE_WITHDRAWN', detail: { invoice: inv.invoiceNumber }, ip });
  return row;
}

/* ---------- Read models ---------- */

export interface InvoiceFilter { tenantId: string; vendorId?: string; status?: string; q?: string; poId?: string; page?: number }
export async function listInvoices(f: InvoiceFilter) {
  const where = [eq(supplierInvoices.tenantId, f.tenantId)];
  if (f.vendorId) where.push(eq(supplierInvoices.vendorId, f.vendorId));
  if (f.poId) where.push(eq(supplierInvoices.poId, f.poId));
  if (f.status === 'REVIEW') where.push(inArray(supplierInvoices.status, ['SUBMITTED', 'EXCEPTION']));
  else if (f.status === 'UNPAID') where.push(inArray(supplierInvoices.status, ['APPROVED', 'PARTLY_PAID']));
  else if (f.status) where.push(eq(supplierInvoices.status, f.status));
  if (f.q) where.push(sql`(${supplierInvoices.invoiceNumber} ilike ${`%${f.q}%`} or ${purchaseOrders.poNumber} ilike ${`%${f.q}%`} or ${vendors.name} ilike ${`%${f.q}%`})`);
  const size = 50, page = Math.max(1, f.page ?? 1);
  const rows = await db.select({ i: supplierInvoices, poNumber: purchaseOrders.poNumber, vendorName: vendors.name, vendorCode: vendors.code }).from(supplierInvoices)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, supplierInvoices.poId)).innerJoin(vendors, eq(vendors.id, supplierInvoices.vendorId))
    .where(and(...where)).orderBy(desc(supplierInvoices.createdAt)).limit(size + 1).offset((page - 1) * size);
  return { rows: rows.slice(0, size).map((r) => ({ ...invoiceSummary(r.i), poNumber: r.poNumber, vendorName: r.vendorName, vendorCode: r.vendorCode })), hasMore: rows.length > size, page };
}

export async function invoiceCounts(tenantId: string, vendorId?: string) {
  const rows = await db.select({ status: supplierInvoices.status, n: sql<number>`count(*)` }).from(supplierInvoices)
    .where(and(eq(supplierInvoices.tenantId, tenantId), ...(vendorId ? [eq(supplierInvoices.vendorId, vendorId)] : []))).groupBy(supplierInvoices.status);
  const c = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  return { review: (c.SUBMITTED ?? 0) + (c.EXCEPTION ?? 0), exceptions: c.EXCEPTION ?? 0, unpaid: (c.APPROVED ?? 0) + (c.PARTLY_PAID ?? 0), paid: c.PAID ?? 0, rejected: c.REJECTED ?? 0, all: rows.reduce((t, r) => t + Number(r.n), 0) };
}

export const invoiceSummary = (i: SupplierInvoice) => ({
  id: i.id, invoiceNumber: i.invoiceNumber, invoiceDate: i.invoiceDate, currency: i.currency, subtotal: Number(i.subtotal), taxAmount: Number(i.taxAmount), total: Number(i.total),
  paidAmount: Number(i.paidAmount), status: i.status, dueDate: i.dueDate, poId: i.poId, shipmentId: i.shipmentId, createdAt: i.createdAt, decidedAt: i.decidedAt,
  warnings: i.checks.filter((c) => c.level === 'warning').length,
});

export async function invoiceDetail(tenantId: string, id: string, vendorId?: string) {
  const inv = await db.query.supplierInvoices.findFirst({ where: and(eq(supplierInvoices.tenantId, tenantId), eq(supplierInvoices.id, id), ...(vendorId ? [eq(supplierInvoices.vendorId, vendorId)] : [])) });
  if (!inv) throw new HttpError(404, 'Invoice not found');
  const [po, vendor, lines, ship, payments] = await Promise.all([
    db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, inv.poId), columns: { id: true, poNumber: true, currency: true, paymentTerms: true, buyerName: true } }),
    db.query.vendors.findFirst({ where: eq(vendors.id, inv.vendorId), columns: { id: true, name: true, code: true } }),
    db.select({ l: supplierInvoiceLines, lineNo: poLines.lineNo, itemCode: poLines.itemCode, description: poLines.description, uom: poLines.uom, poPrice: poLines.unitPrice, ordered: poLines.quantity, received: poLines.receivedQty })
      .from(supplierInvoiceLines).innerJoin(poLines, eq(poLines.id, supplierInvoiceLines.lineId)).where(eq(supplierInvoiceLines.invoiceId, id)).orderBy(asc(poLines.lineNo)),
    inv.shipmentId ? db.query.shipments.findFirst({ where: eq(shipments.id, inv.shipmentId), columns: { id: true, number: true } }) : undefined,
    db.select().from(supplierPayments).where(and(eq(supplierPayments.tenantId, tenantId), eq(supplierPayments.vendorId, inv.vendorId), sql`${supplierPayments.allocations} @> ${JSON.stringify([{ invoiceId: id }])}::jsonb`)).orderBy(desc(supplierPayments.paymentDate)),
  ]);
  const { signedQr: _q, ...einvoice } = inv.einvoice ?? {};
  return {
    invoice: { ...invoiceSummary(inv), checks: inv.checks, einvoice: inv.einvoice ? { ...einvoice, qr: !!inv.einvoice.signedQr } : null, notes: inv.notes, submittedBy: inv.submittedBy, decidedBy: inv.decidedBy, decisionNote: inv.decisionNote, erpInvoiceId: inv.erpInvoiceId, documentId: inv.documentId },
    po, vendor, shipment: ship ?? null,
    lines: lines.map((x) => ({ id: x.l.id, lineId: x.l.lineId, lineNo: x.lineNo, itemCode: x.itemCode, description: x.description, uom: x.uom, quantity: Number(x.l.quantity), unitPrice: Number(x.l.unitPrice), amount: Number(x.l.amount), taxRate: x.l.taxRate === null ? null : Number(x.l.taxRate), taxAmount: Number(x.l.taxAmount), poPrice: Number(x.poPrice), ordered: Number(x.ordered), received: Number(x.received) })),
    payments: payments.map((p) => ({ id: p.id, reference: p.reference, paymentDate: p.paymentDate, method: p.method, currency: p.currency, ...allocationFor(p, id) })),
  };
}

const allocationFor = (p: typeof supplierPayments.$inferSelect, invoiceId: string) => {
  const a = p.allocations.find((x) => x.invoiceId === invoiceId);
  return { amount: a?.amount ?? 0, withheld: a?.withheld ?? 0 };
};

/* ---------- Payments (remittances from the ERP) ---------- */

export interface PaymentInput {
  erpId: string; supplierCode: string; reference: string; paymentDate: string; method?: string | null; currency: string; amount: number; withheld?: number | null; notes?: string | null;
  invoices: { invoiceNumber: string; amount: number; withheld?: number | null }[];
}

export async function recordPayments(tenant: Tenant, items: PaymentInput[]) {
  const out = { created: 0, unchanged: 0, failed: 0, errors: [] as string[] };
  for (const [i, p] of items.entries()) {
    try {
      // Same lookup as purchase orders: a mapped supplier code, else the vendor's ERP id or vendor code.
      const vendorId = await matchVendor(tenant.id, [p.supplierCode.trim()]);
      const code = vendorId ? { vendorId } : null;
      if (!code) throw new Error(`supplier code ${p.supplierCode} isn’t linked to a vendor`);
      if (await db.query.supplierPayments.findFirst({ where: and(eq(supplierPayments.tenantId, tenant.id), eq(supplierPayments.erpId, p.erpId)), columns: { id: true } })) { out.unchanged++; continue; }
      const allocated = r2(p.invoices.reduce((t, x) => t + x.amount, 0));
      if (Math.abs(allocated - p.amount) > 0.01) throw new Error(`invoice amounts add up to ${allocated}, the payment is ${p.amount}`);
      const pay = await db.transaction(async (tx) => {
        const allocations: { invoiceId: string | null; invoiceNumber: string; amount: number; withheld?: number }[] = [];
        for (const a of p.invoices) {
          const [inv] = await tx.select().from(supplierInvoices).where(and(eq(supplierInvoices.tenantId, tenant.id), eq(supplierInvoices.vendorId, code.vendorId), sql`upper(${supplierInvoices.invoiceNumber}) = ${a.invoiceNumber.trim().toUpperCase()}`, notInArray(supplierInvoices.status, ['REJECTED', 'CANCELLED']))).for('update');
          allocations.push({ invoiceId: inv?.id ?? null, invoiceNumber: a.invoiceNumber.trim(), amount: a.amount, ...(a.withheld ? { withheld: a.withheld } : {}) });
          if (!inv) continue;
          const paid = r2(Number(inv.paidAmount) + a.amount + (a.withheld ?? 0));
          await tx.update(supplierInvoices).set({ paidAmount: String(paid), status: paid >= Number(inv.total) - 0.01 ? 'PAID' : 'PARTLY_PAID' }).where(eq(supplierInvoices.id, inv.id));
        }
        const [row] = await tx.insert(supplierPayments).values({ tenantId: tenant.id, vendorId: code.vendorId, erpId: p.erpId, reference: p.reference, paymentDate: p.paymentDate, method: p.method ?? null, currency: p.currency.toUpperCase(),
          amount: String(p.amount), withheld: String(p.withheld ?? r2(p.invoices.reduce((t, x) => t + (x.withheld ?? 0), 0))), notes: p.notes ?? null, allocations }).returning();
        return row;
      });
      out.created++;
      await audit({ tenantId: tenant.id, vendorId: code.vendorId, actor: 'API', action: 'PAYMENT_RECORDED', detail: { reference: p.reference, amount: `${pay.currency} ${pay.amount}`, invoices: p.invoices.length } });
      await notifyPayment(tenant, pay).catch((err) => logger.warn({ err }, 'remittance email failed'));
    } catch (e: any) { out.failed++; out.errors.push(`#${i + 1} (${p.erpId}): ${String(e?.message ?? e).slice(0, 300)}`); }
  }
  return out;
}

async function notifyPayment(tenant: Tenant, p: typeof supplierPayments.$inferSelect) {
  const fmt = (n: number) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const lang = await langForVendorId(p.vendorId);
  const lines = p.allocations.map((a) => snippet(lang, 'paymentLine', { inv: a.invoiceNumber, amount: `${p.currency} ${fmt(a.amount)}`, wh: a.withheld ? snippet(lang, 'paymentLineWithheld', { amount: fmt(a.withheld) }) : '' })).join('\n');
  for (const r of await supplierRecipients(p.vendorId)) {
    await mailSupplier(lang, { tenantId: tenant.id, to: r.email, link: supplierLink(tenant, '/vendor/payments') }, 'paymentAdvice', {
      name: r.name, buyer: tenant.name, amount: `${p.currency} ${fmt(Number(p.amount))}`, date: lang === 'ar' ? mailDate(p.paymentDate, lang) : p.paymentDate,
      method: p.method ? snippet(lang, 'paymentMethod', { method: p.method }) : '', ref: p.reference, lines,
      withheld: Number(p.withheld) ? snippet(lang, 'paymentWithheld', { amount: `${p.currency} ${fmt(Number(p.withheld))}` }) : '' });
  }
  await db.update(supplierPayments).set({ notifiedAt: new Date() }).where(eq(supplierPayments.id, p.id));
}

export async function listPayments(tenantId: string, vendorId?: string, page = 1) {
  const size = 50;
  const rows = await db.select({ p: supplierPayments, vendorName: vendors.name, vendorCode: vendors.code }).from(supplierPayments).innerJoin(vendors, eq(vendors.id, supplierPayments.vendorId))
    .where(and(eq(supplierPayments.tenantId, tenantId), ...(vendorId ? [eq(supplierPayments.vendorId, vendorId)] : []))).orderBy(desc(supplierPayments.paymentDate), desc(supplierPayments.createdAt)).limit(size + 1).offset((page - 1) * size);
  return { rows: rows.slice(0, size).map(({ p, vendorName, vendorCode }) => ({ id: p.id, reference: p.reference, paymentDate: p.paymentDate, method: p.method, currency: p.currency, amount: Number(p.amount), withheld: Number(p.withheld), notes: p.notes, allocations: p.allocations, vendorName, vendorCode })), hasMore: rows.length > size, page };
}
