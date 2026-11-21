/**
 * The invoice lifecycle, shared by the supplier portal (PO invoices) and AP (Invoices add-on):
 *
 *   DRAFT (AP) ─submit→ SUBMITTED | EXCEPTION ─route→ IN_APPROVAL (approval matrix) ─→ APPROVED ─→ PARTLY_PAID → PAID
 *                                          └→ touchless: clean, nothing in the matrix applies → APPROVED at once
 *   REJECTED · CANCELLED end it. Approved → ERP: automatic, or READY until AP sends it (pushMode).
 *
 * Without the add-on, portal invoices wait as SUBMITTED / EXCEPTION for one decision (decideInvoice), as before.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../lib/db.js';
import type { Contract, Party, PurchaseOrder, SupplierInvoice, Tenant } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { nextYearlyNumber } from '../../lib/numbering.js';
import { cancelFlow, flowView, forwardFlow, registerFlowSubject, startFlow } from '../approvalFlow.js';
import { applicableFlowLevels } from '../approvalFlow.js';
import { APPROVED, checkInvoice, dueDateFrom, isClean, LIVE, termDays, type CheckInput, type CheckSubject, type InvoiceKind } from './checks.js';
import { BASIS_LABEL, assertBasisOn, assertInvoicesOn, basisOn, invoiceApprovalLevels, invoiceRules, invoicesOn, optionOn, type Basis } from './config.js';

const { supplierInvoices, supplierInvoiceLines, poLines, purchaseOrders, invoiceCodes, parties, contracts, vendors } = schema;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface By { id?: string | null; name: string; email?: string | null; ip?: string }

/* ---------------- input ---------------- */

const money = z.coerce.number().finite().min(0).max(1e13);
const code = z.string().trim().max(60).optional().nullable().transform((v) => v || null);
export const lineInput = z.object({
  lineId: z.string().max(40).optional().nullable(), itemCode: code, description: z.string().trim().max(500).optional().nullable(), uom: code, hsn: code,
  quantity: money, unitPrice: money, taxRate: z.coerce.number().min(0).max(100).optional().nullable(), taxAmount: money.optional().nullable(),
  glAccount: code, costCentre: code, project: code, task: code,
});
const einvoiceInput = z.object({ irn: z.string().trim().max(80).optional().nullable(), ackNo: z.string().trim().max(40).optional().nullable(), ackDate: z.string().trim().max(30).optional().nullable(), signedQr: z.string().trim().max(5000).optional().nullable() }).optional().nullable();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD');
export const apInvoiceInput = z.object({
  kind: z.enum(['INVOICE', 'CREDIT', 'DEBIT']).default('INVOICE'),
  partyId: z.string().min(1, 'Choose the supplier'),
  poId: z.string().optional().nullable().transform((v) => v || null),
  contractId: z.string().optional().nullable().transform((v) => v || null),
  relatedInvoiceId: z.string().optional().nullable().transform((v) => v || null),
  invoiceNumber: z.string().trim().max(60).default(''),
  invoiceDate: isoDate,
  glDate: isoDate.optional().nullable(),
  dueDate: isoDate.optional().nullable(),
  currency: z.string().trim().toUpperCase().length(3).optional(),
  total: money,
  description: z.string().trim().max(500).optional().nullable(),
  entityCode: code,
  taxType: z.enum(['IGST', 'CGST_SGST']).optional().nullable(),
  einvoice: einvoiceInput,
  documentId: z.string().optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  lines: z.array(lineInput).max(500).default([]),
});
export type ApInvoiceInput = z.input<typeof apInvoiceInput>;

/* ---------------- what an invoice is against ---------------- */

export function basisOf(inv: { poId: string | null; contractId: string | null }): Basis { return inv.poId ? 'po' : inv.contractId ? 'contract' : 'nonPo'; }

/** Load the PO, contract, party and supplier facts the checks need. */
export async function subjectFor(t: Tenant, inv: { poId: string | null; contractId: string | null; partyId: string | null; vendorId: string | null; relatedInvoiceId?: string | null; entityCode?: string | null; duplicateCleared?: { invoiceId: string }[] }, excludeInvoiceId?: string): Promise<CheckSubject> {
  let basisSrc: { poId: string | null; contractId: string | null } = inv;
  if (inv.relatedInvoiceId) {
    const rel = await db.query.supplierInvoices.findFirst({ where: and(eq(supplierInvoices.tenantId, t.id), eq(supplierInvoices.id, inv.relatedInvoiceId)), columns: { poId: true, contractId: true } });
    if (rel) basisSrc = rel;
  }
  const [po, contract, party, vendor] = await Promise.all([
    inv.poId ? db.query.purchaseOrders.findFirst({ where: and(eq(purchaseOrders.tenantId, t.id), eq(purchaseOrders.id, inv.poId)) }) : undefined,
    inv.contractId ? db.query.contracts.findFirst({ where: and(eq(contracts.tenantId, t.id), eq(contracts.id, inv.contractId)) }) : undefined,
    inv.partyId ? db.query.parties.findFirst({ where: and(eq(parties.tenantId, t.id), eq(parties.id, inv.partyId)) }) : undefined,
    inv.vendorId ? db.query.vendors.findFirst({ where: and(eq(vendors.tenantId, t.id), eq(vendors.id, inv.vendorId)) }) : undefined,
  ]);
  const gstin = String(((vendor?.profile ?? {}) as { tax?: { gstin?: string } }).tax?.gstin ?? '') || party?.taxNo || null;
  return {
    tenant: t, basis: basisOf(basisSrc), po: po ?? null, contract: contract ?? null, party: party ?? null, vendorId: inv.vendorId,
    supplierGstin: gstin, supplierHold: vendor?.blockedAt ? vendor.blockedReason ?? 'held by your team' : null, entityCode: inv.entityCode ?? null, excludeInvoiceId,
    cleared: (inv.duplicateCleared ?? []).map((c) => c.invoiceId),
  };
}

/** The party of an onboarded supplier (created and linked the first time). */
export async function partyOfVendor(t: Tenant, vendorId: string, by: By) {
  const { vendorParty } = await import('../contracts/parties.js');
  return vendorParty(t, vendorId, { id: by.id ?? null, name: by.name, ip: by.ip } as never);
}

/** Payment terms → due date: PO, then contract, then party, then the workspace default. */
function dueDays(t: Tenant, s: CheckSubject) {
  return termDays(s.po?.paymentTerms) ?? termDays(s.party?.ap?.paymentTerms) ?? (invoicesOn(t) ? Number(invoiceRules(t).dueDays ?? 30) : null);
}

/* ---------------- AP: drafts and submit ---------------- */

async function loadParty(t: Tenant, id: string) {
  const p = await db.query.parties.findFirst({ where: and(eq(parties.tenantId, t.id), eq(parties.id, id)) });
  if (!p || p.kind !== 'SUPPLIER') throw new HttpError(400, 'Choose a supplier');
  return p;
}

async function checkLinks(t: Tenant, input: z.output<typeof apInvoiceInput>, party: Party) {
  if (input.kind === 'CREDIT' && !optionOn(t, 'creditNotes')) throw new HttpError(400, 'Credit notes are switched off in Administration → Invoices.');
  if (input.kind === 'DEBIT' && !optionOn(t, 'debitNotes')) throw new HttpError(400, 'Debit notes are switched off in Administration → Invoices.');
  if (input.kind !== 'INVOICE') return { po: null, contract: null };
  let po: PurchaseOrder | undefined, contract: Contract | undefined;
  if (input.poId) {
    assertBasisOn(t, 'po');
    po = await db.query.purchaseOrders.findFirst({ where: and(eq(purchaseOrders.tenantId, t.id), eq(purchaseOrders.id, input.poId)) });
    if (!po) throw new HttpError(400, 'Purchase order not found');
    if (!party.vendorId || po.vendorId !== party.vendorId) throw new HttpError(400, `Order ${po.poNumber} is for another supplier`);
  } else if (input.contractId) {
    assertBasisOn(t, 'contract');
    contract = await db.query.contracts.findFirst({ where: and(eq(contracts.tenantId, t.id), eq(contracts.id, input.contractId)) });
    if (!contract) throw new HttpError(400, 'Contract not found');
    if (contract.partyId !== party.id) throw new HttpError(400, `Contract ${contract.number} is with another party`);
    if (contract.direction !== 'BUY') throw new HttpError(400, 'Supplier invoices go against supplier contracts');
  } else assertBasisOn(t, 'nonPo');
  return { po: po ?? null, contract: contract ?? null };
}

/** A party's coding defaults fill empty lines (rent → Rent expense, Plant 1). */
const withDefaults = (lines: z.output<typeof lineInput>[], p: Party, coded: boolean) => (coded ? lines.map((l) => ({ ...l, glAccount: l.glAccount ?? p.ap?.defaultAccount ?? null, costCentre: l.costCentre ?? p.ap?.defaultCostCentre ?? null })) : lines);

/** Create or update an AP draft (invoice, credit note or debit note). Checks run and are shown; nothing is decided yet. */
export async function saveDraft(t: Tenant, id: string | null, raw: unknown, by: By & { source?: 'AP' | 'BULK' | 'EXCEL' | 'EMAIL' }) {
  assertInvoicesOn(t);
  const input = apInvoiceInput.parse(raw);
  // A credit or debit note follows its invoice's operating unit and currency unless given.
  if (input.relatedInvoiceId) {
    const rel = await db.query.supplierInvoices.findFirst({ where: and(eq(supplierInvoices.tenantId, t.id), eq(supplierInvoices.id, input.relatedInvoiceId)), columns: { entityCode: true, currency: true } });
    if (rel) { input.entityCode = input.entityCode ?? rel.entityCode; input.currency = input.currency ?? rel.currency; }
  }
  const party = await loadParty(t, input.partyId);
  const { po, contract } = await checkLinks(t, input, party);
  const existing = id ? await getInvoice(t, id) : null;
  if (existing && existing.status !== 'DRAFT') throw new HttpError(409, 'Only drafts can be changed');
  if (existing && existing.source === 'PORTAL') throw new HttpError(409, 'Invoices from the supplier portal are changed by the supplier');
  const coded = !po;
  const lines = withDefaults(input.lines, party, coded);
  const subject = await subjectFor(t, { poId: po?.id ?? null, contractId: contract?.id ?? null, partyId: party.id, vendorId: party.vendorId, relatedInvoiceId: input.relatedInvoiceId, entityCode: input.entityCode, duplicateCleared: existing?.duplicateCleared }, existing?.id);
  const m = await checkInvoice(subject, { ...input, invoiceNumber: input.invoiceNumber || 'DRAFT', lines, fileSha256: existing?.file?.sha256 ?? null });
  const due = input.dueDate ?? dueDateFrom(input.invoiceDate, dueDays(t, subject));
  return db.transaction(async (tx) => {
    let number = input.invoiceNumber;
    if (input.kind === 'DEBIT' && !number) number = existing?.invoiceNumber && existing.kind === 'DEBIT' ? existing.invoiceNumber : await nextYearlyNumber(tx, { table: supplierInvoices, tenantCol: supplierInvoices.tenantId, numberCol: supplierInvoices.invoiceNumber }, t.id, 'DN');
    if (!number) throw new HttpError(400, 'Enter the supplier’s invoice number');
    const values = {
      kind: input.kind, partyId: party.id, vendorId: party.vendorId, poId: po?.id ?? null, contractId: contract?.id ?? null, relatedInvoiceId: input.relatedInvoiceId,
      invoiceNumber: number, invoiceDate: input.invoiceDate, glDate: input.glDate ?? null, dueDate: due, currency: m.currency || input.currency || 'INR',
      subtotal: String(m.subtotal), taxAmount: String(m.tax), total: String(input.total), description: input.description ?? null, entityCode: input.entityCode,
      einvoice: input.einvoice && (input.einvoice.irn || input.einvoice.signedQr) ? cleanEinvoice(input.einvoice) : null,
      documentId: input.documentId ?? existing?.documentId ?? null, notes: input.notes ?? null, checks: m.checks,
    };
    const [row] = existing
      ? await tx.update(supplierInvoices).set(values).where(eq(supplierInvoices.id, existing.id)).returning()
      : await tx.insert(supplierInvoices).values({ ...values, tenantId: t.id, status: 'DRAFT', source: by.source ?? 'AP', submittedBy: by.name, createdById: by.id ?? null, ownerId: by.id ?? null }).returning();
    await tx.delete(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, row.id));
    if (m.lines.length) await tx.insert(supplierInvoiceLines).values(m.lines.map((l, i) => lineRow(t.id, row.id, l, i)));
    if (!existing) await audit({ tenantId: t.id, vendorId: party.vendorId, actor: by.name, action: 'INVOICE_DRAFTED', detail: { subjectId: row.id, invoice: row.invoiceNumber, kind: row.kind, party: party.code }, ip: by.ip });
    return row;
  });
}

const cleanEinvoice = (e: NonNullable<z.output<typeof einvoiceInput>>) => Object.fromEntries(Object.entries({ irn: e.irn?.trim().toLowerCase(), ackNo: e.ackNo?.trim(), ackDate: e.ackDate?.trim(), signedQr: e.signedQr?.trim() }).filter(([, v]) => v)) as Record<string, string>;
const lineRow = (tenantId: string, invoiceId: string, l: Awaited<ReturnType<typeof checkInvoice>>['lines'][number], i: number) => ({
  tenantId, invoiceId, lineId: l.lineId ?? null, lineNo: i + 1, itemCode: l.itemCode ?? null, description: l.description ?? null, uom: l.uom ?? null, hsn: l.hsn ?? null,
  quantity: String(l.quantity), unitPrice: String(l.unitPrice), amount: String(l.amount), taxRate: l.taxRate === null ? null : String(l.taxRate), taxAmount: String(l.taxAmount),
  glAccount: l.glAccount ?? null, costCentre: l.costCentre ?? null, project: l.project ?? null, task: l.task ?? null,
});

/** The stored draft as checker input. */
async function storedInput(inv: SupplierInvoice): Promise<CheckInput> {
  const lines = await db.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, inv.id)).orderBy(supplierInvoiceLines.lineNo);
  return {
    kind: inv.kind as InvoiceKind, invoiceNumber: inv.invoiceNumber, invoiceDate: inv.invoiceDate, currency: inv.currency, total: Number(inv.total), shipmentId: inv.shipmentId,
    einvoice: inv.einvoice, relatedInvoiceId: inv.relatedInvoiceId, fileSha256: inv.file?.sha256 ?? null,
    lines: lines.map((l) => ({ lineId: l.lineId, itemCode: l.itemCode, description: l.description, uom: l.uom, hsn: l.hsn, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice),
      taxRate: l.taxRate === null ? null : Number(l.taxRate), taxAmount: Number(l.taxAmount), glAccount: l.glAccount, costCentre: l.costCentre, project: l.project, task: l.task })),
  };
}

/** Run the checks again on a stored invoice and keep them (arrivals by email or bulk, “not a duplicate”). */
export async function recheckInvoice(t: Tenant, inv: SupplierInvoice) {
  const subject = await subjectFor(t, inv, inv.id);
  const m = await checkInvoice(subject, await storedInput(inv));
  const [row] = await db.update(supplierInvoices).set({ checks: m.checks }).where(eq(supplierInvoices.id, inv.id)).returning();
  return row;
}

/**
 * “Not a duplicate”: clear the earlier invoices the duplicate check matched as a warning (blocks can't be cleared), recorded with
 * who, when and why. An exception left with no warnings goes back to Submitted.
 */
export async function clearDuplicates(t: Tenant, id: string, note: string, by: By) {
  assertInvoicesOn(t);
  const inv = await getInvoice(t, id);
  if (!['DRAFT', 'SUBMITTED', 'EXCEPTION', 'IN_APPROVAL'].includes(inv.status)) throw new HttpError(409, 'This invoice has already been decided');
  if (!note.trim()) throw new HttpError(400, 'Say why it isn’t a duplicate');
  const found = inv.checks.filter((c) => c.level === 'warning' && c.refs?.length && c.rule);
  if (!found.length) throw new HttpError(409, 'No possible duplicates to clear');
  const at = new Date().toISOString();
  const add = found.flatMap((c) => c.refs!.map((r) => ({ invoiceId: r.id, number: r.number, rule: c.rule!, by: by.name, at, note: note.trim() })));
  await db.update(supplierInvoices).set({ duplicateCleared: [...inv.duplicateCleared, ...add] }).where(eq(supplierInvoices.id, inv.id));
  let row = await recheckInvoice(t, { ...inv, duplicateCleared: [...inv.duplicateCleared, ...add] });
  if (row.status === 'EXCEPTION' && !row.checks.some((c) => c.level === 'warning')) [row] = await db.update(supplierInvoices).set({ status: 'SUBMITTED' }).where(eq(supplierInvoices.id, inv.id)).returning();
  await audit({ tenantId: t.id, vendorId: inv.vendorId, actor: by.name, action: 'INVOICE_NOT_DUPLICATE', detail: { subjectId: inv.id, invoice: inv.invoiceNumber, of: add.map((a) => `${a.number} (${a.rule})`).join(', '), note: note.trim() }, ip: by.ip });
  return row;
}

/** Submit an AP draft: final checks (errors stop it), then the approval matrix or touchless. */
export async function submitDraft(t: Tenant, id: string, by: By) {
  assertInvoicesOn(t);
  const inv = await getInvoice(t, id);
  if (inv.status !== 'DRAFT') throw new HttpError(409, 'This invoice has already been submitted');
  if (!inv.documentId && !inv.file && inv.kind !== 'DEBIT' && inv.source !== 'EXCEL') throw new HttpError(400, 'Attach the invoice PDF first');
  if (!inv.partyId) throw new HttpError(400, 'Choose the supplier first');
  const subject = await subjectFor(t, inv, inv.id);
  const m = await checkInvoice(subject, await storedInput(inv));
  const errors = m.checks.filter((c) => c.level === 'error');
  if (errors.length) {
    await db.update(supplierInvoices).set({ checks: m.checks }).where(eq(supplierInvoices.id, inv.id));
    throw new HttpError(422, errors.map((e) => e.message).join('. '), { checks: m.checks }, 'INVOICE_CHECKS');
  }
  const [row] = await db.update(supplierInvoices).set({ status: m.checks.some((c) => c.level === 'warning') ? 'EXCEPTION' : 'SUBMITTED', checks: m.checks, submittedBy: by.name })
    .where(and(eq(supplierInvoices.id, inv.id), eq(supplierInvoices.status, 'DRAFT'))).returning();
  if (!row) throw new HttpError(409, 'This invoice changed — reload and try again');
  await audit({ tenantId: t.id, vendorId: row.vendorId, actor: by.name, action: 'INVOICE_SUBMITTED', detail: { subjectId: row.id, invoice: row.invoiceNumber, kind: row.kind, exceptions: row.status === 'EXCEPTION' }, ip: by.ip });
  return routeInvoice(t, row, by);
}

/* ---------------- routing: matrix, touchless ---------------- */

/** Rule context for the approval matrix (fields from invoiceApprovalCatalog). */
export async function ruleContext(t: Tenant, inv: SupplierInvoice) {
  const lines = await db.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, inv.id));
  const main = mainCoding(lines);
  const party = inv.partyId ? await db.query.parties.findFirst({ where: eq(parties.id, inv.partyId), columns: { code: true } }) : undefined;
  const basis = inv.kind === 'INVOICE' ? basisOf(inv) : (await subjectFor(t, inv)).basis;
  return { profile: { invoice: {
    amount: Number(inv.total), basis: BASIS_LABEL[basis], kind: inv.kind === 'CREDIT' ? 'Credit note' : inv.kind === 'DEBIT' ? 'Debit note' : 'Invoice',
    exception: inv.checks.some((c) => c.level === 'warning') ? 'Yes' : 'No', exceptionCodes: inv.checks.filter((c) => c.level === 'warning').map((c) => c.code).join(' '),
    entity: inv.entityCode ?? '', party: party?.code ?? '', costCentre: main.costCentre ?? '', account: main.account ?? '', project: main.project ?? '', currency: inv.currency,
    source: inv.source === 'PORTAL' ? 'Supplier portal' : 'AP',
  } } };
}
/** The coding with the largest amount — the invoice's "main" cost centre for approval. */
function mainCoding(lines: { amount: string; costCentre: string | null; glAccount: string | null; project: string | null }[]) {
  const by = new Map<string, number>();
  for (const l of lines) if (l.costCentre) by.set(l.costCentre, (by.get(l.costCentre) ?? 0) + Number(l.amount));
  const costCentre = [...by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const top = [...lines].sort((a, b) => Number(b.amount) - Number(a.amount))[0];
  return { costCentre, account: top?.glAccount ?? null, project: top?.project ?? null };
}

/**
 * After submit (portal or AP), with the add-on: start the approval matrix. No level applies → touchless approves a clean invoice
 * (when on and allowed for its basis and amount); otherwise it waits for one decision as before.
 */
export async function routeInvoice(t: Tenant, inv: SupplierInvoice, by: By): Promise<SupplierInvoice> {
  if (!invoicesOn(t)) return inv;
  const ctx = await ruleContext(t, inv);
  const levels = invoiceApprovalLevels(t);
  if (applicableFlowLevels(levels, ctx as never).length) {
    const [row] = await db.update(supplierInvoices).set({ status: 'IN_APPROVAL' }).where(eq(supplierInvoices.id, inv.id)).returning();
    await startFlow(t, 'invoice', inv.id, levels, ctx as never, { name: by.name, ip: by.ip });
    return row;
  }
  if (touchlessAllowed(t, inv)) return markApproved(t, inv, { name: 'VendorGate (touchless)', id: null }, 'Clean invoice — approved without anyone touching it');
  return inv;
}

function touchlessAllowed(t: Tenant, inv: SupplierInvoice) {
  if (!optionOn(t, 'touchless') || !isClean(inv.checks.filter((c) => c.level !== 'ok')) || inv.kind === 'DEBIT') return false;
  const r = invoiceRules(t);
  const basis = basisOf(inv);
  const allowed = r.touchlessBasis === 'all' ? true : r.touchlessBasis === 'poContract' ? basis !== 'nonPo' : basis === 'po';
  const upTo = r.touchlessUpTo === null || r.touchlessUpTo === undefined ? null : Number(r.touchlessUpTo);
  return allowed && (upTo === null || Number(inv.total) <= upTo);
}

/**
 * Forward for approval (AP assistant / manager → Procurement, the requesting department, the buyer…). In the matrix the
 * forwarded step goes in front of the pending level; waiting for one decision, the forwarded step comes first and then the
 * decision — by the person who forwarded when they may decide, else by an invoice approver.
 */
export async function forwardInvoice(t: Tenant, id: string, raw: unknown, by: By & { id: string; canDecide: boolean }) {
  assertInvoicesOn(t);
  const input = z.object({ userId: z.string().max(40).optional().nullable(), roleId: z.string().max(40).optional().nullable(), note: z.string().trim().min(1, 'Say what you need them to look at').max(1000) }).parse(raw);
  const inv = await getInvoice(t, id);
  if (!['SUBMITTED', 'EXCEPTION', 'IN_APPROVAL'].includes(inv.status)) throw new HttpError(409, 'Only invoices waiting for approval can be forwarded');
  let returnTo: { userId: string | null; roleId: string; label: string } | undefined;
  if (inv.status !== 'IN_APPROVAL') {
    const self = by.canDecide && inv.createdById !== by.id ? (await db.select({ roleId: schema.userRoles.roleId }).from(schema.userRoles).where(eq(schema.userRoles.userId, by.id)).limit(1))[0] : undefined;
    if (self) returnTo = { userId: by.id, roleId: self.roleId, label: `AP decision — ${by.name}` };
    else {
      const role = await db.query.roles.findFirst({ where: and(eq(schema.roles.tenantId, t.id), inArray(schema.roles.key, ['INVOICE_APPROVER', 'FINANCE_MANAGER'])), orderBy: (r, { desc }) => [desc(r.key)] });
      if (!role) throw new HttpError(409, 'No invoice approver role to return the invoice to');
      returnTo = { userId: null, roleId: role.id, label: 'AP decision' };
    }
  }
  const step = await forwardFlow(t, 'invoice', inv.id, { userId: input.userId ?? null, roleId: input.roleId ?? null, note: input.note }, { id: by.id, name: by.name, ip: by.ip }, { returnTo, allowed: true });
  if (inv.status !== 'IN_APPROVAL') await db.update(supplierInvoices).set({ status: 'IN_APPROVAL' }).where(eq(supplierInvoices.id, inv.id));
  return step;
}

/* ---------------- decisions ---------------- */

/** One decision for an invoice no matrix level applies to (and every invoice without the add-on). */
export async function decideInvoice(t: Tenant, inv: SupplierInvoice, decision: 'APPROVE' | 'REJECT', note: string | null, by: By) {
  if (inv.status === 'IN_APPROVAL') throw new HttpError(409, 'This invoice is in the approval matrix — approve it from its approval steps');
  if (inv.status !== 'SUBMITTED' && inv.status !== 'EXCEPTION') throw new HttpError(409, 'This invoice has already been decided');
  if (decision === 'REJECT' && !note) throw new HttpError(400, inv.source === 'PORTAL' ? 'Say why the invoice is rejected — the supplier sees it' : 'Say why the invoice is rejected');
  if (decision === 'APPROVE' && inv.status === 'EXCEPTION' && !note) throw new HttpError(400, 'This invoice has exceptions — add a note on why it can be approved');
  if (by.id && inv.createdById === by.id && invoicesOn(t)) throw new HttpError(403, 'You entered this invoice — someone else approves it');
  return decision === 'APPROVE' ? markApproved(t, inv, by, note) : markRejected(t, inv, by, note!);
}

/** Approved: billed quantities on the PO, then the ERP (now, or READY for AP) and the supplier's email. */
export async function markApproved(t: Tenant, inv: SupplierInvoice, by: By, note: string | null) {
  const row = await db.transaction(async (tx) => {
    const [r] = await tx.update(supplierInvoices).set({ status: 'APPROVED', decidedBy: by.name, decidedAt: new Date(), decisionNote: note })
      .where(and(eq(supplierInvoices.id, inv.id), inArray(supplierInvoices.status, ['SUBMITTED', 'EXCEPTION', 'IN_APPROVAL']))).returning();
    if (!r) throw new HttpError(409, 'This invoice changed — reload and try again');
    await applyBilled(tx, r, 1);
    return r;
  });
  await audit({ tenantId: t.id, vendorId: inv.vendorId, actor: by.email ?? by.name, action: 'INVOICE_APPROVED', detail: { subjectId: inv.id, invoice: inv.invoiceNumber, kind: inv.kind, ...(note ? { note } : {}) }, ip: by.ip });
  const { afterApproved } = await import('./erp.js');
  return afterApproved(t, row, by);
}

/** PO lines: invoices add billed quantity, credit notes take it back. */
async function applyBilled(tx: Tx, inv: SupplierInvoice, sign: 1 | -1) {
  if (inv.kind === 'DEBIT') return;
  const dir = (inv.kind === 'CREDIT' ? -1 : 1) * sign;
  for (const l of await tx.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, inv.id))) {
    if (l.lineId) await tx.update(poLines).set({ billedQty: sql`greatest(0, ${poLines.billedQty} + (${dir})::numeric * (${l.quantity})::numeric)` }).where(eq(poLines.id, l.lineId));
  }
}

async function markRejected(t: Tenant, inv: SupplierInvoice, by: By, note: string) {
  const [r] = await db.update(supplierInvoices).set({ status: 'REJECTED', decidedBy: by.name, decidedAt: new Date(), decisionNote: note })
    .where(and(eq(supplierInvoices.id, inv.id), inArray(supplierInvoices.status, ['SUBMITTED', 'EXCEPTION', 'IN_APPROVAL']))).returning();
  if (!r) throw new HttpError(409, 'This invoice changed — reload and try again');
  await audit({ tenantId: t.id, vendorId: inv.vendorId, actor: by.email ?? by.name, action: 'INVOICE_REJECTED', detail: { subjectId: inv.id, invoice: inv.invoiceNumber, note }, ip: by.ip });
  if (inv.source === 'PORTAL') await (await import('./notify.js')).tellSupplier(t, r, 'REJECTED', note);
  return r;
}

/** Withdraw: the supplier (portal, while in review) or AP (a draft, or one still in review). */
export async function cancelInvoice(t: Tenant, inv: SupplierInvoice, by: By, reason = 'Withdrawn by the supplier') {
  const from = inv.source === 'PORTAL' ? ['SUBMITTED', 'EXCEPTION', 'IN_APPROVAL'] : ['DRAFT', 'SUBMITTED', 'EXCEPTION', 'IN_APPROVAL'];
  const [row] = await db.update(supplierInvoices).set({ status: 'CANCELLED', decidedBy: by.name, decidedAt: new Date(), decisionNote: reason })
    .where(and(eq(supplierInvoices.id, inv.id), inArray(supplierInvoices.status, from))).returning();
  if (!row) throw new HttpError(409, 'Only invoices still in review can be withdrawn');
  if (inv.status === 'IN_APPROVAL') await cancelFlow(t.id, 'invoice', inv.id).catch(() => {});
  await audit({ tenantId: t.id, vendorId: inv.vendorId, actor: by.email ?? by.name, action: 'INVOICE_WITHDRAWN', detail: { subjectId: inv.id, invoice: inv.invoiceNumber }, ip: by.ip });
  return row;
}

export async function getInvoice(t: Tenant, id: string) {
  const inv = await db.query.supplierInvoices.findFirst({ where: and(eq(supplierInvoices.tenantId, t.id), eq(supplierInvoices.id, id)) });
  if (!inv) throw new HttpError(404, 'Invoice not found');
  return inv;
}

/* ---------------- the approval matrix (generic flow engine) ---------------- */

registerFlowSubject('invoice', {
  async describe(tenantId, id) {
    const inv = await db.query.supplierInvoices.findFirst({ where: and(eq(supplierInvoices.tenantId, tenantId), eq(supplierInvoices.id, id)) });
    if (!inv) return null;
    const party = inv.partyId ? await db.query.parties.findFirst({ where: eq(parties.id, inv.partyId), columns: { name: true } }) : undefined;
    const kind = inv.kind === 'CREDIT' ? 'Credit note' : inv.kind === 'DEBIT' ? 'Debit note' : 'Invoice';
    return { title: `${party?.name ?? 'Supplier'} · ${inv.currency} ${Number(inv.total).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, ref: inv.invoiceNumber, link: `/staff/ap/invoices/${inv.id}`, kind };
  },
  async approved(tenantId, id, by) {
    const t = (await db.query.tenants.findFirst({ where: eq(schema.tenants.id, tenantId) }))!;
    await markApproved(t, await getInvoice(t, id), { id: by.id, name: by.name }, null);
  },
  async returned(tenantId, id, decision, remarks, by) {
    const t = (await db.query.tenants.findFirst({ where: eq(schema.tenants.id, tenantId) }))!;
    const inv = await getInvoice(t, id);
    // AP invoices go back to a draft to fix; supplier-portal invoices can't be changed here, so sending back rejects them.
    if (decision === 'SEND_BACK' && inv.source !== 'PORTAL') {
      await db.update(supplierInvoices).set({ status: 'DRAFT', decisionNote: remarks, decidedBy: by.name }).where(eq(supplierInvoices.id, id));
      await audit({ tenantId, vendorId: inv.vendorId, actor: by.name, action: 'INVOICE_SENT_BACK', detail: { subjectId: id, invoice: inv.invoiceNumber, remarks } });
      return;
    }
    await markRejected(t, inv, { id: by.id, name: by.name }, remarks);
  },
  async blockedFor(tenantId, id, userId) {
    const inv = await db.query.supplierInvoices.findFirst({ where: and(eq(supplierInvoices.tenantId, tenantId), eq(supplierInvoices.id, id)), columns: { createdById: true } });
    return inv?.createdById === userId ? 'You entered this invoice — someone else approves it' : null;
  },
  async assigneeFor(tenantId, id, assignee) {
    if (assignee !== 'costCentreOwner') return null;
    const lines = await db.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, id));
    const cc = mainCoding(lines).costCentre;
    if (!cc) return null;
    const c = await db.query.invoiceCodes.findFirst({ where: and(eq(invoiceCodes.tenantId, tenantId), eq(invoiceCodes.kind, 'COST_CENTRE'), eq(invoiceCodes.code, cc)) });
    return c?.ownerId ?? null;
  },
});

export const invoiceFlow = (t: Tenant, id: string, userId?: string) => flowView(t.id, 'invoice', id, userId);
export { LIVE, APPROVED, basisOn };

/**
 * When the add-on is switched on: portal invoices (and payments) without a party get their supplier's party, so AP sees one
 * supplier list. Safe to run again; only rows without a party are touched.
 */
export async function linkInvoicesToParties(t: Tenant) {
  const vendorIds = (await db.selectDistinct({ v: supplierInvoices.vendorId }).from(supplierInvoices)
    .where(and(eq(supplierInvoices.tenantId, t.id), sql`${supplierInvoices.partyId} is null`, sql`${supplierInvoices.vendorId} is not null`))).map((r) => r.v!);
  let linked = 0;
  for (const v of vendorIds) {
    const p = await partyOfVendor(t, v, { name: 'VendorGate' });
    const r = await db.update(supplierInvoices).set({ partyId: p.id }).where(and(eq(supplierInvoices.tenantId, t.id), eq(supplierInvoices.vendorId, v), sql`${supplierInvoices.partyId} is null`)).returning({ id: supplierInvoices.id });
    await db.update(schema.supplierPayments).set({ partyId: p.id }).where(and(eq(schema.supplierPayments.tenantId, t.id), eq(schema.supplierPayments.vendorId, v), sql`${schema.supplierPayments.partyId} is null`));
    linked += r.length;
  }
  return { suppliers: vendorIds.length, invoices: linked };
}
