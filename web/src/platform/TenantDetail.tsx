import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Modal } from '../components/ui';
import { fmtDate, fmtDateTime, humanize } from '../lib/format';
import { PLAN_LABEL, SOURCE_LABEL, papi, relDays } from './session';
import { TenantStatus } from './Tenants';

type Features = { erp: boolean; ai: boolean; kyc: boolean };
interface Limits { maxUsers: number | null; maxVendors: number | null; emailsPerDay: number | null; features: Features }
interface Detail {
  tenant: { id: string; slug: string; name: string; status: 'ACTIVE' | 'SUSPENDED'; statusReason: string | null; plan: string; limits: Partial<Limits>; trialEndsAt: string | null; source: string; notes: string | null; createdAt: string };
  effective: Limits & { label: string };
  usage: { users: number; vendors: number; emailsToday: number; emailsLast30: number; emailsFailedLast30: number; vendorsByStatus: Record<string, number>; lastActiveAt: string | null };
  admins: { id: string; name: string; email: string; status: string; mfaEnabled: boolean; lastLoginAt: string | null }[];
  activity: { id: string; actor: string; action: string; createdAt: string }[];
  platformHistory: { id: string; actor: string; action: string; detail: any; createdAt: string }[];
}
const FEATURE_LABEL: Record<keyof Features, string> = { erp: 'ERP integration', ai: 'AI document reading', kyc: 'Verification checks' };

export function PlatformTenantDetail() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const [d, setD] = useState<Detail>();
  const [error, setError] = useState<string>();
  const [modal, setModal] = useState<'suspend' | 'support' | 'admin'>();
  const load = useCallback(() => papi(`/tenants/${id}`).then(setD).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  if (error && !d) return <div className="page"><Alert kind="error">{error}</Alert></div>;
  if (!d) return <div className="page"><div className="spinner" /></div>;
  const t = d.tenant;
  const signIn = `${window.location.origin}/login?workspace=${t.slug}`;

  return (
    <div className="page">
      <Link to="/platform/tenants" className="back">← Workspaces</Link>
      <header className="page-head">
        <div><h1>{t.name} <TenantStatus {...t} /> <span className={`badge plan-${t.plan}`}>{PLAN_LABEL[t.plan] ?? t.plan}</span></h1>
          <p className="muted">Workspace ID <span className="mono">{t.slug}</span> · created {fmtDate(t.createdAt)} via {SOURCE_LABEL[t.source] ?? t.source}</p></div>
        <div className="head-actions">
          {t.status === 'ACTIVE' && <button className="btn btn-secondary" onClick={() => setModal('support')}>Support access…</button>}
          {t.status === 'ACTIVE'
            ? <button className="btn btn-danger-ghost" onClick={() => setModal('suspend')}>Suspend…</button>
            : <button className="btn btn-primary" onClick={async () => { try { await papi(`/tenants/${t.id}/reactivate`, { method: 'POST' }); load(); } catch (e: any) { setError(e.message); } }}>Reactivate</button>}
        </div>
      </header>
      {params.get('created') && <Alert kind="success">Workspace created. The administrator has been emailed an invitation to set their password.</Alert>}
      {t.status === 'SUSPENDED' && <Alert kind="warning"><strong>Suspended.</strong> Nobody in this workspace can sign in and vendors can’t open their links. Data is kept. Reason: “{t.statusReason}”</Alert>}
      {error && <Alert kind="error">{error}</Alert>}

      <div className="detail-grid">
        <div>
          <UsageCard d={d} />
          <PlanCard d={d} onSaved={load} />
          <section className="card pad section-card">
            <div className="row-between"><h3>Administrators</h3><button className="btn btn-secondary btn-sm" onClick={() => setModal('admin')}>Add administrator</button></div>
            <table className="table static compact">
              <thead><tr><th>Name</th><th>Status</th><th>2FA</th><th>Last sign-in</th><th /></tr></thead>
              <tbody>{d.admins.map((a) => (
                <tr key={a.id}>
                  <td><div className="strong">{a.name}</div><div className="muted small">{a.email}</div></td>
                  <td><span className={`badge ${a.status === 'ACTIVE' ? 'badge-approved' : a.status === 'INVITED' ? 'badge-invited' : 'badge-rejected'}`}>{humanize(a.status)}</span></td>
                  <td className="small">{a.mfaEnabled ? 'On' : <span className="muted">Off</span>}</td>
                  <td className="muted small">{fmtDateTime(a.lastLoginAt)}</td>
                  <td className="actions">{a.status === 'INVITED' && <button className="link-btn small" onClick={async () => { try { await papi(`/tenants/${t.id}/users/${a.id}/resend-invite`, { method: 'POST' }); setError(undefined); alertOk(`Invitation sent again to ${a.email}`); } catch (e: any) { setError(e.message); } }}>Resend invite</button>}</td>
                </tr>))}
                {!d.admins.length && <tr><td colSpan={5} className="muted">No administrators.</td></tr>}
              </tbody>
            </table>
          </section>
          <section className="card pad section-card">
            <h3>Recent activity in the workspace</h3>
            <ul className="plain-list">{d.activity.map((a) => <li key={a.id}><span className="strong">{humanize(a.action)}</span> <span className="muted small">· {a.actor} · {fmtDateTime(a.createdAt)}</span></li>)}</ul>
            {!d.activity.length && <p className="muted small">Nothing yet.</p>}
          </section>
        </div>
        <div className="side-col">
          <section className="card pad section-card">
            <h3>Details</h3>
            <dl className="kv small">
              <dt>Sign-in link</dt><dd><a href={signIn} target="_blank" rel="noreferrer" className="break">{signIn.replace(/^https?:\/\//, '')}</a></dd>
              <dt>Last active</dt><dd>{d.usage.lastActiveAt ? relDays(d.usage.lastActiveAt) : 'never'}</dd>
              {t.plan === 'trial' && <><dt>Trial ends</dt><dd>{fmtDate(t.trialEndsAt)} ({relDays(t.trialEndsAt)})</dd></>}
              <dt>Internal ID</dt><dd className="mono break">{t.id}</dd>
            </dl>
          </section>
          <NotesCard id={t.id} notes={t.notes} />
          <section className="card pad section-card">
            <h3>Console history</h3>
            <ul className="plain-list small">{d.platformHistory.map((h) => <li key={h.id}><span className="strong">{humanize(h.action.replace(/^TENANT_/, ''))}</span>{h.detail?.reason && <> — “{h.detail.reason}”</>}<span className="muted block">{h.actor} · {fmtDateTime(h.createdAt)}</span></li>)}</ul>
            <Link to={`/platform/audit?tenantId=${t.id}`} className="small">Full history →</Link>
          </section>
        </div>
      </div>

      {modal === 'suspend' && <SuspendModal tenant={t} onClose={() => setModal(undefined)} onDone={() => { setModal(undefined); load(); }} />}
      {modal === 'support' && <SupportModal tenant={t} onClose={() => setModal(undefined)} />}
      {modal === 'admin' && <AddAdminModal tenantId={t.id} onClose={() => setModal(undefined)} onDone={() => { setModal(undefined); load(); }} />}
    </div>
  );
}

let toastTimer: ReturnType<typeof setTimeout>;
function alertOk(msg: string) {
  const el = document.getElementById('platform-toast');
  if (!el) return;
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

function Meter({ label, used, max }: { label: string; used: number; max: number | null }) {
  const pct = max ? Math.min(100, (used / max) * 100) : 0;
  return (
    <div className="meter">
      <div className="row-between small"><span>{label}</span><span className="mono-num"><strong>{used.toLocaleString('en-IN')}</strong>{max !== null ? ` / ${max.toLocaleString('en-IN')}` : <span className="muted"> · no limit</span>}</span></div>
      {max !== null && <div className="meter-track" role="img" aria-label={`${label}: ${used} of ${max}`}><span className={`meter-fill ${pct >= 100 ? 'full' : pct >= 80 ? 'near' : ''}`} style={{ width: `${Math.max(pct, used ? 2 : 0)}%` }} /></div>}
    </div>
  );
}

function UsageCard({ d }: { d: Detail }) {
  const u = d.usage, e = d.effective;
  return (
    <section className="card pad section-card">
      <h3>Usage</h3>
      <div className="meters">
        <Meter label="Users (not disabled)" used={u.users} max={e.maxUsers} />
        <Meter label="Vendors" used={u.vendors} max={e.maxVendors} />
        <Meter label="Emails today" used={u.emailsToday} max={e.emailsPerDay} />
      </div>
      <p className="muted small">Emails in the last 30 days: {u.emailsLast30.toLocaleString('en-IN')}{u.emailsFailedLast30 > 0 && <> · <span className="err-text">{u.emailsFailedLast30} failed</span></>}
        {Object.keys(u.vendorsByStatus).length > 0 && <> · Vendors: {Object.entries(u.vendorsByStatus).map(([s, n]) => `${n} ${humanize(s).toLowerCase()}`).join(', ')}</>}</p>
    </section>
  );
}

function PlanCard({ d, onSaved }: { d: Detail; onSaved: () => void }) {
  const t = d.tenant;
  const num = (v: number | null | undefined) => (v === undefined ? '' : v === null ? 'unlimited' : String(v));
  const [plan, setPlan] = useState(t.plan);
  const [trialEnds, setTrialEnds] = useState(t.trialEndsAt?.slice(0, 10) ?? '');
  const [o, setO] = useState({ maxUsers: num(t.limits.maxUsers), maxVendors: num(t.limits.maxVendors), emailsPerDay: num(t.limits.emailsPerDay) });
  const [feat, setFeat] = useState<Partial<Features>>(t.limits.features ?? {});
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const parse = (s: string) => (s.trim() === '' ? undefined : /^unlimited$/i.test(s.trim()) ? null : Number(s));

  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(undefined);
    const limits: Record<string, unknown> = {};
    for (const k of ['maxUsers', 'maxVendors', 'emailsPerDay'] as const) {
      const v = parse(o[k]);
      if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 1)) return setMsg({ kind: 'error', text: 'Limits must be whole numbers, “unlimited”, or empty to use the plan’s value.' });
      if (v !== undefined) limits[k] = v;
    }
    if (Object.keys(feat).length) limits.features = feat;
    try {
      await papi(`/tenants/${t.id}`, { method: 'PATCH', body: { plan, limits, ...(plan === 'trial' ? { trialEndsAt: trialEnds || undefined } : {}) } });
      setMsg({ kind: 'success', text: 'Saved. Changes apply immediately.' }); onSaved();
    } catch (err: any) { setMsg({ kind: 'error', text: err.message }); }
  }
  const planDefault = (k: 'maxUsers' | 'maxVendors' | 'emailsPerDay') => {
    const p = PLAN_DEFAULTS[plan]?.[k];
    return p === null ? 'unlimited' : String(p ?? '');
  };
  return (
    <section className="card pad section-card">
      <h3>Plan and limits</h3>
      <p className="muted small">Leave a limit empty to use the plan’s value. Type “unlimited” to remove it for this workspace only.</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <form onSubmit={save} className="field-grid">
        <div className="field"><label htmlFor="pl">Plan</label><select id="pl" value={plan} onChange={(e) => setPlan(e.target.value)}>{Object.entries(PLAN_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        {plan === 'trial' && <div className="field"><label htmlFor="te">Trial ends on</label><input id="te" type="date" value={trialEnds} onChange={(e) => setTrialEnds(e.target.value)} /></div>}
        <div className="field"><label htmlFor="mu">Max users</label><input id="mu" value={o.maxUsers} onChange={(e) => setO({ ...o, maxUsers: e.target.value })} placeholder={`Plan: ${planDefault('maxUsers')}`} /></div>
        <div className="field"><label htmlFor="mv">Max vendors</label><input id="mv" value={o.maxVendors} onChange={(e) => setO({ ...o, maxVendors: e.target.value })} placeholder={`Plan: ${planDefault('maxVendors')}`} /></div>
        <div className="field"><label htmlFor="me">Emails per day</label><input id="me" value={o.emailsPerDay} onChange={(e) => setO({ ...o, emailsPerDay: e.target.value })} placeholder={`Plan: ${planDefault('emailsPerDay')}`} /></div>
        <div className="field field-wide"><label>Features</label>
          <div className="feature-list">{(Object.keys(FEATURE_LABEL) as (keyof Features)[]).map((k) => {
            const planOn = PLAN_DEFAULTS[plan]?.features[k] ?? true;
            const v = feat[k];
            return (
              <label key={k} className="feature-row">
                <span>{FEATURE_LABEL[k]}</span>
                <select value={v === undefined ? '' : v ? 'on' : 'off'} onChange={(e) => { const n = { ...feat }; if (e.target.value === '') delete n[k]; else n[k] = e.target.value === 'on'; setFeat(n); }}>
                  <option value="">Plan default ({planOn ? 'on' : 'off'})</option><option value="on">On</option><option value="off">Off</option>
                </select>
              </label>);
          })}</div></div>
        <div className="field-wide"><button className="btn btn-primary">Save plan</button></div>
      </form>
    </section>
  );
}
/** Mirrors server/src/lib/plans.ts (shown as hints only; the server decides). */
const PLAN_DEFAULTS: Record<string, { maxUsers: number | null; maxVendors: number | null; emailsPerDay: number | null; features: Features }> = {
  trial: { maxUsers: 5, maxVendors: 25, emailsPerDay: 200, features: { erp: false, ai: false, kyc: true } },
  standard: { maxUsers: 25, maxVendors: 1000, emailsPerDay: 2000, features: { erp: true, ai: true, kyc: true } },
  enterprise: { maxUsers: null, maxVendors: null, emailsPerDay: null, features: { erp: true, ai: true, kyc: true } },
};

function NotesCard({ id, notes }: { id: string; notes: string | null }) {
  const [v, setV] = useState(notes ?? '');
  const [saved, setSaved] = useState(false);
  return (
    <section className="card pad section-card">
      <h3>Internal notes</h3>
      <textarea rows={4} value={v} onChange={(e) => { setV(e.target.value); setSaved(false); }} placeholder="Only visible to platform admins" aria-label="Internal notes" />
      <div className="row-between"><span className="muted small">{saved ? 'Saved' : ''}</span>
        <button className="btn btn-secondary btn-sm" disabled={v === (notes ?? '')} onClick={async () => { await papi(`/tenants/${id}`, { method: 'PATCH', body: { notes: v || null } }); setSaved(true); }}>Save notes</button></div>
    </section>
  );
}

function SuspendModal({ tenant, onClose, onDone }: { tenant: Detail['tenant']; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  return (
    <Modal title={`Suspend ${tenant.name}?`} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button className="btn btn-danger" disabled={confirm !== tenant.slug || reason.trim().length < 3} onClick={async () => { try { await papi(`/tenants/${tenant.id}/suspend`, { body: { reason } }); onDone(); } catch (e: any) { setError(e.message); } }}>Suspend workspace</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <p>Everyone in the workspace is signed out immediately and can’t sign in again, and vendors can’t open their links. Nothing is deleted — you can reactivate at any time.</p>
      <div className="stack">
        <div className="field"><label htmlFor="sr">Reason (kept in the audit log)</label><input id="sr" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Invoice overdue since 1 Oct" autoFocus /></div>
        <div className="field"><label htmlFor="sc">Type <span className="mono">{tenant.slug}</span> to confirm</label><input id="sc" className="mono" value={confirm} onChange={(e) => setConfirm(e.target.value.trim())} /></div>
      </div>
    </Modal>
  );
}

function SupportModal({ tenant, onClose }: { tenant: Detail['tenant']; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [opened, setOpened] = useState<string>();
  const [error, setError] = useState<string>();
  return (
    <Modal title="Open support access" onClose={onClose} footer={opened
      ? <><button className="btn btn-ghost" onClick={onClose}>Close</button><a className="btn btn-primary" href={opened} target="_blank" rel="noreferrer" onClick={() => setTimeout(onClose, 100)}>Open {tenant.name} →</a></>
      : <><button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={reason.trim().length < 5} onClick={async () => { try { setOpened((await papi(`/tenants/${tenant.id}/support-access`, { body: { reason, minutes } })).redirect); } catch (e: any) { setError(e.message); } }}>Start support access</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      {opened ? <Alert kind="success">Support access is open for {minutes} minutes. Open the workspace in a new tab; you can look but not change anything.</Alert> : (
        <>
          <p>Lets you see <strong>{tenant.name}</strong> the way their administrator does, to help with a support request. You can look but not change anything, and access ends automatically.</p>
          <Alert kind="info">This is recorded in the customer’s own audit log with your name and reason.</Alert>
          <div className="field-grid">
            <div className="field field-wide"><label htmlFor="sp-r">Reason</label><input id="sp-r" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Ticket #142 — vendor invites not arriving" autoFocus /></div>
            <div className="field"><label htmlFor="sp-m">Duration</label><select id="sp-m" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={120}>2 hours</option></select></div>
          </div>
          <p className="muted small">While it’s open, this browser is signed in to that workspace (replacing any workspace sign-in you had). Use “End support access” on the yellow bar when you’re done.</p>
        </>
      )}
    </Modal>
  );
}

function AddAdminModal({ tenantId, onClose, onDone }: { tenantId: string; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: '', email: '' });
  const [error, setError] = useState<string>();
  return (
    <Modal title="Add administrator" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="aa">Send invitation</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <p className="muted small">Use this when the customer has lost access, e.g. their only administrator left the company.</p>
      <form id="aa" className="stack" onSubmit={async (e) => { e.preventDefault(); try { await papi(`/tenants/${tenantId}/admins`, { body: f }); onDone(); } catch (err: any) { setError(err.message); } }}>
        <div className="field"><label htmlFor="aa-n">Name</label><input id="aa-n" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus /></div>
        <div className="field"><label htmlFor="aa-e">Email</label><input id="aa-e" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></div>
      </form>
    </Modal>
  );
}
