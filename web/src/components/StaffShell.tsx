import { NavLink, Outlet, Navigate, useNavigate } from 'react-router-dom';
import { decodeToken, tokens } from '../lib/api';
import { useMeta } from '../lib/meta';
import { BRAND } from '../brand';

export function useStaff() {
  const p = decodeToken(tokens.get('staff'));
  if (!p || p.kind !== 'staff' || p.exp * 1000 < Date.now()) return null;
  return p as { userId: string; role: 'ADMIN' | 'TAX_MANAGER' | 'FINANCE_MANAGER' | 'MDM_MANAGER'; name: string; email: string };
}

export function StaffShell() {
  const me = useStaff();
  const meta = useMeta();
  const nav = useNavigate();
  if (!me) return <Navigate to="/login" replace />;
  const initials = me.name.split(' ').map((s) => s[0]).join('').slice(0, 2);
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark" aria-hidden>{BRAND.mark}</span><span>{BRAND.name}</span></div>
        <nav>
          <NavLink to="/staff/vendors" end>Vendors</NavLink>
          <NavLink to="/staff/queue">My approvals</NavLink>
          <NavLink to="/staff/mailbox">Mailbox <span className="tag">demo</span></NavLink>
        </nav>
        <div className="sidebar-foot">
          <div className="me"><span className="avatar" aria-hidden>{initials}</span><div><div className="me-name">{me.name}</div><div className="me-role">{meta.roleLabels[me.role]}</div></div></div>
          <button className="btn btn-ghost btn-sm" onClick={() => { tokens.clear('staff'); nav('/login'); }}>Switch user</button>
        </div>
      </aside>
      <main className="main"><Outlet /></main>
    </div>
  );
}
