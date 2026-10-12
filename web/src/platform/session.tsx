import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, ApiError } from '../lib/api';

export interface PlatformAdmin { id: string; name: string; email: string; status: string; mfaEnabled: boolean; lastLoginAt: string | null; createdAt: string }
interface PlatformMe { admin: PlatformAdmin; mfaSetupRequired: boolean }
interface Value { me: PlatformMe | null; loading: boolean; refresh: () => Promise<PlatformMe | null>; signOut: () => Promise<void> }
const Ctx = createContext<Value>(null!);

export const papi = <T = any,>(path: string, opts?: { method?: string; body?: unknown }) => api<T>(`/platform${path}`, opts);

export function PlatformProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<PlatformMe | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const r = await papi<PlatformMe & { mfaPending?: boolean }>('/auth/me');
      const v = r.mfaPending ? null : r;
      setMe(v); return v;
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) console.error(e);
      setMe(null); return null;
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); document.title = 'VendorGate Platform'; }, [refresh]);
  const signOut = useCallback(async () => { await papi('/auth/logout', { method: 'POST' }).catch(() => {}); setMe(null); }, []);
  return <Ctx.Provider value={{ me, loading, refresh, signOut }}><div className="platform-root">{children}</div></Ctx.Provider>;
}
export const usePlatform = () => useContext(Ctx);

export function RequirePlatform({ children }: { children: ReactNode }) {
  const { me, loading } = usePlatform();
  const loc = useLocation();
  if (loading) return <div className="center-page"><div className="spinner" /></div>;
  if (!me) return <Navigate to={`/platform/login?next=${encodeURIComponent(loc.pathname)}`} replace />;
  if (me.mfaSetupRequired) return <Navigate to="/platform/setup-2fa" replace />;
  return <>{children}</>;
}

export const PLAN_LABEL: Record<string, string> = { trial: 'Trial', standard: 'Standard', enterprise: 'Enterprise' };
export const SOURCE_LABEL: Record<string, string> = { platform: 'Console', signup: 'Self sign-up', cli: 'Command line', bootstrap: 'First deploy' };

/** "in 5 days" / "3 days ago" / "today" */
export function relDays(iso?: string | null) {
  if (!iso) return '—';
  const d = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (d === 0) return 'today';
  return d > 0 ? `in ${d} day${d === 1 ? '' : 's'}` : `${-d} day${d === -1 ? '' : 's'} ago`;
}
