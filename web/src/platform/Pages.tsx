import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Empty, Modal } from '../components/ui';
import { fmtDateTime, humanize } from '../lib/format';
import { PLAN_LABEL, papi, usePlatform, type PlatformAdmin } from './session';

/* ---------- Sign-ups ---------- */

interface Signup { id: string; email: string; name: string; company: string; slug: string; createdAt: string; completedAt: string | null; tenantId: string | null; ip: string | null; state: 'COMPLETED' | 'EXPIRED' | 'WAITING' }
const SIGNUP_STATE: Record<Signup['state'], [string, string]> = { COMPLETED: ['Workspace created', 'badge-approved'], WAITING: ['Waiting for email confirmation', 'badge-under_review'], EXPIRED: ['Link expired', 'badge-invited'] };

export function PlatformSignups() {
  const [rows, setRows] = useState<Signup[]>();
  const [enabled, setEnabled] = useState<boolean>();
  useEffect(() => { papi('/signups').then(setRows); papi('/settings').then((s) => setEnabled(s.signupEnabled)); }, []);
  const url = `${window.location.origin}/signup`;
  return (
    <div className="page">
      <header className="page-head"><div><h1>Sign-ups</h1><p className="muted">Companies that signed up themselves at <a href={url} target="_blank" rel="noreferrer">{url.replace(/^https?:\/\//, '')}</a>.</p></div></header>
      {enabled === false && <Alert kind="info">Self-service sign-up is <strong>off</strong>. Turn it on in <Link to="/platform/settings">Sign-up settings</Link>.</Alert>}
      <div className="card">
        {!rows ? <div className="pad"><div className="spinner" /></div> : !rows.length ? <Empty>No sign-ups yet.</Empty> : (
          <div className="table-wrap"><table className="table static">
            <thead><tr><th>Company</th><th>Person</th><th>Status</th><th>Signed up</th></tr></thead>
            <tbody>{rows.map((s) => (
              <tr key={s.id}>
                <td><div className="strong">{s.tenantId ? <Link to={`/platform/tenants/${s.tenantId}`}>{s.company}</Link> : s.company}</div><div className="muted small mono">{s.slug}</div></td>
                <td>{s.name}<div className="muted small">{s.email}</div></td>
                <td><span className={`badge ${SIGNUP_STATE[s.state][1]}`}>{SIGNUP_STATE[s.state][0]}</span></td>
                <td className="muted small">{fmtDateTime(s.createdAt)}{s.ip && <div>IP {s.ip}</div>}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}

/* ---------- Settings ---------- */

interface Settings { signupEnabled: boolean; signupPlan: string; trialDays: number; blockFreeEmail: boolean; notifyEmail: string | null; termsUrl: string | null; updatedAt: string }

export function PlatformSettings() {
  const [s, setS] = useState<Settings>();
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  useEffect(() => { papi('/settings').then(setS); }, []);
  if (!s) return <div className="page"><div className="spinner" /></div>;
  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(undefined);
    try { setS(await papi('/settings', { method: 'PUT', body: { signupEnabled: s!.signupEnabled, signupPlan: s!.signupPlan, trialDays: s!.trialDays, blockFreeEmail: s!.blockFreeEmail, notifyEmail: s!.notifyEmail ?? '', termsUrl: s!.termsUrl ?? '' } })); setMsg({ kind: 'success', text: 'Saved.' }); }
    catch (err: any) { setMsg({ kind: 'error', text: err.message }); }
  }
  const url = `${window.location.origin}/signup`;
  return (
    <div className="page narrow-page">
      <header className="page-head"><div><h1>Sign-up settings</h1><p className="muted">Let companies create their own workspace without talking to you first.</p></div></header>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <form onSubmit={save}>
        <section className="card pad section-card">
          <label className="check-row"><input type="checkbox" checked={s.signupEnabled} onChange={(e) => setS({ ...s, signupEnabled: e.target.checked })} />
            <span><strong>Allow self-service sign-up</strong><span className="muted small block">Shows “Create a workspace” on the sign-in page and opens <a href={url} target="_blank" rel="noreferrer">{url.replace(/^https?:\/\//, '')}</a>. People confirm their email before the workspace is created.</span></span></label>
        </section>
        <section className="card pad section-card">
          <h3>New sign-ups get</h3>
          <div className="field-grid">
            <div className="field"><label htmlFor="sp">Plan</label><select id="sp" value={s.signupPlan} onChange={(e) => setS({ ...s, signupPlan: e.target.value })}>{Object.entries(PLAN_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            {s.signupPlan === 'trial' && <div className="field"><label htmlFor="td">Trial length (days)</label><input id="td" type="number" min={1} max={365} value={s.trialDays} onChange={(e) => setS({ ...s, trialDays: Number(e.target.value) })} /></div>}
          </div>
          <p className="muted small">Trial: 5 users, 25 vendors, 200 emails a day, no ERP or AI. When a trial ends, people can still sign in and see their data but can’t add vendors or users until you change the plan.</p>
        </section>
        <section className="card pad section-card">
          <h3>Protection</h3>
          <label className="check-row"><input type="checkbox" checked={s.blockFreeEmail} onChange={(e) => setS({ ...s, blockFreeEmail: e.target.checked })} />
            <span><strong>Work email addresses only</strong><span className="muted small block">Rejects Gmail, Outlook.com, Yahoo, Rediffmail, disposable addresses and similar. Recommended: it keeps out most fake sign-ups and tells you which company is behind each one.</span></span></label>
          <p className="muted small">Always on: email confirmation, rate limits per IP and per email address, and a hidden field that catches bots.</p>
        </section>
        <section className="card pad section-card">
          <h3>Notifications and terms</h3>
          <div className="field-grid">
            <div className="field"><label htmlFor="ne">Email me about new sign-ups</label><input id="ne" type="email" value={s.notifyEmail ?? ''} onChange={(e) => setS({ ...s, notifyEmail: e.target.value })} placeholder="sales@yourcompany.com" /></div>
            <div className="field"><label htmlFor="tu">Terms of service link</label><input id="tu" value={s.termsUrl ?? ''} onChange={(e) => setS({ ...s, termsUrl: e.target.value })} placeholder="https://integratatech.ai/terms" /><div className="field-help">People must accept it to sign up.</div></div>
          </div>
        </section>
        <button className="btn btn-primary">Save settings</button>
      </form>
    </div>
  );
}

/* ---------- Platform admins ---------- */

export function PlatformAdmins() {
  const { me } = usePlatform();
  const [rows, setRows] = useState<PlatformAdmin[]>();
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const load = () => papi('/admins').then(setRows);
  useEffect(() => { load(); }, []);
  const act = async (fn: () => Promise<unknown>, ok: string) => { setError(undefined); setNotice(undefined); try { await fn(); setNotice(ok); load(); } catch (e: any) { setError(e.message); } };
  return (
    <div className="page">
      <header className="page-head"><div><h1>Platform admins</h1><p className="muted">People who can create and manage every customer workspace. Keep this list short; everyone must use two-factor authentication.</p></div>
        <button className="btn btn-primary" onClick={() => setInviting(true)}>Invite admin</button></header>
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      <div className="card"><div className="table-wrap"><table className="table static">
        <thead><tr><th>Name</th><th>Status</th><th>2FA</th><th>Last sign-in</th><th /></tr></thead>
        <tbody>{rows?.map((a) => (
          <tr key={a.id}>
            <td><div className="strong">{a.name}{a.id === me?.admin.id && <span className="badge sm">you</span>}</div><div className="muted small">{a.email}</div></td>
            <td><span className={`badge ${a.status === 'ACTIVE' ? 'badge-approved' : a.status === 'INVITED' ? 'badge-invited' : 'badge-rejected'}`}>{humanize(a.status)}</span></td>
            <td className="small">{a.mfaEnabled ? 'On' : <span className="muted">Not set up</span>}</td>
            <td className="muted small">{fmtDateTime(a.lastLoginAt)}</td>
            <td className="actions">{a.id !== me?.admin.id && <>
              {a.status === 'INVITED' && <button className="link-btn small" onClick={() => act(() => papi(`/admins/${a.id}/resend-invite`, { method: 'POST' }), `Invitation sent again to ${a.email}.`)}>Resend invite</button>}
              {a.status === 'ACTIVE' && a.mfaEnabled && <button className="link-btn small" onClick={() => act(() => papi(`/admins/${a.id}`, { method: 'PATCH', body: { resetMfa: true } }), `${a.name} will set up two-factor authentication again at the next sign-in.`)}>Reset 2FA</button>}
              {a.status === 'ACTIVE' && <button className="link-btn small danger" onClick={() => act(() => papi(`/admins/${a.id}`, { method: 'PATCH', body: { status: 'DISABLED' } }), `${a.name} can no longer sign in.`)}>Disable</button>}
              {a.status === 'DISABLED' && <button className="link-btn small" onClick={() => act(() => papi(`/admins/${a.id}`, { method: 'PATCH', body: { status: 'ACTIVE' } }), `${a.name} can sign in again.`)}>Enable</button>}
            </>}</td>
          </tr>))}</tbody>
      </table></div></div>
      {inviting && <InviteAdmin onClose={() => setInviting(false)} onDone={(email) => { setInviting(false); setNotice(`Invitation sent to ${email}.`); load(); }} />}
      <ChangePassword />
    </div>
  );
}

function InviteAdmin({ onClose, onDone }: { onClose: () => void; onDone: (email: string) => void }) {
  const [f, setF] = useState({ name: '', email: '' });
  const [error, setError] = useState<string>();
  return (
    <Modal title="Invite a platform admin" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="ia">Send invitation</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <form id="ia" className="stack" onSubmit={async (e) => { e.preventDefault(); try { await papi('/admins', { body: f }); onDone(f.email); } catch (err: any) { setError(err.message); } }}>
        <div className="field"><label htmlFor="ia-n">Name</label><input id="ia-n" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus /></div>
        <div className="field"><label htmlFor="ia-e">Email</label><input id="ia-e" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></div>
      </form>
    </Modal>
  );
}

function ChangePassword() {
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  return (
    <section className="card pad section-card" style={{ marginTop: 16 }}>
      <h3>Your password</h3>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <form className="field-grid" onSubmit={async (e) => {
        e.preventDefault();
        if (f.newPassword !== f.confirm) return setMsg({ kind: 'error', text: 'New passwords don’t match' });
        try { await papi('/auth/change-password', { body: { currentPassword: f.currentPassword, newPassword: f.newPassword } }); setF({ currentPassword: '', newPassword: '', confirm: '' }); setMsg({ kind: 'success', text: 'Password changed. Other sessions have been signed out.' }); }
        catch (err: any) { setMsg({ kind: 'error', text: err.message }); }
      }}>
        <div className="field"><label htmlFor="cp1">Current password</label><input id="cp1" type="password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} required autoComplete="current-password" /></div>
        <div className="field"><label htmlFor="cp2">New password</label><input id="cp2" type="password" value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} required autoComplete="new-password" /></div>
        <div className="field"><label htmlFor="cp3">Confirm</label><input id="cp3" type="password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required autoComplete="new-password" /></div>
        <div className="field-wide"><button className="btn btn-secondary">Change password</button></div>
      </form>
    </section>
  );
}

/* ---------- Audit ---------- */

interface AuditRow { id: string; actor: string; action: string; tenantId: string | null; tenantName: string | null; tenantSlug: string | null; detail: Record<string, unknown> | null; ip: string | null; createdAt: string }

export function PlatformAudit() {
  const [params] = useSearchParams();
  const tenantId = params.get('tenantId') ?? '';
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [more, setMore] = useState(true);
  const load = async (before?: string) => {
    const qs = new URLSearchParams({ ...(tenantId ? { tenantId } : {}), ...(before ? { before } : {}) });
    const r: AuditRow[] = await papi(`/audit?${qs}`);
    setRows((x) => (before ? [...x, ...r] : r)); setMore(r.length === 100);
  };
  useEffect(() => { load(); }, [tenantId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="page">
      <header className="page-head"><div><h1>Audit log</h1><p className="muted">Everything done in the platform console, plus sign-ins and self-service sign-ups.{tenantId && <> Showing one workspace. <Link to="/platform/audit">Show all</Link></>}</p></div></header>
      <div className="card"><div className="table-wrap"><table className="table static compact">
        <thead><tr><th>When</th><th>Who</th><th>What</th><th>Workspace</th><th>Details</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}>
            <td className="nowrap small">{fmtDateTime(r.createdAt)}</td>
            <td className="small">{r.actor}{r.ip && <div className="muted">{r.ip}</div>}</td>
            <td className="small strong">{humanize(r.action)}</td>
            <td className="small">{r.tenantId ? (r.tenantName ? <Link to={`/platform/tenants/${r.tenantId}`}>{r.tenantName}</Link> : <span className="muted">deleted</span>) : '—'}</td>
            <td className="small muted">{r.detail ? Object.entries(r.detail).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ') : ''}</td>
          </tr>))}</tbody>
      </table></div>
        {!rows.length && <Empty>Nothing recorded yet.</Empty>}
        {more && rows.length > 0 && <div className="pad center"><button className="btn btn-secondary btn-sm" onClick={() => load(rows[rows.length - 1].createdAt)}>Load older</button></div>}
      </div>
    </div>
  );
}
