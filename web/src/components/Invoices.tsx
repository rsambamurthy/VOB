/**
 * Invoices add-on (accounts payable) — shared pieces for the AP screens: types, status badges, the entry setup (code lists),
 * code pickers and the line editor used by new invoices, credit / debit notes and drafts. Supplier-portal invoices keep
 * their own screens (orders/collab.tsx); the AP invoice page reuses `ChecksList` from there.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { money } from '../lib/format';
import type { Check } from '../orders/collab';
import type { FlowViewData } from './ApprovalFlow';

export type InvKind = 'INVOICE' | 'CREDIT' | 'DEBIT';
export type Basis = 'po' | 'contract' | 'nonPo';
export const KIND_LABEL: Record<InvKind, string> = { INVOICE: 'Invoice', CREDIT: 'Credit note', DEBIT: 'Debit note' };
export const BASIS_LABEL: Record<Basis, string> = { po: 'Purchase order', contract: 'Contract', nonPo: 'Without a PO or contract' };
export const SOURCE_LABEL: Record<string, string> = { PORTAL: 'Supplier portal', AP: 'Entered by AP', BULK: 'Bulk upload', EXCEL: 'Excel import', EMAIL: 'Email inbox' };

export interface ApRow {
  id: string; kind: InvKind; invoiceNumber: string; invoiceDate: string; currency: string; total: number; paidAmount: number; status: string; statusLabel: string;
  erpStatus: string | null; erpLabel: string | null; dueDate: string | null; basis: Basis; basisLabel: string; source: string; warnings: number; errors: number;
  poNumber: string | null; contractNumber: string | null; partyName: string | null; partyCode: string | null; createdAt: string;
}
export interface Counts { drafts: number; review: number; exceptions: number; inApproval: number; ready: number; failed: number; unpaid: number; overdue: number; paid: number; rejected: number; all: number }
export interface Line {
  id?: string; lineId?: string | null; lineNo?: number; itemCode: string | null; description: string | null; uom?: string | null; hsn?: string | null; quantity: number; unitPrice: number; taxRate: number | null;
  amount?: number; taxAmount?: number; poPrice?: number | null; ordered?: number | null; received?: number | null;
  glAccount: string | null; costCentre: string | null; project: string | null; task: string | null;
}
export interface ApDetail {
  invoice: ApRow & { subtotal: number; taxAmount: number; checks: Check[]; notes: string | null; description: string | null; submittedBy: string; decidedBy: string | null; decisionNote: string | null; decidedAt: string | null;
    erpInvoiceId: string | null; erpError: string | null; erpHolds: { code: string; reason?: string }[] | null; erpSentAt: string | null; emailedAt: string | null; entityCode: string | null; glDate: string | null;
    relatedInvoiceId: string | null; netPayable: number | null; poId: string | null; contractId: string | null; partyId: string | null; einvoice: { irn?: string; ackNo?: string; ackDate?: string; qr: boolean } | null };
  po: { id: string; poNumber: string; paymentTerms: string | null } | null;
  party: { id: string; name: string; code: string; taxNo: string | null; ap: Record<string, string> | null } | null;
  vendor: { id: string | null; name: string; code: string } | null;
  contract: { id: string; number: string; title: string } | null;
  related: { id: string; invoiceNumber: string; invoiceDate: string; total: number; status: string } | null;
  notesOnIt: { id: string; kind: InvKind; invoiceNumber: string; total: number; status: string }[];
  lines: (Line & { id: string; amount: number; taxAmount: number })[];
  payments: { id: string; reference: string; paymentDate: string; method: string | null; currency: string; amount: number; withheld: number }[];
  flow: FlowViewData; messages: { id: string; status: string; connector: string; error: string | null; sentAt: string | null; createdAt: string }[];
  file: string | null; debitNoteTo: string | null;
  duplicateCleared: { invoiceId: string; number: string; rule: string; by: string; at: string; note: string }[];
  mail: { id: string; fromAddress: string | null; fromName: string | null; subject: string | null; receivedAt: string } | null;
  can: { edit: boolean; submit: boolean; decide: boolean; cancel: boolean; push: boolean; email: boolean; creditNote: boolean; debitNote: boolean; forward: boolean; clearDuplicate: boolean };
}
export type DupCheck = Check & { rule?: string; refs?: { id: string; number: string }[] };
export interface CodeOption { code: string; name: string; parent: string | null }
export interface InvoiceSetup {
  codes: Record<'ENTITY' | 'ACCOUNT' | 'COST_CENTRE' | 'PROJECT' | 'TASK' | 'TAX', CodeOption[]>;
  settings: { on: boolean; bases: Basis[]; creditNotes: boolean; debitNotes: boolean; pushMode: string; bulkUpload: boolean; excelImport: boolean };
  currency: string; costCentreRequired: boolean;
}

const STATUS_CLS: Record<string, string> = {
  DRAFT: 'badge-invited', SUBMITTED: 'badge-under_review', EXCEPTION: 'badge-sent_back', IN_APPROVAL: 'flag-medium', APPROVED: 'badge-approved', PARTLY_PAID: 'badge-in_progress', PAID: 'badge-auto', REJECTED: 'badge-rejected', CANCELLED: 'badge-invited',
};
const ERP_CLS: Record<string, string> = { READY: 'badge-under_review', SENT: 'badge-in_progress', IMPORTED: 'badge-approved', FAILED: 'badge-rejected' };
export const ApStatus = ({ status, label }: { status: string; label: string }) => <span className={`badge sm ${STATUS_CLS[status] ?? ''}`}>{label}</span>;
export const ErpBadge = ({ status, label }: { status: string | null; label: string | null }) => (status ? <span className={`badge sm ${ERP_CLS[status] ?? ''}`}>{label}</span> : null);

export function useInvoiceSetup() {
  const [setup, setSetup] = useState<InvoiceSetup>();
  useEffect(() => { api<InvoiceSetup>('/staff/invoices/setup').then(setSetup).catch(() => {}); }, []);
  return setup;
}

/** Code lists for the pickers (one datalist per list, rendered once on the page). */
export const CODE_LIST: Record<'ENTITY' | 'ACCOUNT' | 'COST_CENTRE' | 'PROJECT' | 'TASK', string> = { ENTITY: 'inv-entities', ACCOUNT: 'inv-accounts', COST_CENTRE: 'inv-ccs', PROJECT: 'inv-projects', TASK: 'inv-tasks' };
export function CodeLists({ setup }: { setup: InvoiceSetup }) {
  return <>{(Object.keys(CODE_LIST) as (keyof typeof CODE_LIST)[]).map((k) => (
    <datalist key={k} id={CODE_LIST[k]}>{(setup.codes[k] ?? []).map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</datalist>))}</>;
}

export const blankLine = (): Line => ({ itemCode: null, description: '', quantity: 1, unitPrice: 0, taxRate: null, glAccount: null, costCentre: null, project: null, task: null });
const r2 = (n: number) => Math.round(n * 100) / 100;
export const lineTotal = (l: Line) => r2(l.quantity * l.unitPrice * (1 + (l.taxRate ?? 0) / 100));

/**
 * Lines of an invoice or note. `po` = lines are PO lines (quantity and price only; coding comes from the order); otherwise
 * each line is coded to a GL account and cost centre from the code lists.
 */
export function LinesEditor({ lines, onChange, currency, po, setup }: { lines: Line[]; onChange: (l: Line[]) => void; currency: string; po?: boolean; setup: InvoiceSetup }) {
  const set = (i: number, patch: Partial<Line>) => onChange(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const num = (v: string) => (v === '' ? 0 : Number(v));
  const total = r2(lines.reduce((t, l) => t + lineTotal(l), 0));
  return (
    <div className="table-wrap">
      <table className="table static compact inv-lines">
        <thead><tr><th>{po ? 'Order line' : 'Description'}</th><th className="num">Quantity</th><th className="num">Unit price</th><th className="num">Tax %</th>
          {!po && <><th>GL account</th><th>Cost centre{setup.costCentreRequired ? '' : ' (optional)'}</th><th>Project</th></>}<th className="num">Amount</th><th /></tr></thead>
        <tbody>{lines.map((l, i) => (
          <tr key={i}>
            <td>{po ? <><span className="mono-num">{l.lineNo}</span> {l.description}<div className="muted small">{l.itemCode}{l.ordered != null && ` · ordered ${l.ordered}, received ${l.received ?? 0}`}{l.poPrice != null && ` · PO price ${money(l.poPrice, currency)}`}</div></>
              : <input aria-label={`Line ${i + 1} description`} value={l.description ?? ''} onChange={(e) => set(i, { description: e.target.value })} />}</td>
            <td className="num"><input className="num-input" aria-label={`Line ${i + 1} quantity`} inputMode="decimal" value={l.quantity} onChange={(e) => set(i, { quantity: num(e.target.value) })} /></td>
            <td className="num"><input className="num-input" aria-label={`Line ${i + 1} unit price`} inputMode="decimal" value={l.unitPrice} onChange={(e) => set(i, { unitPrice: num(e.target.value) })} /></td>
            <td className="num"><input className="num-input sm" aria-label={`Line ${i + 1} tax rate`} inputMode="decimal" value={l.taxRate ?? ''} onChange={(e) => set(i, { taxRate: e.target.value === '' ? null : Number(e.target.value) })} /></td>
            {!po && <>
              <td><input list={CODE_LIST.ACCOUNT} className="code-input" aria-label={`Line ${i + 1} GL account`} value={l.glAccount ?? ''} onChange={(e) => set(i, { glAccount: e.target.value || null })} /></td>
              <td><input list={CODE_LIST.COST_CENTRE} className="code-input" aria-label={`Line ${i + 1} cost centre`} value={l.costCentre ?? ''} onChange={(e) => set(i, { costCentre: e.target.value || null })} /></td>
              <td><input list={CODE_LIST.PROJECT} className="code-input" aria-label={`Line ${i + 1} project`} value={l.project ?? ''} onChange={(e) => set(i, { project: e.target.value || null })} /></td>
            </>}
            <td className="num nowrap">{money(lineTotal(l), currency)}</td>
            <td className="actions"><button type="button" className="link-btn small danger" aria-label={`Remove line ${i + 1}`} onClick={() => onChange(lines.filter((_, k) => k !== i))}>Remove</button></td>
          </tr>))}</tbody>
        <tfoot><tr><td colSpan={po ? 4 : 7} className="num muted small">Lines with tax</td><td className="num strong">{money(total, currency)}</td><td /></tr></tfoot>
      </table>
      {!po && <div className="pad"><button type="button" className="btn btn-secondary btn-sm" onClick={() => onChange([...lines, blankLine()])}>+ Add line</button></div>}
    </div>
  );
}
