import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Empty, Modal } from '../components/ui';
import { fmtDate } from '../lib/format';
import { PLAN_LABEL, SOURCE_LABEL, papi, relDays } from './session';

interface Row { id: string; slug: string; name: string; status: 'ACTIVE' | 'SUSPENDED'; plan: string; source: string; trialEndsAt: string | null; createdAt: string; users: number; vendors: number; lastActiveAt: string | null }

export function TenantStatus({ status, plan, trialEndsAt }: { status: string; plan: string; trialEndsAt?: string | null }) {
  if (status === 'SUSPENDED') return <span className="badge badge-rejected">Suspended</span>;
  if (plan === 'trial' && trialEndsAt && new Date(trialEndsAt) < new Date()) return <span className="badge badge-sent_back">Trial ended</span>;
  return <span className="badge badge-approved">Active</span>;
}

export function PlatformTenants() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<Row[]>();
  const [q, setQ] = useState('');
  const [error, setError] = useState<string>();
  const status = params.get('status') ?? '';
  const plan = params.get('plan') ?? '';
  const creating = params.get('new') === '1';

  useEffect(() => {
    const t = setTimeout(() => {
      const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}), ...(plan ? { plan } : {}) });
      papi(`/tenants?${qs}`).then(setRows).catch((e) => setError(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [q, status, plan]);

  const setFilter = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };

  return (
    <div className="page">
      <header className="page-head"><div><h1>Workspaces</h1><p className="muted">Each customer company has its own workspace, users, configuration and vendors.</p></div>
        <button className="btn btn-primary" onClick={() => setFilter('new', '1')}>New workspace</button></header>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="card">
        <div className="toolbar">
          <input className="search" placeholder="Search company or workspace ID…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search workspaces" />
          <select value={status} onChange={(e) => setFilter('status', e.target.value)} aria-label="Status">
            <option value="">All statuses</option><option value="ACTIVE">Active</option><option value="SUSPENDED">Suspended</option>
          </select>
          <select value={plan} onChange={(e) => setFilter('plan', e.target.value)} aria-label="Plan">
            <option value="">All plans</option>{Object.entries(PLAN_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {rows && <span className="muted small">{rows.length} workspace{rows.length === 1 ? '' : 's'}</span>}
        </div>
        {!rows ? <div className="pad"><div className="spinner" /></div> : rows.length === 0 ? <Empty>No workspaces match.</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Company</th><th>Plan</th><th>Status</th><th className="num">Users</th><th className="num">Vendors</th><th>Last active</th><th>Created</th></tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} onClick={() => nav(`/platform/tenants/${t.id}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/platform/tenants/${t.id}`)}>
                    <td><div className="strong">{t.name}</div><div className="muted small mono">{t.slug}</div></td>
                    <td><span className={`badge plan-${t.plan}`}>{PLAN_LABEL[t.plan] ?? t.plan}</span>
                      {t.plan === 'trial' && t.trialEndsAt && <div className="muted small">{new Date(t.trialEndsAt) < new Date() ? 'ended' : 'ends'} {relDays(t.trialEndsAt)}</div>}</td>
                    <td><TenantStatus {...t} /></td>
                    <td className="num">{t.users}</td>
                    <td className="num">{t.vendors}</td>
                    <td className="muted small">{t.lastActiveAt ? relDays(t.lastActiveAt) : 'never'}</td>
                    <td className="muted small">{fmtDate(t.createdAt)}<div>{SOURCE_LABEL[t.source] ?? t.source}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {creating && <NewTenantModal onClose={() => setFilter('new', '')} onCreated={(id) => nav(`/platform/tenants/${id}?created=1`)} />}
    </div>
  );
}

function NewTenantModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState({ name: '', slug: '', adminName: '', adminEmail: '', plan: 'trial', trialDays: 14, country: 'IN', primaryColor: '', productName: '', notes: '' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugState, setSlugState] = useState<{ available: boolean; reason: string | null }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: k === 'trialDays' ? Number(e.target.value) : e.target.value });

  useEffect(() => { papi('/settings').then((s) => setF((x) => ({ ...x, trialDays: s.trialDays }))).catch(() => {}); }, []);
  const [countries, setCountries] = useState<{ code: string; name: string; currency: string }[]>([]);
  useEffect(() => { papi('/plans').then((r) => setCountries(r.countries ?? [])).catch(() => {}); }, []);
  // Suggest a workspace ID from the company name until the user edits it.
  useEffect(() => {
    if (slugTouched || !f.name.trim()) return;
    const t = setTimeout(() => api_suggest(f.name).then((s) => setF((x) => ({ ...x, slug: s }))), 300);
    return () => clearTimeout(t);
  }, [f.name, slugTouched]);
  useEffect(() => {
    if (!f.slug) { setSlugState(undefined); return; }
    const t = setTimeout(() => papi(`/tenants/check-slug?slug=${encodeURIComponent(f.slug)}`).then(setSlugState).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [f.slug]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined);
    try {
      const r = await papi('/tenants', { body: { ...f, trialDays: f.plan === 'trial' ? f.trialDays : undefined, primaryColor: f.primaryColor || undefined, productName: f.productName || undefined, notes: f.notes || undefined } });
      onCreated(r.id);
    } catch (err: any) { setError(err.message); setBusy(false); }
  }
  return (
    <Modal title="New workspace" onClose={onClose} wide footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="nt" disabled={busy || slugState?.available === false}>{busy ? 'Creating…' : 'Create and invite admin'}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <form id="nt" onSubmit={submit} className="field-grid">
        <div className="field"><label htmlFor="nt-name">Company name</label><input id="nt-name" value={f.name} onChange={set('name')} required autoFocus /></div>
        <div className="field"><label htmlFor="nt-slug">Workspace ID</label>
          <input id="nt-slug" className="mono" value={f.slug} onChange={(e) => { setSlugTouched(true); setF({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }); }} required maxLength={40} />
          <div className={`field-help ${slugState && !slugState.available ? 'err-text' : ''}`}>{slugState ? (slugState.available ? '✓ Available. People type this when they sign in.' : slugState.reason) : 'People type this when they sign in.'}</div></div>
        <div className="field"><label htmlFor="nt-an">Administrator’s name</label><input id="nt-an" value={f.adminName} onChange={set('adminName')} required /></div>
        <div className="field"><label htmlFor="nt-ae">Administrator’s email</label><input id="nt-ae" type="email" value={f.adminEmail} onChange={set('adminEmail')} required /><div className="field-help">Gets an invitation to set a password.</div></div>
        <div className="field"><label htmlFor="nt-country">Country</label>
          <select id="nt-country" value={f.country} onChange={set('country')} disabled={countries.length < 2}>{(countries.length ? countries : [{ code: 'IN', name: 'India', currency: 'INR' }]).map((c) => <option key={c.code} value={c.code}>{c.name} ({c.currency})</option>)}</select>
          <div className="field-help">Sets the onboarding template, tax and bank checks, currency and privacy notice. More countries are added as country packs.</div></div>
        <div className="field"><label htmlFor="nt-plan">Plan</label>
          <select id="nt-plan" value={f.plan} onChange={set('plan')}>{Object.entries(PLAN_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        {f.plan === 'trial' && <div className="field"><label htmlFor="nt-td">Trial length (days)</label><input id="nt-td" type="number" min={1} max={365} value={f.trialDays} onChange={set('trialDays')} /></div>}
        <div className="field"><label htmlFor="nt-pn">Product name shown to them (optional)</label><input id="nt-pn" value={f.productName} onChange={set('productName')} placeholder="VendorGate" maxLength={40} /></div>
        <div className="field"><label htmlFor="nt-col">Brand colour (optional)</label><input id="nt-col" value={f.primaryColor} onChange={set('primaryColor')} placeholder="#1f2758" maxLength={7} /></div>
        <div className="field field-wide"><label htmlFor="nt-notes">Internal notes (only visible here)</label><textarea id="nt-notes" rows={2} value={f.notes} onChange={set('notes')} placeholder="Deal, contact person, special terms…" /></div>
      </form>
    </Modal>
  );
}

/** Suggestion from the public sign-up endpoint (same rules). */
const api_suggest = (company: string) => fetch(`/api/signup/check-slug?company=${encodeURIComponent(company)}`, { headers: { 'X-Requested-With': 'fetch' } }).then((r) => r.json()).then((r) => r.slug as string);
