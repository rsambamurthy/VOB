/**
 * Read models for invoices — one list, counts and detail for the supplier portal (own invoices only), the purchasing screens
 * and the Invoices add-on screens.
 */
import { and, asc, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import type { SupplierInvoice } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { basisOf } from './record.js';
import { BASIS_LABEL } from './config.js';

const { supplierInvoices, supplierInvoiceLines, poLines, purchaseOrders, vendors, parties, contracts, supplierPayments, poMessages } = schema;

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft', SUBMITTED: 'Submitted', EXCEPTION: 'Exception', IN_APPROVAL: 'In approval', APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Cancelled', PARTLY_PAID: 'Partly paid', PAID: 'Paid',
};
export const ERP_LABEL: Record<string, string> = { READY: 'Ready for ERP', SENT: 'Sent to ERP', IMPORTED: 'Imported', FAILED: 'Import failed' };
/** Tabs: groups of statuses the screens filter by. */
export const TABS = ['DRAFT', 'REVIEW', 'EXCEPTION', 'IN_APPROVAL', 'READY', 'FAILED', 'UNPAID', 'OVERDUE', 'PAID', 'REJECTED', 'SUBMITTED', 'APPROVED', 'CANCELLED', 'PARTLY_PAID'] as const;
export type Tab = typeof TABS[number];

export interface InvoiceFilter { tenantId: string; vendorId?: string; partyId?: string; poId?: string; contractId?: string; status?: Tab; kind?: string; basis?: string; q?: string; page?: number; pageSize?: number; portal?: boolean }

const today = () => new Date().toISOString().slice(0, 10);
function where(f: InvoiceFilter): SQL[] {
  const w: SQL[] = [eq(supplierInvoices.tenantId, f.tenantId)];
  if (f.vendorId) w.push(eq(supplierInvoices.vendorId, f.vendorId));
  // The supplier sees their own submitted invoices, never AP drafts.
  if (f.portal) w.push(sql`${supplierInvoices.status} <> 'DRAFT'`, eq(supplierInvoices.kind, 'INVOICE'));
  if (f.partyId) w.push(eq(supplierInvoices.partyId, f.partyId));
  if (f.poId) w.push(eq(supplierInvoices.poId, f.poId));
  if (f.contractId) w.push(eq(supplierInvoices.contractId, f.contractId));
  if (f.kind) w.push(eq(supplierInvoices.kind, f.kind));
  if (f.basis === 'po') w.push(sql`${supplierInvoices.poId} is not null`);
  if (f.basis === 'contract') w.push(sql`${supplierInvoices.poId} is null and ${supplierInvoices.contractId} is not null`);
  if (f.basis === 'nonPo') w.push(sql`${supplierInvoices.poId} is null and ${supplierInvoices.contractId} is null`);
  const s = f.status;
  if (s === 'REVIEW') w.push(inArray(supplierInvoices.status, ['SUBMITTED', 'EXCEPTION', 'IN_APPROVAL']));
  else if (s === 'UNPAID') w.push(inArray(supplierInvoices.status, ['APPROVED', 'PARTLY_PAID']));
  else if (s === 'OVERDUE') w.push(inArray(supplierInvoices.status, ['APPROVED', 'PARTLY_PAID']), lt(supplierInvoices.dueDate, today()));
  else if (s === 'READY' || s === 'FAILED') w.push(eq(supplierInvoices.erpStatus, s));
  else if (s) w.push(eq(supplierInvoices.status, s));
  if (f.q) w.push(sql`(${supplierInvoices.invoiceNumber} ilike ${`%${f.q}%`} or ${purchaseOrders.poNumber} ilike ${`%${f.q}%`} or ${vendors.name} ilike ${`%${f.q}%`} or ${parties.name} ilike ${`%${f.q}%`} or ${parties.code} ilike ${`%${f.q}%`})`);
  return w;
}

export async function listInvoices(f: InvoiceFilter) {
  const size = Math.min(200, Math.max(1, f.pageSize ?? 50)), page = Math.max(1, f.page ?? 1);
  const rows = await db.select({ i: supplierInvoices, poNumber: purchaseOrders.poNumber, vendorName: vendors.name, vendorCode: vendors.code, partyName: parties.name, partyCode: parties.code, contractNumber: contracts.number }).from(supplierInvoices)
    .leftJoin(purchaseOrders, eq(purchaseOrders.id, supplierInvoices.poId)).leftJoin(vendors, eq(vendors.id, supplierInvoices.vendorId))
    .leftJoin(parties, eq(parties.id, supplierInvoices.partyId)).leftJoin(contracts, eq(contracts.id, supplierInvoices.contractId))
    .where(and(...where(f))).orderBy(desc(supplierInvoices.createdAt), desc(supplierInvoices.id)).limit(size + 1).offset((page - 1) * size);
  return {
    rows: rows.slice(0, size).map((r) => ({ ...invoiceSummary(r.i), poNumber: r.poNumber, contractNumber: r.contractNumber,
      vendorName: r.vendorName ?? r.partyName, vendorCode: r.vendorCode ?? r.partyCode, partyName: r.partyName ?? r.vendorName, partyCode: r.partyCode ?? r.vendorCode })),
    hasMore: rows.length > size, page,
  };
}

export async function invoiceCounts(tenantId: string, vendorId?: string, opts: { portal?: boolean } = {}) {
  const rows = await db.select({ status: supplierInvoices.status, erp: supplierInvoices.erpStatus, n: sql<number>`count(*)::int`, overdue: sql<number>`count(*) filter (where ${supplierInvoices.dueDate} < ${today()})::int` }).from(supplierInvoices)
    .where(and(eq(supplierInvoices.tenantId, tenantId), ...(vendorId ? [eq(supplierInvoices.vendorId, vendorId)] : []), ...(opts.portal ? [sql`${supplierInvoices.status} <> 'DRAFT'`, eq(supplierInvoices.kind, 'INVOICE')] : [])))
    .groupBy(supplierInvoices.status, supplierInvoices.erpStatus);
  const sum = (pred: (r: typeof rows[number]) => boolean, k: 'n' | 'overdue' = 'n') => rows.filter(pred).reduce((t, r) => t + Number(r[k]), 0);
  const unpaid = (r: typeof rows[number]) => r.status === 'APPROVED' || r.status === 'PARTLY_PAID';
  return {
    drafts: sum((r) => r.status === 'DRAFT'), review: sum((r) => ['SUBMITTED', 'EXCEPTION', 'IN_APPROVAL'].includes(r.status)), exceptions: sum((r) => r.status === 'EXCEPTION'),
    inApproval: sum((r) => r.status === 'IN_APPROVAL'), ready: sum((r) => r.erp === 'READY'), failed: sum((r) => r.erp === 'FAILED'),
    unpaid: sum(unpaid), overdue: sum(unpaid, 'overdue'), paid: sum((r) => r.status === 'PAID'), rejected: sum((r) => r.status === 'REJECTED'), all: sum(() => true),
  };
}

export const invoiceSummary = (i: SupplierInvoice) => ({
  id: i.id, kind: i.kind, invoiceNumber: i.invoiceNumber, invoiceDate: i.invoiceDate, currency: i.currency, subtotal: Number(i.subtotal), taxAmount: Number(i.taxAmount), total: Number(i.total),
  paidAmount: Number(i.paidAmount), status: i.status, statusLabel: STATUS_LABEL[i.status] ?? i.status, erpStatus: i.erpStatus, erpLabel: i.erpStatus ? ERP_LABEL[i.erpStatus] ?? i.erpStatus : null,
  dueDate: i.dueDate, poId: i.poId, contractId: i.contractId, partyId: i.partyId, shipmentId: i.shipmentId, source: i.source, basis: basisOf(i), basisLabel: BASIS_LABEL[basisOf(i)],
  createdAt: i.createdAt, decidedAt: i.decidedAt, warnings: i.checks.filter((c) => c.level === 'warning').length, errors: i.checks.filter((c) => c.level === 'error').length,
});

/** One invoice. `vendorId` limits it to the supplier's own (portal). */
export async function invoiceDetail(tenantId: string, id: string, vendorId?: string) {
  const inv = await db.query.supplierInvoices.findFirst({ where: and(eq(supplierInvoices.tenantId, tenantId), eq(supplierInvoices.id, id), ...(vendorId ? [eq(supplierInvoices.vendorId, vendorId), sql`${supplierInvoices.status} <> 'DRAFT'`] : [])) });
  if (!inv) throw new HttpError(404, 'Invoice not found');
  const [po, vendor, party, contract, lines, ship, payments, related, notes] = await Promise.all([
    inv.poId ? db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, inv.poId), columns: { id: true, poNumber: true, currency: true, paymentTerms: true, buyerName: true } }) : undefined,
    inv.vendorId ? db.query.vendors.findFirst({ where: eq(vendors.id, inv.vendorId), columns: { id: true, name: true, code: true } }) : undefined,
    inv.partyId ? db.query.parties.findFirst({ where: eq(parties.id, inv.partyId), columns: { id: true, name: true, code: true, ap: true, taxNo: true } }) : undefined,
    inv.contractId ? db.query.contracts.findFirst({ where: eq(contracts.id, inv.contractId), columns: { id: true, number: true, title: true, value: true, currency: true } }) : undefined,
    db.select({ l: supplierInvoiceLines, lineNo: poLines.lineNo, itemCode: poLines.itemCode, description: poLines.description, uom: poLines.uom, poPrice: poLines.unitPrice, ordered: poLines.quantity, received: poLines.receivedQty })
      .from(supplierInvoiceLines).leftJoin(poLines, eq(poLines.id, supplierInvoiceLines.lineId)).where(eq(supplierInvoiceLines.invoiceId, id)).orderBy(asc(supplierInvoiceLines.lineNo), asc(poLines.lineNo)),
    inv.shipmentId ? db.query.shipments.findFirst({ where: eq(schema.shipments.id, inv.shipmentId), columns: { id: true, number: true } }) : undefined,
    db.select().from(supplierPayments).where(and(eq(supplierPayments.tenantId, tenantId), sql`${supplierPayments.allocations} @> ${JSON.stringify([{ invoiceId: id }])}::jsonb`)).orderBy(desc(supplierPayments.paymentDate)),
    inv.relatedInvoiceId ? db.query.supplierInvoices.findFirst({ where: eq(supplierInvoices.id, inv.relatedInvoiceId), columns: { id: true, invoiceNumber: true, invoiceDate: true, total: true, status: true } }) : undefined,
    db.select({ id: supplierInvoices.id, kind: supplierInvoices.kind, invoiceNumber: supplierInvoices.invoiceNumber, total: supplierInvoices.total, status: supplierInvoices.status }).from(supplierInvoices)
      .where(and(eq(supplierInvoices.relatedInvoiceId, id), ...(vendorId ? [eq(supplierInvoices.kind, 'CREDIT'), sql`${supplierInvoices.status} <> 'DRAFT'`] : []))),
  ]);
  const { signedQr: _q, ...einvoice } = inv.einvoice ?? {};
  const live = notes.filter((n) => !['DRAFT', 'REJECTED', 'CANCELLED'].includes(n.status));
  const credits = live.filter((n) => n.kind === 'CREDIT').reduce((t, n) => t + Number(n.total), 0);
  const debits = live.filter((n) => n.kind === 'DEBIT').reduce((t, n) => t + Number(n.total), 0);
  return {
    invoice: { ...invoiceSummary(inv), checks: inv.checks, einvoice: inv.einvoice ? { ...einvoice, qr: !!inv.einvoice.signedQr } : null, notes: inv.notes, description: inv.description, submittedBy: inv.submittedBy,
      decidedBy: inv.decidedBy, decisionNote: inv.decisionNote, erpInvoiceId: inv.erpInvoiceId, erpError: inv.erpError, erpHolds: inv.erpHolds, erpSentAt: inv.erpSentAt, emailedAt: inv.emailedAt,
      documentId: inv.documentId, entityCode: inv.entityCode, glDate: inv.glDate, createdById: inv.createdById, relatedInvoiceId: inv.relatedInvoiceId,
      netPayable: inv.kind === 'INVOICE' ? Math.round((Number(inv.total) - credits - debits) * 100) / 100 : null },
    po: po ?? null, vendor: vendor ?? (party ? { id: null, name: party.name, code: party.code } : null), party: party ?? null, contract: contract ?? null, shipment: ship ?? null, related: related ?? null,
    notesOnIt: notes.map((n) => ({ ...n, total: Number(n.total) })),
    lines: lines.map((x) => ({ id: x.l.id, lineId: x.l.lineId, lineNo: x.lineNo ?? x.l.lineNo, itemCode: x.l.itemCode ?? x.itemCode, description: x.l.description ?? x.description, uom: x.l.uom ?? x.uom, hsn: x.l.hsn,
      quantity: Number(x.l.quantity), unitPrice: Number(x.l.unitPrice), amount: Number(x.l.amount), taxRate: x.l.taxRate === null ? null : Number(x.l.taxRate), taxAmount: Number(x.l.taxAmount),
      poPrice: x.poPrice === null ? null : Number(x.poPrice), ordered: x.ordered === null ? null : Number(x.ordered), received: x.received === null ? null : Number(x.received),
      glAccount: x.l.glAccount, costCentre: x.l.costCentre, project: x.l.project, task: x.l.task })),
    payments: payments.map((p) => ({ id: p.id, reference: p.reference, paymentDate: p.paymentDate, method: p.method, currency: p.currency, ...allocationFor(p, id) })),
  };
}

const allocationFor = (p: typeof supplierPayments.$inferSelect, invoiceId: string) => {
  const a = p.allocations.find((x) => x.invoiceId === invoiceId);
  return { amount: a?.amount ?? 0, withheld: a?.withheld ?? 0 };
};

/** ERP messages about one invoice (order invoices and standalone ones). */
export const invoiceMessages = (tenantId: string, id: string) => db.select({ id: poMessages.id, status: poMessages.status, connector: poMessages.connector, error: poMessages.error, sentAt: poMessages.sentAt, createdAt: poMessages.createdAt, target: poMessages.target })
  .from(poMessages).where(and(eq(poMessages.tenantId, tenantId), eq(poMessages.kind, 'INVOICE'), sql`${poMessages.payload}->>'invoiceId' = ${id}`)).orderBy(desc(poMessages.createdAt)).limit(20);

