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
import { runKyc, latestChecks, type KycKind } from '../integrations/kyc/index.js';
import { queueExtraction, extractionsFor, getExtraction } from '../integrations/ai/index.js';

export const vendorRouter = Router();
vendorRouter.use(requireVendor);

const EDITABLE = ['INVITED', 'IN_PROGRESS', 'SENT_BACK'];
const ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg'];

// Files are held in memory (max 5 MB), checked and scanned, then written to the configured storage.
const upload = multer({
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

function assertEditable(status: string) {
  if (!EDITABLE.includes(status)) throw new HttpError(409, 'Your registration has been submitted and can no longer be edited');
}

vendorRouter.get('/', ah(async (req, res) => {
  const v = await loadMine(req);
  const profile = v.profile as Profile;
  const lastSendBack = v.steps.find((s) => s.status === 'SENT_BACK' && s.cycle === v.reviewCycle);
  const { inviteToken: _t, ...vendor } = v;
  const tenant = vendorCtx(req).tenant;
  const { config } = await getPublished(tenant.id);
  res.json({
    // Reviewers' identities and remarks are internal; the vendor only sees level, label and status (plus send-back remarks).
    vendor: { ...vendor, steps: v.steps.filter((s) => s.cycle === v.reviewCycle).map((s) => ({ id: s.id, cycle: s.cycle, level: s.level, label: s.label, status: s.status, actedAt: s.actedAt })) },
    sendBackRemarks: v.status === 'SENT_BACK' ? lastSendBack?.remarks : undefined,
    config: { sections: config.sections, guide: config.guide, levels: config.workflow.levels.map((l) => l.label) },
    checklist: buildChecklist(config, profile, v.documents.map((d) => d.docType), v.vendorType),
    docRequirements: visibleDocRequirements(config, profile, v.vendorType),
    editable: EDITABLE.includes(v.status),
    buyer: { name: tenant.name, branding: tenant.branding },
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
  res.json({ checklist: buildChecklist(config, profile, v.documents.map((d) => d.docType), v.vendorType), docRequirements: visibleDocRequirements(config, profile, v.vendorType) });
}));

vendorRouter.post('/documents', upload.single('file'), ah(async (req, res) => {
  const v = await loadMine(req);
  if (!req.file) throw new HttpError(400, 'No file uploaded');
  assertEditable(v.status);
  const docType = String(req.body.docType ?? '');
  const { config } = await getPublished(v.tenantId);
  if (!config.documents.some((d) => d.type === docType)) throw new HttpError(400, 'Unknown document type');
  const stored = await storeUpload(v.tenantId, v.id, req.file);
  const [doc] = await db.insert(documents).values({ tenantId: v.tenantId, vendorId: v.id, docType, ...stored }).returning();
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: v.contactEmail, action: 'DOCUMENT_UPLOADED', detail: { docType, fileName: stored.fileName, scan: stored.scanStatus }, ip: req.ip });
  await queueExtraction(doc, !!vendorCtx(req).tenant.settings.aiExtraction);
  const { storagePath: _p, ...safe } = doc;
  res.status(201).json(safe);
}));

vendorRouter.delete('/documents/:docId', ah(async (req, res) => {
  const v = await loadMine(req);
  assertEditable(v.status);
  const doc = v.documents.find((d) => d.id === req.params.docId);
  if (!doc) throw new HttpError(404, 'Document not found');
  await db.delete(documents).where(eq(documents.id, doc.id));
  await removeStored(doc);
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: v.contactEmail, action: 'DOCUMENT_REMOVED', detail: { docType: doc.docType, fileName: doc.fileName }, ip: req.ip });
  res.json({ ok: true });
}));

vendorRouter.post('/verify/:kind', ah(async (req, res) => {
  const v = await loadMine(req);
  const kind = z.enum(['gstin', 'pan', 'bank', 'cin']).parse(req.params.kind) as KycKind;
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
  res.json({ applied, checklist: buildChecklist(config, profile, v.documents.map((d) => d.docType), v.vendorType), profile });
}));

vendorRouter.post('/submit', ah(async (req, res) => {
  const v = await loadMine(req);
  assertEditable(v.status);
  const { config } = await getPublished(v.tenantId);
  const checklist = buildChecklist(config, v.profile as Profile, v.documents.map((d) => d.docType), v.vendorType);
  if (!isSubmittable(checklist)) {
    throw new HttpError(422, 'Please complete all required fields before submitting', checklist.filter((c) => !c.ok && c.severity === 'error'));
  }
  const resubmission = v.status === 'SENT_BACK';
  await startReview(v);
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: v.contactEmail, action: resubmission ? 'RESUBMITTED' : 'SUBMITTED', ip: req.ip });
  res.json({ ok: true });
}));
