import { and, asc, eq } from 'drizzle-orm';
import { db, schema } from './db.js';
import type { Role, User, Vendor } from '../db/schema.js';

const { vendors, approvalSteps, users: usersT } = schema;
const setVendor = (id: string, data: Partial<Vendor>) => db.update(vendors).set(data).where(eq(vendors.id, id));
import { levelsFor, roleLabels } from '../config/workflow.js';
import { audit } from './audit.js';
import { sendMail } from './mailer.js';
import { env } from './env.js';
import { HttpError } from './http.js';

async function notifyRole(role: Role, vendor: Vendor, stepLabel: string) {
  const users = await db.select().from(usersT).where(eq(usersT.role, role));
  const link = `${env.appBaseUrl}/staff/vendors/${vendor.id}`;
  for (const u of users) {
    await sendMail(u.email, `Action needed: ${stepLabel} for ${vendor.name}`,
      `Hello ${u.name},\n\n${vendor.name} (${vendor.code}) is waiting for your ${stepLabel}.\nOpen the vendor to approve, send back or reject.`, link);
  }
}

export async function startReview(vendor: Vendor) {
  const levels = levelsFor(vendor.vendorType);
  const cycle = vendor.reviewCycle + 1;
  await db.transaction(async (tx) => {
    await tx.insert(approvalSteps).values(
      levels.map((l, i) => ({ vendorId: vendor.id, cycle, level: i + 1, role: l.role, label: l.label, status: i === 0 ? ('PENDING' as const) : ('WAITING' as const) })),
    );
    await tx.update(vendors).set({ status: 'UNDER_REVIEW', reviewCycle: cycle, submittedAt: new Date() }).where(eq(vendors.id, vendor.id));
  });
  await notifyRole(levels[0].role, vendor, levels[0].label);
}

export type Decision = 'APPROVE' | 'SEND_BACK' | 'REJECT';

export async function decide(vendorId: string, user: Pick<User, 'id' | 'name' | 'role' | 'email'>, action: Decision, remarks: string) {
  const vendor = await db.query.vendors.findFirst({ where: eq(vendors.id, vendorId) });
  if (!vendor) throw new HttpError(404, 'Vendor not found');
  if (vendor.status !== 'UNDER_REVIEW') throw new HttpError(409, 'Vendor is not under review');
  const steps = await db.select().from(approvalSteps).where(and(eq(approvalSteps.vendorId, vendorId), eq(approvalSteps.cycle, vendor.reviewCycle))).orderBy(asc(approvalSteps.level));
  const current = steps.find((s) => s.status === 'PENDING');
  if (!current) throw new HttpError(409, 'No pending approval step');
  if (current.role !== user.role) throw new HttpError(403, `This step is waiting for the ${roleLabels[current.role]}`);
  if (action !== 'APPROVE' && !remarks.trim()) throw new HttpError(400, 'Remarks are required when sending back or rejecting');

  const now = new Date();
  const stepStatus = (action === 'APPROVE' ? 'APPROVED' : action === 'REJECT' ? 'REJECTED' : 'SENT_BACK') as 'APPROVED' | 'REJECTED' | 'SENT_BACK';
  // Guard against two reviewers acting on the same step at once.
  const claimed = await db.update(approvalSteps)
    .set({ status: stepStatus, remarks: remarks || null, actedById: user.id, actedAt: now })
    .where(and(eq(approvalSteps.id, current.id), eq(approvalSteps.status, 'PENDING')))
    .returning({ id: approvalSteps.id });
  if (claimed.length === 0) throw new HttpError(409, 'This step was already actioned by someone else — refresh the page');
  await audit(vendorId, user.name, `STEP_${stepStatus}`, { level: current.level, label: current.label, remarks });

  const vendorLink = `${env.appBaseUrl}/onboard/${vendor.inviteToken}`;
  if (action === 'APPROVE') {
    const next = steps.find((s) => s.level === current.level + 1);
    if (next) {
      await db.update(approvalSteps).set({ status: 'PENDING' }).where(eq(approvalSteps.id, next.id));
      await notifyRole(next.role, vendor, next.label);
      return { status: 'UNDER_REVIEW' as const, nextLevel: next.label };
    }
    await setVendor(vendorId, { status: 'APPROVED', decidedAt: now });
    await audit(vendorId, 'system', 'VENDOR_APPROVED');
    await sendMail(vendor.contactEmail, 'Your vendor registration is approved',
      `Dear ${vendor.contactFirstName},\n\n${vendor.name} has been approved as a vendor (vendor code ${vendor.code}). Welcome aboard.`);
    return { status: 'APPROVED' as const };
  }

  // Send back / reject: cancel the remaining levels of this cycle.
  await db.update(approvalSteps).set({ status: 'CANCELLED' })
    .where(and(eq(approvalSteps.vendorId, vendorId), eq(approvalSteps.cycle, vendor.reviewCycle), eq(approvalSteps.status, 'WAITING')));
  if (action === 'SEND_BACK') {
    await setVendor(vendorId, { status: 'SENT_BACK' });
    await sendMail(vendor.contactEmail, 'Corrections needed on your vendor registration',
      `Dear ${vendor.contactFirstName},\n\nOur ${current.label} team has asked for changes before approving ${vendor.name}:\n\n"${remarks}"\n\nPlease sign in, update the form and submit again.`, vendorLink);
    return { status: 'SENT_BACK' as const };
  }
  await setVendor(vendorId, { status: 'REJECTED', decidedAt: now });
  await sendMail(vendor.contactEmail, 'Update on your vendor registration',
    `Dear ${vendor.contactFirstName},\n\nWe are unable to approve ${vendor.name} as a vendor at this time.\n\nReason: ${remarks}`);
  return { status: 'REJECTED' as const };
}
