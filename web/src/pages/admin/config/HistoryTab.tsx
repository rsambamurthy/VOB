import { fmtDateTime } from '../../../lib/format';

export interface VersionRow { id: string; version: number; status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'; note?: string | null; publishedAt?: string | null; updatedAt: string }

export function HistoryTab({ versions, onRestore, onPreview }: { versions: VersionRow[]; onRestore: (v: number) => void; onPreview: (v: number) => void }) {
  return (
    <div className="card">
      <div className="table-wrap">
        <table className="table static">
          <thead><tr><th>Version</th><th>Status</th><th>Note</th><th>Published</th><th /></tr></thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td className="strong">v{v.version}</td>
                <td><span className={`badge ${v.status === 'PUBLISHED' ? 'badge-approved' : v.status === 'DRAFT' ? 'badge-under_review' : ''}`}>{v.status === 'PUBLISHED' ? 'Live' : v.status === 'DRAFT' ? 'Draft' : 'Archived'}</span></td>
                <td className="small">{v.note ?? <span className="muted">—</span>}</td>
                <td className="small muted">{fmtDateTime(v.publishedAt)}</td>
                <td className="actions">
                  <button className="link-btn small" onClick={() => onPreview(v.version)}>Preview form</button>
                  {v.status === 'ARCHIVED' && <button className="link-btn small" onClick={() => onRestore(v.version)}>Restore as draft</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
