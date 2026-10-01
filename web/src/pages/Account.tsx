import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Alert } from '../components/ui';
import { PasswordHint } from './auth/AuthLayout';
import { fmtDateTime } from '../lib/format';

export function Account() {
  const { me, refresh } = useSession();
  const [params] = useSearchParams();
  if (!me) return null;
  return (
    <div className="page narrow-page">
      <header className="page-head"><div><h1>My account</h1><p className="muted">{me.user.email} · {me.tenant.name} ({me.tenant.slug})</p></div></header>
      {me.mfaSetupRequired && <Alert kind="warning"><strong>{me.tenant.name}</strong> requires two-factor authentication. Set it up below to continue.</Alert>}
      <MfaCard enabled={me.user.mfaEnabled} required={!!me.tenant.settings.requireMfa} onChange={refresh} autoStart={params.get('setup') === '1'} />
      {!me.mfaSetupRequired && <OutOfOfficeCard />}
      {!me.mfaSetupRequired && <PasswordCard />}
      {!me.mfaSetupRequired && <SessionsCard />}
    </div>
  );
}

function MfaCard({ enabled, required, onChange, autoStart }: { enabled: boolean; required: boolean; onChange: () => Promise<unknown>; autoStart: boolean }) {
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string }>();
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>();
  const [disable, setDisable] = useState({ password: '', code: '' });
  const [showDisable, setShowDisable] = useState(false);
  const [error, setError] = useState<string>();

  async function start() { setError(undefined); try { setSetup(await api('/auth/mfa/setup', { method: 'POST' })); } catch (e: any) { setError(e.message); } }
  useEffect(() => { if (autoStart && !enabled) start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function enable(e: React.FormEvent) {
    e.preventDefault(); setError(undefined);
    try { const r = await api('/auth/mfa/enable', { body: { code } }); setCodes(r.recoveryCodes); setSetup(undefined); setCode(''); }
    catch (err: any) { setError(err.message); }
  }
  async function turnOff(e: React.FormEvent) {
    e.preventDefault(); setError(undefined);
    try { await api('/auth/mfa/disable', { body: disable }); setShowDisable(false); await onChange(); } catch (err: any) { setError(err.message); }
  }

  return (
    <section className="card pad section-card">
      <div className="row-between"><h3>Two-factor authentication</h3>{enabled && !codes ? <span className="badge badge-approved">On</span> : !codes && <span className="badge">Off</span>}</div>
      <p className="muted small">Protects your account with a code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password…).</p>
      {error && <Alert kind="error">{error}</Alert>}
      {codes ? (
        <>
          <Alert kind="success">Two-factor authentication is on. Save these recovery codes somewhere safe — each can be used once if you lose your phone.</Alert>
          <div className="recovery-codes mono">{codes.map((c) => <span key={c}>{c}</span>)}</div>
          <div className="btn-row">
            <button className="btn btn-secondary btn-sm" onClick={() => navigator.clipboard?.writeText(codes.join('\n'))}>Copy</button>
            <a className="btn btn-secondary btn-sm" download="recovery-codes.txt" href={`data:text/plain;charset=utf-8,${encodeURIComponent(codes.join('\n'))}`}>Download</a>
            <button className="btn btn-primary btn-sm" onClick={async () => { setCodes(undefined); await onChange(); }}>I’ve saved them</button>
          </div>
        </>
      ) : enabled ? (
        !required && (showDisable ? (
          <form onSubmit={turnOff} className="inline-form">
            <input type="password" placeholder="Password" value={disable.password} onChange={(e) => setDisable({ ...disable, password: e.target.value })} aria-label="Password" />
            <input placeholder="6-digit code" value={disable.code} onChange={(e) => setDisable({ ...disable, code: e.target.value })} aria-label="Authenticator code" />
            <button className="btn btn-danger btn-sm">Turn off</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowDisable(false)}>Cancel</button>
          </form>
        ) : <button className="btn btn-secondary btn-sm" onClick={() => setShowDisable(true)}>Turn off…</button>)
      ) : setup ? (
        <form onSubmit={enable} className="mfa-setup">
          <img src={setup.qrDataUrl} alt="QR code for your authenticator app" width={180} height={180} />
          <div className="stack">
            <ol className="small">
              <li>Scan the QR code with your authenticator app.</li>
              <li>Can’t scan? Enter this key: <code className="mono break">{setup.secret}</code></li>
              <li>Type the 6-digit code the app shows.</li>
            </ol>
            <input className="otp-input" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} maxLength={6} placeholder="••••••" aria-label="Code from app" autoFocus />
            <button className="btn btn-primary" disabled={code.length !== 6}>Turn on</button>
          </div>
        </form>
      ) : (
        <button className="btn btn-primary btn-sm" onClick={start}>Set up two-factor authentication</button>
      )}
    </section>
  );
}

function PasswordCard() {
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (f.newPassword !== f.confirm) return setMsg({ kind: 'error', text: 'New passwords don’t match' });
    try { await api('/auth/change-password', { body: { currentPassword: f.currentPassword, newPassword: f.newPassword } }); setF({ currentPassword: '', newPassword: '', confirm: '' }); setMsg({ kind: 'success', text: 'Password changed. Other devices have been signed out.' }); }
    catch (err: any) { setMsg({ kind: 'error', text: err.message }); }
  }
  return (
    <section className="card pad section-card">
      <h3>Password</h3>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <form onSubmit={submit} className="field-grid">
        <div className="field"><label htmlFor="cp">Current password</label><input id="cp" type="password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} required autoComplete="current-password" /></div>
        <div className="field"><label htmlFor="np">New password</label><input id="np" type="password" value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} required autoComplete="new-password" /><PasswordHint /></div>
        <div className="field"><label htmlFor="np2">Confirm new password</label><input id="np2" type="password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required autoComplete="new-password" /></div>
        <div className="field-wide"><button className="btn btn-secondary">Change password</button></div>
      </form>
    </section>
  );
}

function SessionsCard() {
  const [rows, setRows] = useState<{ id: string; createdAt: string; lastSeenAt: string; ip?: string; userAgent?: string; current: boolean }[]>();
  const load = () => api('/auth/sessions').then(setRows);
  useEffect(() => { load(); }, []);
  return (
    <section className="card pad section-card">
      <div className="row-between"><h3>Active sessions</h3>{rows && rows.length > 1 && <button className="btn btn-secondary btn-sm" onClick={async () => { await api('/auth/sessions/revoke-others', { method: 'POST' }); load(); }}>Sign out other sessions</button>}</div>
      <ul className="plain-list">
        {rows?.map((s) => (
          <li key={s.id}><strong>{browserName(s.userAgent)}</strong>{s.current && <span className="badge badge-approved">This device</span>}<span className="muted small block">IP {s.ip ?? '—'} · signed in {fmtDateTime(s.createdAt)} · last active {fmtDateTime(s.lastSeenAt)}</span></li>
        ))}
      </ul>
    </section>
  );
}

function browserName(ua?: string) {
  if (!ua) return 'Unknown device';
  const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${b}${os ? ` on ${os}` : ''}`;
}

interface Deleg { id: string; toUserId: string; toName?: string; startsAt: string; endsAt: string; reason?: string }
function OutOfOfficeCard() {
  const [data, setData] = useState<{ mine: Deleg[]; covering: { id: string; name: string; startsAt: string; endsAt: string }[]; colleagues: { id: string; name: string; email: string }[] }>();
  const today = new Date(); const inAWeek = new Date(Date.now() + 7 * 86_400_000);
  const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const [f, setF] = useState({ toUserId: '', startsAt: local(today), endsAt: local(inAWeek), reason: '' });
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const load = () => api('/me/delegations').then(setData);
  useEffect(() => { load(); }, []);
  async function add(e: React.FormEvent) {
    e.preventDefault(); setMsg(undefined);
    try { await api('/me/delegations', { body: { ...f, startsAt: new Date(f.startsAt).toISOString(), endsAt: new Date(f.endsAt).toISOString() } }); setMsg({ kind: 'success', text: 'Out-of-office set. Your delegate can now act on your approvals during that time.' }); load(); }
    catch (err: any) { setMsg({ kind: 'error', text: err.message }); }
  }
  return (
    <section className="card pad section-card">
      <h3>Out of office</h3>
      <p className="muted small">While you’re away, a colleague can approve, send back or reject everything waiting for you. Your own access is unchanged.</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {data?.covering.map((c) => <Alert key={c.id} kind="info">You’re covering for <strong>{c.name}</strong> until {fmtDateTime(c.endsAt)}. Their approvals appear in your queue.</Alert>)}
      {data?.mine.length ? (
        <ul className="plain-list">
          {data.mine.map((d) => (
            <li key={d.id}><strong>{d.toName}</strong><span className="muted small">{fmtDateTime(d.startsAt)} → {fmtDateTime(d.endsAt)}{d.reason ? ` · ${d.reason}` : ''}</span>
              <button className="link-btn small danger" onClick={async () => { await api(`/me/delegations/${d.id}`, { method: 'DELETE' }); load(); }}>End</button></li>
          ))}
        </ul>
      ) : null}
      <form onSubmit={add} className="field-grid">
        <div className="field"><label htmlFor="oo-to">Delegate to</label>
          <select id="oo-to" value={f.toUserId} onChange={(e) => setF({ ...f, toUserId: e.target.value })} required>
            <option value="">Choose a colleague…</option>{data?.colleagues.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></div>
        <div className="field"><label htmlFor="oo-from">From</label><input id="oo-from" type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} required /></div>
        <div className="field"><label htmlFor="oo-until">Until</label><input id="oo-until" type="datetime-local" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} required /></div>
        <div className="field"><label htmlFor="oo-why">Reason (optional)</label><input id="oo-why" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Annual leave" /></div>
        <div className="field-wide"><button className="btn btn-secondary">Set out of office</button></div>
      </form>
    </section>
  );
}
