import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { usePlatform } from './session';
import { PoweredBy, Wordmark } from '../components/Brand';

export function PlatformShell() {
  const { me, signOut } = usePlatform();
  const nav = useNavigate();
  if (!me) return null;
  const initials = me.admin.name.split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-text"><Wordmark light /><span className="brand-tenant">Platform console</span></span>
        </div>
        <nav aria-label="Platform">
          <NavLink to="/platform" end>Overview</NavLink>
          <NavLink to="/platform/tenants">Workspaces</NavLink>
          <NavLink to="/platform/signups">Sign-ups</NavLink>
          <div className="nav-section">Platform</div>
          <NavLink to="/platform/settings">Sign-up settings</NavLink>
          <NavLink to="/platform/admins">Platform admins</NavLink>
          <NavLink to="/platform/audit">Audit log</NavLink>
        </nav>
        <div className="sidebar-foot">
          <div className="me">
            <span className="avatar" aria-hidden>{initials}</span>
            <div><div className="me-name">{me.admin.name}</div><div className="me-role">{me.admin.email}</div></div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={async () => { await signOut(); nav('/platform/login'); }}>Sign out</button>
          <PoweredBy light />
        </div>
      </aside>
      <main className="main" id="main"><Outlet /></main>
      <div id="platform-toast" className="toast" role="status" hidden />
    </div>
  );
}
