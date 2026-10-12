/**
 * After approval: change requests (with routed re-approval), document expiry, periodic
 * re-verification, block / unblock, and the "needs attention" flags derived from all of that.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte } from 'drizzle-orm';
import { defineJob } from '../jobs/queue.js';
import { db, schema } from '../lib/db.js';
import type { ChangeRequest, ChangeRequestStep, DocumentRow, Vendor } from '../db/schema.js';
import { HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { getPublished } from './config.js';
import { approverIds, directApprovers, emailsFor, usersWithPermission } from './approvers.js';
export { usersWithPermission } from './approvers.js';
import { buildChecklist, isSubmittable, sanitizeSection, type Profile } from '../lib/profileEngine.js';
import { runKyc } from '../integrations/kyc/index.js';
import { allChecks, checkInputs } from '../countries/registry.js';
import { pushLater } from '../integrations/erp/index.js';
import type { OnboardingConfig } from '../config/types.js';

const { vendors, documents, changeRequests, changeRequestSteps, roles, tenants, users, userRoles } = schema;
const DAY = 86_400_000;
const vendorUrl = (id: string) => `${env.appBaseUrl}/staff/vendors/${id}`;
const portalUrl = (v: Pick<Vendor, 'inviteToken'>) => `${env.appBaseUrl}/onboard/${v.inviteToken}`;
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));

/* ======================= Change requests ======================= */

/** Which approval levels must sign off, given the fields (and "documents") touched. */
export function levelsForChange(cfg: OnboardingConfig, touched: string[]) {
  const levels = cfg.workflow.levels;
  const known = new Set(levels.map((l) => l.id));
  const ch = cfg.workflow.changes ?? { rules: [], defaultLevelIds: [] };
  const matches = (pattern: string, id: string) => pattern === id || (pattern.endsWith('.*') && id.startsWith(pattern.slice(0, -1)));
  const ids = new Set<string>();
  for (const r of ch.rules) if (touched.some((t) => r.match.some((m) => matches(m, t)))) r.levelIds.forEach((x) => ids.add(x));
  if (!ids.size) ch.defaultLevelIds.forEach((x) => ids.add(x));
  let picked = levels.filter((l) => ids.has(l.id) && known.has(l.id));
  if (!picked.length) picked = levels.slice(-1); // safety net: the final approval level always reviews changes
  return picked;
}

const SENSITIVE = (id: string) => id.startsWith('bank.') || ['tax.gstin', 'tax.pan', 'basic.vendorName'].includes(id);

async function notifyStep(step: Pick<ChangeRequestStep, 'tenantId' | 'roleId' | 'assigneeUserId' | 'label' | 'dueAt'>, vendor: Vendor, prefix = 'Action needed') {
  for (const u of await emailsFor(await approverIds(step))) {
    await sendMail({ tenantId: vendor.tenantId, to: u.email, subject: `${prefix}: change request from ${vendor.name} (${step.label})`,
      body: `Hello ${u.name},\n\n${vendor.name} (${vendor.code}) has asked to change their registered details. Please review the old and new values and approve or reject.`, link: vendorUrl(vendor.id) });
  }
}

async function activate(step: ChangeRequestStep, vendor: Vendor) {
  const now = new Date();
  const [s] = await db.update(changeRequestSteps).set({ status: 'PENDING', activatedAt: now, dueAt: step.slaHours ? new Date(now.getTime() + step.slaHours * 3600_000) : null })
    .where(eq(changeRequestSteps.id, step.id)).returning();
  await notifyStep(s, vendor);
}

export async function openChangeRequest(vendorId: string) {
  return db.query.changeRequests.findFirst({ where: and(eq(changeRequests.vendorId, vendorId), eq(changeRequests.status, 'PENDING')) });
}

/** `by` = a staff member proposing the change on the vendor's behalf; omitted = the vendor's own request. */
export async function submitChangeRequest(vendor: Vendor, input: { changes: Record<string, Record<string, unknown>>; note?: string }, ip?: string, by?: { id: string; name: string }) {
  if (vendor.status !== 'APPROVED') throw new HttpError(409, by ? 'Only approved vendors can be changed this way. Use the onboarding review instead.' : 'Change requests are for approved vendors. Edit the form directly instead.');
  if (vendor.blockedAt && !by) throw new HttpError(409, 'Your vendor account is on hold. Please contact the buyer.');
  if (by && !input.note?.trim()) throw new HttpError(400, 'Give a reason for the change (e.g. “Vendor emailed a new cancelled cheque on 3 Oct”).');
  if (await openChangeRequest(vendor.id)) throw new HttpError(409, by ? 'This vendor already has a change request waiting for review. Wait for it to be decided or withdrawn first.' : 'You already have a change request waiting for review. Cancel it or wait for a decision first.');
  const { config } = await getPublished(vendor.tenantId);
  const current = vendor.profile as Profile;
  const proposed: Profile = structuredClone(current);
  const labels = new Map(config.sections.flatMap((s) => s.groups.flatMap((g) => g.fields.map((f) => [`${s.key}.${f.key}`, f.label] as [string, string]))));
  const diff: ChangeRequest['changes'] = [];
  for (const [sec, values] of Object.entries(input.changes ?? {})) {
    const clean = sanitizeSection(config, sec, values ?? {});
    for (const [k, v] of Object.entries(clean)) {
      if (str(current[sec]?.[k]).trim() === str(v).trim()) continue;
      diff.push({ fieldId: `${sec}.${k}`, label: labels.get(`${sec}.${k}`) ?? k, old: str(current[sec]?.[k]), new: str(v) });
      proposed[sec] = { ...(proposed[sec] ?? {}), [k]: v };
    }
  }
  // Each side only submits its own uploads: the vendor's unsent files never ride along on a staff proposal, and vice versa.
  const pendingDocs = await db.select().from(documents).where(and(eq(documents.vendorId, vendor.id), eq(documents.status, 'PENDING'), isNull(documents.changeRequestId),
    by ? eq(documents.uploadedById, by.id) : isNull(documents.uploadedById)));
  if (!diff.length && !pendingDocs.length) throw new HttpError(400, 'Nothing has changed. Edit a value or upload a renewed document first.');

  // The changed profile must still be complete and valid (documents: current active + newly uploaded).
  const active = await db.select({ docType: documents.docType }).from(documents).where(and(eq(documents.vendorId, vendor.id), eq(documents.status, 'ACTIVE')));
  const checklist = buildChecklist(config, proposed, [...active, ...pendingDocs].map((d) => d.docType), vendor.vendorType);
  const relevant = checklist.filter((c) => !c.ok && c.severity === 'error' && (diff.some((d) => d.fieldId === c.id) || c.id.startsWith('doc.') || c.id.startsWith('cross.')));
  if (relevant.length) throw new HttpError(422, 'Some changed values need fixing', relevant);

  const touched = [...diff.map((d) => d.fieldId), ...(pendingDocs.length ? ['documents'] : [])];
  const levels = levelsForChange(config, touched);
  const tenantRoles = await db.select().from(roles).where(eq(roles.tenantId, vendor.tenantId));
  const sensitive = diff.some((d) => SENSITIVE(d.fieldId));

  const { cr, steps } = await db.transaction(async (tx) => {
    const [cr] = await tx.insert(changeRequests).values({ tenantId: vendor.tenantId, vendorId: vendor.id, changes: diff, documentIds: pendingDocs.map((d) => d.id), note: input.note?.slice(0, 1000) || null, sensitive, raisedById: by?.id ?? null }).returning();
    if (pendingDocs.length) await tx.update(documents).set({ changeRequestId: cr.id }).where(inArray(documents.id, pendingDocs.map((d) => d.id)));
    const steps = await tx.insert(changeRequestSteps).values(levels.map((l, i) => {
      const role = tenantRoles.find((r) => r.key === l.roleKey);
      if (!role) throw new HttpError(500, `Approval level “${l.label}” refers to a role that no longer exists`);
      return { tenantId: vendor.tenantId, changeRequestId: cr.id, level: i + 1, roleId: role.id, label: l.label, slaHours: l.slaHours ?? null, status: 'WAITING' as const };
    })).returning();
    return { cr, steps };
  });
  await audit({ tenantId: vendor.tenantId, vendorId: vendor.id, actor: by?.name ?? vendor.contactEmail, action: by ? 'CHANGE_PROPOSED' : 'CHANGE_REQUESTED', detail: { fields: diff.map((d) => d.fieldId).join(', '), documents: pendingDocs.length, ...(by ? { reason: input.note } : {}) }, ip });
  if (by) {
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, vendor.tenantId) });
    await sendMail({ tenantId: vendor.tenantId, to: vendor.contactEmail, subject: `${tenant?.name ?? 'Your buyer'} is updating your registered details`,
      body: `Dear ${vendor.contactFirstName},\n\n${tenant?.name ?? 'Your buyer'} has proposed an update to ${vendor.name}'s registered details:\n\n${diff.map((d) => `- ${d.label}`).join('\n') || '- New / renewed documents'}\n\nReason: ${input.note}\n\nIt will take effect after internal approval. If this is not expected, reply to this email or contact the buyer.`, link: portalUrl(vendor) });
  }

  // Fraud controls for bank changes: run a penny-drop on the new account and alert the registered contact.
  if (diff.some((d) => d.fieldId.startsWith('bank.'))) {
    for (const { def } of allChecks().filter((c) => c.def.onBankChange)) {
      const input = checkInputs(def, proposed as Profile);
      if (!Object.values(input).every(Boolean)) continue;
      await runKyc({ ...vendor, profile: proposed }, def.kind, input, 'system (bank change)').catch((e) => logger.warn({ err: e }, 'bank check on change failed'));
    }
    await sendMail({ tenantId: vendor.tenantId, to: vendor.contactEmail, subject: 'Security notice: bank details change requested',
      body: `Dear ${vendor.contactFirstName},\n\nA request to change the bank account registered for ${vendor.name} was submitted on the supplier portal. It will only take effect after review.\n\nIf you did not make this request, reply to this email or contact the buyer immediately.`, link: portalUrl(vendor) });
  }
  await activate(steps[0], vendor);
  return cr;
}

async function loadCr(tenantId: string, crId: string) {
  const cr = await db.query.changeRequests.findFirst({ where: and(eq(changeRequests.tenantId, tenantId), eq(changeRequests.id, crId)) });
  if (!cr) throw new HttpError(404, 'Change request not found');
  const vendor = await db.query.vendors.findFirst({ where: eq(vendors.id, cr.vendorId) });
  const steps = await db.select().from(changeRequestSteps).where(eq(changeRequestSteps.changeRequestId, cr.id)).orderBy(asc(changeRequestSteps.level));
  return { cr, vendor: vendor!, steps, current: steps.find((s) => s.status === 'PENDING') };
}

export async function decideChange(tenantId: string, crId: string, actor: { id: string; name: string }, action: 'APPROVE' | 'REJECT', remarks: string, ip?: string) {
  const { cr, vendor, steps, current } = await loadCr(tenantId, crId);
  if (cr.status !== 'PENDING' || !current) throw new HttpError(409, 'This change request is no longer waiting for review');
  if (!(await approverIds(current)).has(actor.id)) throw new HttpError(403, `This step (${current.label}) is assigned to someone else`);
  if (cr.raisedById === actor.id) throw new HttpError(403, 'You proposed this change, so someone else has to approve it');
  if (action === 'REJECT' && !remarks.trim()) throw new HttpError(400, 'Give a reason when rejecting a change');
  const now = new Date();
  const claimed = await db.update(changeRequestSteps).set({ status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED', remarks: remarks || null, actedById: actor.id, actedAt: now })
    .where(and(eq(changeRequestSteps.id, current.id), eq(changeRequestSteps.status, 'PENDING'))).returning({ id: changeRequestSteps.id });
  if (!claimed.length) throw new HttpError(409, 'Someone else just actioned this step — refresh the page');
  const asDelegate = !(await directApprovers(current)).includes(actor.id);
  await audit({ tenantId, vendorId: vendor.id, actor: actor.name, action: action === 'APPROVE' ? 'CHANGE_STEP_APPROVED' : 'CHANGE_REJECTED', detail: { level: current.label, remarks, ...(asDelegate ? { as: 'delegate' } : {}) }, ip });

  if (action === 'REJECT') {
    await db.update(changeRequestSteps).set({ status: 'CANCELLED' }).where(and(eq(changeRequestSteps.changeRequestId, cr.id), eq(changeRequestSteps.status, 'WAITING')));
    await db.update(changeRequests).set({ status: 'REJECTED', remarks, decidedAt: now }).where(eq(changeRequests.id, cr.id));
    await db.update(documents).set({ status: 'REJECTED' }).where(eq(documents.changeRequestId, cr.id));
    if (!cr.raisedById) await sendMail({ tenantId, to: vendor.contactEmail, subject: 'Your change request was not approved',
      body: `Dear ${vendor.contactFirstName},\n\nYour requested change to ${vendor.name}'s details was not approved.\n\nReason: ${remarks}\n\nYour existing details remain in effect.`, link: portalUrl(vendor) });
    return { status: 'REJECTED' as const };
  }
  const next = steps.find((s) => s.level === current.level + 1);
  if (next) { await activate(next, vendor); return { status: 'PENDING' as const, nextLevel: next.label }; }
  await applyChange(cr, vendor);
  await db.update(changeRequests).set({ status: 'APPROVED', remarks: remarks || null, decidedAt: now }).where(eq(changeRequests.id, cr.id));
  await audit({ tenantId, vendorId: vendor.id, actor: 'system', action: 'CHANGE_APPLIED', detail: { fields: cr.changes.map((c) => c.fieldId).join(', ') } });
  await sendMail({ tenantId, to: vendor.contactEmail, subject: cr.raisedById ? 'Your registered details have been updated' : 'Your change request was approved',
    body: cr.raisedById
      ? `Dear ${vendor.contactFirstName},\n\nThe update to ${vendor.name}'s registered details is now in effect:\n\n${cr.changes.map((c) => `- ${c.label}`).join('\n') || '- New / renewed documents'}\n\nIf anything looks wrong, contact the buyer.`
      : `Dear ${vendor.contactFirstName},\n\nThe changes you requested to ${vendor.name}'s details have been approved and are now in effect.` });
  return { status: 'APPROVED' as const };
}

async function applyChange(cr: ChangeRequest, vendor: Vendor) {
  const fresh = await db.query.vendors.findFirst({ where: eq(vendors.id, vendor.id) });
  const profile = structuredClone((fresh ?? vendor).profile as Profile);
  for (const c of cr.changes) { const [s, k] = c.fieldId.split('.'); profile[s] = { ...(profile[s] ?? {}), [k]: c.new }; }
  const name = cr.changes.find((c) => c.fieldId === 'basic.vendorName')?.new;
  await db.update(vendors).set({ profile, ...(name ? { name } : {}) }).where(eq(vendors.id, vendor.id));
  // New documents replace older ACTIVE ones of the same type.
  const newDocs = await db.select().from(documents).where(eq(documents.changeRequestId, cr.id));
  for (const d of newDocs) {
    await db.update(documents).set({ status: 'SUPERSEDED', supersededAt: new Date() })
      .where(and(eq(documents.vendorId, vendor.id), eq(documents.docType, d.docType), eq(documents.status, 'ACTIVE')));
  }
  if (newDocs.length) await db.update(documents).set({ status: 'ACTIVE' }).where(inArray(documents.id, newDocs.map((d) => d.id)));
  // Documents alone don't change anything the ERP holds.
  if (cr.changes.length) await pushLater(vendor.tenantId, vendor.id, 'UPDATE');
}

export async function cancelChangeRequest(vendor: Vendor, crId: string, ip?: string) {
  const cr = await db.query.changeRequests.findFirst({ where: and(eq(changeRequests.id, crId), eq(changeRequests.vendorId, vendor.id)) });
  if (!cr || cr.status !== 'PENDING') throw new HttpError(409, 'This change request can no longer be cancelled');
  if (cr.raisedById) throw new HttpError(409, 'This change was proposed by the buyer. Contact them if it is not right.');
  await withdraw(cr.id);
  await audit({ tenantId: vendor.tenantId, vendorId: vendor.id, actor: vendor.contactEmail, action: 'CHANGE_CANCELLED', ip });
}

/** Staff withdraw a proposal they raised (or anyone with approvals.manage). */
export async function cancelStaffChange(tenantId: string, crId: string, actor: { id: string; name: string; canManage: boolean }, ip?: string) {
  const { cr, vendor } = await loadCr(tenantId, crId);
  if (cr.status !== 'PENDING') throw new HttpError(409, 'This change request can no longer be withdrawn');
  if (!cr.raisedById) throw new HttpError(409, 'Only the vendor can withdraw their own request. Reject it instead.');
  if (cr.raisedById !== actor.id && !actor.canManage) throw new HttpError(403, 'Only the person who proposed this change can withdraw it');
  await withdraw(cr.id);
  // Staff-uploaded files of a withdrawn proposal are dropped rather than left pending.
  await db.update(documents).set({ status: 'REJECTED' }).where(and(eq(documents.vendorId, vendor.id), eq(documents.status, 'PENDING'), isNull(documents.changeRequestId), eq(documents.uploadedById, cr.raisedById)));
  await audit({ tenantId, vendorId: vendor.id, actor: actor.name, action: 'CHANGE_WITHDRAWN', ip });
}

async function withdraw(crId: string) {
  const cr = { id: crId };
  await db.update(changeRequests).set({ status: 'CANCELLED', decidedAt: new Date() }).where(eq(changeRequests.id, cr.id));
  await db.update(changeRequestSteps).set({ status: 'CANCELLED' }).where(and(eq(changeRequestSteps.changeRequestId, cr.id), inArray(changeRequestSteps.status, ['PENDING', 'WAITING'])));
  // Uploaded documents go back to "pending, not yet submitted" so they can be re-used or removed.
  await db.update(documents).set({ changeRequestId: null }).where(eq(documents.changeRequestId, cr.id));
}

export async function reassignChangeStep(tenantId: string, crId: string, stepId: string, userId: string | null, actor: { name: string }, ip?: string) {
  const { vendor, current } = await loadCr(tenantId, crId);
  if (!current || current.id !== stepId) throw new HttpError(409, 'Only the current pending step can be reassigned');
  let to = 'the whole role';
  if (userId) {
    const u = await db.query.users.findFirst({ where: and(eq(users.id, userId), eq(users.tenantId, tenantId), eq(users.status, 'ACTIVE')) });
    if (!u) throw new HttpError(400, 'Choose an active user in this workspace');
    to = u.name;
  }
  const [s] = await db.update(changeRequestSteps).set({ assigneeUserId: userId, remindedAt: null }).where(eq(changeRequestSteps.id, current.id)).returning();
  await audit({ tenantId, vendorId: vendor.id, actor: actor.name, action: 'CHANGE_STEP_REASSIGNED', detail: { label: current.label, to }, ip });
  await notifyStep(s, vendor, 'Assigned to you');
  return { assignee: to };
}

/** Change requests with steps, for a vendor (staff view) or a whole queue. */
export async function changeRequestsForVendor(vendorId: string) {
  return db.query.changeRequests.findMany({
    where: eq(changeRequests.vendorId, vendorId), orderBy: desc(changeRequests.createdAt), limit: 20,
    with: { raisedBy: { columns: { id: true, name: true } }, steps: { orderBy: asc(changeRequestSteps.level), with: { actedBy: { columns: { name: true } }, assignee: { columns: { name: true } }, role: { columns: { name: true } } } } },
  });
}

export async function sweepOverdueChanges(now = new Date()) {
  const overdue = await db.select().from(changeRequestSteps).where(and(eq(changeRequestSteps.status, 'PENDING'), lt(changeRequestSteps.dueAt, now), isNull(changeRequestSteps.remindedAt)));
  for (const step of overdue) {
    const cr = await db.query.changeRequests.findFirst({ where: eq(changeRequests.id, step.changeRequestId) });
    const vendor = cr && await db.query.vendors.findFirst({ where: eq(vendors.id, cr.vendorId) });
    if (vendor) await notifyStep(step, vendor, 'OVERDUE');
    await db.update(changeRequestSteps).set({ remindedAt: now }).where(eq(changeRequestSteps.id, step.id));
  }
  return overdue.length;
}

/* ======================= Block / unblock ======================= */

export async function setBlocked(tenantId: string, vendorId: string, block: boolean, reason: string, actor: { id: string; name: string }, notifyVendor: boolean, ip?: string) {
  const v = await db.query.vendors.findFirst({ where: and(eq(vendors.tenantId, tenantId), eq(vendors.id, vendorId)) });
  if (!v) throw new HttpError(404, 'Vendor not found');
  if (v.status !== 'APPROVED') throw new HttpError(409, 'Only approved vendors can be blocked. Reject or leave the registration instead.');
  if (!reason.trim()) throw new HttpError(400, 'Give a reason — it goes in the audit log');
  if (block === !!v.blockedAt) throw new HttpError(409, block ? 'Vendor is already blocked' : 'Vendor is not blocked');
  await db.update(vendors).set(block ? { blockedAt: new Date(), blockedReason: reason, blockedById: actor.id } : { blockedAt: null, blockedReason: null, blockedById: null }).where(eq(vendors.id, v.id));
  await audit({ tenantId, vendorId, actor: actor.name, action: block ? 'VENDOR_BLOCKED' : 'VENDOR_UNBLOCKED', detail: { reason }, ip });
  await pushLater(tenantId, vendorId, block ? 'BLOCK' : 'UNBLOCK', actor.name);
  if (notifyVendor) {
    await sendMail({ tenantId, to: v.contactEmail, subject: block ? 'Your vendor account has been put on hold' : 'Your vendor account is active again',
      body: block ? `Dear ${v.contactFirstName},\n\n${v.name}'s vendor account has been put on hold. New orders and payments may be paused.\n\nReason: ${reason}\n\nPlease contact us if you have questions.`
        : `Dear ${v.contactFirstName},\n\n${v.name}'s vendor account is active again.` });
  }
}

/* ======================= Document expiry ======================= */

export const daysUntil = (iso: string, now = new Date()) => Math.floor((new Date(`${iso}T00:00:00Z`).getTime() - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / DAY);

/** Sends 30-day, 7-day and "expired" reminders once each, to the vendor and the buyer's vendor admins. */
export async function runExpiryReminders(now = new Date()) {
  const horizon = new Date(now.getTime() + 31 * DAY).toISOString().slice(0, 10);
  const docs = await db.select().from(documents).where(and(eq(documents.status, 'ACTIVE'), isNotNull(documents.expiresOn), lte(documents.expiresOn, horizon)));
  let sent = 0;
  for (const d of docs) {
    const days = daysUntil(d.expiresOn!, now);
    const flag = days < 0 ? 4 : days <= 7 ? 2 : days <= 30 ? 1 : 0;
    if (!flag || (d.expiryNotified & flag)) continue;
    const v = await db.query.vendors.findFirst({ where: eq(vendors.id, d.vendorId) });
    if (!v || v.status !== 'APPROVED') continue;
    const { config } = await getPublished(v.tenantId);
    const label = config.documents.find((x) => x.type === d.docType)?.label ?? d.docType;
    const when = days < 0 ? `expired on ${d.expiresOn}` : `expires on ${d.expiresOn} (${days} day${days === 1 ? '' : 's'})`;
    await sendMail({ tenantId: v.tenantId, to: v.contactEmail, subject: `${days < 0 ? 'Expired' : 'Expiring soon'}: ${label}`,
      body: `Dear ${v.contactFirstName},\n\nThe ${label} on file for ${v.name} ${when}. Please sign in and upload the renewed document so your account stays active.`, link: portalUrl(v) });
    if (flag >= 2) {
      const admins = await usersWithPermission(v.tenantId, 'vendors.create');
      for (const a of admins) await sendMail({ tenantId: v.tenantId, to: a.email, subject: `${v.name}: ${label} ${days < 0 ? 'has expired' : 'expires soon'}`, body: `Hello ${a.name},\n\nThe ${label} for ${v.name} (${v.code}) ${when}. The vendor has been reminded.`, link: vendorUrl(v.id) });
    }
    await db.update(documents).set({ expiryNotified: d.expiryNotified | flag | (flag === 4 ? 3 : flag === 2 ? 1 : 0) }).where(eq(documents.id, d.id));
    if (flag === 4) await audit({ tenantId: v.tenantId, vendorId: v.id, actor: 'system', action: 'DOCUMENT_EXPIRED', detail: { document: label, expiredOn: d.expiresOn } });
    sent++;
  }
  return sent;
}


/* ======================= Periodic re-verification ======================= */

export function nextReviewFrom(from: Date, months: number | undefined) {
  const m = months ?? 12;
  if (!m) return null;
  const d = new Date(from); d.setMonth(d.getMonth() + m);
  return d;
}

/** Re-run the automated checks for one approved vendor; flag ATTENTION on any failure or expired document. */
export async function reviewVendor(v: Vendor, requestedBy = 'system (periodic review)') {
  const p = v.profile as Profile;
  // Every online check whose inputs this vendor has filled in (GSTIN, PAN, CIN, bank for Indian suppliers).
  const plan: [string, Record<string, string>, string][] = [];
  for (const { def } of allChecks()) {
    const input = checkInputs(def, p);
    if (Object.values(input).every(Boolean)) plan.push([def.kind, input, def.label]);
  }
  const problems: string[] = [];
  for (const [kind, input, label] of plan) {
    try {
      const r = await runKyc(v, kind, input, requestedBy);
      if (r.status !== 'VERIFIED') problems.push(`${label}: ${r.message}`);
      else if (r.nameMatch !== null && r.nameMatch < 70) problems.push(`${label}: name on record “${r.nameOnRecord}” doesn’t match`);
    } catch (e: any) { problems.push(`${label}: ${e.message}`); }
  }
  const expired = await db.select({ docType: documents.docType, expiresOn: documents.expiresOn }).from(documents)
    .where(and(eq(documents.vendorId, v.id), eq(documents.status, 'ACTIVE'), isNotNull(documents.expiresOn), lt(documents.expiresOn, new Date().toISOString().slice(0, 10))));
  for (const d of expired) problems.push(`${d.docType} expired on ${d.expiresOn}`);
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, v.tenantId) });
  const now = new Date();
  const status = problems.length ? 'ATTENTION' : 'OK';
  await db.update(vendors).set({ lastReviewAt: now, nextReviewAt: nextReviewFrom(now, tenant?.settings.reKycMonths), reviewStatus: status, reviewNote: problems.join(' · ').slice(0, 1000) || null }).where(eq(vendors.id, v.id));
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: requestedBy, action: problems.length ? 'REVIEW_NEEDS_ATTENTION' : 'REVIEW_PASSED', detail: { checks: plan.length, problems: problems.join(' · ') } });
  if (problems.length) {
    for (const a of await usersWithPermission(v.tenantId, 'vendors.block')) {
      await sendMail({ tenantId: v.tenantId, to: a.email, subject: `Periodic review needs attention: ${v.name}`, body: `Hello ${a.name},\n\nThe periodic re-verification of ${v.name} (${v.code}) found:\n\n- ${problems.join('\n- ')}\n\nReview the vendor and decide whether to block it.`, link: vendorUrl(v.id) });
    }
  }
  if (requestedBy.startsWith('system')) {
    await sendMail({ tenantId: v.tenantId, to: v.contactEmail, subject: 'Please confirm your registered details', body: `Dear ${v.contactFirstName},\n\nAs part of our periodic review, please sign in and confirm that ${v.name}'s registered details (address, bank account, tax registrations) are still correct, or request a change if anything is out of date.`, link: portalUrl(v) });
  }
  return { status, problems };
}

export async function runPeriodicReviews(now = new Date(), limit = 200) {
  const due = await db.select().from(vendors).where(and(eq(vendors.status, 'APPROVED'), isNull(vendors.erasedAt), isNotNull(vendors.nextReviewAt), lte(vendors.nextReviewAt, now))).limit(limit);
  for (const v of due) {
    const t = await db.query.tenants.findFirst({ where: eq(tenants.id, v.tenantId) });
    if (t?.status !== 'ACTIVE') continue;
    await reviewVendor(v).catch((e) => logger.error({ err: e, vendor: v.id }, 'periodic review failed'));
  }
  return due.length;
}

/* ======================= "Needs attention" flags ======================= */

export interface Flag { code: 'ERASURE_REQUESTED' | 'BLOCKED' | 'DOC_EXPIRED' | 'DOC_EXPIRING' | 'CHANGE_PENDING' | 'REVIEW_ATTENTION' | 'REVIEW_DUE'; label: string; severity: 'high' | 'medium' | 'low' }

export function flagsFor(v: Pick<Vendor, 'status' | 'blockedAt' | 'reviewStatus' | 'nextReviewAt'> & { erasureRequestedAt?: Date | null }, docs: Pick<DocumentRow, 'status' | 'expiresOn' | 'docType'>[], hasOpenChange: boolean, now = new Date()): Flag[] {
  const flags: Flag[] = [];
  if (v.erasureRequestedAt) flags.push({ code: 'ERASURE_REQUESTED', label: 'Deletion requested', severity: 'high' });
  if (v.status !== 'APPROVED') return flags;
  if (v.blockedAt) flags.push({ code: 'BLOCKED', label: 'Blocked', severity: 'high' });
  const active = docs.filter((d) => d.status === 'ACTIVE' && d.expiresOn);
  const expired = active.filter((d) => daysUntil(d.expiresOn!, now) < 0);
  const soon = active.filter((d) => { const n = daysUntil(d.expiresOn!, now); return n >= 0 && n <= 30; });
  if (expired.length) flags.push({ code: 'DOC_EXPIRED', label: `${expired.length} document${expired.length > 1 ? 's' : ''} expired`, severity: 'high' });
  if (soon.length) flags.push({ code: 'DOC_EXPIRING', label: `${soon.length} expiring within 30 days`, severity: 'medium' });
  if (v.reviewStatus === 'ATTENTION') flags.push({ code: 'REVIEW_ATTENTION', label: 'Re-check found problems', severity: 'high' });
  if (v.nextReviewAt && v.nextReviewAt <= now) flags.push({ code: 'REVIEW_DUE', label: 'Re-check due', severity: 'low' });
  if (hasOpenChange) flags.push({ code: 'CHANGE_PENDING', label: 'Change request pending', severity: 'medium' });
  return flags;
}

export async function flagsForMany(tenantId: string, vendorRows: (Pick<Vendor, 'id' | 'status' | 'blockedAt' | 'reviewStatus' | 'nextReviewAt'> & { erasureRequestedAt?: Date | null })[]) {
  const ids = vendorRows.filter((v) => v.status === 'APPROVED').map((v) => v.id);
  if (!ids.length) return new Map(vendorRows.map((v) => [v.id, flagsFor(v, [], false)]));
  const docs = await db.select({ vendorId: documents.vendorId, status: documents.status, expiresOn: documents.expiresOn, docType: documents.docType }).from(documents)
    .where(and(eq(documents.tenantId, tenantId), inArray(documents.vendorId, ids), isNotNull(documents.expiresOn), eq(documents.status, 'ACTIVE')));
  const open = new Set((await db.select({ v: changeRequests.vendorId }).from(changeRequests).where(and(eq(changeRequests.tenantId, tenantId), eq(changeRequests.status, 'PENDING'), inArray(changeRequests.vendorId, ids)))).map((r) => r.v));
  return new Map(vendorRows.map((v) => [v.id, flagsFor(v, docs.filter((d) => d.vendorId === v.id), open.has(v.id))]));
}

/* Daily: expiry reminders + periodic re-verification. */
defineJob('lifecycle.daily', async () => {
  const reminders = await runExpiryReminders();
  const reviews = await runPeriodicReviews();
  const erased = await (await import('./privacy.js')).runRetention();
  logger.info({ reminders, reviews, erased }, 'daily lifecycle run');
}, { retryLimit: 1, expireInSeconds: 1800 });
