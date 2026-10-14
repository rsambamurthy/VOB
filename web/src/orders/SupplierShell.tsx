/** Top bar shared by the supplier's profile and purchase order pages. */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { applyBranding } from '../lib/session';
import { monogram, setLocaleInfo, type LocaleInfo } from '../lib/format';
import type { Branding, VendorStatus } from '../lib/types';
import { StatusBadge } from '../components/ui';
import { useHelp } from '../help/HelpPanel';
import { PoweredBy, PRODUCT } from '../components/Brand';

export interface SupplierInfo {
  buyer: { name: string; branding: Branding; workspace?: string } & Partial<LocaleInfo>;
  vendor: { name: string; code: string; status: VendorStatus };
  orders: { enabled: boolean; pending: number };
  signedInAs?: string;
  privacy?: { needsConsent: boolean };
}

export function rememberWorkspace(ws?: string) { if (ws) try { localStorage.setItem('vg.supplierWorkspace', ws); } catch { /* ignore */ } }

export async function supplierSignOut(workspace?: string) {
  await api('/vendor-auth/logout', { method: 'POST' }).catch(() => {});
  window.location.href = workspace ? `/s/${workspace}` : '/vendor/expired';
}

export function SupplierTopbar({ info }: { info: SupplierInfo }) {
  const { openHelp } = useHelp();
  return (
    <header className="topbar">
      <div className="brand">
        {info.buyer.branding.logoUrl ? <img src={info.buyer.branding.logoUrl} alt="" className="brand-logo" /> : (info.buyer.branding.productName ?? PRODUCT) !== PRODUCT && <span className="brand-mark">{monogram(info.buyer.branding.productName)}</span>}
        <span>{info.buyer.name}</span><span className="muted small hide-sm">· Supplier portal</span>
      </div>
      {info.orders.enabled && (
        <nav className="topnav" aria-label="Supplier portal">
          <NavLink to="/vendor" end>{info.vendor.status === 'APPROVED' ? 'Company details' : 'Business profile'}</NavLink>
          <NavLink to="/vendor/orders">Purchase orders{info.orders.pending > 0 && <span className="count-pill" aria-label={`${info.orders.pending} waiting`}>{info.orders.pending}</span>}</NavLink>
        </nav>
      )}
      <div className="topbar-right">
        <span className="hide-sm" title={info.signedInAs}>{info.vendor.name}</span><StatusBadge status={info.vendor.status} />
        <button className="btn btn-ghost btn-sm" onClick={() => openHelp()} title="Help (F1)">Help</button>
        <button className="btn btn-ghost btn-sm" onClick={() => supplierSignOut(info.buyer.workspace)}>Sign out</button>
      </div>
    </header>
  );
}

const Ctx = createContext<{ info?: SupplierInfo; reload: () => void }>({ reload: () => {} });
export const useSupplier = () => useContext(Ctx);

/** Wraps the purchase order pages: loads who is signed in, shows the top bar. */
export function SupplierShell({ children }: { children: ReactNode }) {
  const nav = useNavigate();
  const loc = useLocation();
  const [info, setInfo] = useState<SupplierInfo>();
  const reload = useCallback(() => {
    api<SupplierInfo>('/vendor').then((r) => {
      // Privacy notice must be accepted first; the profile page shows it.
      if (r.privacy?.needsConsent || !r.orders.enabled) { nav('/vendor', { replace: true }); return; }
      setInfo(r); setLocaleInfo(r.buyer); rememberWorkspace(r.buyer.workspace); applyBranding(r.buyer.branding);
    }).catch((e) => { if (e instanceof ApiError && e.status === 401) nav(`/vendor/expired?next=${encodeURIComponent(loc.pathname)}`, { replace: true }); });
  }, [nav, loc.pathname]);
  useEffect(() => { reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!info) return <div className="center-page"><div className="spinner" /></div>;
  return (
    <Ctx.Provider value={{ info, reload }}>
      <div className="vendor-app">
        <SupplierTopbar info={info} />
        {children}
        <footer className="page-foot"><PoweredBy /></footer>
      </div>
    </Ctx.Provider>
  );
}
