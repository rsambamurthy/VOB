import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';

export interface Delivery {
  id: string; event: string; kind: string; status: 'PENDING' | 'SENT' | 'TEST' | 'FAILED'; attempts: number; target: string | null;
  httpStatus: number | null; error: string | null; erpVendorId: string | null; requestedBy: string | null; sentAt: string | null; createdAt: string; fileName: string | null;
}
interface VendorErp { connector: string; testMode: boolean; erpVendorId: string | null; status: string | null; syncedAt: string | null; canPush: boolean; deliveries: Delivery[] }

const LABEL: Record<string, [string, string]> = {
  PENDING: ['Queued', 'step-pending'], SENT: ['Sent', 'step-approved'], SYNCED: ['Synced', 'step-approved'], TEST: ['Test only', ''], FAILED: ['Failed', 'step-rejected'],
};
export const ErpBadge = ({ status }: { status: string | null }) => {
  if (!status) return <span className="muted small">Not sent</span>;
  const [label, cls] = LABEL[status] ?? [status, ''];
  return <span className={`badge ${cls}`}>{status === 'FAILED' ? '⚠ ' : ''}{label}</span>;
};
const CONNECTOR: Record<string, string> = { oracle: 'Oracle EBS', webhook: 'Webhook', csv: 'CSV file', none: 'Not connected' };

/** Sidebar card on an approved vendor: ERP sync state, push, retry. */
export function ErpCard({ vendorId, onFlash, canConfigure }: { vendorId: string; onFlash: (f: { kind: 'success' | 'error'; text: string }) => void; canConfigure: boolean }) {
  const [d, setD] = useState<VendorErp>();
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const load = useCallback(() => api<VendorErp>(`/staff/vendors/${vendorId}/erp`).then(setD).catch(() => {}), [vendorId]);
  useEffect(() => { load(); }, [load]);
  // Pushes run in the background; refresh while one is queued.
  useEffect(() => { if (!d?.deliveries.some((x) => x.status === 'PENDING')) return; const t = setTimeout(load, 2500); return () => clearTimeout(t); }, [d, load]);
  if (!d) return null;
  async function push() {
    setBusy(true);
    try { const r = await api<Delivery>(`/staff/vendors/${vendorId}/erp/push`, { method: 'POST' }); onFlash(r.status === 'FAILED' ? { kind: 'error', text: `ERP push failed: ${r.error}` } : { kind: 'success', text: r.status === 'TEST' ? 'Recorded in test mode — nothing was sent.' : r.status === 'PENDING' ? 'Queued for the ERP.' : 'Sent to the ERP.' }); await load(); }
    catch (e: any) { onFlash({ kind: 'error', text: e.message }); } finally { setBusy(false); }
  }
  async function retry(id: string) {
    try { const r = await api<Delivery>(`/staff/erp/deliveries/${id}/retry`, { method: 'POST' }); onFlash(r.status === 'FAILED' ? { kind: 'error', text: `Still failing: ${r.error}` } : { kind: 'success', text: 'Retried.' }); await load(); }
    catch (e: any) { onFlash({ kind: 'error', text: e.message }); }
  }
  const shown = all ? d.deliveries : d.deliveries.slice(0, 3);
  return (
    <div className="card pad">
      <div className="row-between card-title"><h3>ERP</h3>{d.canPush && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={push}>{busy ? 'Pushing…' : 'Push to ERP'}</button>}</div>
      {d.connector === 'none' ? (
        <p className="small muted">No ERP connection yet{canConfigure ? <> — <Link to="/staff/admin/erp">set one up</Link></> : ''}. The “ERP export” button gives the Oracle payload to copy by hand.</p>
      ) : (
        <>
          <dl className="kv small">
            <dt>Connector</dt><dd>{CONNECTOR[d.connector]}{d.testMode && <span className="badge sm">test mode</span>}</dd>
            <dt>Status</dt><dd><ErpBadge status={d.status} /></dd>
            <dt>ERP vendor id</dt><dd className="mono">{d.erpVendorId ?? '—'}</dd>
            <dt>Last synced</dt><dd>{fmtDateTime(d.syncedAt)}</dd>
          </dl>
          {shown.length > 0 && (
            <ul className="erp-log">
              {shown.map((x) => (
                <li key={x.id}>
                  <div className="row-between"><span className="small"><strong>{x.event}</strong> <ErpBadge status={x.status} /></span><span className="muted small">{fmtDateTime(x.sentAt ?? x.createdAt)}</span></div>
                  {x.error && <div className="small err-text">{x.error}{x.attempts > 1 ? ` (${x.attempts} attempts)` : ''}</div>}
                  <div className="small">
                    <a className="link-btn small" href={`/api/staff/erp/deliveries/${x.id}/payload`} target="_blank" rel="noreferrer">{x.fileName ? 'Download file' : 'View payload'}</a>
                    {x.status === 'FAILED' && d.canPush && <> · <button className="link-btn small" onClick={() => retry(x.id)}>Retry</button></>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {d.deliveries.length > 3 && <button className="link-btn small" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${d.deliveries.length}`}</button>}
        </>
      )}
    </div>
  );
}
