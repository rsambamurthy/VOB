import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Alert } from '../../components/ui';
import { AuthLayout, PasswordHint } from './AuthLayout';

export function ResetPassword() {
  const { token = '' } = useParams();
  const nav = useNavigate();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw !== pw2) return setError('Passwords don’t match');
    setBusy(true); setError(undefined);
    try {
      const r = await api('/auth/reset-password', { body: { token, password: pw } });
      nav(`/login?workspace=${encodeURIComponent(r.workspace)}&reset=1`, { replace: true });
    } catch (err: any) { setError(err.message); setBusy(false); }
  }
  return (
    <AuthLayout title="Choose a new password" subtitle="You’ll be signed out on every other device.">
      <form onSubmit={submit} className="stack">
        {error && <Alert kind="error">{error}</Alert>}
        <div className="field"><label htmlFor="pw">New password</label><input id="pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} required autoComplete="new-password" /><PasswordHint /></div>
        <div className="field"><label htmlFor="pw2">Confirm password</label><input id="pw2" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} required autoComplete="new-password" /></div>
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Saving…' : 'Set password'}</button>
      </form>
    </AuthLayout>
  );
}
