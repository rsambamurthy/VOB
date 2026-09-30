import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, lastWorkspace } from '../../lib/api';
import { Alert } from '../../components/ui';
import { AuthLayout } from './AuthLayout';

export function ForgotPassword() {
  const [params] = useSearchParams();
  const [workspace, setWorkspace] = useState(params.get('workspace') || lastWorkspace.get());
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(undefined);
    try { await api('/auth/forgot-password', { body: { workspace, email } }); setSent(true); } catch (err: any) { setError(err.message); }
  }
  return (
    <AuthLayout title="Reset your password">
      {sent ? (
        <>
          <Alert kind="success">If an account exists for <strong>{email}</strong> in <strong>{workspace}</strong>, we’ve emailed a reset link. It’s valid for 1 hour.</Alert>
          <Link to="/login" className="btn btn-secondary btn-block">Back to sign in</Link>
        </>
      ) : (
        <form onSubmit={submit} className="stack">
          {error && <Alert kind="error">{error}</Alert>}
          <div className="field"><label htmlFor="ws">Workspace ID</label><input id="ws" value={workspace} onChange={(e) => setWorkspace(e.target.value)} required /></div>
          <div className="field"><label htmlFor="em">Email</label><input id="em" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <button className="btn btn-primary btn-block">Send reset link</button>
          <Link to="/login" className="small center">Back to sign in</Link>
        </form>
      )}
    </AuthLayout>
  );
}
