import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';

const { vendors, documents, approvalSteps } = schema;
import { ah, HttpError } from '../lib/http.js';
import { requireVendor, vendorCtx } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { getPublished } from '../services/config.js';
import { buildChecklist, isSubmittable, sanitizeSection, visibleDocRequirements, type Profile } from '../lib/profileEngine.js';
import { startReview } from '../services/workflowEngine.js';
import { storeUpload, removeStored } from '../integrations/storage/index.js';
import { runKyc, latestChecks } from '../integrations/kyc/index.js';
import { checkDef, checkList, localeFor } from '../countries/registry.js';
import { hasFeature } from '../services/limits.js';
import { pendingOrderCount } from '../services/orders/queries.js';
import { queueExtraction, extractionsFor, getExtraction } from '../integrations/ai/index.js';
import { exportVendorData, needsConsent, noticeFor, recordConsent, requestErasure } from '../services/privacy.js';
import { cancelChangeRequest, changeRequestsForVendor, flagsFor, openChangeRequest, submitChangeRequest } from '../services/lifecycle.js';

export const vendorRouter = Router();
vendorRouter.use(requireVendor);

/** DPDP: nothing is collected until the vendor has accepted the current privacy notice. */
const requireConsent = ah(async (req, _res, next) => {
  const { vendorId, tenant } = vendorCtx(req);
  const v = await db.query.vendors.findFirst({ where: eq(vendors.id, vendorId), columns: { consentVersion: true } });
  if (!v || needsConsent(tenant, v)) throw new HttpError(403, 'Please read and accept the privacy notice first', undefined, 'CONSENT_REQUIRED');
  next();
});
for (const path of ['/profile/:section', '/documents', '/verify/:kind', '/extractions/:id/apply', '/submit', '/change-requests', '/confirm-details']) vendorRouter.use(path, (req, res, next) => (req.method === 'GET' ? next() : requireConsent(req, res, next)));

const EDITABLE = ['INVITED', 'IN_PROGRESS', 'SENT_BACK'];
const ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg'];

// Files are held in memory (max 5 MB), checked and scanned, then written to the configured storage.
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => (ALLOWED_MIME.includes(file.mimetype) ? cb(null, true) : cb(new HttpError(400, 'Only PDF, PNG or JPG files are allowed'))),
});

async function loadMine(req: Parameters<typeof vendorCtx>[0]) {
  const { vendorId, tenant } = vendorCtx(req);
  const v = await db.query.vendors.findFirst({
    where: and(eq(vendors.tenantId, tenant.id), eq(vendors.id, vendorId)),
    with: { documents: { orderBy: desc(documents.uploadedAt) }, steps: { orderBy: [desc(approvalSteps.cycle), asc(approvalSteps.level)] } },
  });
  if (!v) throw new HttpError(404, 'Vendor not found');
  return v;
}

/** What the vendor may see about a check — no raw provider payload. */
export function publicCheck(c: { id: string; kind: string; status: string; message: string; inputMasked: string; nameOnRecord: string | null; nameMatch: number | null; test: boolean; createdAt: Date; data: Record<string, string> | null }) {
  return { id: c.id, kind: c.kind, status: c.status, message: c.message, inputMasked: c.inputMasked, nameOnRecord: c.nameOnRecord, nameMatch: c.nameMatch, test: c.test, checkedAt: c.createdAt, data: c.data };
}

const activeTypes = (docs: { status: string; docType: string }[]) => docs.filter((d) => d.status === 'ACTIVE').map((d) => d.docType);

/** Validate a "valid until" date for a document type that expires. Returns the date or null. */
export function checkExpiry(req_: { label: string; hasExpiry?: boolean }, raw: unknown) {
  const expiresOn = typeof raw === 'string' && raw ? raw : null;
  if (req_.hasExpiry && !expiresOn) throw new HttpError(400, `Enter the date this ${req_.label} is valid until`);
  if (expiresOn && (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn) || Number.isNaN(Date.parse(expiresOn)))) throw new HttpError(400, 'Valid-until date is not a valid date');
  if (expiresOn && expiresOn < new Date().toISOString().slice(0, 10)) throw new HttpError(400, 'This document has already expired. Upload a current one.');
  return expiresOn;
}

function assertEditable(status: string) {
  if (!EDITABLE.includes(status)) throw new HttpError(409, 'Your registration has been submitted and can no longer be edited');
}

vendorRouter.get('/', ah(async (req, res) => {
  const v = await loadMine(req);
  const profile = v.profile as Profile;
  const lastSendBack = v.steps.find((s) => s.status === 'SENT_BACK' && s.cycle === v.reviewCycle);
  const { inviteToken: _t, ...rest } = v;
  // Superseded / rejected files are kept for audit but not shown to the vendor.
  const vendor = { ...rest, documents: rest.documents.filter((d) => d.status === 'ACTIVE' || (d.status === 'PENDING' && (!d.uploadedById || d.changeRequestId))).map(({ storagePath: _p, ...d }) => d) };
  const tenant = vendorCtx(req).tenant;
  const { config } = await getPublished(tenant.id);
  res.json({
    // Reviewers' identities and remarks are internal; the vendor only sees level, label and status (plus send-back remarks).
    vendor: { ...vendor, steps: v.steps.filter((s) => s.cycle === v.reviewCycle).map((s) => ({ id: s.id, cycle: s.cycle, level: s.level, label: s.label, status: s.status, actedAt: s.actedAt })) },
    sendBackRemarks: v.status === 'SENT_BACK' ? lastSendBack?.remarks : undefined,
    config: { sections: config.sections, guide: config.guide, levels: config.workflow.levels.map((l) => l.label) },
    checklist: buildChecklist(config, profile, activeTypes(v.documents), v.vendorType),
    docRequirements: visibleDocRequirements(config, profile, v.vendorType),
    editable: EDITABLE.includes(v.status),
    lifecycle: v.status === 'APPROVED' ? {
      blocked: !!v.blockedAt,
      // Internal review outcomes stay internal; the vendor sees hold, expiry and pending-change flags.
      flags: flagsFor(v, v.documents, !!(await openChangeRequest(v.id))).filter((f) => !f.code.startsWith('REVIEW_')),
      lastConfirmedAt: v.lastConfirmedAt, nextReviewAt: v.nextReviewAt,
      changeRequests: (await changeRequestsForVendor(v.id)).slice(0, 5).map((cr) => ({ id: cr.id, status: cr.status, byBuyer: !!cr.raisedById, changes: cr.changes, documentIds: cr.documentIds, note: cr.note, remarks: cr.status === 'REJECTED' && !cr.raisedById ? cr.remarks : null, createdAt: cr.createdAt, decidedAt: cr.decidedAt, steps: cr.steps.map((s) => ({ id: s.id, level: s.level, label: s.label, status: s.status })) })),
    } : null,
    buyer: { name: tenant.name, branding: tenant.branding, workspace: tenant.slug, ...localeFor(tenant.country) },
    verifiable: checkList(),
    orders: hasFeature(tenant, 'collab') ? { enabled: true, pending: await pendingOrderCount(v.id) } : { enabled: false, pending: 0 },
    signedInAs: vendorCtx(req).contactEmail ?? v.contactEmail,
    privacy: { ...noticeFor(tenant), needsConsent: needsConsent(tenant, v), consentAt: v.consentAt, consentVersion: v.consentVersion, erasureRequestedAt: v.erasureRequestedAt },
    checks: (await latestChecks(v.id)).map(publicCheck),
    extractions: await extractionsFor(v.id, profile, config),
  });
}));

vendorRouter.put('/profile/:section', ah(async (req, res) => {
  const v = await loadMine(req);
  assertEditable(v.status);
  const key = req.params.section;
  const { config } = await getPublished(v.tenantId);
  if (!config.sections.some((s) => s.key === key)) throw new HttpError(400, 'Unknown section');
  const data = sanitizeSection(config, key, z.record(z.unknown()).parse(req.body));
  const profile = { ...(v.profile as Profile), [key]: { ...((v.profile as Profile)[key] ?? {}), ...data } };
  await db.update(vendors).set({
    profile, status: v.status === 'INVITED' ? 'IN_PROGRESS' : v.status, name: key === 'basic' && data.vendorName ? String(data.vendorName) : v.name,
  }).where(eq(vendors.id, v.id));
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: v.contactEmail, action: 'SECTION_SAVED', detail: { section: key }, ip: req.ip });
  res.json({ checklist: buildChecklist(config, profile, activeTypes(v.documents), v.vendorType), docRequirements: visibleDocRequirements(config, profile, v.vendorType) });
}));

vendorRouter.post('/documents', upload.single('file'), ah(async (req, res) => {
  const v = await loadMine(req);
  if (!req.file) throw new HttpError(400, 'No file uploaded');
  const approved = v.status === 'APPROVED';
  if (!approved) assertEditable(v.status);
  if (approved && await openChangeRequest(v.id)) throw new HttpError(409, 'Wait for your open change request to be decided (or cancel it) before uploading more documents.');
  const docType = String(req.body.docType ?? '');
  const { config } = await getPublished(v.tenantId);
  const req_ = config.documents.find((d) => d.type === docType);
  if (!req_) throw new HttpError(400, 'Unknown document type');
  const expiresOn = checkExpiry(req_, req.body.expiresOn);
  const stored = await storeUpload(v.tenantId, v.id, req.file);
  // Approved vendors' uploads wait in a change request; during onboarding they count straight away.
  const [doc] = await db.insert(documents).values({ tenantId: v.tenantId, vendorId: v.id, docType, ...stored, expiresOn, status: approved ? 'PENDING' : 'ACTIVE' }).returning();
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: v.contactEmail, action: 'DOCUMENT_UPLOADED', detail: { docType, fileName: stored.fileName, scan: stored.scanStatus }, ip: req.ip });
  await queueExtraction(doc, !!vendorCtx(req).tenant.settings.aiExtraction && hasFeature(vendorCtx(req).tenant, 'ai'));
  const { storagePath: _p, ...safe } = doc;
  res.status(201).json(safe);
}));

vendorRouter.delete('/documents/:docId', ah(async (req, res) => {
  const v = await loadMine(req);
  const doc = v.documents.find((d) => d.id === req.params.docId);
  if (!doc) throw new HttpError(404, 'Document not found');
  // Approved vendors may only remove new uploads that aren't part of a submitted change request.
  if (v.status === 'APPROVED') { if (doc.status !== 'PENDING' || doc.changeRequestId || doc.uploadedById) throw new HttpError(409, 'This document is in use. Upload a replacement and submit a change request instead.'); }
  else assertEditable(v.status);
  await db.delete(documents).where(eq(documents.id, doc.id));
  await removeStored(doc);
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: v.contactEmail, action: 'DOCUMENT_REMOVED', detail: { docType: doc.docType, fileName: doc.fileName }, ip: req.ip });
  res.json({ ok: true });
}));

vendorRouter.post('/verify/:kind', ah(async (req, res) => {
  const v = await loadMine(req);
  const kind = z.string().max(40).parse(req.params.kind);
  if (!checkDef(kind)) throw new HttpError(404, 'Unknown check');
  const result = await runKyc(v, kind, z.record(z.string().max(40)).parse(req.body), v.contactEmail);
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: v.contactEmail, action: 'VERIFICATION_RUN', detail: { kind, status: result.status, cached: 'cached' in result }, ip: req.ip });
  res.json(publicCheck(result));
}));

/** Copy AI-read values into the form (only the fields the vendor picked, only fields this workspace has). */
vendorRouter.post('/extractions/:id/apply', ah(async (req, res) => {
  const v = await loadMine(req);
  assertEditable(v.status);
  const { fieldIds } = z.object({ fieldIds: z.array(z.string()).min(1).max(30) }).parse(req.body);
  const ex = await getExtraction(v.tenantId, v.id, req.params.id);
  if (!ex || ex.status !== 'DONE') throw new HttpError(404, 'Nothing to apply');
  const { config } = await getPublished(v.tenantId);
  const profile = structuredClone(v.profile as Profile);
  const applied: string[] = [];
  for (const f of ex.fields.filter((x) => fieldIds.includes(x.fieldId))) {
    const [sec, key] = f.fieldId.split('.');
    const clean = sanitizeSection(config, sec, { [key]: f.value });
    if (key in clean) { profile[sec] = { ...(profile[sec] ?? {}), ...clean }; applied.push(f.fieldId); }
  }
  await db.update(vendors).set({ profile }).where(eq(vendors.id, v.id));
  await db.update(schema.documentExtractions).set({ appliedAt: new Date() }).where(eq(schema.documentExtractions.id, ex.id));
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: v.contactEmail, action: 'AI_VALUES_APPLIED', detail: { fields: applied.join(', ') }, ip: req.ip });
  res.json({ applied, checklist: buildChecklist(config, profile, activeTypes(v.documents), v.vendorType), profile });
}));

vendorRouter.post('/submit', ah(async (req, res) => {
  const v = await loadMine(req);
  assertEditable(v.status);
  const { config } = await getPublished(v.tenantId);
  const checklist = buildChecklist(config, v.profile as Profile, activeTypes(v.documents), v.vendorType);
  if (!isSubmittable(checklist)) {
    throw new HttpError(422, 'Please complete all required fields before submitting', checklist.filter((c) => !c.ok && c.severity === 'error'));
  }
  const resubmission = v.status === 'SENT_BACK';
  await startReview(v);
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: v.contactEmail, action: resubmission ? 'RESUBMITTED' : 'SUBMITTED', ip: req.ip });
  res.json({ ok: true });
}));

/* ---------- After approval ---------- */

vendorRouter.post('/change-requests', ah(async (req, res) => {
  const v = await loadMine(req);
  const input = z.object({ changes: z.record(z.record(z.unknown())).default({}), note: z.string().max(1000).optional() }).parse(req.body);
  const cr = await submitChangeRequest(v, input, req.ip);
  res.status(201).json({ id: cr.id });
}));

vendorRouter.post('/change-requests/:id/cancel', ah(async (req, res) => {
  const v = await loadMine(req);
  await cancelChangeRequest(v, req.params.id, req.ip);
  res.json({ ok: true });
}));

/** Periodic review: the vendor confirms their registered details are still correct. */
vendorRouter.post('/confirm-details', ah(async (req, res) => {
  const v = await loadMine(req);
  if (v.status !== 'APPROVED') throw new HttpError(409, 'Only approved vendors confirm their details');
  await db.update(vendors).set({ lastConfirmedAt: new Date() }).where(eq(vendors.id, v.id));
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: v.contactEmail, action: 'DETAILS_CONFIRMED', ip: req.ip });
  res.json({ ok: true });
}));

/* ---------- Privacy (DPDP) ---------- */

vendorRouter.post('/consent', ah(async (req, res) => {
  const v = await loadMine(req);
  const { version } = z.object({ version: z.number().int() }).parse(req.body);
  await recordConsent(vendorCtx(req).tenant, v, version, req.ip);
  res.json({ ok: true });
}));

/** Access request: everything we hold about the vendor, as a JSON download. */
vendorRouter.get('/my-data', ah(async (req, res) => {
  const v = await loadMine(req);
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: v.contactEmail, action: 'DATA_EXPORTED', detail: { by: 'vendor' }, ip: req.ip });
  res.setHeader('Content-Disposition', `attachment; filename="${v.code}-my-data.json"`);
  res.json(await exportVendorData(v, { forStaff: false }));
}));

/** Withdraw consent and ask for deletion; an administrator acts on it. */
vendorRouter.post('/erasure-request', ah(async (req, res) => {
  const v = await loadMine(req);
  const { reason } = z.object({ reason: z.string().max(500).default('') }).parse(req.body);
  await requestErasure(v, reason, req.ip);
  res.json({ ok: true });
}));
