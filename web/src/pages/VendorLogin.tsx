import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { applyBranding } from '../lib/session';
import { monogram } from '../lib/format';
import type { Branding } from '../lib/types';
import { Alert } from '../components/ui';
import { PoweredBy, PRODUCT, ProductName } from '../components/Brand';

export function VendorLogin() {
  const { token = '' } = useParams();
  const nav = useNavigate();
  const [invite, setInvite] = useState<{ vendorName: string; email: string; buyer: { name: string; branding: Branding } }>();
  const [sent, setSent] = useState<{ sentTo: string; devOtp?: string }>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => { api(`/vendor-auth/invite/${token}`).then((i) => { setInvite(i); applyBranding(i.buyer.branding); }).catch((e) => setError(e.message)); }, [token]);

  async function requestOtp() {
    setBusy(true); setError(undefined);
    try { setSent(await api('/vendor-auth/request-otp', { body: { token } })); setTimeout(() => codeRef.current?.focus(), 50); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try {
      await api('/vendor-auth/verify-otp', { body: { token, code } });
      nav('/vendor');
    } catch (err: any) { setError(err.message); setBusy(false); }
  }

  return (
    <div className="center-page login-bg">
      <div className="card login-card split">
        <div className="login-side">
          <div className="brand brand-lg light">
            {invite?.buyer.branding.logoUrl ? <img src={invite.buyer.branding.logoUrl} alt="" className="brand-logo" /> : (invite?.buyer.branding.productName ?? PRODUCT) !== PRODUCT && <span className="brand-mark">{monogram(invite?.buyer.branding.productName)}</span>}
            <ProductName name={invite?.buyer.branding.productName} light />
          </div>
          <h2>{invite ? `${invite.buyer.name} supplier registration` : 'Supplier registration'}</h2>
          <p>Register once, keep your details up to date, and track your approval in one place.</p>
          <PoweredBy light />
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
