import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useMeta } from '../lib/meta';
import { useStaff } from '../components/StaffShell';
import { Alert, Empty, Modal, StatusBadge } from '../components/ui';
import { fmtDate, statusLabel } from '../lib/format';
import type { VendorStatus, VendorSummary } from '../lib/types';

const STATUSES: VendorStatus[] = ['INVITED', 'IN_PROGRESS', 'UNDER_REVIEW', 'SENT_BACK', 'APPROVED', 'REJECTED'];

export function VendorList({ mine = false }: { mine?: boolean }) {
  const me = useStaff()!;
  const meta = useMeta();
  const nav = useNavigate();
  const [data, setData] = useState<{ vendors: VendorSummary[]; counts: Record<string, number>; myQueue: number }>();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (status) p.set('status', status);
    if (mine) p.set('mine', 'true');
    api(`/staff/vendors?${p}`, { session: 'staff' }).then(setData).catch((e) => setError(e.message));
  }, [q, status, mine]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);

  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{mine ? 'My approvals' : 'Vendors'}</h1>
          <p className="muted">{mine ? `Vendors waiting for the ${meta.roleLabels[me.role]}` : 'Every vendor invited, in progress or reviewed'}</p>
        </div>
        {me.role === 'ADMIN' && !mine && <button className="btn btn-primary" onClick={() => setCreating(true)}>+ New vendor</button>}
      </header>
      {error && <Alert kind="error">{error}</Alert>}

      {!mine && data && (
        <div className="stat-row">
          <button className={`stat ${status === '' ? 'active' : ''}`} onClick={() => setStatus('')}><span className="stat-n">{total}</span><span className="stat-l">All</span></button>
          {STATUSES.map((s) => (
            <button key={s} className={`stat stat-${s.toLowerCase()} ${status === s ? 'active' : ''}`} onClick={() => setStatus(status === s ? '' : s)}>
              <span className="stat-n">{data.counts[s] ?? 0}</span><span className="stat-l">{statusLabel[s]}</span>
            </button>
          ))}
        </div>
      )}
      {!mine && me.role !== 'ADMIN' && data && data.myQueue > 0 && (
        <Alert kind="info"><strong>{data.myQueue}</strong> vendor{data.myQueue > 1 ? 's are' : ' is'} waiting for your review. <Link to="/staff/queue">Open my approvals →</Link></Alert>
      )}

      <div className="card">
        <div className="toolbar">
          <input className="search" placeholder="Search name, code or email…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search vendors" />
        </div>
        {!data ? <div className="pad"><div className="spinner" /></div> : data.vendors.length === 0 ? (
          <Empty>{mine ? 'Nothing waiting for you. 🎉' : 'No vendors match.'}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Vendor</th><th>Type</th><th>Contact</th><th>Status</th><th>Waiting on</th><th>Updated</th></tr></thead>
              <tbody>
                {data.vendors.map((v) => (
                  <tr key={v.id} onClick={() => nav(`/staff/vendors/${v.id}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/staff/vendors/${v.id}`)}>
                    <td><div className="strong">{v.name}</div><div className="muted small mono">{v.code}</div></td>
                    <td>{meta.vendorTypes.find((t) => t.value === v.vendorType)?.label}</td>
                    <td><div>{v.contactFirstName} {v.contactLastName}</div><div className="muted small">{v.contactEmail}</div></td>
                    <td><StatusBadge status={v.status} /></td>
                    <td>{v.pendingStep ? <span className={v.pendingStep.role === me.role ? 'you' : ''}>{v.pendingStep.label}{v.pendingStep.role === me.role ? ' (you)' : ''}</span> : v.status === 'SENT_BACK' || v.status === 'IN_PROGRESS' || v.status === 'INVITED' ? <span className="muted">Vendor</span> : <span className="muted">—</span>}</td>
                    <td className="muted">{fmtDate(v.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {creating && <CreateVendor onClose={() => setCreating(false)} onCreated={(id) => nav(`/staff/vendors/${id}`)} />}
    </div>
  );
}

function CreateVendor({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const meta = useMeta();
  const [f, setF] = useState({ name: '', vendorType: 'DOMESTIC', contactFirstName: '', contactLastName: '', contactEmail: '', contactMobile: '', notify: true });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try {
      const r = await api('/staff/vendors', { session: 'staff', body: f });
      onCreated(r.vendor.id);
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <Modal title="Vendor registration details" onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="create-vendor" disabled={busy}>{busy ? 'Saving…' : f.notify ? 'Create & notify contact' : 'Create vendor'}</button></>}>
      <form id="create-vendor" onSubmit={submit} className="field-grid">
        {error && <div className="field-wide"><Alert kind="error">{error}</Alert></div>}
        <div className="field"><label htmlFor="cv-name">Vendor name<span className="req"> *</span></label><input id="cv-name" required value={f.name} onChange={set('name')} autoFocus /></div>
        <div className="field"><label htmlFor="cv-type">Vendor type<span className="req"> *</span></label>
          <select id="cv-type" value={f.vendorType} onChange={set('vendorType')}>{meta.vendorTypes.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
        <div className="field"><label htmlFor="cv-fn">Contact first name<span className="req"> *</span></label><input id="cv-fn" required value={f.contactFirstName} onChange={set('contactFirstName')} /></div>
        <div className="field"><label htmlFor="cv-ln">Contact last name<span className="req"> *</span></label><input id="cv-ln" required value={f.contactLastName} onChange={set('contactLastName')} /></div>
        <div className="field"><label htmlFor="cv-em">Contact email<span className="req"> *</span></label><input id="cv-em" type="email" required value={f.contactEmail} onChange={set('contactEmail')} /></div>
        <div className="field"><label htmlFor="cv-mo">Mobile number<span className="req"> *</span></label><input id="cv-mo" type="tel" required value={f.contactMobile} onChange={set('contactMobile')} placeholder="98765 43210" /></div>
        <label className="checkbox field-wide"><input type="checkbox" checked={f.notify} onChange={set('notify')} /> Email the invite link to the contact now</label>
      </form>
    </Modal>
  );
}
