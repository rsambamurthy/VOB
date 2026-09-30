import type { StepStatus, VendorStatus } from './types';

export const statusLabel: Record<VendorStatus, string> = {
  INVITED: 'Invited', IN_PROGRESS: 'In progress', UNDER_REVIEW: 'Under review', SENT_BACK: 'Sent back', APPROVED: 'Approved', REJECTED: 'Rejected',
};
export const stepLabel: Record<StepStatus, string> = {
  WAITING: 'Waiting', PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', SENT_BACK: 'Sent back', CANCELLED: 'Cancelled',
};
export const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtDateTime = (s?: string | null) => (s ? new Date(s).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export const humanize = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Two-letter monogram: "VendorGate" → "VG", "Acme Supplier Portal" → "AS". */
export function monogram(name = 'VendorGate') {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
  const caps = name.match(/[A-Z]/g);
  return (caps && caps.length > 1 ? caps[0] + caps[1] : name.slice(0, 2)).toUpperCase();
}
