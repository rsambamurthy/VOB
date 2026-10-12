/** Purchase order building blocks shared by the staff and supplier screens. */
import type { ReactNode } from 'react';
import { fmtDate } from '../lib/format';

export type Acceptance = 'PENDING' | 'PARTIAL' | 'ACCEPTED' | 'AUTO_ACCEPTED';
export interface OrderRow {
  id: string; poNumber: string; revision: number; supplierCode?: string; vendorId: string | null; vendorName: string | null; vendorCode: string | null;
  entity: string | null; group: string | null; buyerName: string | null; currency: string; total: string | null; poDate: string | null;
  status: 'OPEN' | 'CLOSED' | 'CANCELLED'; acceptance: Acceptance; acceptDueAt: string | null; acceptedAt: string | null; source?: string;
  lines: number; pendingLines: number; firstNeedBy: string | null;
}
export interface Counts { all: number; waiting: number; accepted: number; autoAccepted: number; closed: number; unmapped: number; dueSoon: number }
export interface Line {
  id: string; lineNo: number; lineType: string; itemCode: string | null; description: string; uom: string | null; quantity: string; unitPrice: string; amount: string;
  taxCode: string | null; taxRate: string | null; hsn: string | null; site: { code: string; name: string } | null; needByDate: string | null; promisedDate: string | null;
  tolerancePct: string | null; receivedQty: string; billedQty: string; status: string; acceptance: Exclude<Acceptance, 'PARTIAL'>; acceptedAt: string | null; acceptedBy: string | null; acceptNote: string | null;
}
export interface OrderDetailData {
  po: OrderRow & { erpId: string; supplierCode: string; supplierSiteCode: string | null; buyerEmail: string | null; paymentTerms: string | null; incoterms: string | null; notes: string | null; poType: string | null; attachments: { name: string; url: string }[]; firstSeenAt: string; syncedAt: string };
  vendor?: { id: string; name: string; code: string; status: string } | null;
  entity: { code: string; name: string } | null;
  group: { code: string; name: string; autoAcceptDays: number | null } | null;
  lines: Line[];
  receipts: { id: string; lineId: string | null; receiptNumber: string; receiptDate: string | null; quantity: string }[];
  history: { id: string; actor: string; action: string; detail: any; createdAt: string }[];
}

export const ACCEPTANCE_LABEL: Record<Acceptance, string> = { PENDING: 'Awaiting acceptance', PARTIAL: 'Partly accepted', ACCEPTED: 'Accepted', AUTO_ACCEPTED: 'Auto-accepted' };
const CLS: Record<Acceptance, string> = { PENDING: 'badge-under_review', PARTIAL: 'badge-in_progress', ACCEPTED: 'badge-approved', AUTO_ACCEPTED: 'badge-auto' };

export function AcceptanceBadge({ a, status }: { a: Acceptance; status?: string }) {
  if (status === 'CANCELLED') return <span className="badge badge-rejected">Cancelled</span>;
  if (status === 'CLOSED') return <span className="badge badge-invited">Closed</span>;
  return <span className={`badge ${CLS[a]}`}>{ACCEPTANCE_LABEL[a]}</span>;
}

export const money = (v: string | number | null | undefined, cur = 'INR') =>
  v === null || v === undefined ? '—' : new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(Number(v));
export const qty = (v: string | number | null | undefined) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 4 }));

/** "Auto-accepts in 3 days" / "Accept manually" etc. */
export function DueText({ po }: { po: Pick<OrderRow, 'acceptance' | 'acceptDueAt' | 'status'> }) {
  if (po.status !== 'OPEN' || (po.acceptance !== 'PENDING' && po.acceptance !== 'PARTIAL')) return null;
  if (!po.acceptDueAt) return <span className="muted small">Needs manual acceptance</span>;
  const days = Math.ceil((new Date(po.acceptDueAt).getTime() - Date.now()) / 86_400_000);
  return <span className={`small ${days <= 1 ? 'warn-text' : 'muted'}`}>{days <= 0 ? 'Auto-accepts today' : `Auto-accepts in ${days} day${days === 1 ? '' : 's'}`}</span>;
}

export function LinesTable({ lines, currency, select }: { lines: Line[]; currency: string; select?: { selected: Set<string>; toggle: (id: string) => void; toggleAll: (on: boolean) => void } }) {
  const pending = lines.filter((l) => l.acceptance === 'PENDING' && l.status === 'OPEN');
  const anyReceived = lines.some((l) => Number(l.receivedQty) > 0);
  return (
    <div className="table-wrap">
      <table className="table static compact lines-table">
        <thead><tr>
          {select && <th className="chk">{pending.length > 0 && <input type="checkbox" aria-label="Select all lines waiting for acceptance" checked={pending.every((l) => select.selected.has(l.id))} onChange={(e) => select.toggleAll(e.target.checked)} />}</th>}
          <th>Line</th><th>Item</th><th className="num">Quantity</th><th className="num">Unit price</th><th className="num">Amount</th><th>Deliver to</th><th>Need by</th>{anyReceived && <th className="num">Received</th>}<th>Acceptance</th>
        </tr></thead>
        <tbody>{lines.map((l) => {
          const open = l.acceptance === 'PENDING' && l.status === 'OPEN';
          return (
            <tr key={l.id} className={select?.selected.has(l.id) ? 'selected' : ''}>
              {select && <td className="chk">{open && <input type="checkbox" aria-label={`Select line ${l.lineNo}`} checked={select.selected.has(l.id)} onChange={() => select.toggle(l.id)} />}</td>}
              <td className="mono-num">{l.lineNo}</td>
              <td className="item-cell"><div className="strong">{l.description}</div><div className="muted small">{[l.itemCode, l.hsn && `HSN ${l.hsn}`, l.taxCode, l.lineType === 'SERVICE' ? 'Service' : null].filter(Boolean).join(' · ')}</div></td>
              <td className="num nowrap">{qty(l.quantity)} {l.uom}</td>
              <td className="num">{money(l.unitPrice, currency)}</td>
              <td className="num strong">{money(l.amount, currency)}</td>
              <td className="small">{l.site ? <>{l.site.name}<div className="muted">{l.site.code}</div></> : '—'}</td>
              <td className="small nowrap">{fmtDate(l.needByDate)}</td>
              {anyReceived && <td className="num small">{Number(l.receivedQty) ? qty(l.receivedQty) : '—'}</td>}
              <td>{l.status !== 'OPEN' ? <span className="badge badge-invited">{l.status === 'CANCELLED' ? 'Cancelled' : 'Closed'}</span> : l.acceptance === 'PENDING' ? <span className="badge badge-under_review">Waiting</span> : <AcceptanceBadge a={l.acceptance} />}
                {l.acceptedBy && <div className="muted small" title={l.acceptNote ?? ''}>{l.acceptance === 'AUTO_ACCEPTED' ? 'automatically' : l.acceptedBy.replace(/ <.*>$/, '')}</div>}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

export function Facts({ items }: { items: [string, ReactNode][] }) {
  return <dl className="facts">{items.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}
