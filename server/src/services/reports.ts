/**
 * Dashboard metrics and tabular reports (Phase 5). Everything is scoped to one tenant and,
 * where it makes sense, to a date range and vendor type. Sensitive numbers are masked.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, lte, ne, or, type SQL } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { db, schema } from '../lib/db.js';
import type { Profile } from '../lib/profileEngine.js';
import { directApprovers } from './approvers.js';
import { flagsForMany, daysUntil } from './lifecycle.js';
import { getConfig } from './config.js';

const { vendors, approvalSteps, changeRequests, changeRequestSteps, documents, users, roles, erpSyncs } = schema;
const DAY = 86_400_000, HOUR = 3_600_000;
const OPEN = ['INVITED', 'IN_PROGRESS', 'SENT_BACK', 'UNDER_REVIEW'] as const;
type VType = 'DOMESTIC' | 'IMPORT' | 'GOVERNMENT';

export interface Filters { from: Date; to: Date; vendorType?: VType; days?: number }

/** "2026-07-01" / "2026-09-30" → [start of from, end of to]; default: the last 90 days. */
export function parseFilters(q: Record<string, unknown>): Filters {
  const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
  const toS = day(q.to), fromS = day(q.from);
  const to = toS ? new Date(`${toS}T23:59:59.999Z`) : new Date();
  const from = fromS ? new Date(`${fromS}T00:00:00.000Z`) : new Date(to.getTime() - 90 * DAY);
  const vt = typeof q.vendorType === 'string' && ['DOMESTIC', 'IMPORT', 'GOVERNMENT'].includes(q.vendorType) ? (q.vendorType as VType) : undefined;
  const days = Math.min(365, Math.max(1, Number(q.days) || 60));
  return { from: from > to ? new Date(to.getTime() - 90 * DAY) : from, to, vendorType: vt, days };
}

const vt = (f: Filters): SQL[] => (f.vendorType ? [eq(vendors.vendorType, f.vendorType)] : []);
const round1 = (n: number) => Math.round(n * 10) / 10;
function stats(xs: number[]) {
  if (!xs.length) return { count: 0, avg: null as number | null, median: null as number | null, p90: null as number | null };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => { const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
  return { count: s.length, avg: round1(s.reduce((a, b) => a + b, 0) / s.length), median: round1(q(0.5)), p90: round1(q(0.9)) };
}
export const mask = (v: unknown, keepStart = 2, keepEnd = 2) => {
  const s = v === undefined || v === null ? '' : String(v);
  return !s ? '' : s.length <= keepStart + keepEnd ? '•'.repeat(s.length) : `${s.slice(0, keepStart)}${'•'.repeat(Math.min(6, s.length - keepStart - keepEnd))}${s.slice(-keepEnd)}`;
};
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));

/* =========================== Dashboard =========================== */

export async function dashboard(tenantId: string, f: Filters) {
  const now = new Date();
  const T = eq(vendors.tenantId, tenantId);

  // Cohort: vendors invited in the range — how far did they get?
  const cohort = await db.select({ status: vendors.status, submittedAt: vendors.submittedAt }).from(vendors)
    .where(and(T, gte(vendors.createdAt, f.from), lte(vendors.createdAt, f.to), ...vt(f)));
  const funnel = [
    { key: 'invited', label: 'Invited', count: cohort.length },
    { key: 'started', label: 'Started the form', count: cohort.filter((v) => v.status !== 'INVITED').length },
    { key: 'submitted', label: 'Submitted', count: cohort.filter((v) => v.submittedAt || ['UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SENT_BACK'].includes(v.status)).length },
    { key: 'approved', label: 'Approved', count: cohort.filter((v) => v.status === 'APPROVED').length },
  ];
  const rejected = cohort.filter((v) => v.status === 'REJECTED').length;

  // Turnaround for vendors approved in the range.
  const approved = await db.select({ createdAt: vendors.createdAt, submittedAt: vendors.submittedAt, decidedAt: vendors.decidedAt }).from(vendors)
    .where(and(T, eq(vendors.status, 'APPROVED'), gte(vendors.decidedAt, f.from), lte(vendors.decidedAt, f.to), ...vt(f)));
  const total = stats(approved.map((v) => (v.decidedAt!.getTime() - v.createdAt.getTime()) / DAY));
  const review = stats(approved.filter((v) => v.submittedAt).map((v) => (v.decidedAt!.getTime() - v.submittedAt!.getTime()) / DAY));
  const vendorSide = stats(approved.filter((v) => v.submittedAt).map((v) => (v.submittedAt!.getTime() - v.createdAt.getTime()) / DAY));

  // Time each approval level takes (steps decided in the range).
  const acted = await db.select({ label: approvalSteps.label, level: approvalSteps.level, activatedAt: approvalSteps.activatedAt, actedAt: approvalSteps.actedAt, dueAt: approvalSteps.dueAt })
    .from(approvalSteps).innerJoin(vendors, eq(vendors.id, approvalSteps.vendorId))
    .where(and(eq(approvalSteps.tenantId, tenantId), isNotNull(approvalSteps.actedAt), isNotNull(approvalSteps.activatedAt), gte(approvalSteps.actedAt, f.from), lte(approvalSteps.actedAt, f.to),
      inArray(approvalSteps.status, ['APPROVED', 'REJECTED', 'SENT_BACK']), ...vt(f)));
  const byLevelMap = new Map<string, { level: number; hours: number[]; late: number }>();
  for (const s of acted) {
    const e = byLevelMap.get(s.label) ?? { level: s.level, hours: [], late: 0 };
    e.hours.push((s.actedAt!.getTime() - s.activatedAt!.getTime()) / HOUR);
    if (s.dueAt && s.actedAt! > s.dueAt) e.late++;
    e.level = Math.min(e.level, s.level);
    byLevelMap.set(s.label, e);
  }
  const pendingSteps = await db.select({ label: approvalSteps.label, activatedAt: approvalSteps.activatedAt, dueAt: approvalSteps.dueAt, roleId: approvalSteps.roleId, assigneeUserId: approvalSteps.assigneeUserId, tenantId: approvalSteps.tenantId, vendorId: approvalSteps.vendorId })
    .from(approvalSteps).innerJoin(vendors, eq(vendors.id, approvalSteps.vendorId))
    .where(and(eq(approvalSteps.tenantId, tenantId), eq(approvalSteps.status, 'PENDING'), ...vt(f)));
  const byLevel = [...byLevelMap.entries()].map(([label, e]) => ({
    label, ...stats(e.hours), lateShare: e.hours.length ? Math.round((e.late / e.hours.length) * 100) : 0,
    pendingNow: pendingSteps.filter((p) => p.label === label).length,
  })).sort((a, b) => (byLevelMap.get(a.label)!.level - byLevelMap.get(b.label)!.level));
  for (const p of pendingSteps) if (!byLevel.some((b) => b.label === p.label)) byLevel.push({ label: p.label, ...stats([]), lateShare: 0, pendingNow: pendingSteps.filter((x) => x.label === p.label).length });

  // Ageing of open registrations by stage (days in the current stage).
  const open = await db.select({ id: vendors.id, status: vendors.status, updatedAt: vendors.updatedAt }).from(vendors).where(and(T, inArray(vendors.status, [...OPEN]), ...vt(f)));
  const activated = new Map(pendingSteps.map((p) => [p.vendorId, p.activatedAt]));
  const BUCKETS = ['0–2 days', '3–7 days', '8–15 days', 'Over 15 days'];
  const bucket = (d: number) => (d <= 2 ? 0 : d <= 7 ? 1 : d <= 15 ? 2 : 3);
  const ageing = OPEN.map((st) => {
    const counts = [0, 0, 0, 0];
    for (const v of open.filter((x) => x.status === st)) {
      const since = (st === 'UNDER_REVIEW' ? activated.get(v.id) : null) ?? v.updatedAt;
      counts[bucket(Math.floor((now.getTime() - since.getTime()) / DAY))]++;
    }
    return { stage: st, counts, total: counts.reduce((a, b) => a + b, 0) };
  });

  // Workload: what each approver owns now (onboarding + change steps), and how fast they act.
  const crPending = await db.select({ tenantId: changeRequestSteps.tenantId, roleId: changeRequestSteps.roleId, assigneeUserId: changeRequestSteps.assigneeUserId, dueAt: changeRequestSteps.dueAt, raisedById: changeRequests.raisedById })
    .from(changeRequestSteps).innerJoin(changeRequests, eq(changeRequests.id, changeRequestSteps.changeRequestId)).innerJoin(vendors, eq(vendors.id, changeRequests.vendorId))
    .where(and(eq(changeRequestSteps.tenantId, tenantId), eq(changeRequestSteps.status, 'PENDING'), ...vt(f)));
  const owners = new Map<string, string[]>();
  const ownersOf = async (s: { tenantId: string; roleId: string; assigneeUserId: string | null }) => {
    const k = `${s.roleId}|${s.assigneeUserId ?? ''}`;
    if (!owners.has(k)) owners.set(k, await directApprovers(s));
    return owners.get(k)!;
  };
  const load = new Map<string, { pending: number; overdue: number; changes: number; actedHours: number[] }>();
  const row = (id: string) => { if (!load.has(id)) load.set(id, { pending: 0, overdue: 0, changes: 0, actedHours: [] }); return load.get(id)!; };
  for (const s of pendingSteps) for (const u of await ownersOf(s)) { const r = row(u); r.pending++; if (s.dueAt && s.dueAt < now) r.overdue++; }
  for (const s of crPending) for (const u of (await ownersOf(s)).filter((x) => x !== s.raisedById)) { const r = row(u); r.pending++; r.changes++; if (s.dueAt && s.dueAt < now) r.overdue++; }
  const actedBy = await db.select({ by: approvalSteps.actedById, activatedAt: approvalSteps.activatedAt, actedAt: approvalSteps.actedAt }).from(approvalSteps)
    .where(and(eq(approvalSteps.tenantId, tenantId), isNotNull(approvalSteps.actedById), isNotNull(approvalSteps.activatedAt), gte(approvalSteps.actedAt, f.from), lte(approvalSteps.actedAt, f.to)));
  const crActedBy = await db.select({ by: changeRequestSteps.actedById, activatedAt: changeRequestSteps.activatedAt, actedAt: changeRequestSteps.actedAt }).from(changeRequestSteps)
    .where(and(eq(changeRequestSteps.tenantId, tenantId), isNotNull(changeRequestSteps.actedById), isNotNull(changeRequestSteps.activatedAt), gte(changeRequestSteps.actedAt, f.from), lte(changeRequestSteps.actedAt, f.to)));
  for (const a of [...actedBy, ...crActedBy]) row(a.by!).actedHours.push((a.actedAt!.getTime() - a.activatedAt!.getTime()) / HOUR);
  const people = load.size ? await db.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.tenantId, tenantId), inArray(users.id, [...load.keys()]))) : [];
  const workload = people.map((p) => { const r = load.get(p.id)!; const st = stats(r.actedHours); return { userId: p.id, name: p.name, pending: r.pending, overdue: r.overdue, changes: r.changes, decided: st.count, medianHours: st.median }; })
    .sort((a, b) => b.overdue - a.overdue || b.pending - a.pending || a.name.localeCompare(b.name));

  // Month by month: invited vs approved, last 12 months up to `to`.
  const start12 = new Date(Date.UTC(f.to.getUTCFullYear(), f.to.getUTCMonth() - 11, 1));
  const inv = await db.select({ at: vendors.createdAt }).from(vendors).where(and(T, gte(vendors.createdAt, start12), lte(vendors.createdAt, f.to), ...vt(f)));
  const apr = await db.select({ at: vendors.decidedAt }).from(vendors).where(and(T, eq(vendors.status, 'APPROVED'), gte(vendors.decidedAt, start12), lte(vendors.decidedAt, f.to), ...vt(f)));
  const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const monthly = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(start12.getUTCFullYear(), start12.getUTCMonth() + i, 1)); const k = monthKey(d);
    return { month: k, invited: inv.filter((x) => monthKey(x.at) === k).length, approved: apr.filter((x) => monthKey(x.at!) === k).length };
  });

  // Headline tiles.
  const approvedAll = await db.select({ id: vendors.id, status: vendors.status, blockedAt: vendors.blockedAt, reviewStatus: vendors.reviewStatus, nextReviewAt: vendors.nextReviewAt })
    .from(vendors).where(and(T, eq(vendors.status, 'APPROVED'), ...vt(f)));
  const flags = await flagsForMany(tenantId, approvedAll);
  const tiles = {
    approvedInRange: approved.length,
    invitedInRange: cohort.length,
    inProgress: open.length,
    underReview: open.filter((v) => v.status === 'UNDER_REVIEW').length,
    overdueSteps: pendingSteps.filter((s) => s.dueAt && s.dueAt < now).length + crPending.filter((s) => s.dueAt && s.dueAt < now).length,
    activeVendors: approvedAll.filter((v) => !v.blockedAt).length,
    blocked: approvedAll.filter((v) => v.blockedAt).length,
    needsAttention: approvedAll.filter((v) => (flags.get(v.id) ?? []).length).length,
    medianDaysToApprove: total.median,
    openChanges: crPending.length ? new Set((await db.select({ id: changeRequests.id }).from(changeRequests).innerJoin(vendors, eq(vendors.id, changeRequests.vendorId)).where(and(eq(changeRequests.tenantId, tenantId), eq(changeRequests.status, 'PENDING'), ...vt(f)))).map((r) => r.id)).size : 0,
  };

  return {
    range: { from: f.from.toISOString().slice(0, 10), to: f.to.toISOString().slice(0, 10), vendorType: f.vendorType ?? null },
    tiles, funnel, rejected, turnaround: { total, review, vendorSide }, byLevel, ageing: { buckets: BUCKETS, rows: ageing }, workload, monthly,
  };
}

/* =========================== Tabular reports =========================== */

type Cell = string | number | Date | null;
interface Column { key: string; label: string; width?: number; type?: 'date' | 'datetime' | 'number' }
interface ReportDef { title: string; description: string; usesRange: boolean; usesDays?: boolean; columns: Column[]; rows: (tenantId: string, f: Filters) => Promise<Record<string, Cell>[]> }

const vendorCols: Column[] = [{ key: 'code', label: 'Vendor code', width: 12 }, { key: 'vendor', label: 'Vendor', width: 32 }];
const hoursBetween = (a?: Date | null, b?: Date | null) => (a && b ? round1((b.getTime() - a.getTime()) / HOUR) : null);
const daysBetween = (a?: Date | null, b?: Date | null) => (a && b ? round1((b.getTime() - a.getTime()) / DAY) : null);

async function roleNames(tenantId: string) {
  return new Map((await db.select({ id: roles.id, name: roles.name }).from(roles).where(eq(roles.tenantId, tenantId))).map((r) => [r.id, r.name]));
}
async function userNames(tenantId: string) {
  return new Map((await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.tenantId, tenantId))).map((r) => [r.id, r.name]));
}

export const REPORTS: Record<string, ReportDef> = {
  'vendor-register': {
    title: 'Vendor register', description: 'All approved vendors with key details. PAN and bank account numbers are masked.', usesRange: false,
    columns: [...vendorCols, { key: 'type', label: 'Type', width: 12 }, { key: 'status', label: 'Status', width: 10 }, { key: 'gstin', label: 'GSTIN', width: 18 }, { key: 'pan', label: 'PAN (masked)', width: 14 },
      { key: 'bank', label: 'Bank', width: 20 }, { key: 'account', label: 'Account (masked)', width: 16 }, { key: 'ifsc', label: 'IFSC / routing', width: 14 }, { key: 'city', label: 'City', width: 14 }, { key: 'state', label: 'State', width: 16 },
      { key: 'contact', label: 'Contact', width: 20 }, { key: 'email', label: 'Email', width: 26 }, { key: 'mobile', label: 'Mobile', width: 14 }, { key: 'approved', label: 'Approved on', type: 'date', width: 12 },
      { key: 'erpId', label: 'ERP vendor id', width: 14 }, { key: 'erpStatus', label: 'ERP sync', width: 10 }, { key: 'nextReview', label: 'Next re-check', type: 'date', width: 13 }],
    rows: async (tenantId, f) => {
      const rows = await db.query.vendors.findMany({ where: and(eq(vendors.tenantId, tenantId), eq(vendors.status, 'APPROVED'), ...vt(f)), orderBy: asc(vendors.code) });
      return rows.map((v) => {
        const p = v.profile as Profile; const b = p.basic ?? {}, bank = p.bank ?? {}, tax = p.tax ?? {};
        return { code: v.code, vendor: v.name, type: v.vendorType, status: v.blockedAt ? 'Blocked' : 'Active', gstin: str(tax.gstin), pan: mask(tax.pan, 3, 1),
          bank: str(bank.bankName), account: mask(bank.accountNumber, 0, 4), ifsc: str(bank.ifsc) || str(bank.routingNumber) || str(bank.swift), city: str(b.district), state: str(b.region),
          contact: `${v.contactFirstName} ${v.contactLastName}`, email: v.contactEmail, mobile: v.contactMobile, approved: v.decidedAt, erpId: v.erpVendorId ?? '', erpStatus: v.erpSyncStatus ?? '', nextReview: v.nextReviewAt };
      });
    },
  },

  'pending-approvals': {
    title: 'Pending approvals', description: 'Every onboarding and change-request step waiting for a decision right now, oldest first.', usesRange: false,
    columns: [{ key: 'kind', label: 'Kind', width: 12 }, ...vendorCols, { key: 'level', label: 'Level', width: 24 }, { key: 'with', label: 'Waiting on', width: 24 },
      { key: 'since', label: 'Waiting since', type: 'datetime', width: 17 }, { key: 'due', label: 'Due', type: 'datetime', width: 17 }, { key: 'overdue', label: 'Overdue', width: 9 }, { key: 'days', label: 'Days waiting', type: 'number', width: 12 }],
    rows: async (tenantId, f) => {
      const now = new Date(); const rn = await roleNames(tenantId); const un = await userNames(tenantId);
      const a = await db.select({ s: approvalSteps, v: { code: vendors.code, name: vendors.name } }).from(approvalSteps).innerJoin(vendors, eq(vendors.id, approvalSteps.vendorId))
        .where(and(eq(approvalSteps.tenantId, tenantId), eq(approvalSteps.status, 'PENDING'), ...vt(f)));
      const c = await db.select({ s: changeRequestSteps, v: { code: vendors.code, name: vendors.name } }).from(changeRequestSteps)
        .innerJoin(changeRequests, eq(changeRequests.id, changeRequestSteps.changeRequestId)).innerJoin(vendors, eq(vendors.id, changeRequests.vendorId))
        .where(and(eq(changeRequestSteps.tenantId, tenantId), eq(changeRequestSteps.status, 'PENDING'), ...vt(f)));
      return [...a.map((r) => ({ ...r, kind: 'Onboarding' })), ...c.map((r) => ({ ...r, kind: 'Change' }))]
        .map(({ s, v, kind }) => ({ kind, code: v.code, vendor: v.name, level: s.label, with: s.assigneeUserId ? un.get(s.assigneeUserId) ?? '' : rn.get(s.roleId) ?? '',
          since: s.activatedAt, due: s.dueAt, overdue: s.dueAt && s.dueAt < now ? 'Yes' : 'No', days: daysBetween(s.activatedAt, now) }))
        .sort((x, y) => (y.days ?? 0) - (x.days ?? 0));
    },
  },

  'sla-breaches': {
    title: 'Deadline (SLA) breaches', description: 'Steps decided late in the period, plus steps that are overdue now.', usesRange: true,
    columns: [{ key: 'kind', label: 'Kind', width: 12 }, ...vendorCols, { key: 'level', label: 'Level', width: 24 }, { key: 'due', label: 'Due', type: 'datetime', width: 17 },
      { key: 'acted', label: 'Decided', type: 'datetime', width: 17 }, { key: 'hoursLate', label: 'Hours late', type: 'number', width: 11 }, { key: 'by', label: 'Decided by / waiting on', width: 24 }],
    rows: async (tenantId, f) => {
      const now = new Date(); const rn = await roleNames(tenantId); const un = await userNames(tenantId);
      const inRange = <T extends typeof approvalSteps | typeof changeRequestSteps>(t: T) => or(and(isNotNull(t.actedAt), gte(t.actedAt, f.from), lte(t.actedAt, f.to)), eq(t.status, 'PENDING'));
      const a = await db.select({ s: approvalSteps, v: { code: vendors.code, name: vendors.name } }).from(approvalSteps).innerJoin(vendors, eq(vendors.id, approvalSteps.vendorId))
        .where(and(eq(approvalSteps.tenantId, tenantId), isNotNull(approvalSteps.dueAt), inRange(approvalSteps), ...vt(f)));
      const c = await db.select({ s: changeRequestSteps, v: { code: vendors.code, name: vendors.name } }).from(changeRequestSteps)
        .innerJoin(changeRequests, eq(changeRequests.id, changeRequestSteps.changeRequestId)).innerJoin(vendors, eq(vendors.id, changeRequests.vendorId))
        .where(and(eq(changeRequestSteps.tenantId, tenantId), isNotNull(changeRequestSteps.dueAt), inRange(changeRequestSteps), ...vt(f)));
      return [...a.map((r) => ({ ...r, kind: 'Onboarding' })), ...c.map((r) => ({ ...r, kind: 'Change' }))]
        .filter(({ s }) => (s.status === 'PENDING' ? s.dueAt! < now : s.actedAt && s.actedAt > s.dueAt!))
        .map(({ s, v, kind }) => ({ kind, code: v.code, vendor: v.name, level: s.label, due: s.dueAt, acted: s.actedAt, hoursLate: hoursBetween(s.dueAt, s.actedAt ?? now),
          by: s.actedById ? un.get(s.actedById) ?? '' : `${s.assigneeUserId ? un.get(s.assigneeUserId) : rn.get(s.roleId)} (pending)` }))
        .sort((x, y) => (y.hoursLate ?? 0) - (x.hoursLate ?? 0));
    },
  },

  turnaround: {
    title: 'Onboarding turnaround', description: 'Vendors approved in the period: days from invite to approval, split into vendor time and review time.', usesRange: true,
    columns: [...vendorCols, { key: 'type', label: 'Type', width: 12 }, { key: 'invited', label: 'Invited', type: 'date', width: 12 }, { key: 'submitted', label: 'Last submitted', type: 'date', width: 14 },
      { key: 'approved', label: 'Approved', type: 'date', width: 12 }, { key: 'vendorDays', label: 'Vendor days', type: 'number', width: 12 }, { key: 'reviewDays', label: 'Review days', type: 'number', width: 12 },
      { key: 'totalDays', label: 'Total days', type: 'number', width: 11 }, { key: 'cycles', label: 'Submissions', type: 'number', width: 12 }],
    rows: async (tenantId, f) => {
      const rows = await db.select().from(vendors).where(and(eq(vendors.tenantId, tenantId), eq(vendors.status, 'APPROVED'), gte(vendors.decidedAt, f.from), lte(vendors.decidedAt, f.to), ...vt(f))).orderBy(desc(vendors.decidedAt));
      return rows.map((v) => ({ code: v.code, vendor: v.name, type: v.vendorType, invited: v.createdAt, submitted: v.submittedAt, approved: v.decidedAt,
        vendorDays: daysBetween(v.createdAt, v.submittedAt), reviewDays: daysBetween(v.submittedAt, v.decidedAt), totalDays: daysBetween(v.createdAt, v.decidedAt), cycles: v.reviewCycle }));
    },
  },

  'change-requests': {
    title: 'Change requests', description: 'Changes requested by vendors or proposed by staff in the period.', usesRange: true,
    columns: [...vendorCols, { key: 'fields', label: 'What changed', width: 40 }, { key: 'documents', label: 'Documents', type: 'number', width: 11 }, { key: 'raisedBy', label: 'Raised by', width: 20 },
      { key: 'sensitive', label: 'Sensitive', width: 10 }, { key: 'status', label: 'Status', width: 11 }, { key: 'created', label: 'Requested', type: 'datetime', width: 17 },
      { key: 'decided', label: 'Decided', type: 'datetime', width: 17 }, { key: 'days', label: 'Days open', type: 'number', width: 10 }],
    rows: async (tenantId, f) => {
      const un = await userNames(tenantId); const now = new Date();
      const rows = await db.select({ c: changeRequests, v: { code: vendors.code, name: vendors.name } }).from(changeRequests).innerJoin(vendors, eq(vendors.id, changeRequests.vendorId))
        .where(and(eq(changeRequests.tenantId, tenantId), gte(changeRequests.createdAt, f.from), lte(changeRequests.createdAt, f.to), ...vt(f))).orderBy(desc(changeRequests.createdAt));
      return rows.map(({ c, v }) => ({ code: v.code, vendor: v.name, fields: c.changes.map((x) => x.label).join(', '), documents: c.documentIds.length,
        raisedBy: c.raisedById ? un.get(c.raisedById) ?? 'Staff' : 'Vendor', sensitive: c.sensitive ? 'Yes' : 'No', status: c.status, created: c.createdAt, decided: c.decidedAt, days: daysBetween(c.createdAt, c.decidedAt ?? now) }));
    },
  },

  'expiring-documents': {
    title: 'Expiring documents', description: 'Current documents of approved vendors that have expired or expire within the chosen number of days.', usesRange: false, usesDays: true,
    columns: [...vendorCols, { key: 'document', label: 'Document', width: 34 }, { key: 'file', label: 'File', width: 26 }, { key: 'expiresOn', label: 'Valid until', type: 'date', width: 12 },
      { key: 'daysLeft', label: 'Days left', type: 'number', width: 10 }, { key: 'state', label: 'State', width: 10 }],
    rows: async (tenantId, f) => {
      const limit = new Date(Date.now() + (f.days ?? 60) * DAY).toISOString().slice(0, 10);
      const cfg = await getConfig(tenantId);
      const label = (t: string) => cfg.documents.find((d) => d.type === t)?.label ?? t;
      const rows = await db.select({ d: documents, v: { code: vendors.code, name: vendors.name } }).from(documents).innerJoin(vendors, eq(vendors.id, documents.vendorId))
        .where(and(eq(documents.tenantId, tenantId), eq(documents.status, 'ACTIVE'), eq(vendors.status, 'APPROVED'), isNotNull(documents.expiresOn), lte(documents.expiresOn, limit), ...vt(f))).orderBy(asc(documents.expiresOn));
      return rows.map(({ d, v }) => { const n = daysUntil(d.expiresOn!); return { code: v.code, vendor: v.name, document: label(d.docType), file: d.fileName, expiresOn: new Date(`${d.expiresOn}T00:00:00Z`), daysLeft: n, state: n < 0 ? 'Expired' : 'Expiring' }; });
    },
  },

  blocked: {
    title: 'Blocked vendors', description: 'Vendors currently on hold, with who blocked them and why.', usesRange: false,
    columns: [...vendorCols, { key: 'blockedAt', label: 'Blocked on', type: 'datetime', width: 17 }, { key: 'by', label: 'Blocked by', width: 20 }, { key: 'reason', label: 'Reason', width: 44 }, { key: 'days', label: 'Days on hold', type: 'number', width: 12 }],
    rows: async (tenantId, f) => {
      const un = await userNames(tenantId); const now = new Date();
      const rows = await db.select().from(vendors).where(and(eq(vendors.tenantId, tenantId), isNotNull(vendors.blockedAt), ...vt(f))).orderBy(desc(vendors.blockedAt));
      return rows.map((v) => ({ code: v.code, vendor: v.name, blockedAt: v.blockedAt, by: v.blockedById ? un.get(v.blockedById) ?? '' : '', reason: v.blockedReason ?? '', days: daysBetween(v.blockedAt, now) }));
    },
  },

  'erp-deliveries': {
    title: 'ERP deliveries', description: 'Every push to the ERP in the period, with its outcome.', usesRange: true,
    columns: [...vendorCols, { key: 'event', label: 'Event', width: 10 }, { key: 'connector', label: 'Connector', width: 10 }, { key: 'status', label: 'Status', width: 9 },
      { key: 'attempts', label: 'Attempts', type: 'number', width: 9 }, { key: 'erpId', label: 'ERP vendor id', width: 14 }, { key: 'error', label: 'Error', width: 40 }, { key: 'at', label: 'Queued', type: 'datetime', width: 17 }, { key: 'sentAt', label: 'Sent', type: 'datetime', width: 17 }],
    rows: async (tenantId, f) => {
      const rows = await db.select({ s: erpSyncs, v: { code: vendors.code, name: vendors.name } }).from(erpSyncs).innerJoin(vendors, eq(vendors.id, erpSyncs.vendorId))
        .where(and(eq(erpSyncs.tenantId, tenantId), gte(erpSyncs.createdAt, f.from), lte(erpSyncs.createdAt, f.to), ...vt(f))).orderBy(desc(erpSyncs.createdAt));
      return rows.map(({ s, v }) => ({ code: v.code, vendor: v.name, event: s.event, connector: s.kind, status: s.status, attempts: s.attempts, erpId: s.erpVendorId ?? '', error: s.error ?? '', at: s.createdAt, sentAt: s.sentAt }));
    },
  },
};

export const reportList = () => Object.entries(REPORTS).map(([key, r]) => ({ key, title: r.title, description: r.description, usesRange: r.usesRange, usesDays: !!r.usesDays, columns: r.columns }));

export async function runReport(tenantId: string, key: string, f: Filters) {
  const def = REPORTS[key];
  if (!def) return null;
  const rows = (await def.rows(tenantId, f)).slice(0, 20000);
  return { def, rows };
}

/** Excel workbook: the report sheet (frozen header, filters, typed cells) plus an "About" sheet. */
export async function toXlsx(def: ReportDef, rows: Record<string, Cell>[], meta: { tenant: string; by: string; filters: Filters }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VendorGate'; wb.created = new Date();
  const ws = wb.addWorksheet(def.title.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = def.columns.map((c) => ({ header: c.label, key: c.key, width: c.width ?? 16, style: c.type === 'date' ? { numFmt: 'dd-mmm-yyyy' } : c.type === 'datetime' ? { numFmt: 'dd-mmm-yyyy hh:mm' } : {} }));
  // Text cells that look like formulas are stored as plain text (no formula injection).
  for (const r of rows) ws.addRow(Object.fromEntries(def.columns.map((c) => [c.key, r[c.key] ?? null])));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4A1650' } };
  head.alignment = { vertical: 'middle' };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: def.columns.length } };
  const about = wb.addWorksheet('About');
  about.columns = [{ width: 18 }, { width: 70 }];
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  [['Report', def.title], ['Workspace', meta.tenant], ['Description', def.description], ...(def.usesRange ? [['Period', `${fmt(meta.filters.from)} to ${fmt(meta.filters.to)}`]] : []),
    ...(def.usesDays ? [['Window', `Expired or expiring within ${meta.filters.days} days`]] : []), ['Vendor type', meta.filters.vendorType ?? 'All'], ['Rows', String(rows.length)],
    ['Generated', new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'], ['Generated by', meta.by]].forEach((r) => about.addRow(r));
  about.getColumn(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
