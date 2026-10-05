import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Alert, Empty } from '../components/ui';
import { CrBadge } from '../components/Lifecycle';
import { fmtDateTime } from '../lib/format';
import type { ChangeQueueRow, CrStatus } from '../lib/types';

const FILTERS: { key: string; label: string; mine?: boolean; status: CrStatus }[] = [
  { key: 'mine', label: 'Waiting for me', mine: true, status: 'PENDING' },
  { key: 'open', label: 'All open', status: 'PENDING' },
  { key: 'approved', label: 'Approved', status: 'APPROVED' },
  { key: 'rejected', label: 'Rejected', status: 'REJECTED' },
  { key: 'cancelled', label: 'Withdrawn', status: 'CANCELLED' },
];

/** Queue of vendor change requests (post-approval edits). */
export function ChangeRequests() {
  const nav = useNavigate();
  const [filter, setFilter] = useState('mine');
  const [rows, setRows] = useState<ChangeQueueRow[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const f = FILTERS.find((x) => x.key === filter)!;
    setRows(undefined); setError(undefined);
    api<ChangeQueueRow[]>(`/staff/change-requests?status=${f.status}${f.mine ? '&mine=true' : ''}`).then(setRows).catch((e) => { setError(e.message); setRows([]); });
  }, [filter]);

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Change requests</h1><p className="muted">Approved vendors asking to update their registered details or documents</p></div>
      </header>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="card">
        <div className="toolbar seg">
          {FILTERS.map((f) => <button key={f.key} className={`seg-btn ${filter === f.key ? 'active' : ''}`} onClick={() => setFilter(f.key)}>{f.label}</button>)}
        </div>
        {!rows ? <div className="pad"><div className="spinner" /></div> : rows.length === 0 ? (error ? null :
          <Empty>{filter === 'mine' ? 'No change requests waiting for you. 🎉' : 'Nothing here.'}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Vendor</th><th>What changed</th><th>Status</th><th>Waiting on</th><th>Requested</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} tabIndex={0} onClick={() => nav(`/staff/vendors/${r.vendor.id}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/staff/vendors/${r.vendor.id}`)}>
                    <td><div className="strong">{r.vendor.name}</div><div className="muted small mono">{r.vendor.code}</div></td>
                    <td>
                      <div className="small">{r.changes.slice(0, 4).map((c) => c.label).join(', ')}{r.changes.length > 4 ? ` +${r.changes.length - 4} more` : ''}
                        {r.documentIds.length > 0 && <>{r.changes.length ? ' · ' : ''}{r.documentIds.length} document{r.documentIds.length > 1 ? 's' : ''}</>}</div>
                      {r.sensitive && <span className="badge sm flag-medium">sensitive</span>}
                      <div className="muted small">{r.raisedBy ? `Proposed by ${r.raisedBy.name}` : 'Requested by vendor'}</div>
                    </td>
                    <td><CrBadge status={r.status} /></td>
                    <td>{r.pendingStep ? <span className={r.mine ? 'you' : ''}>{r.pendingStep.label}{r.pendingStep.assignee ? ` · ${r.pendingStep.assignee}` : ''}{r.mine ? ' (you)' : ''}{r.pendingStep.overdue && <span className="badge badge-rejected sm">Overdue</span>}</span> : <span className="muted">—</span>}</td>
                    <td className="muted">{fmtDateTime(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
