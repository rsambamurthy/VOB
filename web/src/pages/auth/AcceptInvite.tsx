import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, lastWorkspace } from '../../lib/api';
import { useSession } from '../../lib/session';
import { Alert } from '../../components/ui';
import { AuthLayout, PasswordHint } from './AuthLayout';

export function AcceptInvite() {
  const { token = '' } = useParams();
  const nav = useNavigate();
  const { refresh } = useSession();
  const [info, setInfo] = useState<{ name: string; email: string; workspace: string; tenantName: string }>();
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { api(`/auth/invite/${token}`).then((i) => { setInfo(i); setName(i.name); }).catch((e) => setError(e.message)); }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw !== pw2) return setError('Passwords don’t match');
    setBusy(true); setError(undefined);
    try {
      const r = await api('/auth/accept-invite', { body: { token, name, password: pw } });
      lastWorkspace.set(info!.workspace);
      await refresh();
      nav(r.mfaSetupRequired ? '/staff/account?setup=1' : '/staff/vendors', { replace: true });
    } catch (err: any) { setError(err.message); setBusy(false); }
  }
  return (
    <AuthLayout title={info ? `Join ${info.tenantName}` : 'Accept invitation'} subtitle={info && <>Workspace ID <strong>{info.workspace}</strong> · {info.email}</>}>
      {error && <Alert kind="error">{error}</Alert>}
      {info && (
        <form onSubmit={submit} className="stack">
          <div className="field"><label htmlFor="nm">Your name</label><input id="nm" value={name} onChange={(e) => setName(e.target.value)} required /></div>
          <div className="field"><label htmlFor="pw">Password</label><input id="pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} required autoComplete="new-password" /><PasswordHint /></div>
          <div className="field"><label htmlFor="pw2">Confirm password</label><input id="pw2" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} required autoComplete="new-password" /></div>
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</button>
        </form>
      )}
    </AuthLayout>
  );
}
