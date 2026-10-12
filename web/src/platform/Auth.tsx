import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Alert } from '../components/ui';
import { AuthLayout, PasswordHint } from '../pages/auth/AuthLayout';
import { papi, usePlatform } from './session';

const Tag = () => <span className="badge platform-tag">Platform console</span>;

export function PlatformLogin() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { refresh } = usePlatform();
  const [f, setF] = useState({ email: '', password: '' });
  const [step, setStep] = useState<'password' | 'mfa'>('password');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const next = params.get('next') || '/platform';

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined);
    try {
      const r = await papi('/auth/login', { body: f });
      if (r.mfaRequired) { setStep('mfa'); setBusy(false); return; }
      await refresh(); nav('/platform/setup-2fa', { replace: true });
    } catch (err: any) { setError(err.message); setBusy(false); }
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined);
    try { await papi('/auth/mfa/verify', { body: { code } }); await refresh(); nav(next, { replace: true }); }
    catch (err: any) { setError(err.message); setBusy(false); }
  }
  return (
    <AuthLayout title={step === 'password' ? 'Sign in' : 'Two-factor verification'} subtitle={<Tag />}>
      {params.get('reset') && <Alert kind="success">Password updated. Sign in with your new password.</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      {step === 'password' ? (
        <form onSubmit={submit} className="stack">
          <div className="field"><label htmlFor="pe">Email</label><input id="pe" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required autoComplete="username" autoFocus /></div>
          <div className="field"><label htmlFor="pp">Password</label><input id="pp" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required autoComplete="current-password" /></div>
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <Link to="/platform/forgot-password" className="small center">Forgot password?</Link>
          <p className="small muted center">This console is for the VendorGate team. Customers sign in at <Link to="/login">the workspace sign-in</Link>.</p>
        </form>
      ) : (
        <form onSubmit={verify} className="stack">
          <p className="muted">Enter the 6-digit code from your authenticator app, or a recovery code.</p>
          <input className="otp-input" aria-label="Code" value={code} onChange={(e) => setCode(e.target.value.trim())} autoComplete="one-time-code" autoFocus maxLength={20} />
          <button className="btn btn-primary btn-block" disabled={busy || code.length < 6}>{busy ? 'Verifying…' : 'Verify'}</button>
        </form>
      )}
    </AuthLayout>
  );
}

/** Mandatory 2FA enrolment for platform admins. */
export function PlatformMfaSetup() {
  const nav = useNavigate();
  const { me, loading, refresh } = usePlatform();
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string }>();
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (loading) return;
    if (!me) { nav('/platform/login', { replace: true }); return; }
    if (!me.mfaSetupRequired) { nav('/platform', { replace: true }); return; }
    papi('/auth/mfa/setup', { method: 'POST' }).then(setSetup).catch((e) => setError(e.message));
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  async function enable(e: React.FormEvent) {
    e.preventDefault(); setError(undefined);
    try { setCodes((await papi('/auth/mfa/enable', { body: { code } })).recoveryCodes); } catch (err: any) { setError(err.message); }
  }
  return (
    <AuthLayout title="Set up two-factor authentication" subtitle={<><Tag /> Required for everyone who can manage customer workspaces.</>}>
      {error && <Alert kind="error">{error}</Alert>}
      {codes ? (
        <div className="stack">
          <Alert kind="success">Done. Save these recovery codes somewhere safe — each works once if you lose your phone.</Alert>
          <div className="recovery-codes mono">{codes.map((c) => <span key={c}>{c}</span>)}</div>
          <div className="btn-row">
            <button className="btn btn-secondary btn-sm" onClick={() => navigator.clipboard?.writeText(codes.join('\n'))}>Copy</button>
            <a className="btn btn-secondary btn-sm" download="vendorgate-platform-recovery-codes.txt" href={`data:text/plain;charset=utf-8,${encodeURIComponent(codes.join('\n'))}`}>Download</a>
          </div>
          <button className="btn btn-primary btn-block" onClick={async () => { await refresh(); nav('/platform', { replace: true }); }}>I’ve saved them — continue</button>
        </div>
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
      ) : !error && <div className="spinner" />}
    </AuthLayout>
  );
}

export function PlatformAcceptInvite() {
  const { token = '' } = useParams();
  const nav = useNavigate();
  const { refresh } = usePlatform();
  const [info, setInfo] = useState<{ name: string; email: string }>();
  const [f, setF] = useState({ name: '', password: '', confirm: '' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { papi(`/auth/invite/${token}`).then((i) => { setInfo(i); setF((x) => ({ ...x, name: i.name })); }).catch((e) => setError(e.message)); }, [token]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (f.password !== f.confirm) return setError('Passwords don’t match');
    setBusy(true); setError(undefined);
    try { await papi('/auth/accept-invite', { body: { token, name: f.name, password: f.password } }); await refresh(); nav('/platform/setup-2fa', { replace: true }); }
    catch (err: any) { setError(err.message); setBusy(false); }
  }
  return (
    <AuthLayout title="Join the platform console" subtitle={<><Tag /> {info?.email}</>}>
      {error && <Alert kind="error">{error}</Alert>}
      {info && (
        <form onSubmit={submit} className="stack">
          <div className="field"><label htmlFor="an">Your name</label><input id="an" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></div>
          <div className="field"><label htmlFor="ap">Password</label><input id="ap" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required autoComplete="new-password" /><PasswordHint /></div>
          <div className="field"><label htmlFor="ac">Confirm password</label><input id="ac" type="password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required autoComplete="new-password" /></div>
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Saving…' : 'Continue to 2FA setup'}</button>
        </form>
      )}
    </AuthLayout>
  );
}

export function PlatformForgot() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <AuthLayout title="Reset your password" subtitle={<Tag />}>
      {error && <Alert kind="error">{error}</Alert>}
      {sent ? <Alert kind="success">If {email} is a platform admin, a reset link is on its way. It’s valid for 1 hour.</Alert> : (
        <form className="stack" onSubmit={async (e) => { e.preventDefault(); try { await papi('/auth/forgot-password', { body: { email } }); setSent(true); } catch (err: any) { setError(err.message); } }}>
          <div className="field"><label htmlFor="fe">Email</label><input id="fe" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <button className="btn btn-primary btn-block">Send reset link</button>
        </form>
      )}
      <Link to="/platform/login" className="small center block">Back to sign in</Link>
    </AuthLayout>
  );
}

export function PlatformReset() {
  const { token = '' } = useParams();
  const nav = useNavigate();
  const [f, setF] = useState({ password: '', confirm: '' });
  const [error, setError] = useState<string>();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (f.password !== f.confirm) return setError('Passwords don’t match');
    try { await papi('/auth/reset-password', { body: { token, password: f.password } }); nav('/platform/login?reset=1', { replace: true }); } catch (err: any) { setError(err.message); }
  }
  return (
    <AuthLayout title="Choose a new password" subtitle={<Tag />}>
      {error && <Alert kind="error">{error}</Alert>}
      <form onSubmit={submit} className="stack">
        <div className="field"><label htmlFor="rp">New password</label><input id="rp" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required autoComplete="new-password" /><PasswordHint /></div>
        <div className="field"><label htmlFor="rc">Confirm</label><input id="rc" type="password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} required autoComplete="new-password" /></div>
        <button className="btn btn-primary btn-block">Save password</button>
      </form>
    </AuthLayout>
  );
}
