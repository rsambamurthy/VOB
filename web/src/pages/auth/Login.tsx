import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, lastWorkspace } from '../../lib/api';
import { useSession } from '../../lib/session';
import { Alert } from '../../components/ui';
import { AuthLayout } from './AuthLayout';

export function Login() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { refresh } = useSession();
  const [workspace, setWorkspace] = useState(params.get('workspace') ?? lastWorkspace.get());
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<'password' | 'mfa'>('password');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const next = params.get('next') || '/staff/vendors';
  const [signupOpen, setSignupOpen] = useState(false);
  useEffect(() => { api('/signup/config').then((c) => setSignupOpen(!!c.enabled)).catch(() => {}); }, []);

  async function finish() {
    const me = await refresh();
    nav(me?.mfaSetupRequired ? '/staff/account?setup=1' : next, { replace: true });
  }

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined);
    try {
      const r = await api('/auth/login', { body: { workspace, email, password } });
      lastWorkspace.set(workspace.trim().toLowerCase());
      if (r.mfaRequired) { setStep('mfa'); setBusy(false); return; }
      await finish();
    } catch (err: any) { setError(err.message); setBusy(false); }
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined);
    try {
      const r = await api('/auth/mfa/verify', { body: { code } });
      if (r.recoveryCodesLeft !== undefined && r.recoveryCodesLeft < 3) setNotice(`Only ${r.recoveryCodesLeft} recovery codes left — turn 2FA off and on again from your account page to get new ones.`);
      await finish();
    } catch (err: any) { setError(err.message); setBusy(false); }
  }

  return (
    <AuthLayout title={step === 'password' ? 'Sign in to your workspace' : 'Two-factor verification'}>
      {params.get('reset') && <Alert kind="success">Password updated. Sign in with your new password.</Alert>}
      {notice && <Alert kind="warning">{notice}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      {step === 'password' ? (
        <form onSubmit={submitPassword} className="stack">
          <div className="field"><label htmlFor="ws">Workspace ID</label><input id="ws" value={workspace} onChange={(e) => setWorkspace(e.target.value)} placeholder="e.g. acme" required autoComplete="organization" autoCapitalize="none" /></div>
          <div className="field"><label htmlFor="em">Email</label><input id="em" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" /></div>
          <div className="field"><label htmlFor="pw">Password</label><input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" /></div>
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <Link to={`/forgot-password?workspace=${encodeURIComponent(workspace)}`} className="small center">Forgot password?</Link>
          <p className="small muted center">Supplier? Use the invitation link from your email instead.</p>
          {signupOpen && <p className="small center">New to VendorGate? <Link to="/signup">Create a workspace</Link></p>}
        </form>
      ) : (
        <form onSubmit={submitCode} className="stack">
          <p className="muted">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
          <label htmlFor="code" className="sr-only">Code</label>
          <input id="code" className="otp-input" value={code} onChange={(e) => setCode(e.target.value.trim())} autoComplete="one-time-code" autoFocus maxLength={20} />
          <button className="btn btn-primary btn-block" disabled={busy || code.length < 6}>{busy ? 'Verifying…' : 'Verify'}</button>
          <button type="button" className="link-btn small center" onClick={() => { setStep('password'); setCode(''); }}>Back</button>
        </form>
      )}
    </AuthLayout>
  );
}
