/** Invoices → Email inbox: every email received at the invoices address or mailbox, the drafts made from it, or why none were. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useHelpContext } from '../../help/HelpPanel';
import { Alert, Empty } from '../../components/ui';
import { TabStrip } from '../../components/TabStrip';
import { AP_BASE } from './Invoices';

interface Mail {
  id: string; fromAddress: string | null; fromName: string | null; subject: string | null; receivedAt: string; via: string; status: string; reason: string | null;
  invoiceIds: string[]; attachments: { fileName: string; size: number; result: string; invoiceId?: string }[]; party: { id: string; name: string; code: string } | null;
}
const STATUS: Record<string, [string, string]> = {
  PROCESSED: ['Drafts made', 'badge-approved'], DUPLICATE: ['Already received', 'badge-sent_back'], NO_ATTACHMENT: ['No invoice attached', 'badge-invited'],
  IGNORED: ['Ignored', 'badge-invited'], FAILED: ['Couldn’t read', 'badge-rejected'], RECEIVED: ['Reading…', 'badge-under_review'],
};
const TABS: [string, string][] = [['', 'All'], ['PROCESSED', 'Drafts made'], ['DUPLICATE', 'Already received'], ['NO_ATTACHMENT', 'No invoice'], ['IGNORED', 'Ignored'], ['FAILED', 'Couldn’t read']];

export function InvoiceInbox() {
  useHelpContext('ap-inbox');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [d, setD] = useState<{ rows: Mail[]; hasMore: boolean }>();
  const [error, setError] = useState<string>();
  useEffect(() => { setD(undefined); api<{ rows: Mail[]; hasMore: boolean }>(`/staff/invoices/inbox?page=${page}${status ? `&status=${status}` : ''}`).then(setD).catch((e) => setError(e.message)); }, [status, page]);
  return (
    <div className="page">
      <header className="page-head"><div><h1>Email inbox</h1><p className="muted">Invoices emailed in. Each PDF becomes a draft in <Link to={`${AP_BASE}?tab=DRAFT`}>Drafts</Link> — open it, check what was read, and submit it.</p></div></header>
      {error && <Alert kind="error">{error}</Alert>}
      <TabStrip>{TABS.map(([k, l]) => <button key={k || 'all'} role="tab" aria-selected={status === k} className={status === k ? 'active' : ''} onClick={() => { setStatus(k); setPage(1); }}>{l}</button>)}</TabStrip>
      <div className="card">{!d ? <div className="pad"><div className="spinner" /></div> : !d.rows.length ? <Empty>No emails here yet.</Empty> : <>
        <div className="table-wrap"><table className="table static">
          <thead><tr><th>Received</th><th>From</th><th>Subject</th><th>Attachments</th><th>Result</th></tr></thead>
          <tbody>{d.rows.map((m) => (
            <tr key={m.id}>
              <td className="small nowrap">{fmtDateTime(m.receivedAt)}<div className="muted">{m.via === 'IMAP' ? 'Mailbox' : 'Address'}</div></td>
              <td className="small">{m.fromName ?? m.fromAddress}{m.fromName && <div className="muted">{m.fromAddress}</div>}{m.party ? <div><span className="badge sm">{m.party.name}</span></div> : <div className="muted">Supplier not recognised</div>}</td>
              <td className="small">{m.subject ?? '(no subject)'}</td>
              <td className="small">{m.attachments.map((a, i) => <div key={i}>{a.invoiceId ? <Link to={`${AP_BASE}/${a.invoiceId}`}>{a.fileName}</Link> : a.fileName} <span className="muted">— {a.result}</span></div>)}</td>
              <td><span className={`badge sm ${STATUS[m.status]?.[1] ?? ''}`}>{STATUS[m.status]?.[0] ?? m.status}</span>{m.reason && !m.attachments.length && <div className="muted small">{m.reason}</div>}</td>
            </tr>))}</tbody>
        </table></div>
        {(page > 1 || d.hasMore) && <div className="pager"><button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Newer</button><span className="muted small">Page {page}</span><button className="btn btn-secondary btn-sm" disabled={!d.hasMore} onClick={() => setPage(page + 1)}>Older →</button></div>}
      </>}</div>
    </div>
  );
}
