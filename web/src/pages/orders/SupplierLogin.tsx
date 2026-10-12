import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { applyBranding } from '../../lib/session';
import { monogram } from '../../lib/format';
import type { Branding } from '../../lib/types';
import { Alert } from '../../components/ui';
import { rememberWorkspace } from '../../orders/SupplierShell';

/** Returning suppliers sign in with their email and a one-time code: /s/:workspace */
export function SupplierLogin() {
  const { workspace = '' } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const next = sp.get('next');
  const target = next && /^\/vendor(\/|$)/.test(next) ? next : '/vendor';
  const [ws, setWs] = useState<{ name: string; branding: Branding }>();
  const [email, setEmail] = useState(sp.get('email') ?? '');
  const [sent, setSent] = useState<{ devOtp?: string }>();
  const [code, setCode] = useState('');
  const [choose, setChoose] = useState<{ id: string; name: string; code: string }[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => { api(`/vendor-auth/workspace/${encodeURIComponent(workspace)}`).then((w) => { setWs(w); applyBranding(w.branding); }).catch((e) => setError(e.message)); }, [workspace]);

  async function request(e?: React.FormEvent) {
    e?.preventDefault(); setBusy(true); setError(undefined);
    try { setSent(await api('/vendor-auth/email/request', { body: { workspace, email } })); setCode(''); setTimeout(() => codeRef.current?.focus(), 50); }
    catch (er: any) { setError(er.message); } finally { setBusy(false); }
  }
  async function verify(vendorId?: string) {
    setBusy(true); setError(undefined);
    try {
      const r = await api<{ ok?: boolean; choose?: typeof choose }>('/vendor-auth/email/verify', { body: { workspace, email, code, vendorId } });
      if (r.choose) { setChoose(r.choose); setBusy(false); return; }
      rememberWorkspace(workspace);
      nav(target);
    } catch (er: any) { setError(er.message); setBusy(false); }
  }

  return (
    <div className="center-page login-bg">
      <div className="card login-card split">
        <div className="login-side">
          <div className="brand brand-lg light">
            {ws?.branding.logoUrl ? <img src={ws.branding.logoUrl} alt="" className="brand-logo" /> : <span className="brand-mark">{monogram(ws?.branding.productName)}</span>}
            <span>{ws?.branding.productName ?? 'VendorGate'}</span>
          </div>
          <h2>{ws ? `${ws.name} supplier portal` : 'Supplier portal'}</h2>
          <p>See and accept purchase orders, and keep your company details up to date.</p>
        </div>
        <div className="login-main">
          {!ws && !error && <div className="spinner" />}
          {error && !ws && <Alert kind="error">{error}</Alert>}
          {ws && !sent && (
            <form onSubmit={request}>
              <h2>Sign in</h2>
              <p className="muted">Use the email address {ws.name} has on file for your company. We’ll send you a one-time code.</p>
              {error && <Alert kind="error">{error}</Alert>}
              <div className="field"><label htmlFor="s-email">Work email</label><input id="s-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
              <button className="btn btn-primary btn-block" disabled={busy || !email.includes('@')}>{busy ? 'Sending…' : 'Send code'}</button>
            </form>
          )}
          {ws && sent && !choose && (
            <form onSubmit={(e) => { e.preventDefault(); verify(); }}>
              <h2>Check your email</h2>
              <p className="muted">If <strong>{email}</strong> has access, a 6-digit code is on its way. It expires in 10 minutes.</p>
              {sent.devOtp && <Alert kind="info">Prototype mode: your code is <strong className="mono">{sent.devOtp}</strong></Alert>}
              {error && <Alert kind="error">{error}</Alert>}
              <label htmlFor="s-otp" className="sr-only">One-time code</label>
              <input id="s-otp" ref={codeRef} className="otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="••••••" />
              <button className="btn btn-primary btn-block" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Sign in'}</button>
              <div className="row-between"><button type="button" className="link-btn small" onClick={() => { setSent(undefined); setError(undefined); }}>Use a different email</button>
                <button type="button" className="link-btn small" onClick={() => request()} disabled={busy}>Resend code</button></div>
            </form>
          )}
          {choose && (
            <div>
              <h2>Which company?</h2>
              <p className="muted">{email} has access to more than one supplier account. Choose the one to work on — you can sign out and pick another later.</p>
              {error && <Alert kind="error">{error}</Alert>}
              <div className="choice-list">{choose.map((v) => (
                <button key={v.id} className="user-card" disabled={busy} onClick={() => verify(v.id)}><span className="avatar" aria-hidden>{monogram(v.name)}</span><div><div className="strong">{v.name}</div><div className="muted small mono">{v.code}</div></div></button>
              ))}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
