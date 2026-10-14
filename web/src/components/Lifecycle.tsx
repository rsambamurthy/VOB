import { useState } from 'react';
import type { ChangeRequest, CrStatus, FieldChange, Flag, Profile, SectionDef } from '../lib/types';

/** Fields the server masks for staff (PAN, bank account…); full values need a logged reveal. */
/** Which fields are masked / flagged comes from the server (country packs); these defaults cover the time before it loads. */
export const MASKED_FIELDS: string[] = ['tax.pan', 'tax.tan', 'tax.foreignTin', 'bank.accountNumber', 'bank.iban'];
const KEY_CHANGE = new Set(['tax.gstin', 'tax.pan', 'basic.vendorName']);
export function setFieldMeta(m?: { masked: string[]; keyChange: string[] }) {
  if (!m) return;
  MASKED_FIELDS.splice(0, MASKED_FIELDS.length, ...m.masked);
  KEY_CHANGE.clear(); m.keyChange.forEach((f) => KEY_CHANGE.add(f));
}
export const isMasked = (v: unknown) => typeof v === 'string' && v.includes('•');
import { fmtDate, fmtDateTime } from '../lib/format';
import { StepBadge } from './ui';

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
/** Field-level differences between the registered profile and an edited copy. */
export function diffProfiles(sections: SectionDef[], before: Profile, after: Profile): FieldChange[] {
  const out: FieldChange[] = [];
  for (const s of sections) for (const g of s.groups) for (const f of g.fields) {
    const a = str(before[s.key]?.[f.key]).trim(), b = str(after[s.key]?.[f.key]).trim();
    if (a !== b) out.push({ fieldId: `${s.key}.${f.key}`, label: f.label, old: a, new: b });
  }
  return out;
}

/** Whole days from today (local) until an ISO date (yyyy-mm-dd). Negative = in the past. */
export function daysUntil(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const now = new Date();
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000);
}

export function ExpiryBadge({ on }: { on?: string | null }) {
  if (!on) return null;
  const n = daysUntil(on);
  if (n < 0) return <span className="badge flag-high" title={`Expired ${fmtDate(on)}`}>Expired {fmtDate(on)}</span>;
  if (n <= 30) return <span className="badge flag-medium" title={`Valid until ${fmtDate(on)}`}>{n === 0 ? 'Expires today' : `Expires in ${n} day${n === 1 ? '' : 's'}`}</span>;
  return <span className="muted small">Valid until {fmtDate(on)}</span>;
}

export function FlagBadges({ flags, max }: { flags?: Flag[]; max?: number }) {
  if (!flags?.length) return null;
  const shown = max ? flags.slice(0, max) : flags;
  return (
    <span className="flags">
      {shown.map((f) => <span key={f.code} className={`badge flag-${f.severity}`}>{f.label}</span>)}
      {max && flags.length > max && <span className="badge" title={flags.slice(max).map((f) => f.label).join(', ')}>+{flags.length - max}</span>}
    </span>
  );
}

const crLabel: Record<CrStatus, string> = { PENDING: 'Under review', APPROVED: 'Approved', REJECTED: 'Not approved', CANCELLED: 'Cancelled' };
const crClass: Record<CrStatus, string> = { PENDING: 'step-pending', APPROVED: 'step-approved', REJECTED: 'step-rejected', CANCELLED: 'step-cancelled' };
export const CrBadge = ({ status }: { status: CrStatus }) => <span className={`badge ${crClass[status]}`}>{crLabel[status]}</span>;

const SENSITIVE = (id: string) => id.startsWith('bank.') || KEY_CHANGE.has(id) || MASKED_FIELDS.includes(id);

export function ChangeDiff({ changes, docCount = 0, onReveal }: { changes: FieldChange[]; docCount?: number; onReveal?: (fieldId: string) => Promise<{ old?: string; new?: string }> }) {
  const [shown, setShown] = useState<Record<string, { old?: string; new?: string }>>({});
  return (
    <>
      {changes.length > 0 && (
        <table className="table diff-table">
          <thead><tr><th>Field</th><th>Current</th><th>Requested</th></tr></thead>
          <tbody>
            {changes.map((c) => (
              <tr key={c.fieldId}>
                <td>{c.label}{SENSITIVE(c.fieldId) && <span className="badge sm flag-medium" title="Sensitive field — checked with extra care">sensitive</span>}
                  {onReveal && MASKED_FIELDS.includes(c.fieldId) && !shown[c.fieldId] && (isMasked(c.old) || isMasked(c.new)) && (
                    <div><button type="button" className="link-btn small" title="Shows the full values. Each reveal is recorded in the audit log." onClick={async () => { const r = await onReveal(c.fieldId).catch(() => null); if (r) setShown((x) => ({ ...x, [c.fieldId]: r })); }}>Reveal</button></div>)}</td>
                <td className="diff-old mono-num">{(shown[c.fieldId]?.old ?? c.old) || <span className="muted">—</span>}</td>
                <td className="diff-new mono-num">{(shown[c.fieldId]?.new ?? c.new) || <span className="muted">(cleared)</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {docCount > 0 && <p className="small">📎 {docCount} new document{docCount === 1 ? '' : 's'} attached for review.</p>}
    </>
  );
}

/** Compact list of change requests (vendor or staff side). */
export function CrHistory({ items, onCancel }: { items: ChangeRequest[]; onCancel?: (id: string) => void }) {
  if (!items.length) return <p className="muted small">No change requests yet.</p>;
  return (
    <ul className="cr-history">
      {items.map((cr) => (
        <li key={cr.id}>
          <div className="row-between"><span><CrBadge status={cr.status} />{cr.byBuyer && <span className="badge sm" title="Proposed by the buyer on your behalf">by buyer</span>}</span><span className="muted small">{fmtDateTime(cr.createdAt)}</span></div>
          <div className="small">
            {cr.changes.map((c) => c.label).join(', ') || ''}
            {cr.documentIds.length > 0 && `${cr.changes.length ? ' + ' : ''}${cr.documentIds.length} document${cr.documentIds.length === 1 ? '' : 's'}`}
          </div>
          {cr.status === 'PENDING' && cr.steps.length > 0 && (
            <div className="cr-steps">{cr.steps.map((s) => <span key={s.id} className="small">{s.label} <StepBadge status={s.status} /></span>)}</div>
          )}
          {cr.status === 'REJECTED' && cr.remarks && <div className="small muted">Reason: “{cr.remarks}”</div>}
          {cr.status === 'PENDING' && onCancel && !cr.byBuyer && <button className="link-btn danger small" onClick={() => onCancel(cr.id)}>Withdraw request</button>}
        </li>
      ))}
    </ul>
  );
}
