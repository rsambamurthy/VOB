import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { fmtDateTime, humanize } from '../../lib/format';

interface Row { id: string; actor: string; action: string; detail: Record<string, unknown> | null; ip?: string; vendorId?: string; createdAt: string }

export function Audit() {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ rows: Row[]; hasMore: boolean }>();
  useEffect(() => { api(`/admin/audit?page=${page}`).then(setData); }, [page]);
  return (
    <div className="page">
      <header className="page-head"><div><h1>Audit log</h1><p className="muted">Every sign-in, setting change and vendor action in this workspace.</p></div></header>
      <div className="card">
        {!data ? <div className="pad"><div className="spinner" /></div> : (
          <div className="table-wrap">
            <table className="table static">
              <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th><th>IP</th></tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="muted small nowrap">{fmtDateTime(r.createdAt)}</td>
                    <td>{r.actor}</td>
                    <td>{humanize(r.action)}{r.vendorId && <a className="small" href={`/staff/vendors/${r.vendorId}`}> · vendor</a>}</td>
                    <td className="muted small">{r.detail ? Object.entries(r.detail).filter(([, v]) => v !== '' && v != null && typeof v !== 'object').map(([k, v]) => `${k}: ${v}`).join(' · ') : ''}</td>
                    <td className="muted small mono">{r.ip ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="pager">
          <button className="btn btn-ghost btn-sm" disabled={page === 1} onClick={() => setPage(page - 1)}>← Newer</button>
          <span className="muted small">Page {page}</span>
          <button className="btn btn-ghost btn-sm" disabled={!data?.hasMore} onClick={() => setPage(page + 1)}>Older →</button>
        </div>
      </div>
    </div>
  );
}
