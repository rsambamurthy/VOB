/**
 * Buyer-assisted onboarding: a buyer fills in the form and uploads documents for a supplier who is still
 * onboarding (invited, in progress or sent back), then either leaves it for the supplier to check and submit,
 * or submits it for approval on the supplier's behalf — recording that the supplier gave the details and was
 * shown the privacy notice. Everything is audited as done "for the supplier".
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { getPublished } from '../services/config.js';
import { buildChecklist, isSubmittable, sanitizeSection, visibleDocRequirements, type Profile } from '../lib/profileEngine.js';
import { isSensitive, maskField, maskProfile } from '../lib/fieldCrypto.js';
import { storeUpload, removeStored } from '../integrations/storage/index.js';
import { queueExtraction } from '../integrations/ai/index.js';
import { hasFeature } from '../services/limits.js';
import { startReview } from '../services/workflowEngine.js';
import { runKyc } from '../integrations/kyc/index.js';
import { checkInputs, checksForVendor, inputsComplete } from '../countries/registry.js';
import { noticeFor } from '../services/privacy.js';
import { checkExpiry, upload } from './vendorPortal.js';

export const assistRouter = Router({ mergeParams: true });
const EDITABLE = ['INVITED', 'IN_PROGRESS', 'SENT_BACK'];
const { vendors, documents } = schema;
const activeTypes = (docs: { status: string; docType: string }[]) => docs.filter((d) => d.status === 'ACTIVE').map((d) => d.docType);

async function editableVendor(tenantId: string, id: string) {
  const v = await db.query.vendors.findFirst({ where: and(eq(vendors.tenantId, tenantId), eq(vendors.id, id)), with: { documents: true } });
  if (!v) throw new HttpError(404, 'Vendor not found');
  if (!EDITABLE.includes(v.status)) throw new HttpError(409, 'This supplier has already submitted. After approval, use Propose change.');
  return v;
}
async function state(tenantId: string, vendorId: string) {
  const v = (await db.query.vendors.findFirst({ where: eq(vendors.id, vendorId), with: { documents: true } }))!;
  const { config } = await getPublished(tenantId);
  const profile = v.profile as Profile;
  return { profile: maskProfile(profile), checklist: buildChecklist(config, profile, activeTypes(v.documents), v.vendorType), docRequirements: visibleDocRequirements(config, profile, v.vendorType) };
}

/** Save one tab. Masked values sent back unchanged (e.g. ••••1234) keep the stored number. */
assistRouter.put('/profile/:section', requireStaff('vendors.create'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await editableVendor(s.tenant.id, req.params.id);
  const key = req.params.section;
  const { config } = await getPublished(v.tenantId);
  if (!config.sections.some((x) => x.key === key)) throw new HttpError(400, 'Unknown section');
  const current = (v.profile as Profile)[key] ?? {};
  const raw = z.record(z.unknown()).parse(req.body);
  for (const [f, val] of Object.entries(raw)) if (isSensitive(`${key}.${f}`) && current[f] && val === maskField(`${key}.${f}`, current[f])) delete raw[f];
  const data = sanitizeSection(config, key, raw);
  const profile = { ...(v.profile as Profile), [key]: { ...current, ...data } };
  await db.update(vendors).set({ profile, status: v.status === 'INVITED' ? 'IN_PROGRESS' : v.status, name: key === 'basic' && data.vendorName ? String(data.vendorName) : v.name }).where(eq(vendors.id, v.id));
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: s.user.name, action: 'SECTION_SAVED', detail: { section: key, onBehalf: 'yes' }, ip: req.ip });
  res.json(await state(s.tenant.id, v.id));
}));

assistRouter.post('/documents', requireStaff('vendors.create'), upload.single('file'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await editableVendor(s.tenant.id, req.params.id);
  if (!req.file) throw new HttpError(400, 'No file uploaded');
  const docType = String(req.body.docType ?? '');
  const { config } = await getPublished(v.tenantId);
  const req_ = config.documents.find((d) => d.type === docType);
  if (!req_) throw new HttpError(400, 'Unknown document type');
  const expiresOn = checkExpiry(req_, req.body.expiresOn);
  const stored = await storeUpload(v.tenantId, v.id, req.file);
  const [doc] = await db.insert(documents).values({ tenantId: v.tenantId, vendorId: v.id, docType, ...stored, expiresOn, status: 'ACTIVE', uploadedById: s.user.id }).returning();
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: s.user.name, action: 'DOCUMENT_UPLOADED', detail: { docType, fileName: stored.fileName, onBehalf: 'yes' }, ip: req.ip });
  // Read by AI as for the supplier's own uploads (suggestions only; nothing is filled automatically for staff).
  await queueExtraction(doc, !!s.tenant.settings.aiExtraction && hasFeature(s.tenant, 'ai'));
  res.status(201).json(await state(s.tenant.id, v.id));
}));

assistRouter.delete('/documents/:docId', requireStaff('vendors.create'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await editableVendor(s.tenant.id, req.params.id);
  const doc = v.documents.find((d) => d.id === req.params.docId);
  if (!doc) throw new HttpError(404, 'Document not found');
  await db.delete(documents).where(eq(documents.id, doc.id));
  await removeStored(doc);
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: s.user.name, action: 'DOCUMENT_REMOVED', detail: { docType: doc.docType, fileName: doc.fileName, onBehalf: 'yes' }, ip: req.ip });
  res.json(await state(s.tenant.id, v.id));
}));

/** Submit for approval on the supplier's behalf. The buyer confirms the supplier provided the details and saw the privacy notice. */
assistRouter.post('/submit', requireStaff('vendors.create'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await editableVendor(s.tenant.id, req.params.id);
  const { confirm } = z.object({ confirm: z.literal(true, { errorMap: () => ({ message: 'Confirm that the supplier gave these details and was shown the privacy notice' }) }) }).parse(req.body);
  const { config } = await getPublished(v.tenantId);
  const checklist = buildChecklist(config, v.profile as Profile, activeTypes(v.documents), v.vendorType);
  if (!isSubmittable(checklist)) throw new HttpError(422, 'Complete all required fields and documents first', checklist.filter((c) => !c.ok && c.severity === 'error'));
  if (!v.consentVersion) {
    // The supplier didn't accept the notice in the portal: record that the buyer showed it to them.
    await db.update(vendors).set({ consentAt: new Date(), consentVersion: noticeFor(s.tenant).version, consentIp: `buyer: ${s.user.name}` }).where(eq(vendors.id, v.id));
    await audit({ tenantId: v.tenantId, vendorId: v.id, actor: s.user.name, action: 'CONSENT_RECORDED_BY_BUYER', detail: { noticeVersion: noticeFor(s.tenant).version, confirm }, ip: req.ip });
  }
  for (const { def } of checksForVendor(s.tenant.country, v.profile as Profile).filter((c) => c.def.runOnSubmit)) {
    const input = checkInputs(def, v.profile as Profile);
    if (inputsComplete(def, input)) await runKyc(v, def.kind, input, 'system (on submit)').catch(() => {});
  }
  const resubmission = v.status === 'SENT_BACK';
  await startReview(v);
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: s.user.name, action: resubmission ? 'RESUBMITTED' : 'SUBMITTED', detail: { onBehalf: 'yes' }, ip: req.ip });
  res.json({ ok: true });
}));
