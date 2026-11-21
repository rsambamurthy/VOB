/**
 * Invoices add-on (accounts payable) — the one place that decides what is on. Same layers as Sourcing and Contracts
 * (lib/moduleConfig.ts): plan / licence feature `invoices` → workspace switch → invoice bases (PO, contract, non-PO)
 * → options → rule defaults → per invoice. Use `invoicesOn` / `basisOn` / `optionOn` / `invoiceRules`; never read
 * `settings.invoices` by hand.
 *
 * Without the add-on, suppliers on plans with purchase orders still raise PO invoices in the portal, decided in one step
 * (services/collab/invoices.ts); with it, those invoices go through the approval matrix, touchless and ERP push here.
 */
import { z } from 'zod';
import type { Tenant } from '../../db/schema.js';
import type { WorkflowLevel } from '../../config/types.js';
import { defineModule, type KindDef, type OptionDef, type RuleDef } from '../../lib/moduleConfig.js';
import { effectiveLimits } from '../../lib/plans.js';

/** What an invoice is matched against. */
export const BASES = {
  po: { label: 'Purchase order invoices', help: 'Matched to the order lines, receipts (3-way) and earlier invoices.', available: true },
  contract: { label: 'Contract invoices', help: 'No purchase order: checked against the contract’s agreed prices, value and term.', available: true },
  nonPo: { label: 'Invoices without a PO or contract', help: 'Rent, utilities, services: each line coded to a GL account and cost centre.', available: true },
} as const satisfies Record<string, KindDef>;
export type Basis = keyof typeof BASES;
export const BASIS_KEYS = Object.keys(BASES) as Basis[];
export const BASIS_LABEL: Record<Basis, string> = { po: 'PO', contract: 'Contract', nonPo: 'Non-PO' };

type Area = 'capture' | 'approval' | 'notes' | 'ai';
const AREA_LABELS: Record<Area, string> = { capture: 'Capturing invoices', approval: 'Approval and ERP', notes: 'Credit and debit notes', ai: 'AI' };
interface InvoiceOptionDef extends OptionDef { area: Area }

export const OPTIONS = {
  bulkUpload: { area: 'capture', label: 'Bulk upload', help: 'AP uploads up to 25 PDFs (or a .zip) at once; each becomes a draft to complete.', default: true, available: true },
  excelImport: { area: 'capture', label: 'Excel import', help: 'Invoices keyed elsewhere or back-loaded, one row per line; checked before import.', default: true, available: true },
  touchless: { area: 'approval', label: 'Touchless processing', help: 'A clean invoice — every check passed, no exception, no matrix level that needs a person — is approved without anyone touching it.', default: false, available: true },
  creditNotes: { area: 'notes', label: 'Credit notes', help: 'Credit notes from suppliers, linked to the invoice they correct.', default: true, available: true },
  debitNotes: { area: 'notes', label: 'Debit notes', help: 'Debit notes raised by AP (short supply, rejected goods, price difference, penalty) with a PDF.', default: true, available: true },
  readInvoices: { area: 'ai', label: 'Read uploaded invoices', help: 'Suggest the header, lines and tax from the PDF, masked before any AI.', default: false, available: false, requires: 'ai' },
  emailInbox: { area: 'capture', label: 'Email inbox', help: 'Invoices emailed to the workspace’s invoices address arrive as drafts.', default: false, available: false },
} as const satisfies Record<string, InvoiceOptionDef>;
export type InvoiceOption = keyof typeof OPTIONS;

export const RULES = {
  priceTolerance: { kind: 'number', workspace: true, label: 'Price tolerance', help: 'Unit prices up to this much above the PO or contract price are accepted without an exception.', min: 0, max: 50, step: 0.5, unit: '%', default: 2 },
  costCentre: { kind: 'choice', workspace: true, label: 'Cost centre on lines', help: 'Whether every coded line needs a cost centre.', options: { required: 'Required', optional: 'Optional' }, default: 'required' },
  touchlessBasis: { kind: 'choice', requires: 'touchless', workspace: true, label: 'Touchless for', help: 'Which clean invoices may be approved without anyone touching them.', options: { po: 'PO invoices only', poContract: 'PO and contract invoices', all: 'All invoices' }, default: 'po' },
  touchlessUpTo: { kind: 'number', requires: 'touchless', workspace: true, label: 'Touchless up to', help: 'Largest invoice total approved without anyone touching it. Empty = any amount.', min: 0, max: 1_000_000_000, step: 1, nullable: true, default: null },
  pushMode: { kind: 'choice', workspace: true, label: 'Send to the ERP', help: 'Automatic: each approved invoice goes to the ERP at once. Manual: approved invoices wait in “Ready for ERP” until AP sends them.', options: { automatic: 'Automatic', manual: 'Manual' }, default: 'manual' },
  debitNoteEmail: { kind: 'choice', requires: 'debitNotes', workspace: true, label: 'Email debit notes to the supplier', help: 'When an approved debit note is emailed to the supplier’s accounts contact, with the PDF.', options: { auto: 'Automatically when approved', ask: 'AP chooses per debit note', never: 'Never (record only)' }, default: 'ask' },
  dueDays: { kind: 'number', workspace: true, label: 'Default payment terms', help: 'Days to the due date when the PO, contract or party has no payment terms.', min: 0, max: 365, step: 1, unit: 'days', default: 30 },
} as const satisfies Record<string, RuleDef>;
export type InvoiceRule = keyof typeof RULES;

const M = defineModule({
  name: 'Invoices', feature: 'invoices', settingsKey: 'invoices', kindsKey: 'bases', kindNoun: 'invoice basis',
  kinds: BASES, options: OPTIONS, areas: AREA_LABELS, rules: RULES as Record<InvoiceRule, RuleDef>,
  keep: ['approval', 'erp'],
});

export const invoicesLicensed = M.licensed;
export const invoicesOn = M.on;
export const basisOn = (t: Tenant, b: Basis) => M.kindState(t, b).on;
export const optionOn = M.optionOn;
export const assertInvoicesOn = M.assertOn;
export const assertBasisOn = M.assertKindOn;
export const invoiceRules = (t: Tenant) => M.resolveRules(t, {}, 'invoice');
export const checkInvoicesSettings = M.checkSettings;
export function invoicesConfig(t: Tenant) {
  const { kinds, ...c } = M.config(t);
  return { ...c, bases: kinds };
}
export function invoicesSummary(t: Tenant) {
  const s = M.summary(t);
  return { on: s.on, bases: s.kinds, creditNotes: s.on && optionOn(t, 'creditNotes'), debitNotes: s.on && optionOn(t, 'debitNotes'), pushMode: s.on ? String(invoiceRules(t).pushMode ?? 'manual') : 'manual',
    bulkUpload: s.on && optionOn(t, 'bulkUpload'), excelImport: s.on && optionOn(t, 'excelImport') };
}

/** Price tolerance (%) for PO and contract price checks: the add-on's rule, else the purchasing setting (portal invoices). */
export const priceTolerance = (t: Tenant) => (invoicesOn(t) ? Number(invoiceRules(t).priceTolerance ?? 2) : Number(t.settings.priceTolerancePct ?? 2));

/* ---------------- Oracle account format ---------------- */

/**
 * How a line's coding becomes Oracle's concatenated account (DIST_CODE_CONCATENATED), e.g. "{entity}.{costCentre}.{account}.000".
 * Placeholders: {entity} {costCentre} {account} {project}. Kept with the invoice settings, not the ERP connection, so it can
 * be set before the connection is live.
 */
export const erpSchema = z.object({ accountFormat: z.string().trim().min(3).max(120).regex(/\{account\}/, 'The format must contain {account}') }).strict();
export const DEFAULT_ACCOUNT_FORMAT = '{costCentre}.{account}';
export const accountFormat = (t: Tenant) => ((M.stored(t).erp as { accountFormat?: string } | undefined)?.accountFormat) || DEFAULT_ACCOUNT_FORMAT;
export function concatenatedAccount(t: Tenant, c: { entity?: string | null; costCentre?: string | null; account?: string | null; project?: string | null }) {
  if (!c.account) return null;
  return accountFormat(t).replace(/\{(\w+)\}/g, (_, k: string) => String((c as Record<string, unknown>)[k] ?? '')).replace(/\.\.+/g, '.').replace(/^\.|\.$/g, '');
}

/* ---------------- approval matrix ---------------- */

const yesNo = { type: 'select', options: ['Yes', 'No'] };
export const invoiceApprovalCatalog = () => [
  { id: 'invoice.amount', label: 'Invoice total', type: 'number' },
  { id: 'invoice.basis', label: 'PO, contract or non-PO', type: 'select', options: ['PO', 'Contract', 'Non-PO'] },
  { id: 'invoice.kind', label: 'Invoice or note', type: 'select', options: ['Invoice', 'Credit note', 'Debit note'] },
  { id: 'invoice.exception', label: 'Has an exception', ...yesNo },
  { id: 'invoice.exceptionCodes', label: 'Exception (check code)', type: 'text' },
  { id: 'invoice.entity', label: 'Operating unit', type: 'text' },
  { id: 'invoice.party', label: 'Supplier (party code)', type: 'text' },
  { id: 'invoice.costCentre', label: 'Cost centre', type: 'text' },
  { id: 'invoice.account', label: 'GL account', type: 'text' },
  { id: 'invoice.project', label: 'Project', type: 'text' },
  { id: 'invoice.currency', label: 'Currency', type: 'text' },
  { id: 'invoice.source', label: 'Entered by', type: 'select', options: ['Supplier portal', 'AP'] },
];
export const INVOICE_ASSIGNEES = [{ key: 'costCentreOwner', label: 'Owner of the invoice’s main cost centre' }];

const gt = (field: string, value: number) => ({ match: 'all' as const, conditions: [{ field, op: 'gt' as const, value }] });
const eq = (field: string, value: string) => ({ match: 'all' as const, conditions: [{ field, op: 'eq' as const, value }] });
export const DEFAULT_INVOICE_APPROVAL: WorkflowLevel[] = [
  { id: 'budget', label: 'Budget owner', roleKey: 'INVOICE_APPROVER', assignee: 'costCentreOwner', rule: eq('invoice.basis', 'Non-PO'), slaHours: 48 },
  { id: 'review', label: 'AP review', roleKey: 'INVOICE_APPROVER', rule: eq('invoice.exception', 'Yes'), slaHours: 24 },
  { id: 'finance', label: 'Finance approval', roleKey: 'INVOICE_APPROVER', rule: gt('invoice.amount', 1_000_000), slaHours: 48 },
  { id: 'director', label: 'Director approval', roleKey: 'ADMIN', rule: gt('invoice.amount', 10_000_000), slaHours: 72 },
];
/** Without the AP roles (they come with the add-on) the default levels fall back to Finance Manager / Administrator. */
export function invoiceApprovalLevels(t: Tenant): WorkflowLevel[] {
  const stored = (M.stored(t).approval as { levels?: WorkflowLevel[] } | undefined)?.levels;
  if (stored) return stored;
  return effectiveLimits(t).features.invoices ? DEFAULT_INVOICE_APPROVAL : DEFAULT_INVOICE_APPROVAL.map((l) => (l.roleKey === 'INVOICE_APPROVER' ? { ...l, roleKey: 'FINANCE_MANAGER' } : l));
}
