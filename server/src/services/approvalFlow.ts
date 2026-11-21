/**
 * Generic approval flow for anything that isn't a supplier (sourcing events now; awards next).
 *
 * Levels are the same shape as the onboarding approval flow (WorkflowLevel: label, role, optional rule, deadline)
 * and are edited with the same screen component. Who may act reuses services/approvers.ts (role holders, a person
 * the step is assigned to, and their delegates); rules reuse lib/conditions.ts; deadlines reuse lib/calendar.ts.
 *
 * Each subject type registers a handler that describes the subject and reacts to the outcome.
 */
import { and, asc, eq, inArray, isNull, lt, max } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import type { FlowStep, Tenant } from '../db/schema.js';
import type { WorkflowLevel } from '../config/types.js';
import { ruleHolds, type EvalContext } from '../lib/conditions.js';
import { HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';
import { addWorkingHours, calendarFor, formatDeadline } from '../lib/calendar.js';
import { approverIds, directApprovers, emailsFor, usersWithPermission } from './approvers.js';
import { logger } from '../lib/logger.js';

const { flowSteps, roles, users, tenants } = schema;

export type FlowSubject = 'sourcing_event' | 'sourcing_award' | 'contract' | 'invoice';
export type FlowDecision = 'APPROVE' | 'SEND_BACK' | 'REJECT';
export interface SubjectInfo { title: string; ref: string; link: string; kind: string }
export interface FlowHandler {
  describe(tenantId: string, id: string): Promise<SubjectInfo | null>;
  /** Every level approved. */
  approved(tenantId: string, id: string, by: { id: string; name: string }): Promise<void>;
  /** Sent back for changes, or rejected. */
  returned(tenantId: string, id: string, decision: 'SEND_BACK' | 'REJECT', remarks: string, by: { id: string; name: string }): Promise<void>;
  /** A reason this user may not decide (e.g. nobody approves their own event); null = no objection. */
  blockedFor?(tenantId: string, id: string, userId: string): Promise<string | null>;
  /** The person a level with `assignee` goes to (e.g. the cost-centre owner); null = the role holders. */
  assigneeFor?(tenantId: string, id: string, assignee: string): Promise<string | null>;
}
const handlers = new Map<FlowSubject, FlowHandler>();
export function registerFlowSubject(type: FlowSubject, h: FlowHandler) { handlers.set(type, h); }
function handler(type: FlowSubject) {
  const h = handlers.get(type);
  if (!h) throw new Error(`No approval flow handler for ${type}`);
  return h;
}

/** Levels whose rule holds for this subject. */
export const applicableFlowLevels = (levels: WorkflowLevel[], ctx: EvalContext) => levels.filter((l) => ruleHolds(l.rule, ctx));

async function notify(step: FlowStep, info: SubjectInfo, prefix = 'Approval needed') {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, step.tenantId) });
  const due = step.dueAt ? `\nPlease act by ${formatDeadline(step.dueAt, tenant ?? null)}.` : '';
  for (const u of await emailsFor(await approverIds(step))) {
    await sendMail({ tenantId: step.tenantId, to: u.email, subject: `${prefix}: ${step.label} for ${info.ref}`,
      body: `Hello ${u.name},\n\n${info.kind} ${info.ref} “${info.title}” is waiting for ${step.label}.${due}\nOpen it to approve, send back or reject.`, link: info.link });
  }
}

async function activate(step: FlowStep, info: SubjectInfo) {
  const now = new Date();
  const tenant = step.slaHours ? await db.query.tenants.findFirst({ where: eq(tenants.id, step.tenantId) }) : null;
  const dueAt = step.slaHours && tenant ? addWorkingHours(now, step.slaHours, calendarFor(tenant)) : null;
  const [s] = await db.update(flowSteps).set({ status: 'PENDING', activatedAt: now, dueAt }).where(eq(flowSteps.id, step.id)).returning();
  await notify(s, info);
  return s;
}

/**
 * Start a new approval cycle. Returns the steps created — none when no level applies (nothing needs approval;
 * the caller then treats the subject as approved).
 */
export async function startFlow(tenant: Pick<Tenant, 'id'>, type: FlowSubject, id: string, levels: WorkflowLevel[], ctx: EvalContext, by: { name: string; ip?: string }) {
  const apply = applicableFlowLevels(levels, ctx);
  if (!apply.length) return { cycle: 0, steps: [] as FlowStep[] };
  const tenantRoles = await db.select().from(roles).where(eq(roles.tenantId, tenant.id));
  const resolved = apply.map((l) => {
    const role = tenantRoles.find((r) => r.key === l.roleKey);
    if (!role) throw new HttpError(409, `Approval level “${l.label}” refers to a role that no longer exists. Ask your administrator to check the approval flow.`);
    return { ...l, roleId: role.id };
  });
  const h = handler(type);
  const assignees = await Promise.all(resolved.map((l) => (l.assignee && h.assigneeFor ? h.assigneeFor(tenant.id, id, l.assignee) : Promise.resolve(null))));
  const [{ last }] = await db.select({ last: max(flowSteps.cycle) }).from(flowSteps).where(and(eq(flowSteps.subjectType, type), eq(flowSteps.subjectId, id)));
  const cycle = (last ?? 0) + 1;
  const steps = await db.insert(flowSteps).values(resolved.map((l, i) => ({
    tenantId: tenant.id, subjectType: type, subjectId: id, cycle, level: i + 1, roleId: l.roleId, label: l.label, slaHours: l.slaHours ?? null, status: 'WAITING' as const, assigneeUserId: assignees[i],
  }))).returning();
  const info = await h.describe(tenant.id, id);
  await audit({ tenantId: tenant.id, actor: by.name, action: 'FLOW_STARTED', detail: { subject: type, subjectId: id, ref: info?.ref, levels: resolved.map((l) => l.label) }, ip: by.ip });
  if (info) steps[0] = await activate(steps[0], info);
  return { cycle, steps };
}

async function cycleSteps(tenantId: string, type: FlowSubject, id: string) {
  const [{ last }] = await db.select({ last: max(flowSteps.cycle) }).from(flowSteps).where(and(eq(flowSteps.tenantId, tenantId), eq(flowSteps.subjectType, type), eq(flowSteps.subjectId, id)));
  if (!last) return { cycle: 0, steps: [] as FlowStep[] };
  const steps = await db.select().from(flowSteps).where(and(eq(flowSteps.tenantId, tenantId), eq(flowSteps.subjectType, type), eq(flowSteps.subjectId, id), eq(flowSteps.cycle, last))).orderBy(asc(flowSteps.level));
  return { cycle: last, steps };
}

/** The latest cycle for a screen: each step with its role and who acted, and whether this user can act now. */
export async function flowView(tenantId: string, type: FlowSubject, id: string, userId?: string) {
  const { cycle, steps } = await cycleSteps(tenantId, type, id);
  if (!steps.length) return { cycle, steps: [], current: null, canAct: false };
  const roleRows = await db.select({ id: roles.id, name: roles.name }).from(roles).where(inArray(roles.id, steps.map((s) => s.roleId)));
  const ids = [...new Set(steps.flatMap((s) => [s.actedById, s.assigneeUserId]).filter(Boolean) as string[])];
  const people = ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : [];
  const nameOf = (x: string | null) => (x ? people.find((p) => p.id === x)?.name ?? null : null);
  const current = steps.find((s) => s.status === 'PENDING') ?? null;
  return {
    cycle,
    // Same shape as supplier approval steps, so the screens reuse ApprovalTimeline.
    steps: steps.map((s) => ({ id: s.id, cycle: s.cycle, level: s.level, label: s.label, status: s.status, roleName: roleRows.find((r) => r.id === s.roleId)?.name ?? '', assigneeName: nameOf(s.assigneeUserId), actedBy: nameOf(s.actedById) ? { name: nameOf(s.actedById)! } : null, actedAt: s.actedAt, remarks: s.remarks, dueAt: s.dueAt, overdue: !!s.dueAt && s.status === 'PENDING' && s.dueAt < new Date() })),
    current: current && { id: current.id, label: current.label },
    canAct: !!current && !!userId && (await approverIds(current)).has(userId) && !(await handler(type).blockedFor?.(tenantId, id, userId)),
  };
}

export async function decideFlow(tenantId: string, type: FlowSubject, id: string, actor: { id: string; name: string }, action: FlowDecision, remarks: string, ip?: string) {
  const { steps } = await cycleSteps(tenantId, type, id);
  const current = steps.find((s) => s.status === 'PENDING');
  if (!current) throw new HttpError(409, 'Nothing is waiting for approval');
  if (!(await approverIds(current)).has(actor.id)) throw new HttpError(403, current.assigneeUserId ? `This step (${current.label}) is assigned to someone else` : `This step (${current.label}) is for a role you don’t hold`);
  const blocked = await handler(type).blockedFor?.(tenantId, id, actor.id);
  if (blocked) throw new HttpError(403, blocked);
  if (action !== 'APPROVE' && !remarks.trim()) throw new HttpError(400, 'Remarks are required when sending back or rejecting');
  const status = action === 'APPROVE' ? 'APPROVED' : action === 'REJECT' ? 'REJECTED' : 'SENT_BACK';
  const claimed = await db.update(flowSteps).set({ status, remarks: remarks.trim() || null, actedById: actor.id, actedAt: new Date() })
    .where(and(eq(flowSteps.id, current.id), eq(flowSteps.status, 'PENDING'))).returning({ id: flowSteps.id });
  if (!claimed.length) throw new HttpError(409, 'This step was already actioned by someone else — refresh the page');
  const onBehalf = (await directApprovers(current)).includes(actor.id) ? undefined : 'delegate';
  const h = handler(type);
  const info = await h.describe(tenantId, id);
  await audit({ tenantId, actor: actor.name, action: `FLOW_STEP_${status}`, detail: { subject: type, subjectId: id, ref: info?.ref, level: current.level, label: current.label, remarks: remarks.trim() || undefined, ...(onBehalf ? { as: onBehalf } : {}) }, ip });
  if (action === 'APPROVE') {
    const next = steps.find((s) => s.level === current.level + 1);
    if (next && info) { await activate(next, info); return { status: 'PENDING' as const, nextLevel: next.label }; }
    await h.approved(tenantId, id, actor);
    return { status: 'APPROVED' as const };
  }
  await db.update(flowSteps).set({ status: 'CANCELLED' }).where(and(eq(flowSteps.subjectType, type), eq(flowSteps.subjectId, id), eq(flowSteps.status, 'WAITING')));
  await h.returned(tenantId, id, action, remarks.trim(), actor);
  return { status: status as 'SENT_BACK' | 'REJECTED' };
}

/** Withdrawn by its owner (or the subject was cancelled): close whatever is still open. */
export async function cancelFlow(tenantId: string, type: FlowSubject, id: string) {
  await db.update(flowSteps).set({ status: 'CANCELLED' }).where(and(eq(flowSteps.tenantId, tenantId), eq(flowSteps.subjectType, type), eq(flowSteps.subjectId, id), inArray(flowSteps.status, ['WAITING', 'PENDING'])));
}

/** Subjects of a type waiting for this user (directly, through a role, or as a delegate). */
export async function waitingFor(tenantId: string, userId: string, type: FlowSubject) {
  const pending = await db.select().from(flowSteps).where(and(eq(flowSteps.tenantId, tenantId), eq(flowSteps.subjectType, type), eq(flowSteps.status, 'PENDING')));
  const mine: FlowStep[] = [];
  for (const s of pending) if ((await approverIds(s)).has(userId) && !(await handlers.get(type)?.blockedFor?.(tenantId, s.subjectId, userId))) mine.push(s);
  return mine;
}

/** Overdue pending steps: remind the approvers once and tell people who manage approvals. Runs with the SLA sweep. */
export async function sweepOverdueFlows(now = new Date()) {
  const overdue = await db.select().from(flowSteps).where(and(eq(flowSteps.status, 'PENDING'), lt(flowSteps.dueAt, now), isNull(flowSteps.remindedAt)));
  for (const step of overdue) {
    const h = handlers.get(step.subjectType as FlowSubject);
    const info = h && (await h.describe(step.tenantId, step.subjectId));
    if (!info) continue;
    await notify(step, info, 'OVERDUE');
    for (const m of await usersWithPermission(step.tenantId, 'approvals.manage')) {
      await sendMail({ tenantId: step.tenantId, to: m.email, subject: `Escalation: ${step.label} overdue for ${info.ref}`,
        body: `Hello ${m.name},\n\n${step.label} for ${info.kind.toLowerCase()} ${info.ref} “${info.title}” passed its deadline.`, link: info.link });
    }
    await db.update(flowSteps).set({ remindedAt: now }).where(eq(flowSteps.id, step.id));
    await audit({ tenantId: step.tenantId, actor: 'system', action: 'FLOW_STEP_OVERDUE', detail: { subject: step.subjectType, subjectId: step.subjectId, ref: info.ref, label: step.label } });
  }
  if (overdue.length) logger.info({ count: overdue.length }, 'approval flow reminders sent');
  return overdue.length;
}
