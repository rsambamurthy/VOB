/** Buyer-side vendor management. Every query is scoped by the signed-in user's tenant. */
import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import type { VendorStatus } from '../db/schema.js';
import { ah, HttpError } from '../lib/http.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';
import { env } from '../lib/env.js';
import { buildChecklist, visibleDocRequirements, type Profile } from '../lib/profileEngine.js';
import { assignableUsers, decide, reassign } from '../services/workflowEngine.js';
import { canAct, coveringFor } from '../services/approvers.js';
import { getConfig } from '../services/config.js';
import { latestChecks, runKyc, type KycKind } from '../integrations/kyc/index.js';
import { extractionsFor } from '../integrations/ai/index.js';
import { checkExpiry, publicCheck, upload } from './vendorPortal.js';
import { getPublished } from '../services/config.js';
import { storeUpload, removeStored } from '../integrations/storage/index.js';
import { cancelStaffChange, changeRequestsForVendor, decideChange, flagsForMany, openChangeRequest, reassignChangeStep, reviewVendor, setBlocked, submitChangeRequest } from '../services/lifecycle.js';
import { approverIds } from '../services/approvers.js';
import { CSV_COLUMNS, toCsv, toCsvRow, toOracleSupplier } from '../lib/erpMapper.js';
import { queueErpPush, recentSyncs, retrySync, syncsForVendor, syncSummary } from '../integrations/erp/index.js';
import { actionFor } from '../integrations/erp/drivers.js';
import { validators } from '../lib/validators.js';
import { isSensitive, maskField, maskProfile } from '../lib/fieldCrypto.js';
import { assertCanAddVendor, assertFeature } from '../services/limits.js';
import { declineErasure, eraseVendor, exportVendorData, noticeFor } from '../services/privacy.js';

/** Staff views get PAN / bank numbers masked; the full value needs an explicit, logged reveal. */
const maskChanges = <T extends { fieldId: string; old: string; new: string }>(cs: T[]) => cs.map((c) => (isSensitive(c.fieldId) ? { ...c, old: maskField(c.fieldId, c.old), new: maskField(c.fieldId, c.new) } : c));

const { vendors, approvalSteps, documents, auditLogs, userRoles, changeRequests, changeRequestSteps } = schema;

/** Change requests waiting on this user (own role / assignment / delegation). */
async function myPendingChangeIds(tenantId: string, userId: string) {
  const people = [userId, ...(await coveringFor(tenantId, userId))];
  const roleIds = [...new Set((await db.select({ id: userRoles.roleId }).from(userRoles).where(inArray(userRoles.userId, people))).map((r) => r.id))];
  const byRole = roleIds.length ? and(isNull(changeRequestSteps.assigneeUserId), inArray(changeRequestSteps.roleId, roleIds)) : undefined;
  const byAssignee = inArray(changeRequestSteps.assigneeUserId, people);
  const rows = await db.selectDistinct({ id: changeRequestSteps.changeRequestId }).from(changeRequestSteps)
    .where(and(eq(changeRequestSteps.tenantId, tenantId), eq(changeRequestSteps.status, 'PENDING'), byRole ? or(byRole, byAssignee) : byAssignee));
  if (!rows.length) return new Set<string>();
  // A change someone proposed is never in their own queue — someone else has to approve it.
  const mineRaised = await db.select({ id: changeRequests.id }).from(changeRequests).where(and(inArray(changeRequests.id, rows.map((r) => r.id)), eq(changeRequests.raisedById, userId)));
  const skip = new Set(mineRaised.map((r) => r.id));
  return new Set(rows.map((r) => r.id).filter((id) => !skip.has(id)));
}

/** Pending steps the user can act on: own role / own assignment, plus anyone they're covering for. */
async function actionableStepFilter(tenantId: string, userId: string) {
  const people = [userId, ...(await coveringFor(tenantId, userId))];
  const roleIds = [...new Set((await db.select({ id: userRoles.roleId }).from(userRoles).where(inArray(userRoles.userId, people))).map((r) => r.id))];
  const byRole = roleIds.length ? and(isNull(approvalSteps.assigneeUserId), inArray(approvalSteps.roleId, roleIds)) : undefined;
  const byAssignee = inArray(approvalSteps.assigneeUserId, people);
  return and(eq(approvalSteps.tenantId, tenantId), eq(approvalSteps.status, 'PENDING'), byRole ? or(byRole, byAssignee) : byAssignee)!;
}
export const staffRouter = Router();

const findVendor = (tenantId: string, id: string) => db.query.vendors.findFirst({ where: and(eq(vendors.tenantId, tenantId), eq(vendors.id, id)) });

async function nextVendorCode(tenantId: string) {
  const [{ max }] = await db.select({ max: sql<number>`coalesce(max(substring(${vendors.code} from 5)::int), 0)` }).from(vendors).where(eq(vendors.tenantId, tenantId));
  return `VND-${String(Number(max) + 1).padStart(5, '0')}`;
}

async function sendInvite(tenantName: string, v: { tenantId: string; name: string; contactEmail: string; contactFirstName: string; inviteToken: string }) {
  const link = `${env.appBaseUrl}/onboard/${v.inviteToken}`;
  await sendMail({ tenantId: v.tenantId, to: v.contactEmail, subject: `${tenantName}: invitation to register as a vendor`,
    body: `Dear ${v.contactFirstName},\n\n${tenantName} has invited you to register ${v.name} as a vendor. Open the link below and sign in with the one-time code sent to this email address.`, link });
  return link;
}

staffRouter.get('/vendors', requireStaff('vendors.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { q, status, mine, attention } = req.query as Record<string, string | undefined>;
  const filters: SQL[] = [eq(vendors.tenantId, s.tenant.id)];
  if (status) filters.push(eq(vendors.status, status as VendorStatus));
  if (q) filters.push(or(ilike(vendors.name, `%${q}%`), ilike(vendors.code, `%${q}%`), ilike(vendors.contactEmail, `%${q}%`))!);
  const pendingForMe = await db.selectDistinct({ id: approvalSteps.vendorId }).from(approvalSteps).where(await actionableStepFilter(s.tenant.id, s.user.id));
  const mineIds = new Set(pendingForMe.map((p) => p.id));
  if (mine === 'true') {
    if (!pendingForMe.length) return res.json({ vendors: [], counts: {}, myQueue: 0 });
    filters.push(inArray(vendors.id, pendingForMe.map((p) => p.id)));
  }
  const rows = await db.query.vendors.findMany({
    where: and(...filters), orderBy: desc(vendors.updatedAt), limit: 500,
    columns: { profile: false, inviteToken: false },
    with: { steps: { where: eq(approvalSteps.status, 'PENDING'), columns: { label: true, roleId: true, dueAt: true }, with: { assignee: { columns: { name: true } } } }, createdBy: { columns: { name: true } } },
  });
  const counts = await db.select({ status: vendors.status, n: count() }).from(vendors).where(eq(vendors.tenantId, s.tenant.id)).groupBy(vendors.status);
  const flags = await flagsForMany(s.tenant.id, rows);
  const myChanges = await myPendingChangeIds(s.tenant.id, s.user.id);
  const list = attention === 'true' ? rows.filter((v) => (flags.get(v.id) ?? []).length) : rows;
  // How many approved vendors need attention (for the stat tile), computed over the whole workspace
  const allApproved = attention === 'true' || status || q || mine ? null : rows.filter((v) => (flags.get(v.id) ?? []).length).length;
  res.json({
    attentionCount: allApproved ?? undefined,
    myChangeQueue: myChanges.size,
    vendors: list.map(({ steps, ...v }) => ({ ...v, flags: flags.get(v.id) ?? [], pendingStep: steps[0] ? { label: steps[0].label, mine: mineIds.has(v.id), dueAt: steps[0].dueAt, overdue: !!steps[0].dueAt && steps[0].dueAt < new Date(), assignee: steps[0].assignee?.name ?? null } : null })),
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    myQueue: pendingForMe.length,
  });
}));

const createSchema = z.object({
  name: z.string().trim().min(2, 'Vendor name is required').max(200),
  vendorType: z.enum(['DOMESTIC', 'IMPORT', 'GOVERNMENT']),
  contactFirstName: z.string().trim().min(1, 'First name is required').max(100),
  contactLastName: z.string().trim().min(1, 'Last name is required').max(100),
  contactEmail: z.string().trim().email('Enter a valid email'),
  contactMobile: z.string().trim().refine((v) => !validators.phone(v), 'Enter a valid mobile number'),
  notify: z.boolean().default(true),
});

staffRouter.post('/vendors', requireStaff('vendors.create'), ah(async (req, res) => {
  const s = staffCtx(req);
  const input = createSchema.parse(req.body);
  await assertCanAddVendor(s.tenant);
  const dup = await db.query.vendors.findFirst({ where: and(eq(vendors.tenantId, s.tenant.id), sql`lower(${vendors.name}) = lower(${input.name})`, ne(vendors.status, 'REJECTED')) });
  if (dup) throw new HttpError(409, `A vendor named "${dup.name}" already exists (${dup.code})`);
  const { notify, ...data } = input;
  const email = data.contactEmail.toLowerCase();
  const [vendor] = await db.insert(vendors).values({
    ...data, tenantId: s.tenant.id, contactEmail: email,
    code: await nextVendorCode(s.tenant.id),
    inviteToken: crypto.randomBytes(24).toString('base64url'),
    createdById: s.user.id,
    profile: {
      basic: { vendorName: data.name, supplierCountry: data.vendorType === 'IMPORT' ? '' : 'India', contactName: `${data.contactFirstName} ${data.contactLastName}`, contactEmail: email, contactMobile: data.contactMobile },
      bank: { bankCountry: data.vendorType === 'IMPORT' ? '' : 'India' },
    },
  }).returning();
  await audit({ tenantId: s.tenant.id, vendorId: vendor.id, actor: s.user.name, action: 'VENDOR_CREATED', detail: { vendorType: data.vendorType }, ip: req.ip });
  if (notify) {
    await sendInvite(s.tenant.name, vendor);
    await audit({ tenantId: s.tenant.id, vendorId: vendor.id, actor: s.user.name, action: 'INVITE_SENT', detail: { to: vendor.contactEmail }, ip: req.ip });
  }
  res.status(201).json({ vendor: { id: vendor.id, code: vendor.code } });
}));

staffRouter.post('/vendors/:id/invite', requireStaff('vendors.create'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await findVendor(s.tenant.id, req.params.id);
  if (!v) throw new HttpError(404, 'Vendor not found');
  if (!['INVITED', 'IN_PROGRESS', 'SENT_BACK'].includes(v.status)) throw new HttpError(409, 'Vendor has already submitted');
  await sendInvite(s.tenant.name, v);
  await audit({ tenantId: s.tenant.id, vendorId: v.id, actor: s.user.name, action: 'INVITE_SENT', detail: { to: v.contactEmail }, ip: req.ip });
  res.json({ ok: true });
}));

staffRouter.get('/vendors/:id', requireStaff('vendors.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await db.query.vendors.findFirst({
    where: and(eq(vendors.tenantId, s.tenant.id), eq(vendors.id, req.params.id)),
    with: {
      documents: { orderBy: desc(documents.uploadedAt) },
      steps: { orderBy: [desc(approvalSteps.cycle), asc(approvalSteps.level)], with: { actedBy: { columns: { name: true } }, assignee: { columns: { name: true } }, role: { columns: { name: true } } } },
      audit: { orderBy: desc(auditLogs.createdAt), limit: 200 },
      createdBy: { columns: { name: true } },
    },
  });
  if (!v) throw new HttpError(404, 'Vendor not found');
  const profile = v.profile as Profile;
  const config = await getConfig(s.tenant.id);
  const pending = v.steps.find((st) => st.status === 'PENDING' && st.cycle === v.reviewCycle);
  const { inviteToken, ...rest } = v;
  const canInvite = s.permissions.has('vendors.create');
  res.json({
    vendor: { ...rest, profile: maskProfile(rest.profile), steps: rest.steps.map(({ role, assignee, ...st }) => ({ ...st, roleName: role?.name, assigneeName: assignee?.name ?? null, overdue: st.status === 'PENDING' && !!st.dueAt && st.dueAt < new Date() })), inviteLink: canInvite && env.devShowOtp ? `${env.appBaseUrl}/onboard/${inviteToken}` : undefined },
    checklist: buildChecklist(config, profile, v.documents.filter((d) => d.status === 'ACTIVE').map((d) => d.docType), v.vendorType),
    docRequirements: visibleDocRequirements(config, profile, v.vendorType),
    canAct: !!pending && await canAct(pending, s.user.id),
    canReassign: !!pending && s.permissions.has('approvals.manage'),
    checks: (await latestChecks(v.id)).map((c) => ({ ...publicCheck(c), requestedBy: c.requestedBy, provider: c.provider })),
    extractions: (await extractionsFor(v.id, profile, config)).map((e) => ({ ...e, suggestions: e.suggestions.map((x) => (isSensitive(x.fieldId) ? { ...x, value: maskField(x.fieldId, x.value), current: maskField(x.fieldId, x.current) } : x)) })),
    canInvite,
    canExport: s.permissions.has('vendors.export'),
    canBlock: s.permissions.has('vendors.block'),
    canPropose: s.permissions.has('vendors.edit') && v.status === 'APPROVED' && !v.erasedAt,
    privacy: { consentAt: v.consentAt, consentVersion: v.consentVersion, currentVersion: noticeFor(s.tenant).version, erasureRequestedAt: v.erasureRequestedAt, erasureReason: v.erasureReason, erasedAt: v.erasedAt,
      canErase: s.permissions.has('tenant.settings'), canExport: s.permissions.has('vendors.export') },
    me: s.user.id,
    flags: (await flagsForMany(s.tenant.id, [v])).get(v.id) ?? [],
    changeRequests: await Promise.all((await changeRequestsForVendor(v.id)).map(async (cr) => {
      const cur = cr.steps.find((st) => st.status === 'PENDING');
      return {
        ...cr,
        changes: maskChanges(cr.changes),
        raisedBy: cr.raisedBy ? { id: cr.raisedBy.id, name: cr.raisedBy.name } : null,
        canWithdraw: cr.status === 'PENDING' && !!cr.raisedById && (cr.raisedById === s.user.id || s.permissions.has('approvals.manage')),
        steps: cr.steps.map(({ role, assignee, actedBy, ...st }) => ({ ...st, roleName: role?.name, assigneeName: assignee?.name ?? null, actedBy: actedBy ? { name: actedBy.name } : null, overdue: st.status === 'PENDING' && !!st.dueAt && st.dueAt < new Date() })),
        canAct: !!cur && cr.raisedById !== s.user.id && (await approverIds(cur)).has(s.user.id),
        canReassign: !!cur && s.permissions.has('approvals.manage'),
      };
    })),
  });
}));

staffRouter.post('/vendors/:id/decision', requireStaff(), ah(async (req, res) => {
  const s = staffCtx(req);
  const { action, remarks } = z.object({ action: z.enum(['APPROVE', 'SEND_BACK', 'REJECT']), remarks: z.string().max(2000).default('') }).parse(req.body);
  res.json(await decide(s.tenant.id, req.params.id, { id: s.user.id, name: s.user.name }, action, remarks, req.ip));
}));

staffRouter.get('/vendors/:id/assignable', requireStaff('approvals.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await findVendor(s.tenant.id, req.params.id);
  if (!v) throw new HttpError(404, 'Vendor not found');
  const step = await db.query.approvalSteps.findFirst({ where: and(eq(approvalSteps.vendorId, v.id), eq(approvalSteps.status, 'PENDING')) });
  if (!step) throw new HttpError(409, 'Nothing is pending');
  res.json(await assignableUsers(s.tenant.id, step.roleId));
}));

staffRouter.post('/vendors/:id/steps/:stepId/assign', requireStaff('approvals.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { userId } = z.object({ userId: z.string().nullable() }).parse(req.body);
  res.json(await reassign(s.tenant.id, req.params.id, req.params.stepId, userId, { name: s.user.name }, req.ip));
}));

staffRouter.get('/vendors/:id/erp-export', requireStaff('vendors.export'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await findVendor(s.tenant.id, req.params.id);
  if (!v) throw new HttpError(404, 'Vendor not found');
  if (v.status !== 'APPROVED') throw new HttpError(409, 'Only approved vendors can be exported to the ERP');
  await audit({ tenantId: s.tenant.id, vendorId: v.id, actor: s.user.name, action: 'ERP_EXPORTED', ip: req.ip });
  res.json(toOracleSupplier(v, { orgId: typeof req.query.orgId === 'string' ? req.query.orgId : undefined }));
}));

/** Reviewers can re-run an online check against the vendor's current answers. */
staffRouter.post('/vendors/:id/verify/:kind', requireStaff('vendors.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await findVendor(s.tenant.id, req.params.id);
  if (!v) throw new HttpError(404, 'Vendor not found');
  const kind = z.enum(['gstin', 'pan', 'bank', 'cin']).parse(req.params.kind) as KycKind;
  const p = v.profile as Profile;
  const input: Record<string, string> = kind === 'bank'
    ? { accountNumber: String(p.bank?.accountNumber ?? ''), ifsc: String(p.bank?.ifsc ?? '') }
    : { [kind]: String(p.tax?.[kind] ?? '') };
  if (Object.values(input).some((x) => !x || x === 'undefined')) throw new HttpError(400, `The vendor hasn't entered ${kind === 'bank' ? 'bank account details' : `a ${kind.toUpperCase()}`} yet`);
  const r = await runKyc(v, kind, input, s.user.name);
  await audit({ tenantId: s.tenant.id, vendorId: v.id, actor: s.user.name, action: 'VERIFICATION_RUN', detail: { kind, status: r.status }, ip: req.ip });
  res.json(publicCheck(r));
}));

/* ---------- Change requests (after approval) ---------- */

staffRouter.get('/change-requests', requireStaff('vendors.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  const mine = req.query.mine === 'true';
  const status = typeof req.query.status === 'string' ? req.query.status : 'PENDING';
  const myIds = await myPendingChangeIds(s.tenant.id, s.user.id);
  const rows = await db.query.changeRequests.findMany({
    where: and(eq(changeRequests.tenantId, s.tenant.id), eq(changeRequests.status, status), ...(mine ? [myIds.size ? inArray(changeRequests.id, [...myIds]) : sql`false`] : [])),
    orderBy: desc(changeRequests.createdAt), limit: 200,
    with: { vendor: { columns: { id: true, name: true, code: true } }, raisedBy: { columns: { name: true } }, steps: { where: eq(changeRequestSteps.status, 'PENDING'), columns: { label: true, dueAt: true }, with: { assignee: { columns: { name: true } } } } },
  });
  res.json(rows.map(({ steps, ...cr }) => ({ ...cr, changes: maskChanges(cr.changes), pendingStep: steps[0] ? { label: steps[0].label, dueAt: steps[0].dueAt, overdue: !!steps[0].dueAt && steps[0].dueAt < new Date(), assignee: steps[0].assignee?.name ?? null } : null, mine: myIds.has(cr.id) })));
}));

staffRouter.post('/change-requests/:id/decision', requireStaff('vendors.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { action, remarks } = z.object({ action: z.enum(['APPROVE', 'REJECT']), remarks: z.string().max(2000).default('') }).parse(req.body);
  res.json(await decideChange(s.tenant.id, req.params.id, { id: s.user.id, name: s.user.name }, action, remarks, req.ip));
}));

staffRouter.get('/change-requests/:id/assignable', requireStaff('approvals.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const cr = await db.query.changeRequests.findFirst({ where: and(eq(changeRequests.tenantId, s.tenant.id), eq(changeRequests.id, req.params.id)) });
  if (!cr) throw new HttpError(404, 'Change request not found');
  const step = await db.query.changeRequestSteps.findFirst({ where: and(eq(changeRequestSteps.changeRequestId, cr.id), eq(changeRequestSteps.status, 'PENDING')) });
  if (!step) throw new HttpError(409, 'Nothing is pending');
  res.json(await assignableUsers(s.tenant.id, step.roleId));
}));

staffRouter.post('/change-requests/:id/steps/:stepId/assign', requireStaff('approvals.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { userId } = z.object({ userId: z.string().nullable() }).parse(req.body);
  res.json(await reassignChangeStep(s.tenant.id, req.params.id, req.params.stepId, userId, { name: s.user.name }, req.ip));
}));

/* ---------- Staff-proposed changes (on the vendor's behalf) ---------- */

async function approvedVendor(tenantId: string, id: string) {
  const v = await findVendor(tenantId, id);
  if (!v) throw new HttpError(404, 'Vendor not found');
  if (v.status !== 'APPROVED') throw new HttpError(409, 'Only approved vendors can be changed this way');
  return v;
}

/** Upload a document as part of a proposal; it stays PENDING until the change is approved. */
staffRouter.post('/vendors/:id/documents', requireStaff('vendors.edit'), upload.single('file'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await approvedVendor(s.tenant.id, req.params.id);
  if (!req.file) throw new HttpError(400, 'No file uploaded');
  if (await openChangeRequest(v.id)) throw new HttpError(409, 'This vendor already has a change request waiting for review');
  const { config } = await getPublished(v.tenantId);
  const docType = String(req.body.docType ?? '');
  const req_ = config.documents.find((d) => d.type === docType);
  if (!req_) throw new HttpError(400, 'Unknown document type');
  const expiresOn = checkExpiry(req_, req.body.expiresOn);
  const stored = await storeUpload(v.tenantId, v.id, req.file);
  const [doc] = await db.insert(documents).values({ tenantId: v.tenantId, vendorId: v.id, docType, ...stored, expiresOn, status: 'PENDING', uploadedById: s.user.id }).returning();
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: s.user.name, action: 'DOCUMENT_UPLOADED', detail: { docType, fileName: stored.fileName, onBehalf: 'yes' }, ip: req.ip });
  const { storagePath: _p, ...safe } = doc;
  res.status(201).json(safe);
}));

staffRouter.delete('/vendors/:id/documents/:docId', requireStaff('vendors.edit'), ah(async (req, res) => {
  const s = staffCtx(req);
  const doc = await db.query.documents.findFirst({ where: and(eq(documents.tenantId, s.tenant.id), eq(documents.vendorId, req.params.id), eq(documents.id, req.params.docId)) });
  if (!doc) throw new HttpError(404, 'Document not found');
  if (doc.status !== 'PENDING' || doc.changeRequestId || doc.uploadedById !== s.user.id) throw new HttpError(409, 'Only your own not-yet-submitted uploads can be removed');
  await db.delete(documents).where(eq(documents.id, doc.id));
  await removeStored(doc);
  await audit({ tenantId: s.tenant.id, vendorId: doc.vendorId, actor: s.user.name, action: 'DOCUMENT_REMOVED', detail: { docType: doc.docType, fileName: doc.fileName }, ip: req.ip });
  res.json({ ok: true });
}));

staffRouter.post('/vendors/:id/change-requests', requireStaff('vendors.edit'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await approvedVendor(s.tenant.id, req.params.id);
  const input = z.object({ changes: z.record(z.record(z.unknown())).default({}), note: z.string().max(1000).default('') }).parse(req.body);
  const cr = await submitChangeRequest(v, input, req.ip, { id: s.user.id, name: s.user.name });
  res.status(201).json({ id: cr.id });
}));

staffRouter.post('/change-requests/:id/cancel', requireStaff(), ah(async (req, res) => {
  const s = staffCtx(req);
  await cancelStaffChange(s.tenant.id, req.params.id, { id: s.user.id, name: s.user.name, canManage: s.permissions.has('approvals.manage') }, req.ip);
  res.json({ ok: true });
}));

/* ---------- Block / unblock / re-check ---------- */

staffRouter.post('/vendors/:id/block', requireStaff('vendors.block'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { reason, notifyVendor } = z.object({ reason: z.string().max(500), notifyVendor: z.boolean().default(false) }).parse(req.body);
  await setBlocked(s.tenant.id, req.params.id, true, reason, { id: s.user.id, name: s.user.name }, notifyVendor, req.ip);
  res.json({ ok: true });
}));

staffRouter.post('/vendors/:id/unblock', requireStaff('vendors.block'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { reason, notifyVendor } = z.object({ reason: z.string().max(500), notifyVendor: z.boolean().default(false) }).parse(req.body);
  await setBlocked(s.tenant.id, req.params.id, false, reason, { id: s.user.id, name: s.user.name }, notifyVendor, req.ip);
  res.json({ ok: true });
}));

/** Run the periodic re-verification now. */
staffRouter.post('/vendors/:id/review', requireStaff('vendors.block'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await findVendor(s.tenant.id, req.params.id);
  if (!v || v.status !== 'APPROVED') throw new HttpError(409, 'Only approved vendors are re-checked');
  res.json(await reviewVendor(v, s.user.name));
}));

/* ---------- ERP push (Phase 5) ---------- */

staffRouter.get('/vendors/:id/erp', requireStaff('vendors.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await findVendor(s.tenant.id, req.params.id);
  if (!v) throw new HttpError(404, 'Vendor not found');
  const conn = await db.query.erpConnections.findFirst({ where: eq(schema.erpConnections.tenantId, s.tenant.id) });
  res.json({
    connector: conn?.kind ?? 'none', testMode: conn?.testMode ?? true,
    erpVendorId: v.erpVendorId, status: v.erpSyncStatus, syncedAt: v.erpSyncedAt,
    canPush: s.permissions.has('vendors.export') && v.status === 'APPROVED' && !!conn && conn.kind !== 'none',
    deliveries: (await syncsForVendor(v.id)).map(syncSummary),
  });
}));

staffRouter.post('/vendors/:id/erp/push', requireStaff('vendors.export'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await findVendor(s.tenant.id, req.params.id);
  if (!v) throw new HttpError(404, 'Vendor not found');
  if (v.status !== 'APPROVED') throw new HttpError(409, 'Only approved vendors are sent to the ERP');
  assertFeature(s.tenant, 'erp');
  const sync = await queueErpPush(s.tenant.id, v.id, 'MANUAL', s.user.name);
  res.status(202).json(syncSummary(sync!));
}));

staffRouter.get('/erp/deliveries', requireStaff('vendors.export'), ah(async (req, res) => {
  const s = staffCtx(req);
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
  res.json((await recentSyncs(s.tenant.id, status)).map((x) => ({ ...syncSummary(x), vendor: x.vendor })));
}));

staffRouter.post('/erp/deliveries/:id/retry', requireStaff('vendors.export'), ah(async (req, res) => {
  const s = staffCtx(req);
  res.json(syncSummary(await retrySync(s.tenant.id, req.params.id, s.user.name)));
}));

/** What a delivery sent: the JSON body, or the CSV file. */
staffRouter.get('/erp/deliveries/:id/payload', requireStaff('vendors.export'), ah(async (req, res) => {
  const s = staffCtx(req);
  const x = await db.query.erpSyncs.findFirst({ where: and(eq(schema.erpSyncs.tenantId, s.tenant.id), eq(schema.erpSyncs.id, req.params.id)) });
  if (!x || !x.request) throw new HttpError(404, 'Nothing was recorded for this delivery');
  await audit({ tenantId: s.tenant.id, vendorId: x.vendorId, actor: s.user.name, action: 'ERP_PAYLOAD_VIEWED', detail: { delivery: x.id }, ip: req.ip });
  if (x.request.csv) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${x.request.fileName ?? 'vendor.csv'}"`);
    return res.send(x.request.csv);
  }
  res.json({ target: x.target, headers: x.request.headers, body: x.request.body, httpStatus: x.httpStatus, response: x.response });
}));

/** All approved vendors as one CSV (for a first bulk load into the ERP). */
staffRouter.get('/erp/export.csv', requireStaff('vendors.export'), ah(async (req, res) => {
  const s = staffCtx(req);
  const rows = await db.query.vendors.findMany({ where: and(eq(vendors.tenantId, s.tenant.id), eq(vendors.status, 'APPROVED')), orderBy: asc(vendors.code) });
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'ERP_BULK_EXPORTED', detail: { vendors: rows.length }, ip: req.ip });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="vendors_${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(toCsv([CSV_COLUMNS, ...rows.map((v) => toCsvRow(v, actionFor(v, 'MANUAL')))]));
}));

/* ---------- Reveal a masked value (logged) ---------- */

staffRouter.post('/vendors/:id/reveal', requireStaff('vendors.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { fieldId, changeRequestId } = z.object({ fieldId: z.string(), changeRequestId: z.string().optional() }).parse(req.body);
  if (!isSensitive(fieldId)) throw new HttpError(400, 'This field is not masked');
  const v = await findVendor(s.tenant.id, req.params.id);
  if (!v) throw new HttpError(404, 'Vendor not found');
  let out: { value?: string; old?: string; new?: string };
  if (changeRequestId) {
    const cr = await db.query.changeRequests.findFirst({ where: and(eq(changeRequests.tenantId, s.tenant.id), eq(changeRequests.id, changeRequestId), eq(changeRequests.vendorId, v.id)) });
    const c = cr?.changes.find((x) => x.fieldId === fieldId);
    if (!c) throw new HttpError(404, 'That change was not found');
    out = { old: c.old, new: c.new };
  } else {
    const [sec, key] = fieldId.split('.');
    out = { value: String((v.profile as Profile)[sec]?.[key] ?? '') };
  }
  await audit({ tenantId: s.tenant.id, vendorId: v.id, actor: s.user.name, action: 'SENSITIVE_REVEALED', detail: { field: fieldId, ...(changeRequestId ? { source: 'change request' } : {}) }, ip: req.ip });
  res.json(out);
}));

/* ---------- Privacy (DPDP) ---------- */

staffRouter.get('/vendors/:id/data-export', requireStaff('vendors.export'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await findVendor(s.tenant.id, req.params.id);
  if (!v) throw new HttpError(404, 'Vendor not found');
  await audit({ tenantId: s.tenant.id, vendorId: v.id, actor: s.user.name, action: 'DATA_EXPORTED', detail: { by: 'staff' }, ip: req.ip });
  res.setHeader('Content-Disposition', `attachment; filename="${v.code}-personal-data.json"`);
  res.json(await exportVendorData(v, { forStaff: true }));
}));

staffRouter.post('/vendors/:id/erase', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { reason, confirm } = z.object({ reason: z.string().max(500), confirm: z.string() }).parse(req.body);
  const v = await findVendor(s.tenant.id, req.params.id);
  if (!v) throw new HttpError(404, 'Vendor not found');
  if (confirm.trim().toUpperCase() !== v.code) throw new HttpError(400, `Type the vendor code (${v.code}) to confirm`);
  await eraseVendor(s.tenant.id, v.id, reason, s.user.name, { ip: req.ip });
  res.json({ ok: true });
}));

staffRouter.post('/vendors/:id/erasure-request/decline', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { reason } = z.object({ reason: z.string().max(500) }).parse(req.body);
  await declineErasure(s.tenant.id, req.params.id, reason, s.user.name, req.ip);
  res.json({ ok: true });
}));
