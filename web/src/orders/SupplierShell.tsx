/** Frame shared by the supplier's profile and purchase order pages. */
import { Fragment, createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { applyBranding } from '../lib/session';
import { monogram, setLocaleInfo, type LocaleInfo } from '../lib/format';
import type { Branding, VendorStatus } from '../lib/types';
import { statusText } from '../components/ui';
import { AppFrame, type FrameEntry } from '../components/AppFrame';
import { NavIcon } from '../components/NavIcon';
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

/** The supplier portal frame: top bar and sidebar (same layout as the staff portal). */
export function SupplierFrame({ info, onLanguage, children }: { info: SupplierInfo; onLanguage?: (l: Lang) => unknown; children: ReactNode }) {
  const { openHelp } = useHelp();
  useLang();
  const product = info.buyer.branding.productName ?? PRODUCT;
  const entries: FrameEntry[] = [
    { to: '/vendor', end: true, label: info.vendor.status === 'APPROVED' ? t('shell.navProfileApproved') : t('shell.navProfile'), icon: 'workspace' },
    ...(info.orders.enabled ? [
      { to: '/vendor/orders', label: t('shell.navOrders'), icon: 'orders', count: info.orders.pending, countLabel: t('shell.waiting', { count: info.orders.pending }) },
      { to: '/vendor/invoices', label: t('shell.navInvoices'), icon: 'invoices' },
      { to: '/vendor/payments', label: t('shell.navPayments'), icon: 'payments' },
    ] : []),
  ];
  return (
    <AppFrame
      prefsKey="vg.supplierNav"
      logoUrl={info.buyer.branding.logoUrl}
      product={product}
      workspace={info.buyer.name}
      entries={entries}
      navLabel={t('shell.nav')}
      menuLabels={{ open: t('shell.openMenu'), close: t('shell.closeMenu'), collapse: t('shell.collapse'), expand: t('shell.expand') }}
      actions={<>
        <LangSwitch available={info.buyer.languages} onChange={onLanguage} />
        <button className="af-hbtn" onClick={() => openHelp()} title={t('shell.helpTitle')} aria-label={t('common.help')}><NavIcon name="help" size={18} /></button>
        <button className="af-hbtn" onClick={() => supplierSignOut(info.buyer.workspace)} title={t('common.signOut')} aria-label={t('common.signOut')}><NavIcon name="logout" size={18} /></button>
      </>}
      user={{ initials: monogram(info.vendor.name), name: info.vendor.name, role: statusText(info.vendor.status), title: info.signedInAs }}
      sideFoot={<PoweredBy />}
    >
      {children}
    </AppFrame>
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
      <SupplierFrame info={info} onLanguage={saveLanguage}>
        {/* Pages reload in the new language (server text such as form labels comes back translated). */}
        <Fragment key={lang}>{children}</Fragment>
      </SupplierFrame>
    </Ctx.Provider>
  );
}
