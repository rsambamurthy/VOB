/**
 * Getting invoices in (Invoices add-on): the PDF on an AP draft, bulk upload (PDFs or a .zip → one draft each, linked to the
 * PO named in the file name), the email inbox (inbox.ts, through draftFromFile), and Excel (one row per line, grouped into drafts). Every draft is finished, checked and
 * submitted the same way (record.ts).
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import type { Tenant } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { storeUpload } from '../../integrations/storage/index.js';
import { readSheet, sheetTemplate, type RowError, type SheetColumn } from '../../lib/excel.js';
import { packFor } from '../../countries/registry.js';
import { unpack } from '../contracts/migration.js';
import { assertInvoicesOn, optionOn } from './config.js';
import { getInvoice, partyOfVendor, recheckInvoice, saveDraft, type By } from './record.js';
import { DUPLICATES } from './duplicates.js';
import type { InvoiceFacts } from './reading.js';
import { norm } from './checks.js';

const { supplierInvoices, purchaseOrders, parties } = schema;
type Upload = { buffer: Buffer; originalname: string; size?: number };
const today = () => new Date().toISOString().slice(0, 10);
export const workspaceCurrency = (t: Tenant) => packFor(t.country).currency ?? 'INR';

/** The PDF of an AP draft (replaces the previous one). */
export async function attachFile(t: Tenant, id: string, file: Upload | undefined, by: By) {
  assertInvoicesOn(t);
  if (!file) throw new HttpError(400, 'No file uploaded');
  const inv = await getInvoice(t, id);
  if (inv.source === 'PORTAL') throw new HttpError(409, 'The supplier attached this invoice’s file');
  if (inv.status !== 'DRAFT') throw new HttpError(409, 'Only drafts can be changed');
  const stored = await storeUpload(t.id, 'invoices', file);
  const [row] = await db.update(supplierInvoices).set({ file: { fileName: stored.fileName, mimeType: stored.mimeType, size: stored.size, storagePath: stored.storagePath, storageDriver: stored.storageDriver, sha256: stored.sha256 } })
    .where(eq(supplierInvoices.id, inv.id)).returning();
  await audit({ tenantId: t.id, vendorId: inv.vendorId, actor: by.name, action: 'INVOICE_FILE_ATTACHED', detail: { subjectId: inv.id, invoice: inv.invoiceNumber, file: stored.fileName }, ip: by.ip });
  return row;
}

/** Finds the one purchase order named in a text (file name, email subject, PDF text): PO numbers of 4+ characters, ignoring punctuation. */
export async function poFinder(t: Tenant) {
  const pos = await db.select({ id: purchaseOrders.id, poNumber: purchaseOrders.poNumber, vendorId: purchaseOrders.vendorId, currency: purchaseOrders.currency }).from(purchaseOrders).where(eq(purchaseOrders.tenantId, t.id)).limit(50000);
  const keyed = pos.filter((p) => p.poNumber.length >= 4).map((p) => ({ ...p, key: norm(p.poNumber).replace(/[^A-Z0-9]/g, '') }));
  return (...texts: (string | null | undefined)[]) => {
    for (const text of texts) {
      if (!text) continue;
      const n = norm(text).replace(/[^A-Z0-9]/g, '');
      const hits = keyed.filter((p) => n.includes(p.key));
      if (hits.length === 1) return hits[0];
    }
    return null;
  };
}
export type FoundPo = NonNullable<ReturnType<Awaited<ReturnType<typeof poFinder>>>>;

/** A file already stored by an earlier draft (duplicate check H3; skipped unless that rule is off). */
export async function sameFile(t: Tenant, sha256: string) {
  if (DUPLICATES.resolve(t).rules.H3 === 'off') return null;
  return db.query.supplierInvoices.findFirst({ where: and(eq(supplierInvoices.tenantId, t.id), sql`${supplierInvoices.file}->>'sha256' = ${sha256}`, sql`${supplierInvoices.status} not in ('CANCELLED','REJECTED')`), columns: { id: true, invoiceNumber: true } });
}

/**
 * One draft from one stored file — bulk upload and the email inbox. What is known goes on the draft (supplier, PO, and what
 * was read from the PDF); the checks run straight away so possible duplicates show before anyone opens it.
 */
export async function draftFromFile(t: Tenant, stored: Awaited<ReturnType<typeof storeUpload>>, o: {
  source: 'BULK' | 'EMAIL'; by: By; po?: FoundPo | null; partyId?: string | null; guess?: string; facts?: InvoiceFacts | null; mailId?: string | null;
}) {
  const party = o.partyId ? { id: o.partyId } : o.po?.vendorId ? await partyOfVendor(t, o.po.vendorId, o.by) : null;
  const vendorId = o.po?.vendorId ?? (o.partyId ? (await db.query.parties.findFirst({ where: eq(parties.id, o.partyId), columns: { vendorId: true } }))?.vendorId ?? null : null);
  const f = o.facts ?? {};
  const [row] = await db.insert(supplierInvoices).values({
    tenantId: t.id, kind: 'INVOICE', status: 'DRAFT', source: o.source, invoiceNumber: f.invoiceNumber ?? (o.guess ?? 'NEW').slice(0, 60), invoiceDate: f.invoiceDate ?? today(), currency: o.po?.currency ?? workspaceCurrency(t),
    subtotal: '0', taxAmount: '0', total: String(f.total ?? 0), poId: o.po?.id ?? null, vendorId, partyId: party?.id ?? null, mailId: o.mailId ?? null,
    einvoice: f.irn ? { irn: f.irn } : null,
    file: { fileName: stored.fileName, mimeType: stored.mimeType, size: stored.size, storagePath: stored.storagePath, storageDriver: stored.storageDriver, sha256: stored.sha256 },
    submittedBy: o.by.name, createdById: o.by.id ?? null, ownerId: o.by.id ?? null, checks: [],
  }).returning();
  return recheckInvoice(t, row);
}

/**
 * Bulk upload: each PDF (or each file in a .zip) becomes a draft for AP to finish. A PO number in the file name links the draft
 * to that order and its supplier; the same file twice is skipped. `commit` false = only say what would happen.
 */
export async function bulkUpload(t: Tenant, files: Upload[], by: By, commit: boolean) {
  assertInvoicesOn(t);
  if (!optionOn(t, 'bulkUpload')) throw new HttpError(400, 'Bulk upload is switched off in Administration → Invoices.');
  const { files: list, skipped } = unpack(files as never);
  const find = await poFinder(t);
  const plan = (list as Upload[]).map((f) => {
    const name = f.originalname.replace(/\.[a-z0-9]+$/i, '');
    return { file: f, fileName: f.originalname, po: find(name), guess: name.slice(0, 60) };
  });
  const out = { files: plan.map((p) => ({ fileName: p.fileName, poNumber: p.po?.poNumber ?? null })), skipped, created: [] as { id: string; fileName: string; poNumber: string | null }[], duplicates: [] as string[] };
  if (!commit) return out;
  for (const p of plan) {
    const stored = await storeUpload(t.id, 'invoices', p.file);
    if (await sameFile(t, stored.sha256)) { out.duplicates.push(p.fileName); continue; }
    const row = await draftFromFile(t, stored, { source: 'BULK', by, po: p.po, guess: p.guess });
    out.created.push({ id: row.id, fileName: p.fileName, poNumber: p.po?.poNumber ?? null });
  }
  if (out.created.length) await audit({ tenantId: t.id, actor: by.name, action: 'INVOICES_BULK_UPLOADED', detail: { files: out.created.length, duplicates: out.duplicates.length }, ip: by.ip });
  return out;
}

/* ---------------- Excel ---------------- */

const COLUMNS: SheetColumn[] = [
  { header: 'Supplier', width: 18, required: true }, { header: 'Invoice number', width: 18, required: true }, { header: 'Invoice date', width: 12, required: true, type: 'date' },
  { header: 'Currency', width: 9 }, { header: 'PO number', width: 16 }, { header: 'Contract', width: 16 }, { header: 'Description', width: 34, required: true },
  { header: 'Item code', width: 14 }, { header: 'Quantity', width: 10, required: true }, { header: 'Unit price', width: 12, required: true }, { header: 'Tax rate %', width: 10 },
  { header: 'GL account', width: 12 }, { header: 'Cost centre', width: 12 }, { header: 'Project', width: 12 }, { header: 'Task', width: 10 }, { header: 'Invoice total', width: 14, required: true },
];
export const invoicesTemplate = () => sheetTemplate({
  sheet: 'Invoices', columns: COLUMNS, examplesOnOwnSheet: true,
  examples: [['SUP-00007', 'PIE/26-27/0412', '2026-11-01', 'INR', '', '', 'Warehouse rent — November', '', 1, 250000, 18, '5100', '120', '', '', 295000],
    ['SUP-00002', 'KST/2026/1187', '2026-11-04', 'INR', '', 'RC-2026-0001', 'MS plates 10 mm', 'STL-PL10', 2.5, 61000, 18, '1410', '110', '', '', 179950]],
  help: [['Supplier', 'The party code (SUP-00007) or the supplier’s code in the ERP.'], ['One row per line', 'Rows with the same supplier and invoice number make one invoice. Repeat the header columns on each row.'],
    ['PO number / Contract', 'Leave both empty for invoices without a PO or contract; then give the GL account (and cost centre) on each line.'], ['Import', 'Invoices are added as drafts: open each, check it and submit it.']],
});

/** Invoices from a sheet → drafts (check first, then import). */
export async function importInvoices(t: Tenant, buffer: Buffer, by: By, commit: boolean) {
  assertInvoicesOn(t);
  if (!optionOn(t, 'excelImport')) throw new HttpError(400, 'Excel import is switched off in Administration → Invoices.');
  const rows = await readSheet(buffer, { sheet: 'Invoices', columns: COLUMNS, maxRows: 5000 });
  const errors: RowError[] = [];
  const groups = new Map<string, { row: number; supplier: string; number: string; date: string; currency: string; po: string; contract: string; total: number; lines: Record<string, unknown>[] }>();
  const num = (v: string) => Number(v.replace(/,/g, ''));
  for (const r of rows) {
    const key = `${r.get('Supplier').toUpperCase()}|${norm(r.get('Invoice number'))}`;
    const q = num(r.get('Quantity')), price = num(r.get('Unit price')), total = num(r.get('Invoice total'));
    if (!Number.isFinite(q) || !Number.isFinite(price) || !Number.isFinite(total)) { errors.push({ row: r.row, message: 'Quantity, unit price and invoice total must be numbers' }); continue; }
    const g = groups.get(key) ?? { row: r.row, supplier: r.get('Supplier'), number: r.get('Invoice number'), date: r.get('Invoice date'), currency: r.get('Currency').toUpperCase(), po: r.get('PO number'), contract: r.get('Contract'), total, lines: [] };
    g.lines.push({ description: r.get('Description'), itemCode: r.get('Item code') || null, quantity: q, unitPrice: price, taxRate: r.get('Tax rate %') ? num(r.get('Tax rate %')) : null,
      glAccount: r.get('GL account') || null, costCentre: r.get('Cost centre') || null, project: r.get('Project') || null, task: r.get('Task') || null });
    groups.set(key, g);
  }
  const ready: { row: number; number: string; supplier: string; input: Record<string, unknown> }[] = [];
  for (const g of groups.values()) {
    const code = g.supplier.trim().toUpperCase();
    const party = await db.query.parties.findFirst({ where: and(eq(parties.tenantId, t.id), eq(parties.kind, 'SUPPLIER'), sql`(upper(${parties.code}) = ${code} or upper(${parties.ap}->>'erpSupplierCode') = ${code})`) });
    if (!party) { errors.push({ row: g.row, message: `Supplier “${g.supplier}” not found (party code or ERP supplier code)` }); continue; }
    let poId: string | null = null, contractId: string | null = null;
    if (g.po) {
      const po = await db.query.purchaseOrders.findFirst({ where: and(eq(purchaseOrders.tenantId, t.id), eq(purchaseOrders.poNumber, g.po)) });
      if (!po) { errors.push({ row: g.row, message: `Purchase order ${g.po} not found` }); continue; }
      poId = po.id;
    } else if (g.contract) {
      const c = await db.query.contracts.findFirst({ where: and(eq(schema.contracts.tenantId, t.id), eq(schema.contracts.number, g.contract)) });
      if (!c) { errors.push({ row: g.row, message: `Contract ${g.contract} not found` }); continue; }
      contractId = c.id;
    }
    ready.push({ row: g.row, number: g.number, supplier: party.code, input: { partyId: party.id, poId, contractId, invoiceNumber: g.number, invoiceDate: g.date, currency: g.currency || undefined, total: g.total, lines: poId ? [] : g.lines } });
  }
  if (!rows.length) errors.push({ row: 0, message: 'No invoices found in the sheet.' });
  const created: { row: number; id: string; number: string }[] = [];
  if (commit && !errors.length) for (const x of ready) {
    try { const d = await saveDraft(t, null, x.input, { ...by, source: 'EXCEL' }); created.push({ row: x.row, id: d.id, number: d.invoiceNumber }); }
    catch (e) { errors.push({ row: x.row, message: (e as Error).message }); }
  }
  if (created.length) await audit({ tenantId: t.id, actor: by.name, action: 'INVOICES_IMPORTED', detail: { invoices: created.length }, ip: by.ip });
  return { ready: ready.map((x) => ({ row: x.row, supplier: x.supplier, invoiceNumber: x.number })), errors, created };
}
