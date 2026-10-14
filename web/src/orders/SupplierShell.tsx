/** Top bar shared by the supplier's profile and purchase order pages. */
import { Fragment, createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { applyBranding } from '../lib/session';
import { monogram, setLocaleInfo, type LocaleInfo } from '../lib/format';
import type { Branding, VendorStatus } from '../lib/types';
import { StatusBadge } from '../components/ui';
import { useHelp } from '../help/HelpPanel';
import { PoweredBy, PRODUCT } from '../components/Brand';
import { setLang, t, useLang, type Lang } from '../i18n';
import { LangSwitch } from '../i18n/LangSwitch';

export interface SupplierInfo {
  buyer: { name: string; branding: Branding; workspace?: string; languages?: Lang[] } & Partial<LocaleInfo>;
  language?: Lang;
  vendor: { name: string; code: string; status: VendorStatus };
  orders: { enabled: boolean; pending: number };
  signedInAs?: string;
  privacy?: { needsConsent: boolean };
}

export function rememberWorkspace(ws?: string) { if (ws) try { localStorage.setItem('vg.supplierWorkspace', ws); } catch { /* ignore */ } }

/** Remember the supplier's language on the server (emails follow it) and in this browser. */
export const saveLanguage = (language: Lang) => api('/vendor/language', { method: 'PUT', body: { language } }).catch(() => {});

export async function supplierSignOut(workspace?: string) {
  await api('/vendor-auth/logout', { method: 'POST' }).catch(() => {});
  window.location.href = workspace ? `/s/${workspace}` : '/vendor/expired';
}

export function SupplierTopbar({ info, onLanguage }: { info: SupplierInfo; onLanguage?: (l: Lang) => unknown }) {
  const { openHelp } = useHelp();
  useLang();
  return (
    <header className="topbar">
      <div className="brand">
        {info.buyer.branding.logoUrl ? <img src={info.buyer.branding.logoUrl} alt="" className="brand-logo" /> : (info.buyer.branding.productName ?? PRODUCT) !== PRODUCT && <span className="brand-mark">{monogram(info.buyer.branding.productName)}</span>}
        <span>{info.buyer.name}</span><span className="muted small hide-sm">· {t('shell.portal')}</span>
      </div>
      {info.orders.enabled && (
        <nav className="topnav" aria-label={t('shell.portal')}>
          <NavLink to="/vendor" end>{info.vendor.status === 'APPROVED' ? t('shell.navProfileApproved') : t('shell.navProfile')}</NavLink>
          <NavLink to="/vendor/orders">{t('shell.navOrders')}{info.orders.pending > 0 && <span className="count-pill" aria-label={t('shell.waiting', { count: info.orders.pending })}>{info.orders.pending}</span>}</NavLink>
          <NavLink to="/vendor/invoices">{t('shell.navInvoices')}</NavLink>
          <NavLink to="/vendor/payments">{t('shell.navPayments')}</NavLink>
        </nav>
      )}
      <div className="topbar-right">
        <span className="hide-sm" title={info.signedInAs}>{info.vendor.name}</span><StatusBadge status={info.vendor.status} />
        <LangSwitch available={info.buyer.languages} onChange={onLanguage} />
        <button className="btn btn-ghost btn-sm" onClick={() => openHelp()} title={t('shell.helpTitle')}>{t('common.help')}</button>
        <button className="btn btn-ghost btn-sm" onClick={() => supplierSignOut(info.buyer.workspace)}>{t('common.signOut')}</button>
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
  const lang = useLang();
  const reload = useCallback(() => {
    api<SupplierInfo>('/vendor').then((r) => {
      // Privacy notice must be accepted first; the profile page shows it.
      if (r.privacy?.needsConsent || !r.orders.enabled) { nav('/vendor', { replace: true }); return; }
      setInfo(r); setLocaleInfo(r.buyer); rememberWorkspace(r.buyer.workspace); applyBranding(r.buyer.branding); setLang(r.language ?? 'en');
    }).catch((e) => { if (e instanceof ApiError && e.status === 401) nav(`/vendor/expired?next=${encodeURIComponent(loc.pathname)}`, { replace: true }); });
  }, [nav, loc.pathname]);
  useEffect(() => { reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!info) return <div className="center-page"><div className="spinner" /></div>;
  return (
    <Ctx.Provider value={{ info, reload }}>
      <div className="vendor-app">
        <SupplierTopbar info={info} onLanguage={saveLanguage} />
        {/* Pages reload in the new language (server text such as form labels comes back translated). */}
        <Fragment key={lang}>{children}</Fragment>
        <footer className="page-foot"><PoweredBy /></footer>
      </div>
    </Ctx.Provider>
  );
}
