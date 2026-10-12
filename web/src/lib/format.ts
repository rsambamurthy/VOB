import type { StepStatus, VendorStatus } from './types';

export const statusLabel: Record<VendorStatus, string> = {
  INVITED: 'Invited', IN_PROGRESS: 'In progress', UNDER_REVIEW: 'Under review', SENT_BACK: 'Sent back', APPROVED: 'Approved', REJECTED: 'Rejected',
};
export const stepLabel: Record<StepStatus, string> = {
  WAITING: 'Waiting', PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', SENT_BACK: 'Sent back', CANCELLED: 'Cancelled',
};
/**
 * Locale and currency of the workspace being viewed (from its country pack): set once the
 * signed-in staff member or supplier is known. Dates and numbers everywhere use it.
 */
export interface LocaleInfo { country: string; countryName?: string; currency: string; locale: string; privacyLaw?: string | null }
let current: LocaleInfo = { country: 'IN', currency: 'INR', locale: 'en-IN', privacyLaw: 'DPDP' };
export function setLocaleInfo(l?: Partial<LocaleInfo> | null) { if (l?.locale) current = { ...current, ...l } as LocaleInfo; }
export const localeInfo = () => current;
export const loc = () => current.locale;
/** Whole numbers and counts in the workspace's format (India: 1,00,000). */
export const num = (n: number, opts?: Intl.NumberFormatOptions) => n.toLocaleString(current.locale, opts);
/** Money with the currency's own number of decimals (INR 2, BHD 3, JPY 0). */
export const money = (v: string | number | null | undefined, cur = current.currency) =>
  v === null || v === undefined ? '—' : new Intl.NumberFormat(current.locale, { style: 'currency', currency: cur }).format(Number(v));

export const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleDateString(loc(), { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtDateTime = (s?: string | null) => (s ? new Date(s).toLocaleString(loc(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export const humanize = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Two-letter monogram: "VendorGate" → "VG", "Acme Supplier Portal" → "AS". */
export function monogram(name = 'VendorGate') {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  const caps = name.match(/[A-Z]/g);
  return (caps && caps.length > 1 ? caps[0] + caps[1] : name.slice(0, 2)).toUpperCase();
}
