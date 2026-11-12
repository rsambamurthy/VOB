/**
 * AI document reading. On upload of a supported document an extraction job runs; results are
 * stored as *suggestions* — vendors choose what to apply, and reviewers see mismatches.
 * In 'automatic' data entry, confident values for empty fields are filled in straight away
 * (never over what the supplier typed, never bank or other sensitive fields — those wait for the
 * supplier to confirm).
 * Real AI runs only when AI_PROVIDER=anthropic AND the workspace has switched it on (documents
 * are sent to the AI provider, so it's opt-in per workspace).
 */
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import { env } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { defineJob, enqueue } from '../../jobs/queue.js';
import { readBytes } from '../storage/index.js';
import { deriveExtracted, readableDocuments } from '../../countries/registry.js';

const EXTRACTABLE = readableDocuments();
import { anthropicExtractor, mockExtractor, type Extractor } from './extractors.js';
import type { OnboardingConfig } from '../../config/types.js';
import { normaliseExtracted } from '../../i18n/digits.js';
import type { Tenant } from '../../db/schema.js';
import { hasFeature } from '../../services/limits.js';
import { getPublished } from '../../services/config.js';
import { sanitizeSection, type Profile } from '../../lib/profileEngine.js';
import { isSensitive } from '../../lib/fieldCrypto.js';
import { audit } from '../../lib/audit.js';

/** How suppliers enter their details: typed by hand, AI suggestions to accept, or filled from documents. */
export type DataEntryMode = 'manual' | 'assisted' | 'automatic';
export function dataEntryMode(t: Tenant): DataEntryMode {
  if (!t.settings.aiExtraction || !hasFeature(t, 'ai')) return 'manual';
  return t.settings.dataEntry === 'automatic' ? 'automatic' : 'assisted';
}
/** Below this the value is shown as a suggestion to check, not filled in. */
export const AUTO_FILL_CONFIDENCE = 0.8;
const EDITABLE_STATUSES = ['INVITED', 'IN_PROGRESS', 'SENT_BACK'];

const i = env.int;
let extractor: Extractor = i.AI_PROVIDER === 'anthropic' ? anthropicExtractor({ apiKey: i.ANTHROPIC_API_KEY!, model: i.AI_MODEL }) : mockExtractor;
export function setExtractor(e: Extractor) { extractor = e; }
export const aiStatus = () => ({ provider: extractor.name, live: extractor.live, model: extractor.live ? i.AI_MODEL : undefined, supports: Object.keys(EXTRACTABLE) });

export async function queueExtraction(doc: { id: string; tenantId: string; vendorId: string; docType: string }, aiAllowed: boolean) {
  if (!EXTRACTABLE[doc.docType]) return;
  const skip = extractor.live && !aiAllowed;
  const [row] = await db.insert(schema.documentExtractions).values({
    tenantId: doc.tenantId, vendorId: doc.vendorId, documentId: doc.id, provider: extractor.name, test: !extractor.live,
    status: skip ? 'SKIPPED' : 'PENDING', summary: skip ? 'AI document reading is turned off for this workspace' : null,
  }).returning();
  if (!skip) await enqueue('document.extract', { id: row.id });
}

defineJob<{ id: string }>('document.extract', async ({ id }) => {
  const ex = await db.query.documentExtractions.findFirst({ where: eq(schema.documentExtractions.id, id) });
  if (!ex || ex.status !== 'PENDING') return;
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, ex.documentId) });
  const vendor = await db.query.vendors.findFirst({ where: eq(schema.vendors.id, ex.vendorId) });
  if (!doc || !vendor) return;
  const spec = EXTRACTABLE[doc.docType];
  const profile = vendor.profile as Record<string, Record<string, unknown>>;
  const hints: Record<string, string> = {};
  for (const k of spec.keys) { const [s, f] = k.target.split('.'); const v = profile[s]?.[f]; if (v) hints[k.key] = String(v); }
  try {
    const raw = await extractor.extract({ bytes: await readBytes(doc), mimeType: doc.mimeType, expected: { type: doc.docType, ...spec }, hints });
    const fields = [];
    for (const k of spec.keys) {
      let v = raw.values[k.key]?.trim();
      if (!v) continue;
      v = normaliseExtracted(v);
      if (k.transform) v = k.transform(v);
      if (k.validate && !k.validate(v)) continue; // the AI misread a formatted identifier — drop it rather than suggest junk
      fields.push({ fieldId: k.target, label: k.description, value: v.slice(0, 300), confidence: Math.max(0, Math.min(1, Number(raw.confidence[k.key] ?? 0.5))) });
    }
    // Values implied by others (e.g. the PAN inside a GSTIN), from the country packs.
    fields.push(...deriveExtracted(fields));
    const wrongDoc = raw.documentType !== doc.docType && raw.documentType !== 'OTHER';
    await db.update(schema.documentExtractions).set({
      status: 'DONE', docTypeDetected: raw.documentType, fields, completedAt: new Date(),
      summary: raw.documentType === 'UNREADABLE' ? 'The document could not be read — it may be blurry or password-protected.'
        : wrongDoc ? `This looks like a ${raw.documentType.replace(/_/g, ' ').toLowerCase()}, not a ${spec.label}.`
        : raw.notes ?? null,
    }).where(eq(schema.documentExtractions.id, id));
    if (!wrongDoc && raw.documentType !== 'UNREADABLE') await autoFill(ex.id, vendor.id, fields);
  } catch (err: any) {
    logger.error({ err, extraction: id }, 'document extraction failed');
    await db.update(schema.documentExtractions).set({ status: 'FAILED', error: String(err?.message ?? err).slice(0, 300), completedAt: new Date() }).where(eq(schema.documentExtractions.id, id));
  }
}, { retryLimit: 1, retryDelay: 20, expireInSeconds: 180 });

/**
 * Automatic data entry: copy confident values into *empty* fields. Skips sensitive fields (bank account,
 * IBAN, PAN…) and anything the supplier already typed; those stay as suggestions on the document.
 */
async function autoFill(extractionId: string, vendorId: string, fields: { fieldId: string; value: string; confidence: number }[]) {
  const vendor = await db.query.vendors.findFirst({ where: eq(schema.vendors.id, vendorId) });
  if (!vendor || !EDITABLE_STATUSES.includes(vendor.status)) return;
  const tenant = await db.query.tenants.findFirst({ where: eq(schema.tenants.id, vendor.tenantId) });
  if (!tenant || dataEntryMode(tenant) !== 'automatic') return;
  const { config } = await getPublished(tenant.id);
  const profile = structuredClone(vendor.profile as Profile);
  const filled: string[] = [];
  for (const f of fields) {
    if (f.confidence < AUTO_FILL_CONFIDENCE || isSensitive(f.fieldId)) continue;
    const [sec, key] = f.fieldId.split('.');
    if (String(profile[sec]?.[key] ?? '').trim()) continue;
    const clean = sanitizeSection(config, sec, { [key]: f.value });
    if (key in clean && String(clean[key] ?? '').trim()) { profile[sec] = { ...(profile[sec] ?? {}), ...clean }; filled.push(f.fieldId); }
  }
  if (!filled.length) return;
  const name = filled.includes('basic.vendorName') ? String(profile.basic.vendorName) : vendor.name;
  await db.update(schema.vendors).set({ profile, name, status: vendor.status === 'INVITED' ? 'IN_PROGRESS' : vendor.status }).where(eq(schema.vendors.id, vendor.id));
  await db.update(schema.documentExtractions).set({ autoApplied: filled }).where(eq(schema.documentExtractions.id, extractionId));
  await audit({ tenantId: tenant.id, vendorId: vendor.id, actor: 'AI (from document)', action: 'AI_VALUES_AUTOFILLED', detail: { fields: filled.join(', ') } });
}

export interface Suggestion { fieldId: string; label: string; value: string; confidence: number; current: string; state: 'empty' | 'match' | 'differs'; fieldLabel: string; autoFilled: boolean; sensitive: boolean }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Latest extraction per document, compared against the vendor's current answers and the tenant's fields. */
export async function extractionsFor(vendorId: string, profile: Record<string, Record<string, unknown>>, cfg: OnboardingConfig) {
  const rows = await db.select().from(schema.documentExtractions).where(eq(schema.documentExtractions.vendorId, vendorId)).orderBy(desc(schema.documentExtractions.createdAt));
  const docs = await db.select({ id: schema.documents.id, docType: schema.documents.docType }).from(schema.documents).where(eq(schema.documents.vendorId, vendorId));
  const docLabel = (documentId: string) => { const t = docs.find((d) => d.id === documentId)?.docType; return cfg.documents.find((d) => d.type === t)?.label ?? EXTRACTABLE[t ?? '']?.label ?? ''; };
  const labels = new Map<string, string>(cfg.sections.flatMap((s) => s.groups.flatMap((g) => g.fields.map((f): [string, string] => [`${s.key}.${f.key}`, f.label]))));
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.documentId) ? false : (seen.add(r.documentId), true))).map((r) => ({
    id: r.id, documentId: r.documentId, docLabel: docLabel(r.documentId), status: r.status, provider: r.provider, test: r.test, summary: r.summary, error: r.error, appliedAt: r.appliedAt, autoApplied: r.autoApplied, docTypeDetected: r.docTypeDetected,
    suggestions: r.fields.filter((f) => labels.has(f.fieldId)).map((f): Suggestion => {
      const [s, k] = f.fieldId.split('.');
      const current = String(profile[s]?.[k] ?? '');
      const state = !current ? 'empty' : norm(current) === norm(f.value) ? 'match' : 'differs';
      return { ...f, current, fieldLabel: labels.get(f.fieldId)!, state, autoFilled: r.autoApplied.includes(f.fieldId) && state === 'match', sensitive: isSensitive(f.fieldId) };
    }),
  }));
}

export async function getExtraction(tenantId: string, vendorId: string, id: string) {
  return db.query.documentExtractions.findFirst({ where: and(eq(schema.documentExtractions.id, id), eq(schema.documentExtractions.tenantId, tenantId), eq(schema.documentExtractions.vendorId, vendorId)) });
}
