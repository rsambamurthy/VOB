/**
 * Supplier-portal invoices against purchase orders, and payments back from the ERP.
 *
 * The checks, lifecycle and read models are the shared invoice service (services/invoices): this file only adds what the
 * portal needs — a supplier submits against one of their orders, and the buyer is told. With the Invoices add-on the same
 * invoice then goes through the approval matrix, touchless processing and the ERP push setting; without it, it waits for
 * one decision and goes to the ERP on approval, as before.
 */
import { and, eq, notInArray, sql } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { sendMail } from '../../lib/mailer.js';
import { env } from '../../lib/env.js';
import type { PurchaseOrder, SupplierInvoice, Tenant, Vendor } from '../../db/schema.js';
import { supplierLink, supplierRecipients, matchVendor } from '../orders/importer.js';
import { usersWithPermission } from '../approvers.js';
import { langForVendorId, mailDate, mailSupplier, snippet } from '../../i18n/emails.js';
import { checkInvoice, dueDateFrom, r2, r4, termDays, type CheckInput, type EInvoiceInput } from '../invoices/checks.js';
import { invoicesOn } from '../invoices/config.js';
import { cancelInvoice as cancelShared, decideInvoice as decideShared, partyOfVendor, routeInvoice, subjectFor } from '../invoices/record.js';

export { LIVE, decodeSignedQr, einvoiceChecks, termDays, invoiceableLines, type Check, type InvoiceableLine, type EInvoiceInput } from '../invoices/checks.js';
export { listInvoices, invoiceCounts, invoiceDetail, invoiceSummary, type InvoiceFilter } from '../invoices/views.js';

const { supplierInvoices, supplierInvoiceLines, supplierPayments, vendors, parties } = schema;

export interface InvoiceInput {
  invoiceNumber: string; invoiceDate: string; shipmentId?: string | null; currency?: string; total: number; notes?: string | null; documentId?: string | null;
  lines: { lineId: string; quantity: number; unitPrice: number; taxRate?: number | null; taxAmount?: number | null }[];
  einvoice?: EInvoiceInput | null;
}

/** The checks for a portal invoice (the "Check" button and submit). */
export async function matchInvoice(tenant: Tenant, po: PurchaseOrder, vendor: Vendor, input: InvoiceInput, excludeInvoiceId?: string) {
  const s = await subjectFor(tenant, { poId: po.id, contractId: null, partyId: null, vendorId: vendor.id }, excludeInvoiceId);
  return checkInvoice(s, { ...input, kind: 'INVOICE' } as CheckInput);
}

export async function submitInvoice(tenant: Tenant, po: PurchaseOrder, vendor: Vendor, input: InvoiceInput, by: { name: string; email?: string | null }, ip?: string) {
  if (po.status === 'CANCELLED') throw new HttpError(409, 'This purchase order is cancelled');
  if (po.vendorId !== vendor.id) throw new HttpError(404, 'Purchase order not found');
  // With the Invoices add-on every invoice belongs to the supplier's party (one supplier list for AP and contracts).
  const party = invoicesOn(tenant) ? await partyOfVendor(tenant, vendor.id, { name: 'VendorGate' }) : null;
  const inv = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`inv:${vendor.id}`}))`);
    const m = await matchInvoice(tenant, po, vendor, input);
    const errors = m.checks.filter((c) => c.level === 'error');
    if (errors.length) throw new HttpError(422, errors.map((e) => e.message).join('. '), { checks: m.checks }, 'INVOICE_CHECKS');
    const flagged = m.checks.some((c) => c.level === 'warning');
    const [row] = await tx.insert(supplierInvoices).values({
      tenantId: tenant.id, vendorId: vendor.id, partyId: party?.id ?? null, poId: po.id, shipmentId: input.shipmentId || null, invoiceNumber: input.invoiceNumber.trim(), invoiceDate: input.invoiceDate,
      currency: m.currency, subtotal: String(m.subtotal), taxAmount: String(m.tax), total: String(m.total), status: flagged ? 'EXCEPTION' : 'SUBMITTED', checks: m.checks, source: 'PORTAL',
      einvoice: input.einvoice && (input.einvoice.irn || input.einvoice.signedQr) ? Object.fromEntries(Object.entries({ irn: input.einvoice.irn?.trim().toLowerCase(), ackNo: input.einvoice.ackNo?.trim(), ackDate: input.einvoice.ackDate?.trim(), signedQr: input.einvoice.signedQr?.trim() }).filter(([, v]) => v)) as Record<string, string> : null,
      documentId: input.documentId ?? null, notes: input.notes?.trim() || null, submittedBy: by.email ? `${by.name} <${by.email}>` : by.name,
      dueDate: dueDateFrom(input.invoiceDate, termDays(po.paymentTerms)),
    }).returning();
    await tx.insert(supplierInvoiceLines).values(m.lines.map((l, i) => ({ tenantId: tenant.id, invoiceId: row.id, lineId: l.lineId ?? null, lineNo: i + 1, itemCode: l.itemCode ?? null, description: l.description ?? null, uom: l.uom ?? null, hsn: l.hsn ?? null,
      quantity: String(r4(l.quantity)), unitPrice: String(l.unitPrice), amount: String(l.amount), taxRate: String(l.taxRate), taxAmount: String(l.taxAmount) })));
    return row;
  });
  await audit({ tenantId: tenant.id, vendorId: vendor.id, actor: by.email ?? by.name, action: 'INVOICE_SUBMITTED', detail: { subjectId: inv.id, po: po.poNumber, invoice: inv.invoiceNumber, total: `${inv.currency} ${inv.total}`, ...(inv.status === 'EXCEPTION' ? { exception: inv.checks.filter((c) => c.level === 'warning').map((c) => c.code).join(', ') } : {}) }, ip });
  const routed = await routeInvoice(tenant, inv, { name: by.name, email: by.email, ip });
  if (routed.status === 'SUBMITTED' || routed.status === 'EXCEPTION') {
    const to = new Set<string>([po.buyerEmail ?? '', ...(await usersWithPermission(tenant.id, 'invoices.manage')).map((u) => u.email)].filter(Boolean));
    const link = invoicesOn(tenant) ? `${env.appBaseUrl}/staff/ap/invoices/${inv.id}` : `${env.appBaseUrl}/staff/invoices/${inv.id}`;
    for (const email of to) {
      await sendMail({ tenantId: tenant.id, to: email, subject: `${inv.status === 'EXCEPTION' ? 'Invoice needs review' : 'Invoice received'}: ${vendor.name} ${inv.invoiceNumber}`,
        body: `${vendor.name} submitted invoice ${inv.invoiceNumber} for ${inv.currency} ${Number(inv.total).toLocaleString('en-IN', { minimumFractionDigits: 2 })} against ${po.poNumber}.${inv.status === 'EXCEPTION' ? `\n\nIt doesn’t match cleanly:\n${inv.checks.filter((c) => c.level === 'warning').map((c) => `- ${c.message}`).join('\n')}` : ''}`,
        link }).catch(() => {});
    }
  }
  return routed;
}

export const decideInvoice = (tenant: Tenant, inv: SupplierInvoice, decision: 'APPROVE' | 'REJECT', note: string | null, by: { id?: string | null; name: string; email: string }, ip?: string) =>
  decideShared(tenant, inv, decision, note, { ...by, ip });
export const cancelInvoice = (tenant: Tenant, inv: SupplierInvoice, by: { name: string; email?: string | null }, ip?: string) => cancelShared(tenant, inv, { ...by, ip });

/* ---------- Payments (remittances from the ERP) ---------- */

export interface PaymentInput {
  erpId: string; supplierCode: string; reference: string; paymentDate: string; method?: string | null; currency: string; amount: number; withheld?: number | null; notes?: string | null;
  invoices: { invoiceNumber: string; amount: number; withheld?: number | null }[];
}

/** The supplier a payment is for: an onboarded supplier (same lookup as purchase orders), else a party by its ERP supplier code. */
async function payee(tenantId: string, code: string) {
  const vendorId = await matchVendor(tenantId, [code]);
  const party = await db.query.parties.findFirst({ where: and(eq(parties.tenantId, tenantId), vendorId ? eq(parties.vendorId, vendorId) : sql`upper(${parties.ap}->>'erpSupplierCode') = ${code.toUpperCase()}`) });
  return vendorId || party ? { vendorId: vendorId ?? party?.vendorId ?? null, partyId: party?.id ?? null } : null;
}

/** What is left to pay on an invoice: its total less credit and debit notes against it. */
async function netPayable(inv: SupplierInvoice) {
  const [{ notes }] = await db.select({ notes: sql<string>`coalesce(sum(${supplierInvoices.total}), 0)` }).from(supplierInvoices)
    .where(and(eq(supplierInvoices.relatedInvoiceId, inv.id), notInArray(supplierInvoices.status, ['DRAFT', 'REJECTED', 'CANCELLED'])));
  return r2(Number(inv.total) - Number(notes));
}

export async function recordPayments(tenant: Tenant, items: PaymentInput[]) {
  const out = { created: 0, unchanged: 0, failed: 0, errors: [] as string[] };
  for (const [i, p] of items.entries()) {
    try {
      const who = await payee(tenant.id, p.supplierCode.trim());
      if (!who) throw new Error(`supplier code ${p.supplierCode} isn’t linked to a vendor or supplier`);
      if (await db.query.supplierPayments.findFirst({ where: and(eq(supplierPayments.tenantId, tenant.id), eq(supplierPayments.erpId, p.erpId)), columns: { id: true } })) { out.unchanged++; continue; }
      const allocated = r2(p.invoices.reduce((t, x) => t + x.amount, 0));
      if (Math.abs(allocated - p.amount) > 0.01) throw new Error(`invoice amounts add up to ${allocated}, the payment is ${p.amount}`);
      const supplier = who.vendorId ? eq(supplierInvoices.vendorId, who.vendorId) : eq(supplierInvoices.partyId, who.partyId!);
      const pay = await db.transaction(async (tx) => {
        const allocations: { invoiceId: string | null; invoiceNumber: string; amount: number; withheld?: number }[] = [];
        for (const a of p.invoices) {
          const [inv] = await tx.select().from(supplierInvoices).where(and(eq(supplierInvoices.tenantId, tenant.id), supplier, eq(supplierInvoices.kind, 'INVOICE'), sql`upper(${supplierInvoices.invoiceNumber}) = ${a.invoiceNumber.trim().toUpperCase()}`, notInArray(supplierInvoices.status, ['DRAFT', 'REJECTED', 'CANCELLED']))).for('update');
          allocations.push({ invoiceId: inv?.id ?? null, invoiceNumber: a.invoiceNumber.trim(), amount: a.amount, ...(a.withheld ? { withheld: a.withheld } : {}) });
          if (!inv) continue;
          const paid = r2(Number(inv.paidAmount) + a.amount + (a.withheld ?? 0));
          await tx.update(supplierInvoices).set({ paidAmount: String(paid), status: paid >= (await netPayable(inv)) - 0.01 ? 'PAID' : 'PARTLY_PAID' }).where(eq(supplierInvoices.id, inv.id));
        }
        const [row] = await tx.insert(supplierPayments).values({ tenantId: tenant.id, vendorId: who.vendorId, partyId: who.partyId, erpId: p.erpId, reference: p.reference, paymentDate: p.paymentDate, method: p.method ?? null, currency: p.currency.toUpperCase(),
          amount: String(p.amount), withheld: String(p.withheld ?? r2(p.invoices.reduce((t, x) => t + (x.withheld ?? 0), 0))), notes: p.notes ?? null, allocations }).returning();
        return row;
      });
      out.created++;
      await audit({ tenantId: tenant.id, vendorId: who.vendorId, actor: 'API', action: 'PAYMENT_RECORDED', detail: { reference: p.reference, amount: `${pay.currency} ${pay.amount}`, invoices: p.invoices.length } });
      if (pay.vendorId) await notifyPayment(tenant, pay).catch((err) => logger.warn({ err }, 'remittance email failed'));
    } catch (e: any) { out.failed++; out.errors.push(`#${i + 1} (${p.erpId}): ${String(e?.message ?? e).slice(0, 300)}`); }
  }
  return out;
}

/** Remittance advice to suppliers who use the portal. */
async function notifyPayment(tenant: Tenant, p: typeof supplierPayments.$inferSelect) {
  if (!p.vendorId) return;
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

export async function listPayments(tenantId: string, vendorId?: string, page = 1, partyId?: string) {
  const size = 50;
  const rows = await db.select({ p: supplierPayments, vendorName: vendors.name, vendorCode: vendors.code, partyName: parties.name, partyCode: parties.code }).from(supplierPayments)
    .leftJoin(vendors, eq(vendors.id, supplierPayments.vendorId)).leftJoin(parties, eq(parties.id, supplierPayments.partyId))
    .where(and(eq(supplierPayments.tenantId, tenantId), ...(vendorId ? [eq(supplierPayments.vendorId, vendorId)] : []), ...(partyId ? [eq(supplierPayments.partyId, partyId)] : [])))
    .orderBy(sql`${supplierPayments.paymentDate} desc`, sql`${supplierPayments.createdAt} desc`).limit(size + 1).offset((page - 1) * size);
  return { rows: rows.slice(0, size).map(({ p, vendorName, vendorCode, partyName, partyCode }) => ({ id: p.id, reference: p.reference, paymentDate: p.paymentDate, method: p.method, currency: p.currency, amount: Number(p.amount), withheld: Number(p.withheld), notes: p.notes, allocations: p.allocations, vendorName: vendorName ?? partyName, vendorCode: vendorCode ?? partyCode })), hasMore: rows.length > size, page };
}
