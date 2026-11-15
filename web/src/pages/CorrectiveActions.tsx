import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Alert, Empty } from '../components/ui';
import { TabStrip } from '../components/TabStrip';
import { fmtDate } from '../lib/format';

type Filter = 'open' | 'review' | 'overdue' | 'mine' | 'closed';
interface Row { id: string; vendorId: string; vendorName: string; vendorCode: string; vendorStatus: string; title: string; priority: string; dueOn: string; status: string; overdue: boolean; condition: boolean; raisedByName: string; sourceLabel: string | null; submittedAt: string | null }
interface Data { rows: Row[]; counts: { open: number; review: number; overdue: number } }
const STATUS: Record<string, string> = { OPEN: 'Waiting for the supplier', SUBMITTED: 'Evidence to review', ACCEPTED: 'Accepted', CANCELLED: 'Cancelled' };

/** Vendors → Corrective actions: every action across suppliers. Raising and reviewing happen on the supplier's page. */
export function CorrectiveActions() {
  const [filter, setFilter] = useState<Filter>('open');
  const [d, setD] = useState<Data>();
  const [err, setErr] = useState<string>();
  const load = useCallback(() => api<Data>(`/staff/actions?filter=${filter}`).then(setD).catch((e) => setErr(e.message)), [filter]);
  useEffect(() => { load(); }, [load]);
  const tile = (f: Filter, label: string, n: number | undefined, cls = '') => <button type="button" className={`stat ${cls}${filter === f ? ' active' : ''}`} onClick={() => setFilter(f)}><span className="stat-n">{n ?? '–'}</span><span className="stat-l">{label}</span></button>;
  return (
    <div className="page">
      <header className="page-head"><div><h1>Corrective actions</h1><p className="muted">What suppliers have been asked to fix, by when, and the evidence they sent. Raise actions from a supplier's page (Corrective actions tab) — VendorGate suggests them from questionnaire knock-outs, failed re-checks, expired certificates and poor performance. Overdue actions raise the supplier's risk.</p></div></header>
      {err && <Alert kind="error">{err}</Alert>}
      <div className="stat-row">
        {tile('open', 'Open', d?.counts.open)}
        {tile('review', 'Evidence to review', d?.counts.review, 'stat-medium')}
        {tile('overdue', 'Overdue', d?.counts.overdue, 'stat-high')}
      </div>
      <div className="card">
        <TabStrip>{([['open', 'Open'], ['review', 'To review'], ['overdue', 'Overdue'], ['mine', 'Raised by me'], ['closed', 'Closed']] as [Filter, string][]).map(([f, l]) => <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>{l}</button>)}</TabStrip>
        {!d ? <div className="pad"><div className="spinner" /></div> : !d.rows.length ? <Empty>No corrective actions here.</Empty> : (
          <table className="table">
            <thead><tr><th>Supplier</th><th>Action</th><th>Due</th><th>Status</th><th>Raised by</th></tr></thead>
            <tbody>{d.rows.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/staff/vendors/${r.vendorId}?tab=actions`} className="strong">{r.vendorName}</Link><div className="small muted mono">{r.vendorCode}</div></td>
                <td>{r.title}<div className="small muted">{r.priority[0]}{r.priority.slice(1).toLowerCase()} priority{r.condition ? ' · condition of approval' : ''}{r.sourceLabel ? ` · ${r.sourceLabel}` : ''}</div></td>
                <td className={r.overdue ? 'diff-text strong' : ''}>{fmtDate(r.dueOn)}{r.overdue && <div className="small">overdue</div>}</td>
                <td><span className={`badge sm ${r.status === 'SUBMITTED' ? 'v-test' : r.status === 'ACCEPTED' ? 'badge-approved' : r.overdue ? 'flag-high' : ''}`}>{STATUS[r.status]}</span></td>
                <td className="small">{r.raisedByName}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}
