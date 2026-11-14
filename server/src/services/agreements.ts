/**
 * Agreements suppliers accept in the portal — code of conduct, NDA, supplier agreement. Click-to-accept: the
 * supplier reads the current version, ticks "I agree" and types their name and designation. Each acceptance
 * records the version, a hash of exactly what was shown, time, IP and browser, and has a certificate PDF.
 *
 * Which version a supplier needs:
 *  - onboarding (not yet approved): the latest version marked "accept again", or any version (usually the latest).
 *  - approved before the agreement existed: only when a version marked "accept again" is published.
 *  - approved after it existed (e.g. imported as approved): as onboarding — they accept it on next sign-in.
 */
import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import type { ChecklistItem } from '../lib/profileEngine.js';
import { readBytes, storeUpload } from '../integrations/storage/index.js';
import type { Tenant, Vendor } from '../db/schema.js';

const { agreements, agreementVersions, agreementAcceptances } = schema;
export type Agreement = typeof agreements.$inferSelect;
export type AgreementVersion = typeof agreementVersions.$inferSelect;
export type Acceptance = typeof agreementAcceptances.$inferSelect;
type Lang = 'en' | 'ar';

export const hashText = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/* ---------------- Setting up agreements (Administration → Agreements) ---------------- */

export interface VersionInput { kind: 'TEXT' | 'PDF'; body?: string; bodyAr?: string; file?: { buffer: Buffer; originalname: string }; changeNote?: string; reaccept: boolean }

async function storeVersion(tenantId: string, agreementId: string, version: number, input: VersionInput, byName: string) {
  let fileCols: Partial<AgreementVersion> = {};
  let contentHash: string;
  if (input.kind === 'PDF') {
    if (!input.file) throw new HttpError(400, 'Upload the agreement as a PDF');
    const stored = await storeUpload(tenantId, 'agreements', input.file);
    if (stored.mimeType !== 'application/pdf') throw new HttpError(400, 'The agreement must be a PDF');
    fileCols = { fileName: stored.fileName, mimeType: stored.mimeType, size: stored.size, storagePath: stored.storagePath, storageDriver: stored.storageDriver };
    contentHash = stored.sha256;
  } else {
    const body = (input.body ?? '').trim();
    if (body.length < 20) throw new HttpError(400, 'Write the agreement text (at least a few lines)');
    contentHash = hashText(body + (input.bodyAr?.trim() ? `\n---\n${input.bodyAr.trim()}` : ''));
  }
  const [v] = await db.insert(agreementVersions).values({
    tenantId, agreementId, version, kind: input.kind, body: input.kind === 'TEXT' ? input.body!.trim() : null, bodyAr: input.kind === 'TEXT' ? input.bodyAr?.trim() || null : null,
    ...fileCols, contentHash, changeNote: input.changeNote?.trim() || null, reaccept: input.reaccept, publishedByName: byName,
  }).returning();
  return v;
}

export async function createAgreement(tenant: Tenant, a: { title: string; titleAr?: string; vendorTypes: string[]; required: boolean }, first: VersionInput, by: { name: string; ip?: string }) {
  const [{ max }] = await db.select({ max: agreements.sortOrder }).from(agreements).where(eq(agreements.tenantId, tenant.id)).orderBy(desc(agreements.sortOrder)).limit(1).then((r) => (r.length ? r : [{ max: 0 }]));
  const [ag] = await db.insert(agreements).values({ tenantId: tenant.id, title: a.title.trim(), titleAr: a.titleAr?.trim() || null, vendorTypes: a.vendorTypes, required: a.required, sortOrder: (max ?? 0) + 1 }).returning();
  try {
    await storeVersion(tenant.id, ag.id, 1, first, by.name);
  } catch (e) { await db.delete(agreements).where(eq(agreements.id, ag.id)); throw e; }
  await audit({ tenantId: tenant.id, actor: by.name, action: 'AGREEMENT_CREATED', detail: { title: ag.title, askApproved: first.reaccept ? 'yes' : 'no' }, ip: by.ip });
  if (first.reaccept) await notifyApproved(tenant, ag);
  return ag;
}

export async function publishVersion(tenant: Tenant, agreementId: string, input: VersionInput, by: { name: string; ip?: string }) {
  const ag = await getAgreement(tenant.id, agreementId);
  const [last] = await db.select({ version: agreementVersions.version }).from(agreementVersions).where(eq(agreementVersions.agreementId, ag.id)).orderBy(desc(agreementVersions.version)).limit(1);
  const v = await storeVersion(tenant.id, ag.id, (last?.version ?? 0) + 1, input, by.name);
  await audit({ tenantId: tenant.id, actor: by.name, action: 'AGREEMENT_VERSION_PUBLISHED', detail: { title: ag.title, version: v.version, acceptAgain: input.reaccept ? 'yes' : 'no' }, ip: by.ip });
  if (input.reaccept) await notifyApproved(tenant, ag);
  return v;
}

export async function updateAgreement(tenantId: string, agreementId: string, patch: Partial<Pick<Agreement, 'title' | 'titleAr' | 'vendorTypes' | 'required' | 'sortOrder' | 'status'>>, by: { name: string; ip?: string }) {
  const ag = await getAgreement(tenantId, agreementId);
  await db.update(agreements).set(patch).where(eq(agreements.id, ag.id));
  await audit({ tenantId, actor: by.name, action: patch.status === 'ARCHIVED' ? 'AGREEMENT_ARCHIVED' : patch.status === 'ACTIVE' ? 'AGREEMENT_RESTORED' : 'AGREEMENT_UPDATED', detail: { title: patch.title ?? ag.title }, ip: by.ip });
}

async function getAgreement(tenantId: string, id: string) {
  const ag = await db.query.agreements.findFirst({ where: and(eq(agreements.tenantId, tenantId), eq(agreements.id, id)) });
  if (!ag) throw new HttpError(404, 'Agreement not found');
  return ag;
}

/** Everything for the admin page: agreements, their versions, and how many suppliers have accepted / still need to. */
export async function listAgreements(tenantId: string) {
  const ags = await db.select().from(agreements).where(eq(agreements.tenantId, tenantId)).orderBy(asc(agreements.sortOrder), asc(agreements.createdAt));
  if (!ags.length) return [];
  const versions = await db.select().from(agreementVersions).where(inArray(agreementVersions.agreementId, ags.map((a) => a.id))).orderBy(desc(agreementVersions.version));
  const accs = await db.select().from(agreementAcceptances).where(eq(agreementAcceptances.tenantId, tenantId));
  const vendorRows = (await db.select({ id: schema.vendors.id, status: schema.vendors.status, vendorType: schema.vendors.vendorType, decidedAt: schema.vendors.decidedAt, erasedAt: schema.vendors.erasedAt }).from(schema.vendors).where(eq(schema.vendors.tenantId, tenantId)))
    .filter((v) => !v.erasedAt && v.status !== 'REJECTED');
  const all = vendorRows.flatMap((v) => statusesFor(v, ags, versions, accs));
  return ags.map((a) => {
    const mine = all.filter((x) => x.agreement.id === a.id);
    return { ...a, versions: versions.filter((v) => v.agreementId === a.id).map(publicVersion), accepted: mine.filter((x) => x.accepted).length, outstanding: a.status === 'ACTIVE' ? mine.filter((x) => x.outstanding).length : 0 };
  });
}

export const publicVersion = ({ storagePath: _p, storageDriver: _d, ...v }: AgreementVersion) => v;

/* ---------------- Which suppliers need what ---------------- */

const appliesTo = (a: Pick<Agreement, 'vendorTypes'>, vendorType: string) => !a.vendorTypes.length || a.vendorTypes.includes(vendorType);

/** The version a supplier must have accepted (0 = nothing needed). See the file comment. */
function neededVersion(a: Agreement, versions: Pick<AgreementVersion, 'version' | 'reaccept'>[], v: Pick<Vendor, 'status' | 'decidedAt'>) {
  const lastAgain = Math.max(0, ...versions.filter((x) => x.reaccept).map((x) => x.version));
  const approvedBefore = v.status === 'APPROVED' && v.decidedAt && v.decidedAt < a.createdAt;
  return approvedBefore ? lastAgain : Math.max(lastAgain, 1);
}

export interface AgreementStatus {
  agreement: Agreement; current: AgreementVersion; required: boolean;
  /** Latest acceptance by this supplier (any version). */
  accepted: Acceptance | null;
  /** True when the supplier still has to accept the current version. */
  outstanding: boolean;
}

/** Active agreements of a workspace with their versions (newest first) — loaded once, used for one or many suppliers. */
async function activeWithVersions(tenantId: string) {
  const ags = await db.select().from(agreements).where(and(eq(agreements.tenantId, tenantId), eq(agreements.status, 'ACTIVE'))).orderBy(asc(agreements.sortOrder), asc(agreements.createdAt));
  const versions = ags.length ? await db.select().from(agreementVersions).where(inArray(agreementVersions.agreementId, ags.map((a) => a.id))).orderBy(desc(agreementVersions.version)) : [];
  return { ags, versions };
}

/** One supplier's status for each agreement that applies to them. */
function statusesFor(v: Pick<Vendor, 'id' | 'vendorType' | 'status' | 'decidedAt'>, ags: Agreement[], versions: AgreementVersion[], accs: Acceptance[]): AgreementStatus[] {
  return ags.filter((a) => appliesTo(a, v.vendorType)).flatMap((a) => {
    const vs = versions.filter((x) => x.agreementId === a.id);
    if (!vs.length) return [];
    const accepted = accs.filter((x) => x.agreementId === a.id && x.vendorId === v.id).sort((x, y) => y.version - x.version || +y.acceptedAt - +x.acceptedAt)[0] ?? null;
    return [{ agreement: a, current: vs[0], required: a.required, accepted, outstanding: (accepted?.version ?? 0) < neededVersion(a, vs, v) }];
  });
}

/** Agreements that apply to this supplier, with their current version and the supplier's acceptance. */
export async function agreementsFor(v: Pick<Vendor, 'id' | 'tenantId' | 'vendorType' | 'status' | 'decidedAt'>): Promise<AgreementStatus[]> {
  const { ags, versions } = await activeWithVersions(v.tenantId);
  if (!ags.length) return [];
  const accs = await db.select().from(agreementAcceptances).where(eq(agreementAcceptances.vendorId, v.id));
  return statusesFor(v, ags, versions, accs);
}

const title = (a: Agreement, lang: Lang) => (lang === 'ar' && a.titleAr) || a.title;

/** Checklist items for required agreements still to accept (shown with the form's checklist, block submitting). */
export function agreementChecklist(list: AgreementStatus[], lang: Lang = 'en'): ChecklistItem[] {
  return list.filter((s) => s.required).map((s) => ({
    id: `agreement.${s.agreement.id}`, section: 'agreements', label: title(s.agreement, lang), ok: !s.outstanding, severity: 'error' as const,
    // Translated for the supplier like every other checklist message (i18n/messages.ar.json).
    message: s.outstanding ? `${title(s.agreement, lang)} must be accepted` : undefined,
  }));
}

/** What the supplier (or staff) sees for each agreement. */
export function agreementView(s: AgreementStatus, lang: Lang = 'en') {
  const c = s.current;
  return {
    id: s.agreement.id, title: title(s.agreement, lang), required: s.required, outstanding: s.outstanding,
    current: { id: c.id, version: c.version, kind: c.kind, body: c.kind === 'TEXT' ? ((lang === 'ar' && c.bodyAr) || c.body) : null, hasArabic: !!c.bodyAr, fileName: c.fileName, publishedAt: c.publishedAt, changeNote: c.changeNote },
    accepted: s.accepted ? { id: s.accepted.id, version: s.accepted.version, signerName: s.accepted.signerName, signerDesignation: s.accepted.signerDesignation, acceptedAt: s.accepted.acceptedAt, recordedByName: s.accepted.recordedByName } : null,
  };
}

/** Approved suppliers (of these) who must now accept a new or updated agreement: flag for staff. A few queries for any number of suppliers. */
export async function vendorsWithOutstandingAgreements(tenantId: string, vendorIds: string[]) {
  const out = new Set<string>();
  if (!vendorIds.length) return out;
  const { ags, versions } = await activeWithVersions(tenantId);
  if (!ags.length) return out;
  const approved = await db.select({ id: schema.vendors.id, vendorType: schema.vendors.vendorType, status: schema.vendors.status, decidedAt: schema.vendors.decidedAt }).from(schema.vendors)
    .where(and(eq(schema.vendors.tenantId, tenantId), eq(schema.vendors.status, 'APPROVED'), inArray(schema.vendors.id, vendorIds)));
  if (!approved.length) return out;
  const accs = await db.select().from(agreementAcceptances).where(and(eq(agreementAcceptances.tenantId, tenantId), inArray(agreementAcceptances.vendorId, approved.map((v) => v.id))));
  for (const v of approved) if (statusesFor(v, ags, versions, accs).some((s) => s.required && s.outstanding)) out.add(v.id);
  return out;
}

/* ---------------- Accepting ---------------- */

export interface Signer { signerName: string; signerDesignation: string }

/** The supplier accepts the version they were shown (versionId), in the portal. */
export async function acceptAgreement(v: Vendor, agreementId: string, versionId: string, signer: Signer, ctx: { email: string; ip?: string; userAgent?: string; language: Lang }) {
  const s = (await agreementsFor(v)).find((x) => x.agreement.id === agreementId);
  if (!s) throw new HttpError(404, 'Agreement not found');
  if (s.current.id !== versionId) throw new HttpError(409, 'This agreement was updated while you were reading it. Please read the new version.');
  if (s.accepted?.version === s.current.version) return s.accepted;
  const [acc] = await db.insert(agreementAcceptances).values({
    tenantId: v.tenantId, agreementId, versionId, version: s.current.version, vendorId: v.id, signerName: signer.signerName.trim(), signerDesignation: signer.signerDesignation.trim(),
    signerEmail: ctx.email, language: ctx.language, contentHash: s.current.contentHash, ip: ctx.ip ?? null, userAgent: ctx.userAgent?.slice(0, 300) ?? null,
  }).returning();
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: ctx.email, action: 'AGREEMENT_ACCEPTED', detail: { agreement: s.agreement.title, version: s.current.version, signer: `${acc.signerName}, ${acc.signerDesignation}` }, ip: ctx.ip });
  return acc;
}

/** A buyer records an agreement the supplier signed on paper (the signed copy is kept on the supplier). */
export async function recordSignedCopy(v: Vendor, agreementId: string, signer: Signer, file: { buffer: Buffer; originalname: string }, by: { id: string; name: string; email: string; ip?: string }) {
  const s = (await agreementsFor(v)).find((x) => x.agreement.id === agreementId);
  if (!s) throw new HttpError(404, 'Agreement not found');
  const stored = await storeUpload(v.tenantId, v.id, file);
  const [doc] = await db.insert(schema.documents).values({ tenantId: v.tenantId, vendorId: v.id, docType: 'SIGNED_AGREEMENT', ...stored, status: 'ATTACHMENT', uploadedById: by.id }).returning();
  const [acc] = await db.insert(agreementAcceptances).values({
    tenantId: v.tenantId, agreementId, versionId: s.current.id, version: s.current.version, vendorId: v.id, signerName: signer.signerName.trim(), signerDesignation: signer.signerDesignation.trim(),
    signerEmail: by.email, language: 'en', contentHash: s.current.contentHash, ip: by.ip ?? null, recordedByName: by.name, signedCopyDocumentId: doc.id,
  }).returning();
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: by.name, action: 'AGREEMENT_SIGNED_COPY_RECORDED', detail: { agreement: s.agreement.title, version: s.current.version, signer: `${acc.signerName}, ${acc.signerDesignation}`, onBehalf: 'yes' }, ip: by.ip });
  return acc;
}

/* ---------------- Files and certificates ---------------- */

export async function versionFile(tenantId: string, versionId: string) {
  const v = await db.query.agreementVersions.findFirst({ where: and(eq(agreementVersions.tenantId, tenantId), eq(agreementVersions.id, versionId)) });
  if (!v || v.kind !== 'PDF' || !v.storagePath) throw new HttpError(404, 'File not found');
  return { bytes: await readBytes({ storagePath: v.storagePath, storageDriver: v.storageDriver!, fileName: v.fileName!, mimeType: v.mimeType! }), fileName: v.fileName! };
}

export async function getAcceptance(tenantId: string, id: string, vendorId?: string) {
  const acc = await db.query.agreementAcceptances.findFirst({ where: and(eq(agreementAcceptances.tenantId, tenantId), eq(agreementAcceptances.id, id), ...(vendorId ? [eq(agreementAcceptances.vendorId, vendorId)] : [])) });
  if (!acc) throw new HttpError(404, 'Not found');
  return acc;
}

/** Certificate of acceptance: who accepted which version, when, from where, and a fingerprint of the exact text or file. */
export async function acceptanceCertificate(acc: Acceptance, tenant: Pick<Tenant, 'name'>): Promise<Buffer> {
  const [ag, ver, vendor] = await Promise.all([
    db.query.agreements.findFirst({ where: eq(agreements.id, acc.agreementId) }),
    db.query.agreementVersions.findFirst({ where: eq(agreementVersions.id, acc.versionId) }),
    db.query.vendors.findFirst({ where: eq(schema.vendors.id, acc.vendorId) }),
  ]);
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Acceptance — ${ag?.title}`, Author: tenant.name } });
  const chunks: Buffer[] = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  const navy = '#1f2a5c', grey = '#555555';
  doc.fillColor(navy).font('Helvetica-Bold').fontSize(18).text('Certificate of acceptance');
  doc.moveDown(0.3).font('Helvetica').fontSize(10).fillColor(grey).text(`${tenant.name} · VendorGate`);
  doc.moveDown(1);
  const row = (k: string, val: string) => { doc.font('Helvetica-Bold').fontSize(10).fillColor('#111111').text(k, { continued: true }).font('Helvetica').text(`  ${val}`); doc.moveDown(0.25); };
  row('Agreement:', `${ag?.title ?? ''} — version ${acc.version}`);
  row('Supplier:', `${vendor?.name ?? ''} (${vendor?.code ?? ''})`);
  row('Accepted by:', `${acc.signerName}, ${acc.signerDesignation}`);
  if (acc.recordedByName) row('Recorded by:', `${acc.recordedByName} (${tenant.name}) from a signed copy`);
  else row('Signed in as:', acc.signerEmail ?? '');
  row('Accepted on:', `${acc.acceptedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  if (acc.ip) row('IP address:', acc.ip);
  if (acc.userAgent) row('Browser:', acc.userAgent.slice(0, 120));
  row('Language shown:', acc.language === 'ar' ? 'Arabic' : 'English');
  row('Fingerprint (SHA-256):', acc.contentHash);
  doc.moveDown(0.5).fontSize(9).fillColor(grey).text(ver?.kind === 'PDF'
    ? `The supplier accepted the PDF "${ver.fileName}". The fingerprint above identifies that exact file.`
    : 'The supplier accepted the text below. The fingerprint above identifies that exact text.', { width: 500 });
  if (ver?.kind === 'TEXT' && ver.body) {
    doc.moveDown(1).fillColor(navy).font('Helvetica-Bold').fontSize(12).text(ag?.title ?? '');
    doc.moveDown(0.4).fillColor('#111111').font('Helvetica').fontSize(9.5).text(ver.body, { width: 500, lineGap: 2 });
    if (ver.bodyAr) doc.moveDown(0.8).fillColor(grey).fontSize(9).text('An Arabic version was also shown; it is kept in VendorGate with this version.', { width: 500 });
  }
  doc.end();
  return done;
}

/* ---------------- Notifications ---------------- */

/** Ask approved suppliers who now need to accept (new agreement for everyone, or "accept again"). */
async function notifyApproved(tenant: Tenant, ag: Agreement) {
  const { mailSupplier } = await import('../i18n/emails.js');
  const { vendorLanguage } = await import('../i18n/index.js');
  const { portalLink } = await import('./vendors.js');
  const approved = await db.select().from(schema.vendors).where(and(eq(schema.vendors.tenantId, tenant.id), eq(schema.vendors.status, 'APPROVED')));
  for (const v of approved) {
    if (v.erasedAt || !appliesTo(ag, v.vendorType)) continue;
    const s = (await agreementsFor(v)).find((x) => x.agreement.id === ag.id);
    if (!s?.outstanding) continue;
    await mailSupplier(vendorLanguage(tenant, v), { tenantId: tenant.id, to: v.contactEmail, link: portalLink(v) }, 'agreementToAccept', { first: v.contactFirstName, buyer: tenant.name, agreement: (vendorLanguage(tenant, v) === 'ar' && ag.titleAr) || ag.title });
  }
}
