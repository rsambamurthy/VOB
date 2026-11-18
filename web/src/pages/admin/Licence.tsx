import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Alert } from '../../components/ui';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { useSession } from '../../lib/session';

interface Status {
  state: 'valid' | 'expiring' | 'grace' | 'readonly' | 'missing' | 'notYetValid'; readOnly: boolean; daysLeft: number | null; graceEndsOn: string | null; message: string | null;
  licence: { id: string; customer: string; validFrom: string; validUntil: string; maxUsers: number | null; maxVendors: number | null; features: Record<string, boolean>; graceDays: number } | null;
  installedAt: string | null; installedBy: string | null; usage: { users: number; vendors: number }; version: string; featureLabels?: Record<string, string>;
}
const STATE: Record<Status['state'], { label: string; cls: string }> = {
  valid: { label: 'Valid', cls: 'badge-approved' }, expiring: { label: 'Ending soon', cls: 'flag-medium' }, grace: { label: 'Ended — grace period', cls: 'flag-high' },
  readonly: { label: 'Expired — read-only', cls: 'flag-high' }, missing: { label: 'Not installed', cls: 'flag-high' }, notYetValid: { label: 'Not started yet', cls: 'flag-medium' },
};

/** Administration → Licence (on-premises installations). */
export function Licence() {
  const { refresh } = useSession();
  const [s, setS] = useState<Status>();
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const [busy, setBusy] = useState(false);
  const load = () => api<Status>('/admin/licence').then(setS).catch((e) => setMsg({ kind: 'error', text: e.message }));
  useEffect(() => { load(); }, []);
  async function install() {
    setBusy(true); setMsg(undefined);
    try { await api('/admin/licence', { body: { token } }); setToken(''); setMsg({ kind: 'success', text: 'Licence installed.' }); await load(); await refresh?.(); }
    catch (e: any) { setMsg({ kind: 'error', text: e.message }); } finally { setBusy(false); }
  }
  const lim = (n: number | null, used: number) => (n === null ? `${used} (unlimited)` : `${used} of ${n}`);
  return (
    <div className="page narrow">
      <header className="page-head"><div><h1>Licence</h1><p className="muted">This VendorGate installation runs on a licence from Integratatech. When it ends, there is a {s?.licence?.graceDays ?? 15}-day grace period; after that staff can still see everything but can’t change anything until a new licence is installed. Suppliers can always use their portal.</p></div></header>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {s?.message && <Alert kind={s.readOnly ? 'error' : 'warning'}>{s.message}</Alert>}
      {s && (
        <div className="card pad">
          <div className="row-between"><h3 className="card-title">{s.licence ? s.licence.customer : 'No licence installed'}</h3><span className={`badge ${STATE[s.state].cls}`}>{STATE[s.state].label}</span></div>
          {s.licence && (
            <dl className="kv">
              <dt>Licence number</dt><dd className="mono">{s.licence.id}</dd>
              <dt>Valid</dt><dd>{fmtDate(s.licence.validFrom)} to {fmtDate(s.licence.validUntil)}{s.daysLeft !== null && s.daysLeft >= 0 && <span className="muted"> · {s.daysLeft} days left</span>}</dd>
              <dt>Staff users</dt><dd>{lim(s.licence.maxUsers, s.usage.users)}</dd>
              <dt>Suppliers</dt><dd>{lim(s.licence.maxVendors, s.usage.vendors)}</dd>
              <dt>Included</dt><dd>{Object.entries(s.featureLabels ?? {}).map(([k, l]) => <span key={k} className={`badge sm ${s.licence!.features[k] === false ? '' : 'badge-approved'}`} style={{ marginInlineEnd: 6 }}>{s.licence!.features[k] === false ? `No ${l.toLowerCase()}` : l}</span>)}</dd>
              <dt>Installed</dt><dd>{s.installedAt ? `${fmtDateTime(s.installedAt)} by ${s.installedBy}` : '—'}</dd>
              <dt>VendorGate version</dt><dd className="mono">{s.version}</dd>
            </dl>
          )}
        </div>
      )}
      <div className="card pad">
        <h3 className="card-title">Install a new licence</h3>
        <p className="small muted">Choose the licence file you received from Integratatech (vendorgate-licence-….lic), or paste its contents. The new licence takes effect straight away.</p>
        <div className="btn-row"><label className="btn btn-secondary btn-sm">Choose licence file<input type="file" hidden accept=".lic,.txt" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setToken((await f.text()).trim()); e.target.value = ''; }} /></label></div>
        <textarea rows={4} className="mono small" value={token} placeholder="VGL1.…" onChange={(e) => setToken(e.target.value)} aria-label="Licence" style={{ marginTop: 8 }} />
        <div className="form-foot"><button className="btn btn-primary" disabled={busy || token.trim().length < 20} onClick={install}>{busy ? 'Installing…' : 'Install licence'}</button></div>
      </div>
    </div>
  );
}
