import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session';
import { monogram, loc } from '../lib/format';

export function StaffShell() {
  const { me, can, signOut } = useSession();
  const nav = useNavigate();
  if (!me) return null;
  const product = me.tenant.branding.productName ?? 'VendorGate';
  const initials = me.user.name.split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();
  const collab = me.plan?.features.collab ?? false;
  const admin = can('users.manage') || can('tenant.settings') || can('audit.view') || can('config.manage') || (collab && can('orders.manage'));
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
          {collab && can('orders.view') && <NavLink to="/staff/orders">Purchase orders</NavLink>}
          {admin && <div className="nav-section">Administration</div>}
          {can('users.manage') && <NavLink to="/staff/admin/users">Users</NavLink>}
          {can('users.manage') && <NavLink to="/staff/admin/roles">Roles</NavLink>}
          {can('config.manage') && <NavLink to="/staff/admin/config">Configuration</NavLink>}
          {can('tenant.settings') && <NavLink to="/staff/admin/workspace">Workspace</NavLink>}
          {can('tenant.settings') && <NavLink to="/staff/admin/integrations">Integrations</NavLink>}
          {can('tenant.settings') && <NavLink to="/staff/admin/erp">ERP integration</NavLink>}
          {collab && (can('orders.manage') || can('tenant.settings')) && <NavLink to="/staff/admin/purchasing">Purchasing setup</NavLink>}
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
      <main className="main" id="main">
        {me.support && (
          <div className="support-bar" role="status">
            <span><strong>Support access (read-only)</strong> by {me.support.by} — ends {new Date(me.support.endsAt).toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit' })}{me.support.reason ? ` · “${me.support.reason}”` : ''}</span>
            <button className="btn btn-sm btn-secondary" onClick={async () => { await signOut(); window.location.href = '/platform/tenants'; }}>End support access</button>
          </div>
        )}
        {!me.support && me.plan?.key === 'trial' && me.plan.trialEndsAt && <TrialBar endsAt={me.plan.trialEndsAt} expired={me.plan.trialExpired} />}
        <Outlet />
      </main>
    </div>
  );
}

function TrialBar({ endsAt, expired }: { endsAt: string; expired: boolean }) {
  const days = Math.ceil((new Date(endsAt).getTime() - Date.now()) / 86_400_000);
  if (!expired && days > 7) return <div className="trial-bar quiet">Free trial · {days} days left</div>;
  return (
    <div className={`trial-bar ${expired ? 'ended' : ''}`} role="status">
      {expired ? <>Your free trial has ended. You can still see everything, but adding vendors and users is paused. Contact us to choose a plan.</>
        : <>Your free trial ends {days <= 1 ? 'tomorrow' : `in ${days} days`}. Contact us to choose a plan and keep everything as it is.</>}
    </div>
  );
}
