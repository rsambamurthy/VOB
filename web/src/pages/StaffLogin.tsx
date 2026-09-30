import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api, tokens } from '../lib/api';
import { useMeta } from '../lib/meta';
import { Alert } from '../components/ui';
import { BRAND } from '../brand';

export function StaffLogin() {
  const meta = useMeta();
  const nav = useNavigate();
  const [error, setError] = useState<string>();
  async function login(email: string) {
    try {
      const { token } = await api('/auth/staff-login', { body: { email } });
      tokens.set('staff', token);
      nav('/staff/vendors');
    } catch (e: any) { setError(e.message); }
  }
  return (
    <div className="center-page login-bg">
      <div className="card login-card">
        <div className="brand brand-lg"><span className="brand-mark">{BRAND.mark}</span><span>{BRAND.name}</span></div>
        <p className="muted">{BRAND.tagline}</p>
        <h2>Sign in as a buyer team member</h2>
        <p className="muted small">Prototype: pick a role. In production this is replaced by SSO.</p>
        {error && <Alert kind="error">{error}</Alert>}
        <div className="user-pick">
          {meta.users.map((u) => (
            <button key={u.email} className="user-card" onClick={() => login(u.email)}>
              <span className="avatar">{u.name.split(' ').map((s) => s[0]).join('')}</span>
              <span><strong>{u.name}</strong><span className="muted small block">{meta.roleLabels[u.role]}</span></span>
            </button>
          ))}
        </div>
        <p className="small muted">Vendors sign in from the invite link in their email. <Link to="/staff/mailbox" onClick={(e) => { if (!tokens.get('staff')) { e.preventDefault(); login('admin@buyer.test').then(() => nav('/staff/mailbox')); } }}>Open the demo mailbox</Link> to find one.</p>
      </div>
    </div>
  );
}
