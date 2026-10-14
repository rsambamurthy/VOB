/**
 * The app frame shared by the staff and supplier portals (same look as Integrata's SmartAppt):
 * a coloured top bar (menu button, logo, workspace chip, actions, user chip) and a white sidebar
 * with single links and collapsible groups. Colours follow the workspace brand (see applyBranding).
 * In Arabic the whole frame mirrors (sidebar on the right) through logical CSS properties.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { NavIcon } from './NavIcon';
import { monogram } from '../lib/format';

export interface FrameLink { to: string; label: string; icon: string; end?: boolean; count?: number; countLabel?: string; tag?: string }
export interface FrameGroup { key: string; label: string; icon: string; items: FrameLink[] }
export type FrameEntry = FrameLink | FrameGroup;
const isGroup = (e: FrameEntry): e is FrameGroup => 'items' in e;

/** Sidebar preferences, remembered on this device (per portal). */
function usePrefs(key: string) {
  const load = (): { rail?: boolean; closed?: string[]; open?: string[] } => { try { return JSON.parse(localStorage.getItem(key) ?? '{}'); } catch { return {}; } };
  const [prefs, set] = useState(load);
  const update = (p: typeof prefs) => { set(p); try { localStorage.setItem(key, JSON.stringify(p)); } catch { /* ignore */ } };
  return [prefs, update] as const;
}

const DOTS = ['#a855f7', '#3b82f6', '#2563eb', '#0ea5e9', '#14b8a6', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#6366f1'];

export function AppFrame({ prefsKey, logoUrl, product, workspace, entries, actions, user, navLabel, menuLabels, sideFoot, children }: {
  prefsKey: string;
  logoUrl?: string | null;
  product: string;
  /** Shown as the chip next to the logo (workspace or buyer name). */
  workspace: string;
  entries: FrameEntry[];
  /** Icon buttons and switches on the right of the top bar. */
  actions?: ReactNode;
  /** The user chip (avatar, name, role); `to` makes it a link. */
  user: { initials: string; name: string; role?: ReactNode; to?: string; title?: string };
  navLabel: string;
  menuLabels: { open: string; close: string; collapse: string; expand: string };
  sideFoot?: ReactNode;
  children: ReactNode;
}) {
  const location = useLocation();
  const [prefs, update] = usePrefs(prefsKey);
  const [menuOpen, setMenuOpen] = useState(false); // phone-size drawer
  useEffect(() => { setMenuOpen(false); }, [location.pathname]);
  const rail = !!prefs.rail;

  const active = (l: FrameLink) => (l.end ? location.pathname === l.to : location.pathname === l.to || location.pathname.startsWith(l.to + '/'));
  const groupActive = (g: FrameGroup) => g.items.some(active);
  // Groups start closed except the one holding the current page; the user's choice is remembered.
  const isOpen = (g: FrameGroup) => groupActive(g) || (prefs.open ?? []).includes(g.key);
  const toggle = (g: FrameGroup) => {
    const open = new Set(prefs.open ?? []);
    if (open.has(g.key)) open.delete(g.key); else open.add(g.key);
    update({ ...prefs, open: [...open] });
  };
  const toggleMenu = () => { if (window.matchMedia('(max-width: 900px)').matches) setMenuOpen(!menuOpen); else update({ ...prefs, rail: !rail }); };

  const UserChip = () => {
    const body = <><span className="af-avatar" aria-hidden>{user.initials}</span><span className="af-user-text"><span className="af-user-name">{user.name}</span>{user.role && <span className="af-user-role">{user.role}</span>}</span></>;
    return user.to ? <NavLink to={user.to} className="af-user-chip" title={user.title ?? user.name}>{body}</NavLink> : <span className="af-user-chip" title={user.title ?? user.name}>{body}</span>;
  };

  return (
    <div className={`af ${rail ? 'af-rail' : ''} ${menuOpen ? 'af-menu-open' : ''}`}>
      <header className="af-header">
        <button className="af-hbtn af-hamburger" onClick={toggleMenu} aria-label={menuOpen ? menuLabels.close : rail ? menuLabels.expand : menuLabels.collapse} aria-expanded={menuOpen || !rail}>
          <NavIcon name="menu" size={20} />
        </button>
        <span className="af-logo">{logoUrl ? <img src={logoUrl} alt="" /> : <span className="af-mono">{monogram(product)}</span>}</span>
        <span className="af-product hide-sm">{product}</span>
        <span className="af-chip" title={workspace}><NavIcon name="workspace" size={14} /><span>{workspace}</span></span>
        <span className="af-spacer" />
        <div className="af-actions">{actions}</div>
        <UserChip />
      </header>
      <div className="af-body">
        <aside className="af-side" aria-label={navLabel}>
          <div className="af-sb-head">{navLabel}</div>
          <nav className="af-nav" aria-label={navLabel}>
            {entries.map((e) => {
              if (!isGroup(e)) return <SingleLink key={e.to} l={e} rail={rail} />;
              const open = isOpen(e) && !rail;
              const has = groupActive(e);
              return (
                <div key={e.key} className={`af-mg ${open ? 'open' : ''} ${has ? 'has-active' : ''}`}>
                  <button type="button" className="af-mg-h" aria-expanded={open} onClick={() => (rail ? update({ ...prefs, rail: false, open: [...new Set([...(prefs.open ?? []), e.key])] }) : toggle(e))} title={rail ? e.label : undefined}>
                    <span className="af-mg-ic"><NavIcon name={e.icon} size={12} /></span>
                    <span className="af-mg-t">{e.label}</span>
                    <span className="af-chev"><NavIcon name="chevron" size={12} /></span>
                  </button>
                  {open && (
                    <div className="af-mi-list">
                      {e.items.map((l, i) => (
                        <NavLink key={l.to} to={l.to} end={l.end} className="af-mi">
                          <span className="af-dot" style={{ background: DOTS[i % DOTS.length] }} />
                          <span className="af-mi-t">{l.label}</span>
                          {!!l.count && <span className="af-count" aria-label={l.countLabel}>{l.count}</span>}
                          {l.tag && <span className="af-tag">{l.tag}</span>}
                        </NavLink>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
          {sideFoot && <div className="af-side-foot">{sideFoot}</div>}
        </aside>
        {menuOpen && <button className="af-scrim" aria-label={menuLabels.close} onClick={() => setMenuOpen(false)} />}
        <main className="af-main" id="main">{children}</main>
      </div>
    </div>
  );
}

function SingleLink({ l, rail }: { l: FrameLink; rail: boolean }) {
  return (
    <NavLink to={l.to} end={l.end} className="af-single" title={rail ? l.label : undefined}>
      <span className="af-single-ic"><NavIcon name={l.icon} size={14} /></span>
      <span className="af-single-t">{l.label}</span>
      {!!l.count && <span className="af-count" aria-label={l.countLabel}>{l.count}</span>}
      {l.tag && <span className="af-tag">{l.tag}</span>}
    </NavLink>
  );
}
