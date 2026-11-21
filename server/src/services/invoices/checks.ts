/**
 * One set of checks for every supplier invoice, credit note and debit note — raised by the supplier in the portal or entered
 * by AP. Errors stop the invoice; warnings let it through as an exception (a reason is needed to approve it).
 *
 *   PO        quantity vs ordered (+ tolerance) and already billed, vs received (3-way), PO price, tax rate, shipment
 *   contract  contract active, invoice date within the term, agreed prices (item code), invoices to date vs the value
 *   non-PO    every line coded; codes known and open; the account combination valid in the ERP (when that list is loaded)
 *   notes     linked to an invoice of the same supplier; notes never more than the invoice
 *   all       totals, currency, future dates, duplicates (duplicates.ts, configurable), India e-invoice IRN / QR and GST type, supplier archived / on hold
 */
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import type { Contract, Party, PurchaseOrder, SupplierInvoice, Tenant } from '../../db/schema.js';
import { concatenatedAccount, invoiceRules, invoicesOn, priceTolerance, type Basis } from './config.js';
import { duplicateChecks } from './duplicates.js';

const { poLines, shipments, shipmentLines, supplierInvoices, supplierInvoiceLines, contractPrices, invoiceCodes } = schema;
const DAY = 86_400_000;
export const r2 = (n: number) => Math.round(n * 100) / 100;
export const r4 = (n: number) => Math.round(n * 10000) / 10000;
/** Invoices that count (everything except drafts, rejected and cancelled). */
export const LIVE = ['SUBMITTED', 'EXCEPTION', 'IN_APPROVAL', 'APPROVED', 'PARTLY_PAID', 'PAID'];
export const APPROVED = ['APPROVED', 'PARTLY_PAID', 'PAID'];
const ACCEPTED = ['ACCEPTED', 'AUTO_ACCEPTED'];

/** `rule` / `refs`: the duplicate-check rule and the invoices it matched (duplicates.ts). */
export type Check = { code: string; level: 'error' | 'warning' | 'ok'; message: string; rule?: string; refs?: { id: string; number: string }[] };
export type InvoiceKind = 'INVOICE' | 'CREDIT' | 'DEBIT';
export const KIND_LABEL: Record<InvoiceKind, string> = { INVOICE: 'Invoice', CREDIT: 'Credit note', DEBIT: 'Debit note' };

/* ---------------- PO lines ---------------- */

export interface InvoiceableLine {
  lineId: string; lineNo: number; lineType: string; itemCode: string | null; description: string; uom: string | null; hsn: string | null;
  ordered: number; tolerancePct: number; received: number; billed: number; unitPrice: number; taxRate: number | null; available: number; availableReceived: number;
}

/** Signed quantity: credit notes give quantity back. */
const signedQty = sql<string>`sum(case when ${supplierInvoices.kind} = 'CREDIT' then -${supplierInvoiceLines.quantity} else ${supplierInvoiceLines.quantity} end)`;

/** Accepted lines and how much can still be invoiced on each. */
export async function invoiceableLines(poId: string, excludeInvoiceId?: string): Promise<InvoiceableLine[]> {
  const lines = await db.select().from(poLines).where(eq(poLines.poId, poId)).orderBy(asc(poLines.lineNo));
  const billed = await db.select({ lineId: supplierInvoiceLines.lineId, q: signedQty }).from(supplierInvoiceLines)
    .innerJoin(supplierInvoices, eq(supplierInvoices.id, supplierInvoiceLines.invoiceId))
    .where(and(eq(supplierInvoices.poId, poId), inArray(supplierInvoices.status, LIVE), ne(supplierInvoices.kind, 'DEBIT'), ...(excludeInvoiceId ? [ne(supplierInvoices.id, excludeInvoiceId)] : []))).groupBy(supplierInvoiceLines.lineId);
  const bMap = new Map(billed.map((b) => [b.lineId, Number(b.q)]));
  // Approved invoices are already in billedQty (added on approval); the rest are ours alone.
  const approved = await db.select({ lineId: supplierInvoiceLines.lineId, q: signedQty }).from(supplierInvoiceLines)
    .innerJoin(supplierInvoices, eq(supplierInvoices.id, supplierInvoiceLines.invoiceId))
    .where(and(eq(supplierInvoices.poId, poId), inArray(supplierInvoices.status, APPROVED), ne(supplierInvoices.kind, 'DEBIT'))).groupBy(supplierInvoiceLines.lineId);
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

/* ---------------- India e-invoice ---------------- */

export interface EInvoiceInput { irn?: string | null; ackNo?: string | null; ackDate?: string | null; signedQr?: string | null }

/** Decode the payload of the e-invoice signed QR (a JWT from the IRP). The signature itself isn't verified here. */
export function decodeSignedQr(jwt: string): Record<string, unknown> | null {
  const parts = jwt.trim().split('.');
  if (parts.length !== 3) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof p?.data === 'string' ? JSON.parse(p.data) : p?.data && typeof p.data === 'object' ? p.data : p;
  } catch { return null; }
}

export const norm = (s: string) => s.trim().toUpperCase().replace(/\s+/g, '');

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

/** India: an interstate supply (different GSTIN states) is taxed as IGST; within one state as CGST + SGST. */
export function gstTypeCheck(supplierGstin: string | null, ourGstin: string | null | undefined, taxType: 'IGST' | 'CGST_SGST' | null | undefined): Check[] {
  if (!supplierGstin || !ourGstin || !taxType || !/^\d{2}/.test(supplierGstin) || !/^\d{2}/.test(ourGstin)) return [];
  const inter = supplierGstin.slice(0, 2) !== ourGstin.slice(0, 2);
  if (inter && taxType !== 'IGST') return [{ code: 'GST_TYPE', level: 'warning', message: `Supplier and buyer are in different states (${supplierGstin.slice(0, 2)} → ${ourGstin.slice(0, 2)}): expected IGST, the invoice charges CGST + SGST` }];
  if (!inter && taxType === 'IGST') return [{ code: 'GST_TYPE', level: 'warning', message: `Supplier and buyer are in the same state (${ourGstin.slice(0, 2)}): expected CGST + SGST, the invoice charges IGST` }];
  return [];
}

/** Days from payment terms such as "Net 30", "30 days", "NET45". */
export function termDays(terms: string | null | undefined) {
  const m = /(\d{1,3})/.exec(terms ?? '');
  return m ? Number(m[1]) : null;
}
export const dueDateFrom = (invoiceDate: string, days: number | null) => (days === null ? null : new Date(new Date(invoiceDate).getTime() + days * DAY).toISOString().slice(0, 10));

/* ---------------- the checks ---------------- */

export interface CheckLine {
  lineId?: string | null; itemCode?: string | null; description?: string | null; uom?: string | null; hsn?: string | null;
  quantity: number; unitPrice: number; taxRate?: number | null; taxAmount?: number | null;
  glAccount?: string | null; costCentre?: string | null; project?: string | null; task?: string | null;
}
export interface CheckInput {
  kind?: InvoiceKind; invoiceNumber: string; invoiceDate: string; currency?: string; total: number; shipmentId?: string | null;
  einvoice?: EInvoiceInput | null; taxType?: 'IGST' | 'CGST_SGST' | null; relatedInvoiceId?: string | null; lines: CheckLine[];
  /** SHA-256 of the invoice's PDF (duplicate check H3). */
  fileSha256?: string | null;
}
/** What the invoice is against. `vendorId` / `partyId` identify the supplier for duplicates. */
export interface CheckSubject {
  tenant: Tenant; basis: Basis; po?: PurchaseOrder | null; contract?: Contract | null; party?: Party | null; vendorId?: string | null;
  supplierGstin?: string | null; supplierHold?: string | null; entityCode?: string | null; excludeInvoiceId?: string;
  /** Earlier invoices a person said this is not a duplicate of. */
  cleared?: string[];
}
export type PricedLine = CheckLine & { amount: number; taxRate: number; taxAmount: number };

export async function checkInvoice(s: CheckSubject, input: CheckInput) {
  const { tenant } = s;
  const kind: InvoiceKind = input.kind ?? 'INVOICE';
  const checks: Check[] = [];
  const err = (code: string, message: string) => checks.push({ code, level: 'error', message });
  const warn = (code: string, message: string) => checks.push({ code, level: 'warning', message });
  const tol = priceTolerance(tenant);
  const lines = input.lines.filter((l) => l.quantity > 0);
  if (!lines.length) err('NO_LINES', 'Enter a quantity for at least one line');
  const docCurrency = s.po?.currency ?? s.contract?.currency ?? null;
  const currency = (input.currency ?? docCurrency ?? '').toUpperCase();
  if (!currency) err('CURRENCY', 'Choose the invoice currency');
  else if (docCurrency && currency !== docCurrency.toUpperCase()) err('CURRENCY', `The invoice must be in the ${s.po ? 'order' : 'contract'} currency (${docCurrency})`);
  if (input.invoiceDate > new Date(Date.now() + DAY).toISOString().slice(0, 10)) err('FUTURE_DATE', 'The invoice date can’t be in the future');
  else if (s.po?.poDate && input.invoiceDate < s.po.poDate) warn('BEFORE_PO', `Invoice dated before the order (${s.po.poDate})`);

  // Amounts (a PO line's tax rate applies when the invoice gives none).
  const poMatch = s.basis === 'po' && !!s.po && kind === 'INVOICE';
  const avail = poMatch ? new Map((await invoiceableLines(s.po!.id, s.excludeInvoiceId)).map((l) => [l.lineId, l])) : new Map<string, InvoiceableLine>();
  const priced: PricedLine[] = lines.map((l) => {
    const amount = r2(l.quantity * l.unitPrice);
    const rate = l.taxRate ?? (l.lineId ? avail.get(l.lineId)?.taxRate : null) ?? 0;
    return { ...l, amount, taxRate: rate, taxAmount: l.taxAmount ?? r2(amount * rate / 100) };
  });

  // PO matching.
  if (poMatch && s.po) {
    if (new Set(lines.map((l) => l.lineId)).size !== lines.length) err('LINE_TWICE', 'Each order line can appear once');
    let priceOk = true, qtyOk = true;
    for (const l of priced) {
      const a = l.lineId ? avail.get(l.lineId) : undefined;
      if (!a) { err('LINE', 'One or more lines aren’t on this order or aren’t accepted'); continue; }
      if (r4(l.quantity) > a.available) { err('QTY_OVER_ORDER', `Line ${a.lineNo}: only ${a.available}${a.uom ? ` ${a.uom}` : ''} is left to invoice (ordered ${a.ordered}, already invoiced ${a.billed})`); qtyOk = false; }
      else if (a.lineType === 'GOODS' && r4(l.quantity) > a.availableReceived) { warn('QTY_NOT_RECEIVED', `Line ${a.lineNo}: ${a.availableReceived} received and not yet invoiced, invoice says ${l.quantity}`); qtyOk = false; }
      if (l.unitPrice > a.unitPrice * (1 + tol / 100) + 0.0001) { warn('PRICE_OVER', `Line ${a.lineNo}: price ${l.unitPrice} is above the order price ${a.unitPrice} (tolerance ${tol}%)`); priceOk = false; }
      const given = lines.find((x) => x.lineId === l.lineId)?.taxRate;
      if (a.taxRate !== null && given !== undefined && given !== null && Math.abs(given - a.taxRate) > 0.001) warn('TAX_RATE', `Line ${a.lineNo}: tax ${given}% but the order says ${a.taxRate}%`);
      l.itemCode = l.itemCode ?? a.itemCode; l.description = l.description ?? a.description; l.uom = l.uom ?? a.uom; l.hsn = l.hsn ?? a.hsn;
    }
    if (lines.length && qtyOk && !checks.some((c) => c.code.startsWith('QTY'))) checks.push({ code: 'QTY_OK', level: 'ok', message: 'Quantities match the order and receipts' });
    if (lines.length && priceOk) checks.push({ code: 'PRICE_OK', level: 'ok', message: 'Prices match the order' });
    if (input.shipmentId) {
      const sh = await db.query.shipments.findFirst({ where: and(eq(shipments.id, input.shipmentId), eq(shipments.poId, s.po.id)) });
      if (!sh || sh.status === 'CANCELLED') err('SHIPMENT', 'That shipment notice isn’t on this order');
      else {
        const sl = await db.select().from(shipmentLines).where(eq(shipmentLines.shipmentId, sh.id));
        for (const l of lines) { const x = sl.find((y) => y.lineId === l.lineId); if (!x) warn('NOT_ON_SHIPMENT', `A line isn’t on shipment ${sh.number}`); else if (l.quantity > Number(x.quantity)) warn('OVER_SHIPMENT', `More than shipped on ${sh.number}`); }
      }
    }
  }
  const subtotal = r2(priced.reduce((t, l) => t + l.amount, 0)), tax = r2(priced.reduce((t, l) => t + l.taxAmount, 0));
  const total = r2(subtotal + tax);
  if (Math.abs(total - input.total) > 1) err('TOTAL', `The total doesn’t add up: lines and tax come to ${total.toFixed(2)}, the invoice says ${input.total.toFixed(2)}`);

  // Contract.
  if (s.contract && kind === 'INVOICE') {
    const c = s.contract;
    if (!['ACTIVE', 'EXPIRED', 'TERMINATED'].includes(c.status)) err('CONTRACT_NOT_SIGNED', `Contract ${c.number} isn’t signed yet`);
    if ((c.startDate && input.invoiceDate < c.startDate) || (c.endDate && input.invoiceDate > c.endDate)) warn('CONTRACT_TERM', `Invoice dated outside the contract term (${c.startDate ?? '…'} – ${c.endDate ?? '…'})`);
    const prices = await db.select().from(contractPrices).where(eq(contractPrices.contractId, c.id));
    let priceOk = true;
    for (const l of priced) {
      const p = l.itemCode ? prices.find((x) => x.itemCode && norm(x.itemCode) === norm(l.itemCode!)) : undefined;
      if (p && l.unitPrice > Number(p.price) * (1 + tol / 100) + 0.0001) { warn('CONTRACT_PRICE', `${l.itemCode}: price ${l.unitPrice} is above the contract price ${Number(p.price)} (tolerance ${tol}%)`); priceOk = false; }
    }
    if (prices.length && priced.some((l) => l.itemCode) && priceOk) checks.push({ code: 'CONTRACT_PRICE_OK', level: 'ok', message: 'Prices match the contract' });
    if (c.value !== null) {
      const [{ sum }] = await db.select({ sum: sql<string>`coalesce(sum(${supplierInvoices.subtotal}), 0)` }).from(supplierInvoices)
        .where(and(eq(supplierInvoices.contractId, c.id), eq(supplierInvoices.kind, 'INVOICE'), inArray(supplierInvoices.status, LIVE), ...(s.excludeInvoiceId ? [ne(supplierInvoices.id, s.excludeInvoiceId)] : [])));
      const after = r2(Number(sum) + subtotal);
      if (after > Number(c.value) + 0.01) warn('CONTRACT_VALUE', `Invoices on contract ${c.number} would come to ${after.toLocaleString('en-IN')}, above its value ${Number(c.value).toLocaleString('en-IN')}`);
    }
  }

  // Coding: invoices without a PO, and notes on them.
  const coded = s.basis !== 'po';
  if (coded) checks.push(...await codingChecks(tenant, priced, s.entityCode ?? null));

  // Credit and debit notes.
  if (kind !== 'INVOICE') {
    const rel = input.relatedInvoiceId ? await db.query.supplierInvoices.findFirst({ where: and(eq(supplierInvoices.tenantId, tenant.id), eq(supplierInvoices.id, input.relatedInvoiceId)) }) : undefined;
    if (!rel || rel.kind !== 'INVOICE') err('NOTE_INVOICE', `Choose the invoice this ${kind === 'CREDIT' ? 'credit' : 'debit'} note corrects`);
    else {
      if ((s.party && rel.partyId && rel.partyId !== s.party.id) || (s.vendorId && rel.vendorId && rel.vendorId !== s.vendorId)) err('NOTE_SUPPLIER', 'The note must be for the same supplier as the invoice');
      if (!LIVE.includes(rel.status)) err('NOTE_INVOICE', `Invoice ${rel.invoiceNumber} was ${rel.status === 'REJECTED' ? 'rejected' : 'cancelled'}`);
      if (kind === 'DEBIT' && !APPROVED.includes(rel.status)) err('NOTE_NOT_APPROVED', `Debit notes are raised against approved invoices; ${rel.invoiceNumber} isn’t approved yet`);
      const [{ sum }] = await db.select({ sum: sql<string>`coalesce(sum(${supplierInvoices.total}), 0)` }).from(supplierInvoices)
        .where(and(eq(supplierInvoices.relatedInvoiceId, rel.id), inArray(supplierInvoices.status, LIVE), ...(s.excludeInvoiceId ? [ne(supplierInvoices.id, s.excludeInvoiceId)] : [])));
      if (r2(Number(sum) + total) > Number(rel.total) + 0.01) err('NOTE_OVER', `Notes on ${rel.invoiceNumber} would come to ${r2(Number(sum) + total).toFixed(2)}, more than the invoice (${Number(rel.total).toFixed(2)})`);
      if (rel.currency !== currency) err('CURRENCY', `The note must be in the invoice currency (${rel.currency})`);
    }
  }

  // Duplicates: the configurable duplicate-check algorithm (duplicates.ts).
  checks.push(...await duplicateChecks(s, input, total, kind));

  // Supplier.
  if (s.party?.status === 'ARCHIVED') warn('PARTY_ARCHIVED', `${s.party.name} is archived`);
  if (s.supplierHold) warn('SUPPLIER_ON_HOLD', `The supplier is on hold: ${s.supplierHold}`);

  // India.
  if (kind === 'INVOICE' && (tenant.country === 'IN' || input.einvoice)) checks.push(...einvoiceChecks(input.einvoice, { supplierGstin: s.supplierGstin ?? null, invoiceNumber: input.invoiceNumber, total, required: tenant.country === 'IN' && !!tenant.settings.einvoiceRequired }));
  if (tenant.country === 'IN') checks.push(...gstTypeCheck(s.supplierGstin ?? null, tenant.billing?.gstin, input.taxType));

  return { checks, lines: priced, subtotal, tax, total, currency };
}

/** Each line coded with known, open codes; the combination valid in the ERP when combinations are loaded. */
async function codingChecks(tenant: Tenant, lines: PricedLine[], entity: string | null): Promise<Check[]> {
  const out: Check[] = [];
  const needCc = !invoicesOn(tenant) || invoiceRules(tenant).costCentre !== 'optional';
  const want = new Map<string, Set<string>>([['ACCOUNT', new Set()], ['COST_CENTRE', new Set()], ['PROJECT', new Set()], ['TASK', new Set()]]);
  lines.forEach((l, i) => {
    const n = i + 1;
    if (!l.glAccount) out.push({ code: 'CODING', level: 'error', message: `Line ${n}: choose a GL account` });
    else want.get('ACCOUNT')!.add(l.glAccount);
    if (!l.costCentre) { if (needCc) out.push({ code: 'CODING', level: 'error', message: `Line ${n}: choose a cost centre` }); } else want.get('COST_CENTRE')!.add(l.costCentre);
    if (l.project) want.get('PROJECT')!.add(l.project);
    if (l.task) { if (!l.project) out.push({ code: 'CODING', level: 'error', message: `Line ${n}: a task needs its project` }); want.get('TASK')!.add(l.task); }
  });
  const codes = [...want.values()].some((s) => s.size) ? await db.select().from(invoiceCodes).where(and(eq(invoiceCodes.tenantId, tenant.id), inArray(invoiceCodes.kind, ['ACCOUNT', 'COST_CENTRE', 'PROJECT', 'TASK']))) : [];
  const label: Record<string, string> = { ACCOUNT: 'GL account', COST_CENTRE: 'Cost centre', PROJECT: 'Project', TASK: 'Task' };
  for (const [kind, set] of want) for (const code of set) {
    const c = codes.find((x) => x.kind === kind && x.code === code);
    if (!c) out.push({ code: 'CODE_UNKNOWN', level: 'error', message: `${label[kind]} ${code} isn’t in the code list` });
    else if (!c.enabled) out.push({ code: 'CODE_CLOSED', level: 'error', message: `${label[kind]} ${code} is closed in the ERP` });
    else if (!c.usable) out.push({ code: 'CODE_CLOSED', level: 'error', message: `${label[kind]} ${code} isn’t open for invoices` });
  }
  for (const l of lines) if (l.task && l.project) {
    const t = codes.find((x) => x.kind === 'TASK' && x.code === l.task);
    if (t && t.parent && t.parent !== l.project) out.push({ code: 'CODING', level: 'error', message: `Task ${l.task} isn’t on project ${l.project}` });
  }
  // Valid combinations (Oracle GL_CODE_COMBINATIONS), only when that list has been loaded.
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(invoiceCodes).where(and(eq(invoiceCodes.tenantId, tenant.id), eq(invoiceCodes.kind, 'COMBINATION')));
  if (n > 0 && !out.some((c) => c.level === 'error')) {
    const combos = [...new Set(lines.map((l) => concatenatedAccount(tenant, { entity, costCentre: l.costCentre, account: l.glAccount, project: l.project })).filter(Boolean) as string[])];
    const found = await db.select({ code: invoiceCodes.code, enabled: invoiceCodes.enabled }).from(invoiceCodes).where(and(eq(invoiceCodes.tenantId, tenant.id), eq(invoiceCodes.kind, 'COMBINATION'), inArray(invoiceCodes.code, combos)));
    for (const c of combos) {
      const f = found.find((x) => x.code === c);
      if (!f || !f.enabled) out.push({ code: 'ACCOUNT_COMBINATION', level: 'error', message: `Account ${c} isn’t a valid combination in the ERP` });
    }
  }
  if (lines.length && !out.length) out.push({ code: 'CODING_OK', level: 'ok', message: 'Every line is coded' });
  return out;
}

/** Re-run the checks for a stored invoice (screens, re-submission). */
export const isClean = (checks: Check[]) => !checks.some((c) => c.level !== 'ok');
export type StoredInvoice = SupplierInvoice;
