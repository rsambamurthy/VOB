import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { asc, desc, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';

const { vendors, documents, approvalSteps } = schema;
import { ah, HttpError } from '../lib/http.js';
import { requireVendor, vendorPrincipal } from '../lib/auth.js';
import { env } from '../lib/env.js';
import { audit } from '../lib/audit.js';
import { formSchema, documentRequirements } from '../config/formSchema.js';
import { buildChecklist, isSubmittable, sanitizeSection, visibleDocRequirements, type Profile } from '../lib/profileEngine.js';
import { startReview } from '../lib/workflowEngine.js';
import { verify, type VerifyKind } from '../lib/verification.js';

export const vendorRouter = Router();
vendorRouter.use(requireVendor);

const EDITABLE = ['INVITED', 'IN_PROGRESS', 'SENT_BACK'];
const ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg'];
fs.mkdirSync(env.uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: env.uploadDir,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => (ALLOWED_MIME.includes(file.mimetype) ? cb(null, true) : cb(new HttpError(400, 'Only PDF, PNG or JPG files are allowed'))),
});

async function loadMine(req: Parameters<typeof vendorPrincipal>[0]) {
  const { vendorId } = vendorPrincipal(req);
  const v = await db.query.vendors.findFirst({
    where: eq(vendors.id, vendorId),
    with: { documents: { orderBy: desc(documents.uploadedAt) }, steps: { orderBy: [desc(approvalSteps.cycle), asc(approvalSteps.level)] } },
  });
  if (!v) throw new HttpError(404, 'Vendor not found');
  return v;
}

function assertEditable(status: string) {
  if (!EDITABLE.includes(status)) throw new HttpError(409, 'Your registration has been submitted and can no longer be edited');
}

vendorRouter.get('/', ah(async (req, res) => {
  const v = await loadMine(req);
  const profile = v.profile as Profile;
  const lastSendBack = v.steps.find((s) => s.status === 'SENT_BACK' && s.cycle === v.reviewCycle);
  const { inviteToken: _t, ...vendor } = v;
  res.json({
    vendor: { ...vendor, steps: v.steps.filter((s) => s.cycle === v.reviewCycle).map(({ remarks: _r, ...s }) => s) }, // reviewers' remarks are internal, except send-back
    sendBackRemarks: v.status === 'SENT_BACK' ? lastSendBack?.remarks : undefined,
    checklist: buildChecklist(profile, v.documents.map((d) => d.docType)),
    docRequirements: visibleDocRequirements(profile),
    editable: EDITABLE.includes(v.status),
  });
}));

vendorRouter.put('/profile/:section', ah(async (req, res) => {
  const v = await loadMine(req);
  assertEditable(v.status);
  const key = req.params.section;
  if (!formSchema.some((s) => s.key === key)) throw new HttpError(400, 'Unknown section');
  const data = sanitizeSection(key, z.record(z.unknown()).parse(req.body));
  const profile = { ...(v.profile as Profile), [key]: { ...((v.profile as Profile)[key] ?? {}), ...data } };
  await db.update(vendors).set({
    profile, status: v.status === 'INVITED' ? 'IN_PROGRESS' : v.status, name: key === 'basic' && data.vendorName ? String(data.vendorName) : v.name,
  }).where(eq(vendors.id, v.id));
  await audit(v.id, v.contactEmail, 'SECTION_SAVED', { section: key });
  res.json({ checklist: buildChecklist(profile, v.documents.map((d) => d.docType)), docRequirements: visibleDocRequirements(profile) });
}));

vendorRouter.post('/documents', upload.single('file'), ah(async (req, res) => {
  const v = await loadMine(req);
  if (!req.file) throw new HttpError(400, 'No file uploaded');
  try {
    assertEditable(v.status);
    const docType = String(req.body.docType ?? '');
    if (!documentRequirements.some((d) => d.type === docType)) throw new HttpError(400, 'Unknown document type');
    const [doc] = await db.insert(documents).values({
      vendorId: v.id, docType, fileName: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size, storagePath: req.file.filename,
    }).returning();
    await audit(v.id, v.contactEmail, 'DOCUMENT_UPLOADED', { docType, fileName: req.file.originalname });
    res.status(201).json(doc);
  } catch (e) {
    fs.rm(path.join(env.uploadDir, req.file.filename), () => {});
    throw e;
  }
}));

vendorRouter.delete('/documents/:docId', ah(async (req, res) => {
  const v = await loadMine(req);
  assertEditable(v.status);
  const doc = v.documents.find((d) => d.id === req.params.docId);
  if (!doc) throw new HttpError(404, 'Document not found');
  await db.delete(documents).where(eq(documents.id, doc.id));
  fs.rm(path.join(env.uploadDir, doc.storagePath), () => {});
  await audit(v.id, v.contactEmail, 'DOCUMENT_REMOVED', { docType: doc.docType, fileName: doc.fileName });
  res.json({ ok: true });
}));

vendorRouter.post('/verify/:kind', ah(async (req, res) => {
  const v = await loadMine(req);
  const kind = z.enum(['gstin', 'pan', 'bank', 'cin']).parse(req.params.kind) as VerifyKind;
  const result = verify(kind, z.record(z.string()).parse(req.body), v.name);
  const profile = v.profile as Profile;
  const verifications = { ...((profile._verifications as Record<string, unknown>) ?? {}), [kind]: result };
  await db.update(vendors).set({ profile: { ...profile, _verifications: verifications as Record<string, unknown> } }).where(eq(vendors.id, v.id));
  await audit(v.id, v.contactEmail, 'VERIFICATION_RUN', { kind, status: result.status });
  res.json(result);
}));

vendorRouter.post('/submit', ah(async (req, res) => {
  const v = await loadMine(req);
  assertEditable(v.status);
  const checklist = buildChecklist(v.profile as Profile, v.documents.map((d) => d.docType));
  if (!isSubmittable(checklist)) {
    throw new HttpError(422, 'Please complete all required fields before submitting', checklist.filter((c) => !c.ok && c.severity === 'error'));
  }
  const resubmission = v.status === 'SENT_BACK';
  await startReview(v);
  await audit(v.id, v.contactEmail, resubmission ? 'RESUBMITTED' : 'SUBMITTED');
  res.json({ ok: true });
}));
