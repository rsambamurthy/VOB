import { Link, Outlet, useNavigate } from 'react-router-dom';
import { NavIcon } from './NavIcon';
import { useSession } from '../lib/session';
import { loc } from '../lib/format';
import { PoweredBy } from './Brand';
import { AppFrame, type FrameEntry, type FrameGroup, type FrameLink } from './AppFrame';
import { useHelp } from '../help/HelpPanel';
import { AskBox } from '../pages/Ask';

type L = FrameLink & { show: boolean };

export function StaffShell() {
  const { me, can, signOut } = useSession();
  const nav = useNavigate();
  const { openHelp } = useHelp();
  if (!me) return null;
  const product = me.tenant.branding.productName ?? 'VendorGate';
  const initials = me.user.name.split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();
  const collab = me.plan?.features.collab ?? false;

  const keep = (items: L[]) => items.filter((i) => i.show).map(({ show: _s, ...l }) => l);
  const group = (key: string, label: string, icon: string, items: L[]): FrameGroup | null => { const k = keep(items); return k.length ? { key, label, icon, items: k } : null; };
  const entries = [
    ...keep([
      { to: '/staff/dashboard', label: 'Dashboard', icon: 'dashboard', show: can('reports.view') },
      { to: '/staff/ask', label: `Ask ${product}`, icon: 'ask', tag: 'AI', show: can('vendors.view') && me.tenant.settings.askAi !== false },
    ]),
    group('vendors', 'Vendors', 'vendors', [
      { to: '/staff/vendors', label: 'All vendors', icon: 'vendors', end: true, show: can('vendors.view') },
      { to: '/staff/queue', label: 'My approvals', icon: 'approvals', show: can('vendors.view') },
      { to: '/staff/changes', label: 'Change requests', icon: 'changes', show: can('vendors.view') },
    ]),
    group('purchasing', 'Purchasing', 'orders', [
      { to: '/staff/orders', label: 'Purchase orders', icon: 'orders', show: collab && can('orders.view') },
      { to: '/staff/invoices', label: 'Supplier invoices', icon: 'invoices', show: collab && can('orders.view') },
      { to: '/staff/payments', label: 'Payments', icon: 'payments', show: collab && can('invoices.manage') },
      { to: '/staff/admin/purchasing', label: 'Purchasing setup', icon: 'setup', show: collab && (can('orders.manage') || can('tenant.settings')) },
    ]),
    ...keep([{ to: '/staff/reports', label: 'Reports', icon: 'reports', show: can('reports.view') }]),
    group('admin', 'Administration', 'config', [
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
    ]),
  ].filter(Boolean) as FrameEntry[];

  return (
    <AppFrame
      prefsKey="vg.nav2"
      logoUrl={me.tenant.branding.logoUrl}
      product={product}
      workspace={me.tenant.name}
      entries={entries}
      search={can('vendors.view') && me.tenant.settings.askAi !== false ? <AskBox /> : undefined}
      navLabel="Navigation"
      menuLabels={{ open: 'Open menu', close: 'Close menu', collapse: 'Collapse sidebar', expand: 'Expand sidebar' }}
      actions={<>
        <button className="af-hbtn" onClick={() => openHelp()} title="Help (F1)" aria-label="Help"><NavIcon name="help" size={18} /></button>
        <button className="af-hbtn" onClick={async () => { await signOut(); nav('/login'); }} title="Sign out" aria-label="Sign out"><NavIcon name="logout" size={18} /></button>
      </>}
      user={{ initials, name: me.user.name, role: me.roles.map((r) => r.name).join(', ') || 'No role', to: '/staff/account', title: 'Your account' }}
      sideFoot={<PoweredBy />}
    >
      {me.support && (
        <div className="support-bar" role="status">
          <span><strong>Support access (read-only)</strong> by {me.support.by} — ends {new Date(me.support.endsAt).toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit' })}{me.support.reason ? ` · “${me.support.reason}”` : ''}</span>
          <button className="btn btn-sm btn-secondary" onClick={async () => { await signOut(); window.location.href = '/platform/tenants'; }}>End support access</button>
        </div>
      )}
      {!me.support && me.plan?.key === 'trial' && me.plan.trialEndsAt && <TrialBar endsAt={me.plan.trialEndsAt} expired={me.plan.trialExpired} />}
      <Outlet />
    </AppFrame>
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
