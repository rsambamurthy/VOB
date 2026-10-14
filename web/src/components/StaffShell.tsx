import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { NavIcon } from './NavIcon';
import { useSession } from '../lib/session';
import { monogram, loc } from '../lib/format';
import { PoweredBy, PRODUCT, ProductName } from './Brand';

interface Item { to: string; label: string; icon: string; end?: boolean; show: boolean; tag?: string }
interface Group { key: string; label: string; items: Item[] }

/** Sidebar layout preferences, remembered on this device. */
const PREFS_KEY = 'vg.nav';
function loadPrefs(): { rail?: boolean; closed?: string[] } {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}'); } catch { return {}; }
}
function savePrefs(p: { rail?: boolean; closed?: string[] }) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ } }

export function StaffShell() {
  const { me, can, signOut } = useSession();
  const nav = useNavigate();
  const location = useLocation();
  const [prefs, setPrefs] = useState(loadPrefs);
  const [menuOpen, setMenuOpen] = useState(false); // phone-size menu
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);
  if (!me) return null;
  const product = me.tenant.branding.productName ?? 'VendorGate';
  const initials = me.user.name.split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();
  const collab = me.plan?.features.collab ?? false;
  const rail = !!prefs.rail;
  const update = (p: typeof prefs) => { setPrefs(p); savePrefs(p); };

  const groups: Group[] = [
    { key: 'overview', label: 'Overview', items: [
      { to: '/staff/dashboard', label: 'Dashboard', icon: 'dashboard', show: can('reports.view') },
      { to: '/staff/reports', label: 'Reports', icon: 'reports', show: can('reports.view') },
    ] },
    { key: 'vendors', label: 'Vendors', items: [
      { to: '/staff/vendors', label: 'All vendors', icon: 'vendors', end: true, show: can('vendors.view') },
      { to: '/staff/queue', label: 'My approvals', icon: 'approvals', show: can('vendors.view') },
      { to: '/staff/changes', label: 'Change requests', icon: 'changes', show: can('vendors.view') },
    ] },
    { key: 'purchasing', label: 'Purchasing', items: [
      { to: '/staff/orders', label: 'Purchase orders', icon: 'orders', show: collab && can('orders.view') },
      { to: '/staff/invoices', label: 'Supplier invoices', icon: 'invoices', show: collab && can('orders.view') },
      { to: '/staff/payments', label: 'Payments', icon: 'payments', show: collab && can('invoices.manage') },
      { to: '/staff/admin/purchasing', label: 'Purchasing setup', icon: 'setup', show: collab && (can('orders.manage') || can('tenant.settings')) },
    ] },
    { key: 'admin', label: 'Administration', items: [
      { to: '/staff/admin/users', label: 'Users', icon: 'users', show: can('users.manage') },
      { to: '/staff/admin/roles', label: 'Roles', icon: 'roles', show: can('users.manage') },
      { to: '/staff/admin/config', label: 'Configuration', icon: 'config', show: can('config.manage') },
      { to: '/staff/admin/workspace', label: 'Workspace', icon: 'workspace', show: can('tenant.settings') },
      { to: '/staff/admin/integrations', label: 'Integrations', icon: 'integrations', show: can('tenant.settings') },
      { to: '/staff/admin/erp', label: 'ERP integration', icon: 'erp', show: can('tenant.settings') },
      { to: '/staff/admin/help-topics', label: 'Help topics', icon: 'help', show: can('tenant.settings') },
      { to: '/staff/admin/billing', label: 'Billing', icon: 'billing', show: can('tenant.settings') && !me.support },
      { to: '/staff/admin/audit', label: 'Audit log', icon: 'audit', show: can('audit.view') },
      { to: '/staff/mailbox', label: 'Mailbox', icon: 'mail', show: me.devMailbox, tag: 'dev' },
    ] },
  ].map((g) => ({ ...g, items: g.items.filter((i) => i.show) })).filter((g) => g.items.length);

  // A group is open unless the user closed it — and always open when it holds the current page.
  const hasActive = (g: Group) => g.items.some((i) => (i.end ? location.pathname === i.to : location.pathname.startsWith(i.to)));
  const isOpen = (g: Group) => rail || hasActive(g) || !(prefs.closed ?? []).includes(g.key);
  const toggle = (g: Group) => {
    const closed = new Set(prefs.closed ?? []);
    if (closed.has(g.key)) closed.delete(g.key); else closed.add(g.key);
    update({ ...prefs, closed: [...closed] });
  };

  return (
    <div className={`shell ${rail ? 'shell-rail' : ''}`}>
      <aside className={`sidebar staff-sidebar ${menuOpen ? 'menu-open' : ''}`}>
        <div className="brand">
          {me.tenant.branding.logoUrl ? <img src={me.tenant.branding.logoUrl} alt="" className="brand-logo" /> : (product !== PRODUCT || rail) && <span className="brand-mark" aria-hidden>{monogram(product)}</span>}
          <span className="brand-text"><ProductName name={product} light /><span className="brand-tenant">{me.tenant.name}</span></span>
          <button className="icon-btn menu-btn" aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><NavIcon name="menu" /></button>
        </div>
        <nav aria-label="Main" className="staff-nav">
          {groups.map((g) => {
            const open = isOpen(g);
            return (
              <div key={g.key} className={`nav-group ${open ? 'open' : ''}`}>
                <button className="nav-group-head" aria-expanded={open} onClick={() => toggle(g)} disabled={rail || hasActive(g)} title={hasActive(g) ? undefined : open ? `Collapse ${g.label}` : `Expand ${g.label}`}>
                  <span>{g.label}</span>{!rail && !hasActive(g) && <NavIcon name="chevron" size={14} />}
                </button>
                {open && g.items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.end} title={rail ? i.label : undefined}>
                    <span className="nav-label"><NavIcon name={i.icon} /><span className="nav-text">{i.label}</span></span>
                    {i.tag && <span className="tag">{i.tag}</span>}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <NavLink to="/staff/account" className="me" title={rail ? me.user.name : undefined}>
            <span className="avatar" aria-hidden>{initials}</span>
            <div className="me-text"><div className="me-name">{me.user.name}</div><div className="me-role">{me.roles.map((r) => r.name).join(', ') || 'No role'}</div></div>
          </NavLink>
          <button className="btn btn-ghost btn-sm" onClick={async () => { await signOut(); nav('/login'); }} title={rail ? 'Sign out' : undefined} aria-label="Sign out">{rail ? <NavIcon name="logout" size={16} /> : 'Sign out'}</button>
          <button className="btn btn-ghost btn-sm rail-btn" onClick={() => update({ ...prefs, rail: !rail })} aria-label={rail ? 'Expand sidebar' : 'Collapse sidebar'} title={rail ? 'Expand sidebar' : 'Collapse sidebar'}>
            <NavIcon name={rail ? 'expand' : 'collapse'} size={16} />{!rail && <span>Collapse</span>}
          </button>
          <PoweredBy light compact={rail} />
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
  if (!expired && days > 7) return <div className="trial-bar quiet">Free trial · {days} days left · <Link to="/staff/admin/billing">Choose a plan</Link></div>;
  return (
    <div className={`trial-bar ${expired ? 'ended' : ''}`} role="status">
      {expired ? <>Your free trial has ended. You can still see everything, but adding vendors and users is paused. <Link to="/staff/admin/billing">Choose a plan</Link>.</>
        : <>Your free trial ends {days <= 1 ? 'tomorrow' : `in ${days} days`}. <Link to="/staff/admin/billing">Choose a plan</Link> to keep everything as it is.</>}
    </div>
  );
}
