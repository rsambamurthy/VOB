import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { VENDOR_TYPES } from '../lib/meta';
import { SupplierContactModal } from '../components/SupplierContactModal';
import { useSession } from '../lib/session';
import { Alert, Empty, Modal, StatusBadge } from '../components/ui';
import { fmtDate, statusLabel } from '../lib/format';
import type { VendorStatus, VendorSummary } from '../lib/types';
import { FlagBadges } from '../components/Lifecycle';
import { Pager } from '../components/Pager';

const STATUSES: VendorStatus[] = ['INVITED', 'IN_PROGRESS', 'UNDER_REVIEW', 'SENT_BACK', 'APPROVED', 'REJECTED'];

export function VendorList({ mine = false }: { mine?: boolean }) {
  const { me, can } = useSession();
  const nav = useNavigate();
  const [data, setData] = useState<{ vendors: VendorSummary[]; counts: Record<string, number>; myQueue: number; myChangeQueue: number; attentionCount?: number; total: number; page: number; pageSize: number }>();
  const [page, setPage] = useState(1);
  const [attention, setAttention] = useState(false);
  const [attentionCount, setAttentionCount] = useState<number>();
  const [q, setQ] = useState('');
  const [params] = useSearchParams();
  const [status, setStatus] = useState<string>(params.get('status') ?? '');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  // Sourcing events waiting for this user's approval (shown with the change requests).
  const [eventsWaiting, setEventsWaiting] = useState(0);
  const sourcingOn = !!me?.sourcing?.on;
  useEffect(() => { if (sourcingOn) api<{ waiting: number }>('/staff/sourcing/approvals/count').then((r) => setEventsWaiting(r.waiting)).catch(() => {}); }, [sourcingOn]);

  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (status) p.set('status', status);
    if (mine) p.set('mine', 'true');
    if (attention) p.set('attention', 'true');
    if (page > 1) p.set('page', String(page));
    api(`/staff/vendors?${p}`).then((r) => { setData(r); if (r.attentionCount !== undefined) setAttentionCount(r.attentionCount); }).catch((e) => setError(e.message));
  }, [q, status, mine, attention, page]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  // A new search or filter starts again at the first page.
  useEffect(() => { setPage(1); }, [q, status, mine, attention]);

  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{mine ? 'My approvals' : 'Vendors'}</h1>
          <p className="muted">{mine ? `Waiting for you as ${me!.roles.map((r) => r.name).join(' / ')}` : 'Every vendor invited, in progress or reviewed'}</p>
        </div>
        {can('vendors.create') && !mine && <div className="head-actions"><Link className="btn btn-secondary" to="/staff/vendors/import">Import from Excel</Link><button className="btn btn-primary" onClick={() => setCreating(true)}>+ New vendor</button></div>}
      </header>
      {error && <Alert kind="error">{error}</Alert>}

      {!mine && data && (
        <div className="stat-row">
          <button className={`stat ${status === '' && !attention ? 'active' : ''}`} onClick={() => { setStatus(''); setAttention(false); }}><span className="stat-n">{total}</span><span className="stat-l">All</span></button>
          {STATUSES.map((s) => (
            <button key={s} className={`stat stat-${s.toLowerCase()} ${status === s ? 'active' : ''}`} onClick={() => { setAttention(false); setStatus(status === s ? '' : s); }}>
              <span className="stat-n">{data.counts[s] ?? 0}</span><span className="stat-l">{statusLabel[s]}</span>
            </button>
          ))}
          <button className={`stat stat-attention ${attention ? 'active' : ''}`} onClick={() => { setStatus(''); setAttention(!attention); }} title="Approved vendors that are blocked, have expired or expiring documents, a pending change or a due re-check">
            <span className="stat-n">{attentionCount ?? '–'}</span><span className="stat-l">Needs attention</span>
          </button>
        </div>
      )}
      {!mine && data && data.myQueue > 0 && (
        <Alert kind="info"><strong>{data.myQueue}</strong> vendor{data.myQueue > 1 ? 's are' : ' is'} waiting for your review. <Link to="/staff/queue">Open my approvals →</Link></Alert>
      )}
      {eventsWaiting > 0 && (
        <Alert kind="info"><strong>{eventsWaiting}</strong> sourcing event{eventsWaiting > 1 ? 's are' : ' is'} waiting for your approval. <Link to="/staff/sourcing?filter=approval">Open sourcing events →</Link></Alert>
      )}
      {data && data.myChangeQueue > 0 && (
        <Alert kind="info"><strong>{data.myChangeQueue}</strong> change request{data.myChangeQueue > 1 ? 's are' : ' is'} waiting for you. <Link to="/staff/changes">Open change requests →</Link></Alert>
      )}

      <div className="card">
        <div className="toolbar">
          <input className="search" placeholder="Search name, code or email…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search vendors" />
        </div>
        {!data ? <div className="pad"><div className="spinner" /></div> : data.vendors.length === 0 ? (
          <Empty>{mine ? 'Nothing waiting for you. 🎉' : attention ? 'No approved vendors need attention right now.' : 'No vendors match.'}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Vendor</th><th>Type</th><th>Contact</th><th>Status</th><th>Waiting on</th><th>Updated</th></tr></thead>
              <tbody>
                {data.vendors.map((v) => (
                  <tr key={v.id} onClick={() => nav(`/staff/vendors/${v.id}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/staff/vendors/${v.id}`)}>
                    <td><div className="strong">{v.name}</div><div className="muted small mono">{v.code}</div></td>
                    <td>{VENDOR_TYPES.find((t) => t.value === v.vendorType)?.label}</td>
                    <td><div>{v.contactFirstName} {v.contactLastName}</div><div className="muted small">{v.contactEmail}</div></td>
                    <td><StatusBadge status={v.status} /><div><FlagBadges flags={v.flags} max={2} /></div></td>
                    <td>{v.pendingStep ? <span className={v.pendingStep.mine ? 'you' : ''}>{v.pendingStep.label}{v.pendingStep.assignee ? ` · ${v.pendingStep.assignee}` : ''}{v.pendingStep.mine ? ' (you)' : ''}{v.pendingStep.overdue && <span className="badge badge-rejected sm">Overdue</span>}</span> : v.status === 'SENT_BACK' || v.status === 'IN_PROGRESS' || v.status === 'INVITED' ? <span className="muted">Vendor</span> : <span className="muted">—</span>}</td>
                    <td className="muted">{fmtDate(v.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </div>
        )}
      </div>
      {creating && <SupplierContactModal endpoint="/staff/vendors" onClose={() => setCreating(false)} onCreated={(r) => nav(`/staff/vendors/${r.vendor.id}`)} />}
    </div>
  );
}

