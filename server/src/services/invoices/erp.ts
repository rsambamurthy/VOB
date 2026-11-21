/**
 * Invoices → ERP and back. One invoice message for every invoice, credit and debit note (portal or AP), built fresh at send
 * time and shaped per connector in services/orders/outbound.ts (Oracle: AP_INVOICES_INTERFACE + AP_INVOICE_LINES_INTERFACE,
 * SOURCE = VENDORGATE, then Payables Open Interface Import).
 *
 * Push: automatic on approval, or approved invoices wait as READY until AP sends them (pushMode). The ERP reports the import
 * result (invoice id, rejections, holds) through /api/v1/invoices/results.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../lib/db.js';
import type { SupplierInvoice, Tenant } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { queueMessage, queueStandaloneMessage } from '../orders/outbound.js';
import { APPROVED, norm, r2 } from './checks.js';
import { concatenatedAccount, invoiceRules, invoicesOn } from './config.js';
import type { By } from './record.js';

const { supplierInvoices, supplierInvoiceLines, poLines, purchaseOrders, parties, vendors, contracts, legalEntities } = schema;

/** What the ERP gets for an invoice (all amounts positive; connectors sign credit and debit notes as their ERP wants). */
export interface InvoiceMessage {
  id: string; kind: 'INVOICE' | 'CREDIT' | 'DEBIT'; invoiceNumber: string; invoiceDate: string; glDate: string | null; dueDate: string | null; currency: string;
  subtotal: number; taxAmount: number; total: number; description: string | null; irn: string | null; approvedBy: string | null;
  supplierCode: string; supplierSiteCode: string | null; supplierName: string; entity: string | null;
  poErpId: string | null; poNumber: string | null; revision: number | null; contractNumber: string | null; relatedInvoiceNumber: string | null; shipmentNumber: string | null;
  lines: { lineNo: number; poLineErpId: string | null; poLineNo: number | null; itemCode: string | null; description: string | null; uom: string | null; quantity: number; unitPrice: number; amount: number;
    taxRate: number | null; taxAmount: number; account: string | null; costCentre: string | null; project: string | null; task: string | null; distribution: string | null }[];
}

/** Build the message from the stored invoice (null when it can't be sent: no supplier code). */
export async function buildInvoiceMessage(invoiceId: string): Promise<InvoiceMessage | null> {
  const inv = await db.query.supplierInvoices.findFirst({ where: eq(supplierInvoices.id, invoiceId) });
  if (!inv) return null;
  const [t, lines, po, party, vendor, contract, related, ship] = await Promise.all([
    db.query.tenants.findFirst({ where: eq(schema.tenants.id, inv.tenantId) }),
    db.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, inv.id)).orderBy(supplierInvoiceLines.lineNo),
    inv.poId ? db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, inv.poId) }) : undefined,
    inv.partyId ? db.query.parties.findFirst({ where: eq(parties.id, inv.partyId) }) : undefined,
    inv.vendorId ? db.query.vendors.findFirst({ where: eq(vendors.id, inv.vendorId), columns: { id: true, name: true, code: true, erpVendorId: true } }) : undefined,
    inv.contractId ? db.query.contracts.findFirst({ where: eq(contracts.id, inv.contractId), columns: { number: true } }) : undefined,
    inv.relatedInvoiceId ? db.query.supplierInvoices.findFirst({ where: eq(supplierInvoices.id, inv.relatedInvoiceId), columns: { invoiceNumber: true, poId: true } }) : undefined,
    inv.shipmentId ? db.query.shipments.findFirst({ where: eq(schema.shipments.id, inv.shipmentId), columns: { number: true } }) : undefined,
  ]);
  if (!t) return null;
  const relPo = !po && related?.poId ? await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, related.poId) }) : undefined;
  const thePo = po ?? relPo;
  const poL = thePo ? await db.select().from(poLines).where(eq(poLines.poId, thePo.id)) : [];
  const entity = inv.entityCode ?? (thePo?.entityId ? (await db.query.legalEntities.findFirst({ where: eq(legalEntities.id, thePo.entityId) }))?.code ?? null : null);
  const supplierCode = thePo?.supplierCode ?? party?.ap?.erpSupplierCode ?? vendor?.erpVendorId ?? vendor?.code ?? party?.code;
  if (!supplierCode) return null;
  const n = (s: string | null) => (s === null ? null : Number(s));
  return {
    id: inv.id, kind: inv.kind as InvoiceMessage['kind'], invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate, glDate: inv.glDate, dueDate: inv.dueDate, currency: inv.currency,
    subtotal: Number(inv.subtotal), taxAmount: Number(inv.taxAmount), total: Number(inv.total), description: inv.description, irn: inv.einvoice?.irn ?? null, approvedBy: inv.decidedBy,
    supplierCode, supplierSiteCode: thePo?.supplierSiteCode ?? party?.ap?.erpSiteCode ?? null, supplierName: party?.name ?? vendor?.name ?? supplierCode, entity,
    poErpId: thePo?.erpId ?? null, poNumber: thePo?.poNumber ?? null, revision: thePo?.revision ?? null, contractNumber: contract?.number ?? null,
    relatedInvoiceNumber: related?.invoiceNumber ?? null, shipmentNumber: ship?.number ?? null,
    lines: lines.map((l, i) => {
      const pl = l.lineId ? poL.find((x) => x.id === l.lineId) : undefined;
      return { lineNo: l.lineNo ?? i + 1, poLineErpId: pl?.erpId ?? null, poLineNo: pl?.lineNo ?? null, itemCode: l.itemCode ?? pl?.itemCode ?? null, description: l.description ?? pl?.description ?? null,
        uom: l.uom ?? pl?.uom ?? null, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), amount: Number(l.amount), taxRate: n(l.taxRate), taxAmount: Number(l.taxAmount),
        account: l.glAccount, costCentre: l.costCentre, project: l.project, task: l.task,
        distribution: pl ? null : concatenatedAccount(t, { entity, costCentre: l.costCentre, account: l.glAccount, project: l.project }) };
    }),
  };
}

/* ---------------- shapes per connector (used by outbound.ts) ---------------- */

const sign = (m: InvoiceMessage) => (m.kind === 'INVOICE' ? 1 : -1);

/** Oracle Payables Open Interface: AP_INVOICES_INTERFACE + AP_INVOICE_LINES_INTERFACE. */
export function oracleInvoice(m: InvoiceMessage) {
  const s = sign(m);
  return {
    INVOICE_NUM: m.invoiceNumber, INVOICE_TYPE_LOOKUP_CODE: m.kind === 'INVOICE' ? 'STANDARD' : m.kind, INVOICE_DATE: m.invoiceDate, GL_DATE: m.glDate ?? undefined,
    VENDOR_NUM: m.supplierCode, VENDOR_SITE_CODE: m.supplierSiteCode ?? undefined, INVOICE_AMOUNT: r2(s * m.total), INVOICE_CURRENCY_CODE: m.currency,
    PO_NUMBER: m.poNumber ?? undefined, ORG_ID: m.entity ?? undefined, SOURCE: 'VENDORGATE', TERMS_DATE: m.invoiceDate,
    DESCRIPTION: [m.description, m.irn ? `IRN ${m.irn}` : null, m.relatedInvoiceNumber ? `For invoice ${m.relatedInvoiceNumber}` : null, m.contractNumber ? `Contract ${m.contractNumber}` : null].filter(Boolean).join(' · ').slice(0, 240) || undefined,
    ATTRIBUTE1: m.id,
    LINES: [
      ...m.lines.map((l, i) => ({
        LINE_NUMBER: i + 1, LINE_TYPE_LOOKUP_CODE: 'ITEM', AMOUNT: r2(s * l.amount), QUANTITY_INVOICED: s * l.quantity, UNIT_PRICE: l.unitPrice, DESCRIPTION: l.description?.slice(0, 240) ?? undefined,
        ...(l.poLineErpId ? { PO_HEADER_ID: m.poErpId, PO_LINE_ID: l.poLineErpId, PO_NUMBER: m.poNumber, PO_LINE_NUMBER: l.poLineNo }
          : { DIST_CODE_CONCATENATED: l.distribution ?? undefined, ...(l.project ? { PROJECT: l.project, TASK: l.task ?? undefined } : {}) }),
      })),
      ...(m.taxAmount ? [{ LINE_NUMBER: m.lines.length + 1, LINE_TYPE_LOOKUP_CODE: 'TAX', AMOUNT: r2(s * m.taxAmount) }] : []),
    ],
  };
}

/** The connector-neutral event (webhook, SAP / Dynamics middleware). */
export function invoiceEvent(m: InvoiceMessage) {
  return {
    id: m.id, kind: m.kind, invoiceNumber: m.invoiceNumber, invoiceDate: m.invoiceDate, glDate: m.glDate, dueDate: m.dueDate, currency: m.currency, subtotal: m.subtotal, taxAmount: m.taxAmount, total: m.total,
    description: m.description, irn: m.irn, approvedBy: m.approvedBy, shipmentNumber: m.shipmentNumber, contractNumber: m.contractNumber, relatedInvoiceNumber: m.relatedInvoiceNumber,
    poErpId: m.poErpId, poNumber: m.poNumber, revision: m.revision, supplierCode: m.supplierCode, supplierSiteCode: m.supplierSiteCode, entity: m.entity,
    lines: m.lines.map((l) => ({ poLineErpId: l.poLineErpId, lineNo: l.poLineNo ?? l.lineNo, itemCode: l.itemCode, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount,
      taxRate: l.taxRate, taxAmount: l.taxAmount, account: l.account, costCentre: l.costCentre, project: l.project, task: l.task, distribution: l.distribution })),
  };
}

export const INVOICE_CSV_HEADER = ['TYPE', 'INVOICE_NUMBER', 'INVOICE_DATE', 'SUPPLIER_CODE', 'CURRENCY', 'INVOICE_TOTAL', 'TAX_TOTAL', 'PO_NUMBER', 'ERP_PO_ID', 'LINE_NUM', 'ERP_LINE_ID', 'QUANTITY', 'UNIT_PRICE', 'AMOUNT', 'TAX_RATE', 'TAX_AMOUNT', 'ACCOUNT', 'DUE_DATE', 'RELATED_INVOICE'];
export function invoiceCsvRows(m: InvoiceMessage) {
  return m.lines.map((l) => [m.kind, m.invoiceNumber, m.invoiceDate, m.supplierCode, m.currency, String(m.total), String(m.taxAmount), m.poNumber ?? '', m.poErpId ?? '', String(l.poLineNo ?? l.lineNo), l.poLineErpId ?? '',
    String(l.quantity), String(l.unitPrice), String(l.amount), l.taxRate === null ? '' : String(l.taxRate), String(l.taxAmount), l.distribution ?? '', m.dueDate ?? '', m.relatedInvoiceNumber ?? '']);
}

/* ---------------- push ---------------- */

/** After approval: the ERP (now, or READY for AP), the supplier's email, a debit note's email. */
export async function afterApproved(t: Tenant, inv: SupplierInvoice, by: By) {
  const { tellSupplier, emailDebitNote } = await import('./notify.js');
  let row = inv;
  if (!invoicesOn(t)) {
    // Without the add-on: portal PO invoices go to the ERP at once, as before.
    const po = inv.poId ? await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, inv.poId) }) : undefined;
    if (po) await queueMessage(po, 'INVOICE', { invoiceId: inv.id }, by.name).catch((err) => logger.error({ err }, 'could not queue invoice message'));
  } else if (invoiceRules(t).pushMode === 'automatic') row = (await pushToErp(t, [inv.id], by, { auto: true }))[0] ?? inv;
  else [row] = await db.update(supplierInvoices).set({ erpStatus: 'READY', erpError: null }).where(eq(supplierInvoices.id, inv.id)).returning();
  if (inv.source === 'PORTAL') await tellSupplier(t, row, 'APPROVED', inv.decisionNote).catch((err) => logger.warn({ err }, 'invoice email failed'));
  if (inv.kind === 'DEBIT' && invoiceRules(t).debitNoteEmail === 'auto') await emailDebitNote(t, row, by).catch((err) => logger.warn({ err }, 'debit note email failed'));
  return row;
}

/** Send approved invoices to the ERP (manual push, or automatic on approval). Returns the updated rows. */
export async function pushToErp(t: Tenant, ids: string[], by: By, opts: { auto?: boolean } = {}) {
  if (!ids.length) throw new HttpError(400, 'Choose the invoices to send');
  const rows = await db.select().from(supplierInvoices).where(and(eq(supplierInvoices.tenantId, t.id), inArray(supplierInvoices.id, ids)));
  if (rows.length !== new Set(ids).size) throw new HttpError(404, 'Invoice not found');
  const out: SupplierInvoice[] = [];
  for (const inv of rows) {
    if (!APPROVED.includes(inv.status)) throw new HttpError(409, `${inv.invoiceNumber} isn’t approved`);
    if (inv.erpStatus === 'SENT' || inv.erpStatus === 'IMPORTED') throw new HttpError(409, `${inv.invoiceNumber} has already been sent to the ERP`);
    const po = inv.poId ? await db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, inv.poId) }) : undefined;
    const m = po ? await queueMessage(po, 'INVOICE', { invoiceId: inv.id }, by.name)
      : await queueStandaloneMessage(t.id, 'INVOICE', { vendorId: inv.vendorId ?? undefined, contractId: inv.contractId ?? undefined }, { invoiceId: inv.id }, by.name);
    const none = m.status === 'NO_CONNECTOR';
    const [row] = await db.update(supplierInvoices).set(none ? { erpStatus: 'READY', erpError: 'No ERP connection is set up; nothing was sent.' } : { erpStatus: 'SENT', erpError: null, erpSentAt: new Date() })
      .where(eq(supplierInvoices.id, inv.id)).returning();
    await audit({ tenantId: t.id, vendorId: inv.vendorId, actor: by.name, action: 'INVOICE_SENT_TO_ERP', detail: { subjectId: inv.id, invoice: inv.invoiceNumber, auto: !!opts.auto, connector: m.connector, ...(none ? { error: 'no connector' } : {}) }, ip: by.ip });
    out.push(row);
  }
  return out;
}

/* ---------------- results from the ERP ---------------- */

export const resultInput = z.object({
  /** VendorGate's invoice id (sent as ATTRIBUTE1 / `id`), or the invoice number with the supplier code. */
  id: z.string().trim().max(60).optional(), invoiceNumber: z.string().trim().max(60).optional(), supplierCode: z.string().trim().max(100).optional(),
  status: z.enum(['IMPORTED', 'REJECTED']),
  erpInvoiceId: z.string().trim().max(100).optional(),
  reasons: z.array(z.string().trim().max(300)).max(20).default([]),
  holds: z.array(z.object({ code: z.string().trim().max(60), reason: z.string().trim().max(300).optional() })).max(20).default([]),
}).refine((x) => x.id || (x.invoiceNumber && x.supplierCode), 'Send the invoice id, or the invoice number and supplier code');

/** Oracle import results (AP_INVOICES_ALL, AP_INTERFACE_REJECTIONS, AP_HOLDS_ALL) → IMPORTED or FAILED with the reason. */
export async function recordErpResults(t: Tenant, items: z.output<typeof resultInput>[]) {
  const out = { updated: 0, notFound: 0, errors: [] as string[] };
  for (const [i, r] of items.entries()) {
    let inv = r.id ? await db.query.supplierInvoices.findFirst({ where: and(eq(supplierInvoices.tenantId, t.id), eq(supplierInvoices.id, r.id)) }) : undefined;
    if (!inv && r.invoiceNumber && r.supplierCode) inv = await findBySupplierCode(t, r.invoiceNumber, r.supplierCode);
    if (!inv) { out.notFound++; out.errors.push(`#${i + 1}: no invoice ${r.id ?? `${r.invoiceNumber} from ${r.supplierCode}`}`); continue; }
    const set = r.status === 'IMPORTED'
      ? { erpStatus: 'IMPORTED', erpInvoiceId: r.erpInvoiceId ?? inv.erpInvoiceId, erpError: null, erpHolds: r.holds.length ? r.holds : null }
      : { erpStatus: 'FAILED', erpError: (r.reasons.join('; ') || 'Rejected by the ERP import').slice(0, 1000), erpHolds: null };
    await db.update(supplierInvoices).set(set).where(eq(supplierInvoices.id, inv.id));
    await audit({ tenantId: t.id, vendorId: inv.vendorId, actor: 'API', action: r.status === 'IMPORTED' ? 'INVOICE_IMPORTED_IN_ERP' : 'INVOICE_ERP_IMPORT_FAILED', detail: { subjectId: inv.id, invoice: inv.invoiceNumber, ...(r.erpInvoiceId ? { erpInvoiceId: r.erpInvoiceId } : {}), ...(r.reasons.length ? { reasons: r.reasons } : {}), ...(r.holds.length ? { holds: r.holds.map((h) => h.code) } : {}) } });
    out.updated++;
  }
  return out;
}

async function findBySupplierCode(t: Tenant, number: string, supplierCode: string) {
  const wanted = norm(number);
  const cands = await db.select().from(supplierInvoices).where(and(eq(supplierInvoices.tenantId, t.id), inArray(supplierInvoices.status, [...APPROVED]),
    sql`upper(regexp_replace(${supplierInvoices.invoiceNumber}, '[[:space:]]', '', 'g')) = ${wanted}`)).limit(20);
  for (const inv of cands) {
    const m = await buildInvoiceMessage(inv.id);
    if (m && norm(m.supplierCode) === norm(supplierCode)) return inv;
  }
  return undefined;
}
