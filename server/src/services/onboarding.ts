/**
 * Filling in the onboarding form — one implementation for both ways it happens:
 *  - the supplier in their portal (routes/vendorPortal.ts), and
 *  - a buyer filling it in on the supplier's behalf (routes/assist.ts).
 * Routes only check who may do what and shape the response; every rule about saving a tab, adding a document,
 * documents-first, using values read from a document and submitting lives here, so the two can't drift apart.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { activeTypes, isEditableStatus } from '../lib/onboardingStatus.js';
import { buildChecklist, fillImpliedAnswers, fitToField, isSubmittable, sanitizeSection, visibleDocRequirements, type Profile } from '../lib/profileEngine.js';
import { isSensitive, maskField } from '../lib/fieldCrypto.js';
import { storeUpload } from '../integrations/storage/index.js';
import { answerFromDocument, dataEntryMode, getExtraction, queueExtraction, willReadLive } from '../integrations/ai/index.js';
import { runKyc } from '../integrations/kyc/index.js';
import { checkInputs, checksForVendor, inputsComplete } from '../countries/registry.js';
import { hasFeature } from './limits.js';
import { startReview } from './workflowEngine.js';
import { withIdentity } from './duplicates.js';
import type { OnboardingConfig } from '../config/types.js';
import type { Tenant, Vendor } from '../db/schema.js';

export { activeTypes, isEditableStatus, EDITABLE_STATUSES } from '../lib/onboardingStatus.js';

/** Who is acting: the supplier (their email), or a buyer's user on the supplier's behalf. */
export interface Actor { name: string; userId?: string; onBehalf?: boolean; ip?: string }
const behalf = (a: Actor) => (a.onBehalf ? { onBehalf: 'yes' } : {});
type VendorWithDocs = Vendor & { documents: { status: string; docType: string }[] };

const aiAllowed = (t: Tenant) => !!t.settings.aiExtraction && hasFeature(t, 'ai');

/** Documents first (Automatic data entry): documents whose question isn't answered yet are offered "if it applies". */
export function docRequirementsFor(tenant: Tenant, config: OnboardingConfig, profile: Profile, vendor: Pick<Vendor, 'vendorType' | 'status'>) {
  return visibleDocRequirements(config, profile, vendor.vendorType, { undecided: dataEntryMode(tenant) === 'automatic' && isEditableStatus(vendor.status) });
}

/** The form state either side shows after a change: checklist and which documents apply. */
export function formState(tenant: Tenant, config: OnboardingConfig, vendor: VendorWithDocs, profile = vendor.profile as Profile) {
  return { checklist: buildChecklist(config, profile, activeTypes(vendor.documents), vendor.vendorType), docRequirements: docRequirementsFor(tenant, config, profile, vendor) };
}

/**
 * Save one tab. For a buyer, masked values sent back unchanged (••••1234) keep the stored number — staff only
 * ever see sensitive values masked.
 */
export async function saveSection(config: OnboardingConfig, v: Vendor, key: string, raw: Record<string, unknown>, actor: Actor) {
  if (!config.sections.some((x) => x.key === key)) throw new HttpError(400, 'Unknown section');
  const current = (v.profile as Profile)[key] ?? {};
  const input = { ...raw };
  if (actor.onBehalf) for (const [f, val] of Object.entries(input)) if (isSensitive(`${key}.${f}`) && current[f] && val === maskField(`${key}.${f}`, current[f])) delete input[f];
  const data = sanitizeSection(config, key, input);
  const profile = { ...(v.profile as Profile), [key]: { ...current, ...data } };
  await db.update(schema.vendors).set({ ...withIdentity(profile), status: v.status === 'INVITED' ? 'IN_PROGRESS' : v.status, name: key === 'basic' && data.vendorName ? String(data.vendorName) : v.name }).where(eq(schema.vendors.id, v.id));
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: actor.name, action: 'SECTION_SAVED', detail: { section: key, ...behalf(actor) }, ip: actor.ip });
  return profile;
}

/** Validate a "valid until" date for a document type that expires. Returns the date or null. */
export function checkExpiry(req_: { label: string; hasExpiry?: boolean }, raw: unknown) {
  const expiresOn = typeof raw === 'string' && raw ? raw : null;
  if (req_.hasExpiry && !expiresOn) throw new HttpError(400, `Enter the date this ${req_.label} is valid until`);
  if (expiresOn && (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn) || Number.isNaN(Date.parse(expiresOn)))) throw new HttpError(400, 'Valid-until date is not a valid date');
  if (expiresOn && expiresOn < new Date().toISOString().slice(0, 10)) throw new HttpError(400, 'This document has already expired. Upload a current one.');
  return expiresOn;
}

/**
 * Add a document. During onboarding it counts straight away (ACTIVE); for an approved supplier it waits in a
 * change request (PENDING). It is read by AI, and — documents first — a document offered "if it applies"
 * answers its question (once a live AI has confirmed what the document is).
 */
export async function addDocument(tenant: Tenant, config: OnboardingConfig, v: Vendor, file: Express.Multer.File, docType: string, expiresOnRaw: unknown, actor: Actor, opts: { pending?: boolean } = {}) {
  const req_ = config.documents.find((d) => d.type === docType);
  if (!req_) throw new HttpError(400, 'Unknown document type');
  const expiresOn = checkExpiry(req_, expiresOnRaw);
  const stored = await storeUpload(v.tenantId, v.id, file);
  const [doc] = await db.insert(schema.documents).values({ tenantId: v.tenantId, vendorId: v.id, docType, ...stored, expiresOn, status: opts.pending ? 'PENDING' : 'ACTIVE', ...(actor.userId ? { uploadedById: actor.userId } : {}) }).returning();
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: actor.name, action: 'DOCUMENT_UPLOADED', detail: { docType, fileName: stored.fileName, scan: stored.scanStatus, ...behalf(actor) }, ip: actor.ip });
  const ai = aiAllowed(tenant);
  if (!opts.pending && !willReadLive(docType, ai)) await answerFromDocument(v.id, docType);
  await queueExtraction(doc, ai);
  return doc;
}

/** Use values read from a document (only the fields picked, only fields this workspace has). */
export async function applyExtractedValues(config: OnboardingConfig, v: Vendor, extractionId: string, fieldIds: string[], actor: Actor) {
  const ex = await getExtraction(v.tenantId, v.id, extractionId);
  if (!ex || ex.status !== 'DONE') throw new HttpError(404, 'Nothing to apply');
  const profile = structuredClone(v.profile as Profile);
  const applied: string[] = [];
  for (const f of ex.fields.filter((x) => fieldIds.includes(x.fieldId))) {
    const [sec, key] = f.fieldId.split('.');
    const fitted = fitToField(config, f.fieldId, f.value);
    if (!fitted) continue;
    const clean = sanitizeSection(config, sec, { [key]: fitted });
    if (key in clean) { profile[sec] = { ...(profile[sec] ?? {}), ...clean }; applied.push(f.fieldId); }
  }
  // Applying a GSTIN also answers "Do you hold a GST number?" when it's still blank.
  fillImpliedAnswers(config, profile, applied, v.vendorType);
  await db.update(schema.vendors).set({ ...withIdentity(profile), status: v.status === 'INVITED' ? 'IN_PROGRESS' : v.status }).where(eq(schema.vendors.id, v.id));
  await db.update(schema.documentExtractions).set({ appliedAt: new Date() }).where(eq(schema.documentExtractions.id, ex.id));
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: actor.name, action: 'AI_VALUES_APPLIED', detail: { fields: applied.join(', '), ...behalf(actor) }, ip: actor.ip });
  return { applied, profile };
}

/**
 * Submit for approval: everything required must be there, automatic checks run (e.g. sanctions screening in
 * Gulf workspaces) so reviewers see the result, then the approval flow starts.
 * `missingDetails` lets the portal show the missing items in the supplier's language.
 */
export async function submitForReview(tenant: Tenant, config: OnboardingConfig, v: VendorWithDocs, actor: Actor, missingDetails?: () => unknown) {
  const checklist = buildChecklist(config, v.profile as Profile, activeTypes(v.documents), v.vendorType);
  if (!isSubmittable(checklist)) throw new HttpError(422, 'Please complete all required fields before submitting', missingDetails ? missingDetails() : checklist.filter((c) => !c.ok && c.severity === 'error'));
  for (const { def } of checksForVendor(tenant.country, v.profile as Profile).filter((c) => c.def.runOnSubmit)) {
    const input = checkInputs(def, v.profile as Profile);
    if (inputsComplete(def, input)) await runKyc(v, def.kind, input, 'system (on submit)').catch(() => {});
  }
  const resubmission = v.status === 'SENT_BACK';
  await startReview(v);
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: actor.name, action: resubmission ? 'RESUBMITTED' : 'SUBMITTED', detail: actor.onBehalf ? behalf(actor) : undefined, ip: actor.ip });
}
