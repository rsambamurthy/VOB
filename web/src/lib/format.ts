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
