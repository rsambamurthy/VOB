import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { VENDOR_TYPES } from '../lib/meta';
import { useSession } from '../lib/session';
import { Alert, Empty, Modal, StatusBadge } from '../components/ui';
import { fmtDate, statusLabel } from '../lib/format';
import type { VendorStatus, VendorSummary } from '../lib/types';
import { FlagBadges } from '../components/Lifecycle';

const STATUSES: VendorStatus[] = ['INVITED', 'IN_PROGRESS', 'UNDER_REVIEW', 'SENT_BACK', 'APPROVED', 'REJECTED'];

export function VendorList({ mine = false }: { mine?: boolean }) {
  const { me, can } = useSession();
  const nav = useNavigate();
  const [data, setData] = useState<{ vendors: VendorSummary[]; counts: Record<string, number>; myQueue: number; myChangeQueue: number; attentionCount?: number }>();
  const [attention, setAttention] = useState(false);
  const [attentionCount, setAttentionCount] = useState<number>();
  const [q, setQ] = useState('');
  const [params] = useSearchParams();
  const [status, setStatus] = useState<string>(params.get('status') ?? '');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (status) p.set('status', status);
    if (mine) p.set('mine', 'true');
    if (attention) p.set('attention', 'true');
    api(`/staff/vendors?${p}`).then((r) => { setData(r); if (r.attentionCount !== undefined) setAttentionCount(r.attentionCount); }).catch((e) => setError(e.message));
  }, [q, status, mine, attention]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);

  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{mine ? 'My approvals' : 'Vendors'}</h1>
          <p className="muted">{mine ? `Waiting for you as ${me!.roles.map((r) => r.name).join(' / ')}` : 'Every vendor invited, in progress or reviewed'}</p>
        </div>
        {can('vendors.create') && !mine && <button className="btn btn-primary" onClick={() => setCreating(true)}>+ New vendor</button>}
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
          </div>
        )}
      </div>
      {creating && <CreateVendor onClose={() => setCreating(false)} onCreated={(id) => nav(`/staff/vendors/${id}`)} />}
    </div>
  );
}

function CreateVendor({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { me } = useSession();
  const arabic = !!me?.tenant.supplierLanguages?.includes('ar');
  const [f, setF] = useState({ name: '', vendorType: 'DOMESTIC', contactFirstName: '', contactLastName: '', contactEmail: '', contactMobile: '', notify: true, language: me?.tenant.settings.supplierLanguage ?? 'en' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try {
      const { language, ...rest } = f;
      const r = await api('/staff/vendors', { body: arabic ? { ...rest, language } : rest });
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
          <select id="cv-type" value={f.vendorType} onChange={set('vendorType')}>{VENDOR_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
        <div className="field"><label htmlFor="cv-fn">Contact first name<span className="req"> *</span></label><input id="cv-fn" required value={f.contactFirstName} onChange={set('contactFirstName')} /></div>
        <div className="field"><label htmlFor="cv-ln">Contact last name<span className="req"> *</span></label><input id="cv-ln" required value={f.contactLastName} onChange={set('contactLastName')} /></div>
        <div className="field"><label htmlFor="cv-em">Contact email<span className="req"> *</span></label><input id="cv-em" type="email" required value={f.contactEmail} onChange={set('contactEmail')} /></div>
        <div className="field"><label htmlFor="cv-mo">Mobile number<span className="req"> *</span></label><input id="cv-mo" type="tel" required value={f.contactMobile} onChange={set('contactMobile')} placeholder={f.vendorType === 'IMPORT' ? '+44 7700 900123' : me?.tenant.mobileExample} /><div className="field-help">{f.vendorType === 'IMPORT' ? 'Include the country code, e.g. +44 or +91.' : `A ${me?.tenant.countryName ?? 'local'} number, or include the country code.`}</div></div>
        {arabic && <div className="field"><label htmlFor="cv-lang">Supplier’s language</label><select id="cv-lang" value={f.language} onChange={set('language')}><option value="en">English</option><option value="ar">Arabic (العربية)</option></select><div className="field-help">For the invitation and the portal. The supplier can switch at any time.</div></div>}
        <label className="checkbox field-wide"><input type="checkbox" checked={f.notify} onChange={set('notify')} /> Email the invite link to the contact now</label>
      </form>
    </Modal>
  );
}
