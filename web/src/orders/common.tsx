/** Purchase order building blocks shared by the staff and supplier screens. */
import type { ReactNode } from 'react';
import { fmtDate, money, num } from '../lib/format';
import { t } from '../i18n';

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
  if (status === 'CANCELLED') return <span className="badge badge-rejected">{t('acc.cancelled')}</span>;
  if (status === 'CLOSED') return <span className="badge badge-invited">{t('acc.closed')}</span>;
  return <span className={`badge ${CLS[a]}`}>{t(`acc.${a}`)}</span>;
}

export { money };
export const qty = (v: string | number | null | undefined) => (v === null || v === undefined ? '—' : num(Number(v), { maximumFractionDigits: 4 }));

/** "Auto-accepts in 3 days" / "Accept manually" etc. */
export function DueText({ po }: { po: Pick<OrderRow, 'acceptance' | 'acceptDueAt' | 'status'> }) {
  if (po.status !== 'OPEN' || (po.acceptance !== 'PENDING' && po.acceptance !== 'PARTIAL')) return null;
  if (!po.acceptDueAt) return <span className="muted small">{t('acc.manual')}</span>;
  const days = Math.ceil((new Date(po.acceptDueAt).getTime() - Date.now()) / 86_400_000);
  return <span className={`small ${days <= 1 ? 'warn-text' : 'muted'}`}>{days <= 0 ? t('acc.autoToday') : t('acc.autoIn', { count: days })}</span>;
}

export function LinesTable({ lines, currency, select }: { lines: Line[]; currency: string; select?: { selected: Set<string>; toggle: (id: string) => void; toggleAll: (on: boolean) => void } }) {
  const pending = lines.filter((l) => l.acceptance === 'PENDING' && l.status === 'OPEN');
  const anyReceived = lines.some((l) => Number(l.receivedQty) > 0);
  return (
    <div className="table-wrap">
      <table className="table static compact lines-table">
        <thead><tr>
          {select && <th className="chk">{pending.length > 0 && <input type="checkbox" aria-label={t('lines.selectAll')} checked={pending.every((l) => select.selected.has(l.id))} onChange={(e) => select.toggleAll(e.target.checked)} />}</th>}
          <th>{t('common.line')}</th><th>{t('common.item')}</th><th className="num">{t('common.quantity')}</th><th className="num">{t('common.unitPrice')}</th><th className="num">{t('lines.amount')}</th><th>{t('lines.deliverTo')}</th><th>{t('lines.needBy')}</th>{anyReceived && <th className="num">{t('lines.received')}</th>}<th>{t('lines.acceptance')}</th>
        </tr></thead>
        <tbody>{lines.map((l) => {
          const open = l.acceptance === 'PENDING' && l.status === 'OPEN';
          return (
            <tr key={l.id} className={select?.selected.has(l.id) ? 'selected' : ''}>
              {select && <td className="chk">{open && <input type="checkbox" aria-label={t('lines.select', { n: l.lineNo })} checked={select.selected.has(l.id)} onChange={() => select.toggle(l.id)} />}</td>}
              <td className="mono-num">{l.lineNo}</td>
              <td className="item-cell"><div className="strong">{l.description}</div><div className="muted small">{[l.itemCode, l.hsn && `HSN ${l.hsn}`, l.taxCode, l.lineType === 'SERVICE' ? t('lines.service') : null].filter(Boolean).join(' · ')}</div></td>
              <td className="num nowrap">{qty(l.quantity)} {l.uom}</td>
              <td className="num">{money(l.unitPrice, currency)}</td>
              <td className="num strong">{money(l.amount, currency)}</td>
              <td className="small">{l.site ? <>{l.site.name}<div className="muted">{l.site.code}</div></> : '—'}</td>
              <td className="small nowrap">{fmtDate(l.needByDate)}</td>
              {anyReceived && <td className="num small">{Number(l.receivedQty) ? qty(l.receivedQty) : '—'}</td>}
              <td>{l.status !== 'OPEN' ? <span className="badge badge-invited">{l.status === 'CANCELLED' ? t('acc.cancelled') : t('acc.closed')}</span> : l.acceptance === 'PENDING' ? <span className="badge badge-under_review">{t('acc.waiting')}</span> : <AcceptanceBadge a={l.acceptance} />}
                {l.acceptedBy && <div className="muted small" title={l.acceptNote ?? ''}>{l.acceptance === 'AUTO_ACCEPTED' ? t('acc.automatically') : l.acceptedBy.replace(/ <.*>$/, '')}</div>}</td>
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
