import { and, asc, eq, isNull, lt } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import type { ApprovalStep, Vendor } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';
import { env } from '../lib/env.js';
import { HttpError } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { ruleHolds, type Profile } from '../lib/conditions.js';
import { getPublished } from './config.js';
import { approverIds, directApprovers, emailsFor } from './approvers.js';
import { defineJob } from '../jobs/queue.js';
import { nextReviewFrom, sweepOverdueChanges } from './lifecycle.js';
import { pushLater } from '../integrations/erp/index.js';
import { addWorkingHours, calendarFor, formatDeadline } from '../lib/calendar.js';
import type { WorkflowLevel } from '../config/types.js';

const { vendors, approvalSteps, roles, users, userRoles, tenants } = schema;
const setVendor = (tenantId: string, id: string, data: Partial<Vendor>) =>
  db.update(vendors).set(data).where(and(eq(vendors.tenantId, tenantId), eq(vendors.id, id)));

/** Deadline for a step: SLA hours from now, skipping the weekend when the workspace counts working days. */
async function dueFrom(tenantId: string, from: Date, slaHours?: number | null) {
  if (!slaHours) return null;
  return addWorkingHours(from, slaHours, calendarFor(await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) })));
}
const vendorUrl = (id: string) => `${env.appBaseUrl}/staff/vendors/${id}`;

/** Which configured levels apply to this vendor (evaluating each level's rule). */
export function applicableLevels(levels: WorkflowLevel[], vendor: Pick<Vendor, 'vendorType' | 'profile'>) {
  return levels.filter((l) => ruleHolds(l.rule, { profile: vendor.profile as Profile, vendor: { vendorType: vendor.vendorType } }));
}

async function notifyStep(step: ApprovalStep, vendor: Vendor, subjectPrefix = 'Action needed') {
  const people = await emailsFor(await approverIds(step));
  const tenant = step.dueAt ? await db.query.tenants.findFirst({ where: eq(tenants.id, vendor.tenantId) }) : null;
  const due = step.dueAt ? `\nPlease act by ${formatDeadline(step.dueAt, tenant)}.` : '';
  for (const u of people) {
    await sendMail({ tenantId: vendor.tenantId, to: u.email, subject: `${subjectPrefix}: ${step.label} for ${vendor.name}`,
      body: `Hello ${u.name},\n\n${vendor.name} (${vendor.code}) is waiting for ${step.label}.${due}\nOpen the vendor to approve, send back or reject.`, link: vendorUrl(vendor.id) });
  }
}

async function activate(step: ApprovalStep, vendor: Vendor) {
  const now = new Date();
  const [s] = await db.update(approvalSteps).set({ status: 'PENDING', activatedAt: now, dueAt: await dueFrom(vendor.tenantId, now, step.slaHours) }).where(eq(approvalSteps.id, step.id)).returning();
  await notifyStep(s, vendor);
  return s;
}

export async function startReview(vendor: Vendor) {
  const { version, config } = await getPublished(vendor.tenantId);
  const levels = applicableLevels(config.workflow.levels, vendor);
  if (!levels.length) throw new HttpError(500, 'No approval level applies to this vendor. Ask your administrator to check the approval flow.');
  const tenantRoles = await db.select().from(roles).where(eq(roles.tenantId, vendor.tenantId));
  const resolved = levels.map((l) => {
    const role = tenantRoles.find((r) => r.key === l.roleKey);
    if (!role) throw new HttpError(500, `Approval level “${l.label}” refers to a role that no longer exists`);
    return { ...l, roleId: role.id };
  });
  const cycle = vendor.reviewCycle + 1;
  const steps = await db.transaction(async (tx) => {
    const rows = await tx.insert(approvalSteps).values(resolved.map((l, i) => ({
      tenantId: vendor.tenantId, vendorId: vendor.id, cycle, level: i + 1, roleId: l.roleId, label: l.label, slaHours: l.slaHours ?? null, status: 'WAITING' as const,
    }))).returning();
    await tx.update(vendors).set({ status: 'UNDER_REVIEW', reviewCycle: cycle, submittedAt: new Date(), configVersion: version }).where(eq(vendors.id, vendor.id));
    return rows;
  });
  await activate(steps[0], vendor);
}

export type Decision = 'APPROVE' | 'SEND_BACK' | 'REJECT';

async function loadReview(tenantId: string, vendorId: string) {
  const vendor = await db.query.vendors.findFirst({ where: and(eq(vendors.tenantId, tenantId), eq(vendors.id, vendorId)) });
  if (!vendor) throw new HttpError(404, 'Vendor not found');
  const steps = await db.select().from(approvalSteps)
    .where(and(eq(approvalSteps.tenantId, tenantId), eq(approvalSteps.vendorId, vendorId), eq(approvalSteps.cycle, vendor.reviewCycle)))
    .orderBy(asc(approvalSteps.level));
  return { vendor, steps, current: steps.find((s) => s.status === 'PENDING') };
}

export async function decide(tenantId: string, vendorId: string, actor: { id: string; name: string }, action: Decision, remarks: string, ip?: string) {
  const { vendor, steps, current } = await loadReview(tenantId, vendorId);
  if (vendor.status !== 'UNDER_REVIEW') throw new HttpError(409, 'Vendor is not under review');
  if (!current) throw new HttpError(409, 'No pending approval step');
  const allowed = await approverIds(current);
  if (!allowed.has(actor.id)) {
    throw new HttpError(403, current.assigneeUserId ? `This step (${current.label}) is assigned to someone else` : `This step (${current.label}) is assigned to a role you don’t hold`);
  }
  if (action !== 'APPROVE' && !remarks.trim()) throw new HttpError(400, 'Remarks are required when sending back or rejecting');

  const now = new Date();
  const stepStatus = (action === 'APPROVE' ? 'APPROVED' : action === 'REJECT' ? 'REJECTED' : 'SENT_BACK') as 'APPROVED' | 'REJECTED' | 'SENT_BACK';
  const claimed = await db.update(approvalSteps)
    .set({ status: stepStatus, remarks: remarks || null, actedById: actor.id, actedAt: now })
    .where(and(eq(approvalSteps.id, current.id), eq(approvalSteps.status, 'PENDING')))
    .returning({ id: approvalSteps.id });
  if (claimed.length === 0) throw new HttpError(409, 'This step was already actioned by someone else — refresh the page');
  const onBehalf = (await directApprovers(current)).includes(actor.id) ? undefined : 'delegate';
  await audit({ tenantId, vendorId, actor: actor.name, action: `STEP_${stepStatus}`, detail: { level: current.level, label: current.label, remarks, ...(onBehalf ? { as: onBehalf } : {}) }, ip });

  const vendorLink = `${env.appBaseUrl}/onboard/${vendor.inviteToken}`;
  if (action === 'APPROVE') {
    const next = steps.find((s) => s.level === current.level + 1);
    if (next) {
      await activate(next, vendor);
      return { status: 'UNDER_REVIEW' as const, nextLevel: next.label };
    }
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
    await setVendor(tenantId, vendorId, { status: 'APPROVED', decidedAt: now, nextReviewAt: nextReviewFrom(now, tenant?.settings.reKycMonths), reviewStatus: 'OK' });
    await audit({ tenantId, vendorId, actor: 'system', action: 'VENDOR_APPROVED' });
    await sendMail({ tenantId, to: vendor.contactEmail, subject: 'Your vendor registration is approved',
      body: `Dear ${vendor.contactFirstName},\n\n${vendor.name} has been approved as a vendor (vendor code ${vendor.code}). Welcome aboard.` });
    await pushLater(tenantId, vendorId, 'CREATE');
    return { status: 'APPROVED' as const };
  }

  await db.update(approvalSteps).set({ status: 'CANCELLED' })
    .where(and(eq(approvalSteps.vendorId, vendorId), eq(approvalSteps.cycle, vendor.reviewCycle), eq(approvalSteps.status, 'WAITING')));
  if (action === 'SEND_BACK') {
    await setVendor(tenantId, vendorId, { status: 'SENT_BACK' });
    await sendMail({ tenantId, to: vendor.contactEmail, subject: 'Corrections needed on your vendor registration',
      body: `Dear ${vendor.contactFirstName},\n\nOur ${current.label} team has asked for changes before approving ${vendor.name}:\n\n"${remarks}"\n\nPlease sign in, update the form and submit again.`, link: vendorLink });
    return { status: 'SENT_BACK' as const };
  }
  await setVendor(tenantId, vendorId, { status: 'REJECTED', decidedAt: now });
  await sendMail({ tenantId, to: vendor.contactEmail, subject: 'Update on your vendor registration',
    body: `Dear ${vendor.contactFirstName},\n\nWe are unable to approve ${vendor.name} as a vendor at this time.\n\nReason: ${remarks}` });
  return { status: 'REJECTED' as const };
}

/** Assign the pending step to one person (or back to the whole role with userId = null). */
export async function reassign(tenantId: string, vendorId: string, stepId: string, userId: string | null, actor: { name: string }, ip?: string) {
  const { vendor, current } = await loadReview(tenantId, vendorId);
  if (!current || current.id !== stepId) throw new HttpError(409, 'Only the current pending step can be reassigned');
  let assigneeName = 'the whole role';
  if (userId) {
    const u = await db.query.users.findFirst({ where: and(eq(users.id, userId), eq(users.tenantId, tenantId), eq(users.status, 'ACTIVE')) });
    if (!u) throw new HttpError(400, 'Choose an active user in this workspace');
    assigneeName = u.name;
  }
  const [s] = await db.update(approvalSteps).set({ assigneeUserId: userId, remindedAt: null }).where(eq(approvalSteps.id, current.id)).returning();
  await audit({ tenantId, vendorId, actor: actor.name, action: 'STEP_REASSIGNED', detail: { label: current.label, to: assigneeName }, ip });
  await notifyStep(s, vendor, 'Assigned to you');
  return { assignee: assigneeName };
}

/** Users who could be picked as assignee: anyone active (holding the role is not required — e.g. a senior stepping in). */
export async function assignableUsers(tenantId: string, roleId: string) {
  const all = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.status, 'ACTIVE')));
  const holders = new Set((await db.select({ id: userRoles.userId }).from(userRoles).where(eq(userRoles.roleId, roleId))).map((r) => r.id));
  return all.map((u) => ({ ...u, holdsRole: holders.has(u.id) })).sort((a, b) => Number(b.holdsRole) - Number(a.holdsRole) || a.name.localeCompare(b.name));
}

/**
 * SLA sweep: for each overdue pending step not yet reminded, remind the approvers and
 * escalate to users with approvals.manage. Runs every few minutes from index.ts.
 */
export async function sweepOverdue(now = new Date()) {
  const overdue = await db.select().from(approvalSteps).where(and(eq(approvalSteps.status, 'PENDING'), lt(approvalSteps.dueAt, now), isNull(approvalSteps.remindedAt)));
  for (const step of overdue) {
    const vendor = await db.query.vendors.findFirst({ where: eq(vendors.id, step.vendorId) });
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, step.tenantId) });
    if (!vendor || tenant?.status !== 'ACTIVE') continue;
    await notifyStep(step, vendor, 'OVERDUE');
    const managers = await db.select({ name: users.name, email: users.email, permissions: roles.permissions })
      .from(userRoles).innerJoin(users, eq(users.id, userRoles.userId)).innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(and(eq(users.tenantId, step.tenantId), eq(users.status, 'ACTIVE')));
    const seen = new Set<string>();
    for (const m of managers) {
      if (!m.permissions.includes('approvals.manage') || seen.has(m.email)) continue;
      seen.add(m.email);
      await sendMail({ tenantId: step.tenantId, to: m.email, subject: `Escalation: ${step.label} overdue for ${vendor.name}`,
        body: `Hello ${m.name},\n\n${step.label} for ${vendor.name} (${vendor.code}) passed its deadline. You can reassign it from the vendor page.`, link: vendorUrl(vendor.id) });
    }
    await db.update(approvalSteps).set({ remindedAt: now }).where(eq(approvalSteps.id, step.id));
    await audit({ tenantId: step.tenantId, vendorId: vendor.id, actor: 'system', action: 'STEP_OVERDUE', detail: { label: step.label } });
  }
  if (overdue.length) logger.info({ count: overdue.length }, 'SLA reminders sent');
  return overdue.length;
}


defineJob('sla.sweep', async () => { await sweepOverdue(); await sweepOverdueChanges(); }, { retryLimit: 0, expireInSeconds: 240 });
