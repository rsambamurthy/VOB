import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';

const { vendors, documents, approvalSteps } = schema;
import { ah, HttpError } from '../lib/http.js';
import { requireVendor, vendorCtx } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { getPublished } from '../services/config.js';
import { buildChecklist, type Profile } from '../lib/profileEngine.js';
import { removeStored } from '../integrations/storage/index.js';
import { runKyc, latestChecks } from '../integrations/kyc/index.js';
import { checkDef, checkList, checkOffered, localeFor } from '../countries/registry.js';
import { hasFeature } from '../services/limits.js';
import { pendingOrderCount } from '../services/orders/queries.js';
import { scorecardFor } from '../services/scorecards.js';
import { extractionsFor, dataEntryMode } from '../integrations/ai/index.js';
import { exportVendorData, needsConsent, noticeFor, recordConsent, requestErasure } from '../services/privacy.js';
import { cancelChangeRequest, changeRequestsForVendor, flagsFor, openChangeRequest, submitChangeRequest } from '../services/lifecycle.js';
import { arLabel, localizeConfig, supplierLanguages, translateMessage, vendorLanguage, type Lang } from '../i18n/index.js';
import { activeTypes, addDocument, applyExtractedValues, docRequirementsFor, formState, isEditableStatus, saveSection, submitForReview, type Actor } from '../services/onboarding.js';
import { upload } from '../lib/upload.js';

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

/** The supplier, as the one acting (their contact email is what the history shows). */
const supplier = (req: { ip?: string }, v: { contactEmail: string }): Actor => ({ name: v.contactEmail, ip: req.ip });

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
  if (!isEditableStatus(status)) throw new HttpError(409, 'Your registration has been submitted and can no longer be edited');
}

/** Checklist items in the supplier's language (labels come from the localized form; messages are translated). */
const localChecklist = <T extends { label: string; message?: string }>(items: T[], lang: Lang) =>
  (lang === 'en' ? items : items.map((i) => ({ ...i, label: translateMessage(i.label, lang), message: i.message ? translateMessage(i.message, lang) : i.message })));
const arLabelFor = (s: string, lang: Lang) => (lang === 'ar' ? arLabel(s) : s);

/** The supplier's portal and email language (from the languages the buyer offers). */
vendorRouter.put('/language', ah(async (req, res) => {
  const v = await loadMine(req);
  const { language } = z.object({ language: z.enum(['en', 'ar']) }).parse(req.body);
  if (!supplierLanguages(vendorCtx(req).tenant).includes(language)) throw new HttpError(400, 'This language isn’t offered');
  await db.update(vendors).set({ language }).where(eq(vendors.id, v.id));
  res.json({ language });
}));

vendorRouter.get('/', ah(async (req, res) => {
  const v = await loadMine(req);
  const profile = v.profile as Profile;
  const lang = vendorLanguage(vendorCtx(req).tenant, v);
  const lastSendBack = v.steps.find((s) => s.status === 'SENT_BACK' && s.cycle === v.reviewCycle);
  const { inviteToken: _t, ...rest } = v;
  // Superseded / rejected files are kept for audit but not shown to the vendor.
  const vendor = { ...rest, documents: rest.documents.filter((d) => d.status === 'ACTIVE' || (d.status === 'PENDING' && (!d.uploadedById || d.changeRequestId))).map(({ storagePath: _p, ...d }) => d) };
  const tenant = vendorCtx(req).tenant;
  const { config: stored } = await getPublished(tenant.id);
  // What the supplier reads is in their language; values and rules are the same.
  const config = localizeConfig(stored, lang);
  const tx = (s: string) => translateMessage(s, lang);
  res.json({
    language: lang,
    // Reviewers' identities and remarks are internal; the vendor only sees level, label and status (plus send-back remarks).
    vendor: { ...vendor, steps: v.steps.filter((s) => s.cycle === v.reviewCycle).map((s) => ({ id: s.id, cycle: s.cycle, level: s.level, label: arLabelFor(s.label, lang), status: s.status, actedAt: s.actedAt })) },
    sendBackRemarks: v.status === 'SENT_BACK' ? lastSendBack?.remarks : undefined,
    config: { sections: config.sections, guide: config.guide, levels: config.workflow.levels.map((l) => l.label) },
    checklist: localChecklist(buildChecklist(config, profile, activeTypes(v.documents), v.vendorType), lang),
    // Documents first: documents that depend on answers not yet given are offered "if it applies".
    docRequirements: docRequirementsFor(tenant, config, profile, v),
    editable: isEditableStatus(v.status),
    lifecycle: v.status === 'APPROVED' ? {
      blocked: !!v.blockedAt,
      // Held because a required document lapsed: the supplier can upload the renewal; the reason is shown.
      hold: v.blockedAt && v.blockSource === 'EXPIRY' ? { reason: v.blockedReason && lang === 'ar' ? v.blockedReason.replace(/^Expired: /, '').split('; ').map((d) => arLabelFor(d, lang)).join('؛ ') : v.blockedReason } : null,
      // Internal review outcomes stay internal; the vendor sees hold, expiry and pending-change flags.
      flags: flagsFor(v, v.documents, !!(await openChangeRequest(v.id))).filter((f) => !f.code.startsWith('REVIEW_') && f.code !== 'EMAIL_BOUNCING').map((f) => ({ ...f, label: tx(f.label) })),
      lastConfirmedAt: v.lastConfirmedAt, nextReviewAt: v.nextReviewAt,
      changeRequests: (await changeRequestsForVendor(v.id)).slice(0, 5).map((cr) => ({ id: cr.id, status: cr.status, byBuyer: !!cr.raisedById, changes: cr.changes, documentIds: cr.documentIds, note: cr.note, remarks: cr.status === 'REJECTED' && !cr.raisedById ? cr.remarks : null, createdAt: cr.createdAt, decidedAt: cr.decidedAt, steps: cr.steps.map((s) => ({ id: s.id, level: s.level, label: arLabelFor(s.label, lang), status: s.status })) })),
    } : null,
    buyer: { name: tenant.name, branding: tenant.branding, workspace: tenant.slug, ...localeFor(tenant.country), languages: supplierLanguages(tenant) },
    // Internal compliance checks (sanctions screening) are run by the buyer, never shown to the supplier.
    verifiable: checkList(tenant.country).filter((c) => c.scope !== 'home').map((c) => (lang === 'en' ? c : { ...c, label: tx(c.label), buttonLabel: tx(c.buttonLabel), resultLabels: c.resultLabels && { ok: tx(c.resultLabels.ok), fail: tx(c.resultLabels.fail) } })),
    orders: hasFeature(tenant, 'collab') ? { enabled: true, pending: await pendingOrderCount(v.id) } : { enabled: false, pending: 0 },
    signedInAs: vendorCtx(req).contactEmail ?? v.contactEmail,
    privacy: { ...noticeFor(tenant, lang), needsConsent: needsConsent(tenant, v), consentAt: v.consentAt, consentVersion: v.consentVersion, erasureRequestedAt: v.erasureRequestedAt },
    checks: (await latestChecks(v.id)).filter((c) => checkDef(c.kind)?.def.scope !== 'home').map((c) => { const p = publicCheck(c); return { ...p, message: tx(p.message) }; }),
    extractions: await extractionsFor(v.id, profile, config),
    // 'automatic': the portal starts with the documents and fills the form from them.
    dataEntry: dataEntryMode(tenant),
    // The buyer shares the supplier's performance scorecard with them.
    scorecard: !!tenant.settings.scorecard?.showToSuppliers && v.status === 'APPROVED',
  });
}));

/** The supplier's own performance scorecard, when the buyer shares it (no buyer names or comments). */
vendorRouter.get('/scorecard', ah(async (req, res) => {
  const v = await loadMine(req);
  const tenant = vendorCtx(req).tenant;
  if (!tenant.settings.scorecard?.showToSuppliers || v.status !== 'APPROVED') throw new HttpError(404, 'Not available');
  const days = [30, 90, 180, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 90;
  const { ratings, ...card } = await scorecardFor(tenant, v.id, days);
  res.json({ ...card, ratingsCount: ratings.length, late: card.late.map(({ poId: _p, ...l }) => l) });
}));

vendorRouter.put('/profile/:section', ah(async (req, res) => {
  const v = await loadMine(req);
  assertEditable(v.status);
  const { config } = await getPublished(v.tenantId);
  const profile = await saveSection(config, v, req.params.section, z.record(z.unknown()).parse(req.body), supplier(req, v));
  const lang = vendorLanguage(vendorCtx(req).tenant, v);
  const shown = formState(vendorCtx(req).tenant, localizeConfig(config, lang), v, profile);
  res.json({ ...shown, checklist: localChecklist(shown.checklist, lang) });
}));

vendorRouter.post('/documents', upload.single('file'), ah(async (req, res) => {
  const v = await loadMine(req);
  if (!req.file) throw new HttpError(400, 'No file uploaded');
  const approved = v.status === 'APPROVED';
  if (!approved) assertEditable(v.status);
  if (approved && await openChangeRequest(v.id)) throw new HttpError(409, 'Wait for your open change request to be decided (or cancel it) before uploading more documents.');
  const { config } = await getPublished(v.tenantId);
  // Approved vendors' uploads wait in a change request; during onboarding they count straight away.
  const doc = await addDocument(vendorCtx(req).tenant, config, v, req.file, String(req.body.docType ?? ''), req.body.expiresOn, supplier(req, v), { pending: approved });
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
  const found = checkDef(kind);
  if (!found || found.def.scope === 'home' || !checkOffered(found.def, vendorCtx(req).tenant.country)) throw new HttpError(404, 'Unknown check');
  const result = await runKyc(v, kind, z.record(z.string().max(40)).parse(req.body), v.contactEmail);
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: v.contactEmail, action: 'VERIFICATION_RUN', detail: { kind, status: result.status, cached: 'cached' in result }, ip: req.ip });
  const shown = publicCheck(result);
  res.json({ ...shown, message: translateMessage(shown.message, vendorLanguage(vendorCtx(req).tenant, v)) });
}));

/** Copy AI-read values into the form (only the fields the vendor picked, only fields this workspace has). */
vendorRouter.post('/extractions/:id/apply', ah(async (req, res) => {
  const v = await loadMine(req);
  assertEditable(v.status);
  const { fieldIds } = z.object({ fieldIds: z.array(z.string()).min(1).max(30) }).parse(req.body);
  const { config } = await getPublished(v.tenantId);
  const { applied, profile } = await applyExtractedValues(config, v, req.params.id, fieldIds, supplier(req, v));
  const lang = vendorLanguage(vendorCtx(req).tenant, v);
  res.json({ applied, checklist: localChecklist(buildChecklist(localizeConfig(config, lang), profile, activeTypes(v.documents), v.vendorType), lang), profile });
}));

vendorRouter.post('/submit', ah(async (req, res) => {
  const v = await loadMine(req);
  assertEditable(v.status);
  const { config } = await getPublished(v.tenantId);
  const lang = vendorLanguage(vendorCtx(req).tenant, v);
  await submitForReview(vendorCtx(req).tenant, config, v, supplier(req, v),
    () => localChecklist(buildChecklist(localizeConfig(config, lang), v.profile as Profile, activeTypes(v.documents), v.vendorType), lang).filter((c) => !c.ok && c.severity === 'error'));
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
