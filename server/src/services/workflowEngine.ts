import { and, asc, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import type { Vendor } from '../db/schema.js';
import { levelsFor } from '../config/workflow.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';
import { env } from '../lib/env.js';
import { HttpError } from '../lib/http.js';

const { vendors, approvalSteps, users, userRoles, roles } = schema;
const setVendor = (tenantId: string, id: string, data: Partial<Vendor>) =>
  db.update(vendors).set(data).where(and(eq(vendors.tenantId, tenantId), eq(vendors.id, id)));

async function notifyRole(tenantId: string, roleId: string, vendor: Vendor, stepLabel: string) {
  const recipients = await db.select({ name: users.name, email: users.email })
    .from(userRoles).innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.roleId, roleId), eq(users.tenantId, tenantId), eq(users.status, 'ACTIVE')));
  const link = `${env.appBaseUrl}/staff/vendors/${vendor.id}`;
  for (const u of recipients) {
    await sendMail({ tenantId, to: u.email, subject: `Action needed: ${stepLabel} for ${vendor.name}`,
      body: `Hello ${u.name},\n\n${vendor.name} (${vendor.code}) is waiting for your ${stepLabel}.\nOpen the vendor to approve, send back or reject.`, link });
  }
}

export async function startReview(vendor: Vendor) {
  const levels = levelsFor(vendor.vendorType);
  const tenantRoles = await db.select().from(roles).where(eq(roles.tenantId, vendor.tenantId));
  const resolved = levels.map((l) => {
    const role = tenantRoles.find((r) => r.key === l.roleKey);
    if (!role) throw new HttpError(500, `Approval level "${l.label}" refers to role ${l.roleKey}, which doesn't exist in this workspace`);
    return { ...l, roleId: role.id };
  });
  const cycle = vendor.reviewCycle + 1;
  await db.transaction(async (tx) => {
    await tx.insert(approvalSteps).values(resolved.map((l, i) => ({
      tenantId: vendor.tenantId, vendorId: vendor.id, cycle, level: i + 1, roleId: l.roleId, label: l.label,
      status: i === 0 ? ('PENDING' as const) : ('WAITING' as const),
    })));
    await tx.update(vendors).set({ status: 'UNDER_REVIEW', reviewCycle: cycle, submittedAt: new Date() }).where(eq(vendors.id, vendor.id));
  });
  await notifyRole(vendor.tenantId, resolved[0].roleId, vendor, resolved[0].label);
}

export type Decision = 'APPROVE' | 'SEND_BACK' | 'REJECT';

export async function decide(tenantId: string, vendorId: string, actor: { id: string; name: string; roleIds: Set<string> }, action: Decision, remarks: string, ip?: string) {
  const vendor = await db.query.vendors.findFirst({ where: and(eq(vendors.tenantId, tenantId), eq(vendors.id, vendorId)) });
  if (!vendor) throw new HttpError(404, 'Vendor not found');
  if (vendor.status !== 'UNDER_REVIEW') throw new HttpError(409, 'Vendor is not under review');
  const steps = await db.select().from(approvalSteps)
    .where(and(eq(approvalSteps.tenantId, tenantId), eq(approvalSteps.vendorId, vendorId), eq(approvalSteps.cycle, vendor.reviewCycle)))
    .orderBy(asc(approvalSteps.level));
  const current = steps.find((s) => s.status === 'PENDING');
  if (!current) throw new HttpError(409, 'No pending approval step');
  if (!actor.roleIds.has(current.roleId)) throw new HttpError(403, `This step (${current.label}) is assigned to a role you don’t hold`);
  if (action !== 'APPROVE' && !remarks.trim()) throw new HttpError(400, 'Remarks are required when sending back or rejecting');

  const now = new Date();
  const stepStatus = (action === 'APPROVE' ? 'APPROVED' : action === 'REJECT' ? 'REJECTED' : 'SENT_BACK') as 'APPROVED' | 'REJECTED' | 'SENT_BACK';
  // Guard against two reviewers acting on the same step at once.
  const claimed = await db.update(approvalSteps)
    .set({ status: stepStatus, remarks: remarks || null, actedById: actor.id, actedAt: now })
    .where(and(eq(approvalSteps.id, current.id), eq(approvalSteps.status, 'PENDING')))
    .returning({ id: approvalSteps.id });
  if (claimed.length === 0) throw new HttpError(409, 'This step was already actioned by someone else — refresh the page');
  await audit({ tenantId, vendorId, actor: actor.name, action: `STEP_${stepStatus}`, detail: { level: current.level, label: current.label, remarks }, ip });

  const vendorLink = `${env.appBaseUrl}/onboard/${vendor.inviteToken}`;
  if (action === 'APPROVE') {
    const next = steps.find((s) => s.level === current.level + 1);
    if (next) {
      await db.update(approvalSteps).set({ status: 'PENDING' }).where(eq(approvalSteps.id, next.id));
      await notifyRole(tenantId, next.roleId, vendor, next.label);
      return { status: 'UNDER_REVIEW' as const, nextLevel: next.label };
    }
    await setVendor(tenantId, vendorId, { status: 'APPROVED', decidedAt: now });
    await audit({ tenantId, vendorId, actor: 'system', action: 'VENDOR_APPROVED' });
    await sendMail({ tenantId, to: vendor.contactEmail, subject: 'Your vendor registration is approved',
      body: `Dear ${vendor.contactFirstName},\n\n${vendor.name} has been approved as a vendor (vendor code ${vendor.code}). Welcome aboard.` });
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
