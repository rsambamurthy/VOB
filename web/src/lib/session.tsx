import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, ApiError } from './api';
import type { Branding, Me, Permission } from './types';
import { setLocaleInfo } from './format';

interface SessionValue { me: Me | null; loading: boolean; refresh: () => Promise<Me | null>; can: (p: Permission) => boolean; signOut: () => Promise<void> }
const Ctx = createContext<SessionValue>(null!);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const r = await api<Me & { mfaPending?: boolean }>('/auth/me');
      const val = r.mfaPending ? null : r;
      setMe(val); return val;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) console.error(e);
      setMe(null); return null;
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { applyBranding(me?.tenant.branding); setLocaleInfo(me?.tenant); }, [me]);
  const can = useCallback((p: Permission) => !!me?.permissions.includes(p), [me]);
  const signOut = useCallback(async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); setMe(null); }, []);
  return <Ctx.Provider value={{ me, loading, refresh, can, signOut }}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);

/** Wraps staff-only routes: waits for the session, sends anonymous users to /login, and forces 2FA enrolment when required. */
export function RequireStaff({ children }: { children: ReactNode }) {
  const { me, loading } = useSession();
  const loc = useLocation();
  if (loading) return <div className="center-page"><div className="spinner" /></div>;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (me.mfaSetupRequired && loc.pathname !== '/staff/account') return <Navigate to="/staff/account?setup=1" replace />;
  return <>{children}</>;
}

const DEFAULT_BRAND = '#1f2758';
export function applyBranding(b?: Branding) {
  const color = b?.primaryColor && /^#[0-9a-f]{6}$/i.test(b.primaryColor) ? b.primaryColor : DEFAULT_BRAND;
  const root = document.documentElement.style;
  root.setProperty('--brand', color);
  // App frame: VendorGate's default brand gets Integrata's SmartAppt colours (indigo bar, maroon accent);
  // a workspace with its own colour gets a darker shade of it for the bar and the colour itself as accent.
  const own = color.toLowerCase() !== DEFAULT_BRAND;
  root.setProperty('--af-head', own ? `color-mix(in srgb, ${color} 82%, black)` : '#312e81');
  root.setProperty('--af-accent', own ? color : '#7a210b');
  root.setProperty('--btn', own ? color : '#2563eb');
  root.setProperty('--focus', own ? color : '#3b82f6');
  document.title = b?.productName ?? 'VendorGate';
}
