/**
 * Privacy-law support (India: DPDP Act 2023; wording per country pack): privacy notice + recorded consent,
 * data export for access requests, erasure (on request or by retention policy).
 *
 * Erasure anonymises rather than deletes the vendor row: counts in reports and the audit trail of
 * who did what and when survive, but names, contacts, profile data, documents and checks are gone.
 */
import crypto from 'node:crypto';
import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import type { Tenant, TenantSettings, Vendor } from '../db/schema.js';
import { HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { removeStored } from '../integrations/storage/index.js';
import { kycStatus } from '../integrations/kyc/index.js';
import { DEFAULT_HOME, packFor } from '../countries/registry.js';
import { aiStatus } from '../integrations/ai/index.js';
import { usersWithPermission } from './approvers.js';
import { getConfig } from './config.js';

const { vendors, documents, verifications, documentExtractions, changeRequests, erpSyncs, emailOutbox, smsLog, otpCodes, sessions, auditLogs, tenants, approvalSteps } = schema;
const DAY = 86_400_000;

/* ---------------- Privacy notice ---------------- */

/** Starting text from the home country's pack (written for its privacy law). */
export function defaultNotice(company: string, contactEmail?: string, country?: string | null) {
  const p = packFor(country ?? DEFAULT_HOME).privacy ?? packFor(DEFAULT_HOME).privacy!;
  return p.defaultNotice(company, contactEmail);
}

export function noticeFor(t: Pick<Tenant, 'name' | 'settings'> & { country?: string }) {
  const p = (t.settings as TenantSettings).privacy;
  return { version: p?.version ?? 1, text: p?.text || defaultNotice(t.name, p?.contactEmail, t.country), contactEmail: p?.contactEmail ?? null, updatedAt: p?.updatedAt ?? null, isDefault: !p?.text };
}

export const retentionFor = (t: Pick<Tenant, 'settings'>) => ({ rejectedDays: 365, abandonedDays: 180, ...((t.settings as TenantSettings).retention ?? {}) });

export const needsConsent = (t: Pick<Tenant, 'name' | 'settings'> & { country?: string }, v: Pick<Vendor, 'consentVersion'>) => v.consentVersion !== noticeFor(t).version;

export async function recordConsent(t: Tenant, v: Vendor, version: number, ip?: string) {
  const current = noticeFor(t).version;
  if (version !== current) throw new HttpError(409, 'The privacy notice has changed. Please read the latest version.');
  await db.update(vendors).set({ consentAt: new Date(), consentVersion: version, consentIp: ip ?? null }).where(eq(vendors.id, v.id));
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: v.contactEmail, action: 'CONSENT_GIVEN', detail: { noticeVersion: version }, ip });
}

/* ---------------- Data export (access request) ---------------- */

export async function exportVendorData(v: Vendor, opts: { forStaff: boolean }) {
  const t = (await db.query.tenants.findFirst({ where: eq(tenants.id, v.tenantId) }))!;
  const cfg = await getConfig(v.tenantId);
  const label = (t2: string) => cfg.documents.find((d) => d.type === t2)?.label ?? t2;
  const docs = await db.select().from(documents).where(eq(documents.vendorId, v.id));
  const checks = await db.select().from(verifications).where(eq(verifications.vendorId, v.id));
  const crs = await db.query.changeRequests.findMany({ where: eq(changeRequests.vendorId, v.id) });
  const steps = await db.select().from(approvalSteps).where(eq(approvalSteps.vendorId, v.id));
  const erp = await db.query.erpConnections.findFirst({ where: eq(schema.erpConnections.tenantId, v.tenantId) });
  const kyc = kycStatus(), ai = aiStatus();
  const auditRows = opts.forStaff ? await db.select().from(auditLogs).where(eq(auditLogs.vendorId, v.id)) : [];
  return {
    exportedAt: new Date().toISOString(),
    dataFiduciary: { name: t.name, contact: noticeFor(t).contactEmail },
    vendor: {
      code: v.code, name: v.name, type: v.vendorType, status: v.status, blocked: !!v.blockedAt,
      contact: { firstName: v.contactFirstName, lastName: v.contactLastName, email: v.contactEmail, mobile: v.contactMobile },
      registeredOn: v.createdAt, submittedOn: v.submittedAt, decidedOn: v.decidedAt, erpVendorId: v.erpVendorId,
    },
    profile: v.profile,
    documents: docs.map((d) => ({ type: label(d.docType), fileName: d.fileName, size: d.size, uploadedAt: d.uploadedAt, status: d.status, validUntil: d.expiresOn })),
    verifications: checks.map((c) => ({ kind: c.kind, status: c.status, checkedValue: c.inputMasked, nameOnRecord: c.nameOnRecord, provider: c.provider, checkedAt: c.createdAt })),
    changeRequests: crs.map((c) => ({ status: c.status, changes: c.changes, note: c.note, requestedAt: c.createdAt, decidedAt: c.decidedAt, raisedBy: c.raisedById ? 'buyer staff' : 'you' })),
    approvals: steps.map((s) => ({ level: s.label, status: s.status, decidedAt: s.actedAt, ...(opts.forStaff ? { remarks: s.remarks } : {}) })),
    consent: { noticeVersion: v.consentVersion, givenAt: v.consentAt },
    erasure: { requestedAt: v.erasureRequestedAt, reason: v.erasureReason },
    sharedWith: [
      { recipient: 'Verification provider', purpose: 'Check PAN, GSTIN, CIN and bank account', provider: kyc.provider },
      ...((t.settings as TenantSettings).aiExtraction ? [{ recipient: 'AI document reading', purpose: 'Read uploaded documents to suggest form values', provider: ai.provider }] : []),
      ...(erp && erp.kind !== 'none' ? [{ recipient: 'ERP / accounting system', purpose: 'Set you up as a supplier and pay you', provider: erp.kind }] : []),
    ],
    ...(opts.forStaff ? { auditTrail: auditRows.map((a) => ({ at: a.createdAt, actor: a.actor, action: a.action, detail: a.detail })) } : {}),
  };
}

/* ---------------- Erasure ---------------- */

async function notifyAdmins(tenantId: string, subject: string, body: string, vendorId: string) {
  for (const u of await usersWithPermission(tenantId, 'tenant.settings')) {
    await sendMail({ tenantId, to: u.email, subject, body: `Hello ${u.name},\n\n${body}`, link: `${env.appBaseUrl}/staff/vendors/${vendorId}` });
  }
}

export async function requestErasure(v: Vendor, reason: string, ip?: string) {
  if (v.erasedAt) throw new HttpError(409, 'This data has already been deleted');
  if (v.erasureRequestedAt) throw new HttpError(409, 'You have already asked for deletion. We will email you when it is done.');
  await db.update(vendors).set({ erasureRequestedAt: new Date(), erasureReason: reason.slice(0, 500) || null }).where(eq(vendors.id, v.id));
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: v.contactEmail, action: 'ERASURE_REQUESTED', detail: { reason }, ip });
  await notifyAdmins(v.tenantId, `Data deletion request: ${v.name}`, `${v.name} (${v.code}) has withdrawn consent and asked for their data to be deleted.${reason ? `\n\nReason given: ${reason}` : ''}\n\nOpen the vendor to erase the data, or decline with a reason (for example, records of an active supplier that tax law requires you to keep).`, v.id);
}

export async function declineErasure(tenantId: string, vendorId: string, reason: string, actor: string, ip?: string) {
  const v = await db.query.vendors.findFirst({ where: and(eq(vendors.tenantId, tenantId), eq(vendors.id, vendorId)) });
  if (!v || !v.erasureRequestedAt) throw new HttpError(409, 'There is no open deletion request');
  if (!reason.trim()) throw new HttpError(400, 'Explain why — the vendor is told');
  await db.update(vendors).set({ erasureRequestedAt: null, erasureReason: null }).where(eq(vendors.id, v.id));
  await audit({ tenantId, vendorId, actor, action: 'ERASURE_DECLINED', detail: { reason }, ip });
  await sendMail({ tenantId, to: v.contactEmail, subject: 'Your data deletion request', body: `Dear ${v.contactFirstName},\n\nWe could not delete ${v.name}'s data at this time.\n\nReason: ${reason}\n\nWe will keep only what is needed for this purpose and delete it when we are allowed to.` });
}

/**
 * Anonymise a vendor. Approved suppliers must be blocked first (payments stopped), and registrations
 * under review must be decided first, so nothing in flight points at erased data.
 */
export async function eraseVendor(tenantId: string, vendorId: string, reason: string, actor: string, opts: { ip?: string; policy?: boolean } = {}) {
  const v = await db.query.vendors.findFirst({ where: and(eq(vendors.tenantId, tenantId), eq(vendors.id, vendorId)) });
  if (!v) throw new HttpError(404, 'Vendor not found');
  if (v.erasedAt) throw new HttpError(409, 'Already erased');
  if (v.status === 'UNDER_REVIEW') throw new HttpError(409, 'Decide the registration (reject it) before erasing its data');
  if (v.status === 'APPROVED' && !v.blockedAt) throw new HttpError(409, 'Block this supplier first. Check with finance that its records no longer need to be kept (tax law usually requires about 8 years).');
  if (!reason.trim()) throw new HttpError(400, 'Give a reason — it stays in the audit log');
  const notifyTo = v.erasureRequestedAt ? { email: v.contactEmail, first: v.contactFirstName, name: v.name } : null;

  const docs = await db.select().from(documents).where(eq(documents.vendorId, v.id));
  for (const d of docs) await removeStored(d).catch((err) => logger.warn({ err, doc: d.id }, 'could not remove stored file during erasure'));
  await db.transaction(async (tx) => {
    await tx.delete(documentExtractions).where(eq(documentExtractions.vendorId, v.id));
    await tx.delete(documents).where(eq(documents.vendorId, v.id));
    await tx.delete(verifications).where(eq(verifications.vendorId, v.id));
    await tx.delete(otpCodes).where(eq(otpCodes.vendorId, v.id));
    await tx.delete(sessions).where(eq(sessions.vendorId, v.id));
    await tx.update(changeRequests).set({ changes: [], note: null, remarks: null }).where(eq(changeRequests.vendorId, v.id));
    await tx.update(erpSyncs).set({ request: null, response: null }).where(eq(erpSyncs.vendorId, v.id));
    await tx.update(approvalSteps).set({ remarks: null }).where(eq(approvalSteps.vendorId, v.id));
    await tx.delete(emailOutbox).where(and(eq(emailOutbox.tenantId, tenantId), eq(emailOutbox.to, v.contactEmail)));
    if (v.contactMobile) await tx.delete(smsLog).where(and(eq(smsLog.tenantId, tenantId), eq(smsLog.to, v.contactMobile)));
    // Keep what happened and when; drop who (the vendor's email) and any detail that may hold personal data.
    await tx.update(auditLogs).set({ actor: 'vendor (erased)' }).where(and(eq(auditLogs.vendorId, v.id), eq(auditLogs.actor, v.contactEmail)));
    await tx.update(auditLogs).set({ detail: null }).where(eq(auditLogs.vendorId, v.id));
    await tx.update(vendors).set({
      name: `Erased vendor ${v.code}`, contactFirstName: 'Erased', contactLastName: '', contactEmail: `erased+${v.id}@invalid.local`, contactMobile: '',
      profile: {}, inviteToken: crypto.randomBytes(24).toString('base64url'), blockedReason: v.blockedAt ? 'Erased' : null, reviewNote: null,
      erasedAt: new Date(), erasureRequestedAt: null, erasureReason: null, consentIp: null,
    }).where(eq(vendors.id, v.id));
  });
  await audit({ tenantId, vendorId: v.id, actor, action: 'VENDOR_ERASED', detail: { reason, documents: docs.length, ...(opts.policy ? { by: 'retention policy' } : {}) }, ip: opts.ip });
  // The deletion confirmation goes to the address we just erased — sent once, not stored afterwards.
  if (notifyTo) {
    await sendMail({ tenantId, to: notifyTo.email, subject: 'Your data has been deleted', body: `Dear ${notifyTo.first},\n\nAs requested, the personal data we held for ${notifyTo.name} has been deleted.` });
    await db.delete(emailOutbox).where(and(eq(emailOutbox.tenantId, tenantId), eq(emailOutbox.to, notifyTo.email)));
  }
}

/** Daily: anonymise rejected and abandoned registrations past the workspace's retention period. */
export async function runRetention(now = new Date()) {
  let erased = 0;
  for (const t of await db.select().from(tenants)) {
    const r = retentionFor(t);
    const conds = [];
    if (r.rejectedDays > 0) conds.push(and(eq(vendors.status, 'REJECTED'), lt(vendors.decidedAt, new Date(now.getTime() - r.rejectedDays * DAY))));
    if (r.abandonedDays > 0) conds.push(and(inArray(vendors.status, ['INVITED', 'IN_PROGRESS', 'SENT_BACK']), lt(vendors.updatedAt, new Date(now.getTime() - r.abandonedDays * DAY))));
    if (!conds.length) continue;
    const due = await db.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.tenantId, t.id), isNull(vendors.erasedAt), or(...conds))).limit(200);
    for (const v of due) {
      try { await eraseVendor(t.id, v.id, 'Retention period ended', 'system', { policy: true }); erased++; }
      catch (err) { logger.warn({ err, vendorId: v.id }, 'retention erase failed'); }
    }
  }
  return erased;
}
