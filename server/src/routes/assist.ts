/**
 * Buyer-assisted onboarding: a buyer fills in the form and uploads documents for a supplier who is still
 * onboarding (invited, in progress or sent back), then either leaves it for the supplier to check and submit,
 * or submits it for approval on the supplier's behalf — recording that the supplier gave the details and was
 * shown the privacy notice. Everything is audited as done "for the supplier".
 *
 * The rules are the supplier portal's (services/onboarding.ts); this file only adds the buyer's permissions,
 * masking and the consent confirmation.
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { getPublished } from '../services/config.js';
import type { Profile } from '../lib/profileEngine.js';
import { maskProfile } from '../lib/fieldCrypto.js';
import { removeStored } from '../integrations/storage/index.js';
import { noticeFor } from '../services/privacy.js';
import { upload } from '../lib/upload.js';
import { addDocument, applyExtractedValues, formState, isEditableStatus, saveSection, submitForReview, type Actor } from '../services/onboarding.js';
import type { Tenant } from '../db/schema.js';
import { recordSignedCopy } from '../services/agreements.js';

export const assistRouter = Router({ mergeParams: true });
const { vendors, documents } = schema;

async function editableVendor(tenantId: string, id: string) {
  const v = await db.query.vendors.findFirst({ where: and(eq(vendors.tenantId, tenantId), eq(vendors.id, id)), with: { documents: true } });
  if (!v) throw new HttpError(404, 'Vendor not found');
  if (!isEditableStatus(v.status)) throw new HttpError(409, 'This supplier has already submitted. After approval, use Propose change.');
  return v;
}
async function state(tenant: Tenant, vendorId: string) {
  const v = (await db.query.vendors.findFirst({ where: eq(vendors.id, vendorId), with: { documents: true } }))!;
  const { config } = await getPublished(tenant.id);
  return { profile: maskProfile(v.profile as Profile), ...(await formState(tenant, config, v)) };
}
const buyer = (req: Parameters<typeof staffCtx>[0]): Actor => { const s = staffCtx(req); return { name: s.user.name, userId: s.user.id, onBehalf: true, ip: req.ip }; };

assistRouter.put('/profile/:section', requireStaff('vendors.create'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await editableVendor(s.tenant.id, req.params.id);
  const { config } = await getPublished(v.tenantId);
  await saveSection(config, v, req.params.section, z.record(z.unknown()).parse(req.body), buyer(req));
  res.json(await state(s.tenant, v.id));
}));

assistRouter.post('/documents', requireStaff('vendors.create'), upload.single('file'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await editableVendor(s.tenant.id, req.params.id);
  if (!req.file) throw new HttpError(400, 'No file uploaded');
  const { config } = await getPublished(v.tenantId);
  await addDocument(s.tenant, config, v, req.file, String(req.body.docType ?? ''), req.body.expiresOn, buyer(req));
  res.status(201).json(await state(s.tenant, v.id));
}));

assistRouter.delete('/documents/:docId', requireStaff('vendors.create'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await editableVendor(s.tenant.id, req.params.id);
  const doc = v.documents.find((d) => d.id === req.params.docId);
  if (!doc) throw new HttpError(404, 'Document not found');
  await db.delete(documents).where(eq(documents.id, doc.id));
  await removeStored(doc);
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: s.user.name, action: 'DOCUMENT_REMOVED', detail: { docType: doc.docType, fileName: doc.fileName, onBehalf: 'yes' }, ip: req.ip });
  res.json(await state(s.tenant, v.id));
}));

/** Use values read from a document (e.g. the bank account from a cancelled cheque, which is never filled automatically). */
assistRouter.post('/extractions/:exId/apply', requireStaff('vendors.create'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await editableVendor(s.tenant.id, req.params.id);
  const { fieldIds } = z.object({ fieldIds: z.array(z.string()).min(1).max(30) }).parse(req.body);
  const { config } = await getPublished(v.tenantId);
  const { applied } = await applyExtractedValues(config, v, req.params.exId, fieldIds, buyer(req));
  res.json({ applied, ...(await state(s.tenant, v.id)) });
}));

/** Record an agreement the supplier signed on paper or by email: the signed copy is kept, with who signed it. */
assistRouter.post('/agreements/:agreementId/signed-copy', requireStaff('vendors.create'), upload.single('file'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await editableVendor(s.tenant.id, req.params.id);
  if (!req.file) throw new HttpError(400, 'Attach the signed copy');
  const signer = z.object({ signerName: z.string().trim().min(3, 'Who signed it?').max(120), signerDesignation: z.string().trim().min(2, 'Their designation').max(120) }).parse(req.body);
  await recordSignedCopy(v, req.params.agreementId, signer, req.file, { id: s.user.id, name: s.user.name, email: s.user.email, ip: req.ip });
  res.status(201).json(await state(s.tenant, v.id));
}));

/** Submit for approval on the supplier's behalf. The buyer confirms the supplier provided the details and saw the privacy notice. */
assistRouter.post('/submit', requireStaff('vendors.create'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await editableVendor(s.tenant.id, req.params.id);
  const { confirm } = z.object({ confirm: z.literal(true, { errorMap: () => ({ message: 'Confirm that the supplier gave these details and was shown the privacy notice' }) }) }).parse(req.body);
  const { config } = await getPublished(v.tenantId);
  if (!v.consentVersion && (await formState(s.tenant, config, v)).checklist.every((c) => c.ok || c.severity !== 'error')) {
    // The supplier didn't accept the notice in the portal: record that the buyer showed it to them.
    await db.update(vendors).set({ consentAt: new Date(), consentVersion: noticeFor(s.tenant).version, consentIp: `buyer: ${s.user.name}` }).where(eq(vendors.id, v.id));
    await audit({ tenantId: v.tenantId, vendorId: v.id, actor: s.user.name, action: 'CONSENT_RECORDED_BY_BUYER', detail: { noticeVersion: noticeFor(s.tenant).version, confirm }, ip: req.ip });
  }
  await submitForReview(s.tenant, config, v, buyer(req));
  res.json({ ok: true });
}));
