import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session';
import { monogram } from '../lib/format';

export function StaffShell() {
  const { me, can, signOut } = useSession();
  const nav = useNavigate();
  if (!me) return null;
  const product = me.tenant.branding.productName ?? 'VendorGate';
  const initials = me.user.name.split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();
  const admin = can('users.manage') || can('tenant.settings') || can('audit.view') || can('config.manage');
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          {me.tenant.branding.logoUrl ? <img src={me.tenant.branding.logoUrl} alt="" className="brand-logo" /> : <span className="brand-mark" aria-hidden>{monogram(product)}</span>}
          <span className="brand-text"><span>{product}</span><span className="brand-tenant">{me.tenant.name}</span></span>
        </div>
        <nav aria-label="Main">
          {can('reports.view') && <NavLink to="/staff/dashboard">Dashboard</NavLink>}
          {can('vendors.view') && <NavLink to="/staff/vendors" end>Vendors</NavLink>}
          {can('vendors.view') && <NavLink to="/staff/queue">My approvals</NavLink>}
          {can('vendors.view') && <NavLink to="/staff/changes">Change requests</NavLink>}
          {can('reports.view') && <NavLink to="/staff/reports">Reports</NavLink>}
          {admin && <div className="nav-section">Administration</div>}
          {can('users.manage') && <NavLink to="/staff/admin/users">Users</NavLink>}
          {can('users.manage') && <NavLink to="/staff/admin/roles">Roles</NavLink>}
          {can('config.manage') && <NavLink to="/staff/admin/config">Configuration</NavLink>}
          {can('tenant.settings') && <NavLink to="/staff/admin/workspace">Workspace</NavLink>}
          {can('tenant.settings') && <NavLink to="/staff/admin/integrations">Integrations</NavLink>}
          {can('tenant.settings') && <NavLink to="/staff/admin/erp">ERP integration</NavLink>}
          {can('audit.view') && <NavLink to="/staff/admin/audit">Audit log</NavLink>}
          {me.devMailbox && <NavLink to="/staff/mailbox">Mailbox <span className="tag">dev</span></NavLink>}
        </nav>
        <div className="sidebar-foot">
          <NavLink to="/staff/account" className="me">
            <span className="avatar" aria-hidden>{initials}</span>
            <div><div className="me-name">{me.user.name}</div><div className="me-role">{me.roles.map((r) => r.name).join(', ') || 'No role'}</div></div>
          </NavLink>
          <button className="btn btn-ghost btn-sm" onClick={async () => { await signOut(); nav('/login'); }}>Sign out</button>
        </div>
      </aside>
      <main className="main" id="main"><Outlet /></main>
    </div>
  );
}
