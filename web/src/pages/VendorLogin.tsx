import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, tokens } from '../lib/api';
import { Alert } from '../components/ui';
import { BRAND } from '../brand';

export function VendorLogin() {
  const { token = '' } = useParams();
  const nav = useNavigate();
  const [invite, setInvite] = useState<{ vendorName: string; email: string }>();
  const [sent, setSent] = useState<{ sentTo: string; devOtp?: string }>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => { api(`/auth/invite/${token}`).then(setInvite).catch((e) => setError(e.message)); }, [token]);

  async function requestOtp() {
    setBusy(true); setError(undefined);
    try { setSent(await api('/auth/request-otp', { body: { token } })); setTimeout(() => codeRef.current?.focus(), 50); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try {
      const r = await api('/auth/verify-otp', { body: { token, code } });
      tokens.set('vendor', r.token);
      nav('/vendor');
    } catch (err: any) { setError(err.message); setBusy(false); }
  }

  return (
    <div className="center-page login-bg">
      <div className="card login-card split">
        <div className="login-side">
          <div className="brand brand-lg light"><span className="brand-mark">{BRAND.mark}</span><span>{BRAND.name}</span></div>
          <h2>Vendor registration</h2>
          <p>Register once, keep your details up to date, and track your approval in one place.</p>
        </div>
        <div className="login-main">
          {!invite && !error && <div className="spinner" />}
          {error && !invite && <Alert kind="error">{error}</Alert>}
          {invite && (
            <>
              <h2>Welcome, {invite.vendorName}</h2>
              {!sent ? (
                <>
                  <p className="muted">We’ll send a one-time sign-in code to <strong>{invite.email}</strong>.</p>
                  {error && <Alert kind="error">{error}</Alert>}
                  <button className="btn btn-primary btn-block" onClick={requestOtp} disabled={busy}>{busy ? 'Sending…' : 'Send code'}</button>
                </>
              ) : (
                <form onSubmit={verify}>
                  <p className="muted">Enter the 6-digit code sent to <strong>{sent.sentTo}</strong>.</p>
                  {sent.devOtp && <Alert kind="info">Prototype mode: your code is <strong className="mono">{sent.devOtp}</strong></Alert>}
                  {error && <Alert kind="error">{error}</Alert>}
                  <label htmlFor="otp" className="sr-only">One-time code</label>
                  <input id="otp" ref={codeRef} className="otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="••••••" />
                  <button className="btn btn-primary btn-block" disabled={busy || code.length !== 6}>{busy ? 'Verifying…' : 'Verify & continue'}</button>
                  <button type="button" className="link-btn small" onClick={requestOtp} disabled={busy}>Resend code</button>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
