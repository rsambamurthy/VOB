/**
 * Negotiation with the other party: send a version for review, their comments / proposed wording / marked-up copy,
 * accept or ask for changes; our replies, internal notes and accepting a proposal into the draft.
 *
 * The other party reaches the contract in one of two ways, both ending in the same ReviewCtx and the same routes
 * (routes/contractReview.ts):
 *   - an email link + one-time code (contract_reviewers; for customers and suppliers not onboarded), or
 *   - their supplier portal session, when the party is linked to an onboarded supplier.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../lib/db.js';
import type { Contract, ContractReviewer, Party, Tenant } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../lib/env.js';
import { sendMail } from '../../lib/mailer.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { mailSupplier } from '../../i18n/emails.js';
import { defaultSupplierLanguage, vendorLanguage } from '../../i18n/index.js';
import { storeUpload, DOCX } from '../../integrations/storage/index.js';
import { companyDetails, CONTRACT_TYPES, optionOn, type ContractType, typeInfo } from './config.js';
import { contractFieldValues, fill, fieldsIn, unknownFields } from './fields.js';
import { getParty } from './parties.js';

const { contracts: C, contractReviewers: R, contractVersions: V, contractComments: K, contractFiles: F } = schema;
type By = { id?: string; name: string; ip?: string };
export interface ReviewCtx { tenant: Tenant; contractId: string; actor: { name: string; email: string }; reviewerId?: string; vendorId?: string }

/** Statuses in which the other party can see the contract. */
export const SHARED_STATUSES = ['WITH_PARTY', 'AGREED', 'SIGNING', 'ACTIVE', 'EXPIRED', 'TERMINATED'];
const reviewLink = (token: string) => `${env.appBaseUrl}/review/${token}`;
const staffLink = (id: string) => `${env.appBaseUrl}/staff/contracts/${id}`;

async function getContract(tenantId: string, id: string) {
  const c = await db.query.contracts.findFirst({ where: and(eq(C.tenantId, tenantId), eq(C.id, id)) });
  if (!c) throw new HttpError(404, 'Contract not found');
  return c;
}
const contractAudit = (t: Tenant, c: Pick<Contract, 'id' | 'number'>, actor: string, action: string, extra: Record<string, unknown> = {}, ip?: string) =>
  audit({ tenantId: t.id, actor, action, detail: { subjectId: c.id, number: c.number, ...extra }, ip });
async function partyLanguage(t: Tenant, party: Party) {
  if (party.vendorId) { const v = await db.query.vendors.findFirst({ where: eq(schema.vendors.id, party.vendorId) }); if (v) return vendorLanguage(t, v); }
  return defaultSupplierLanguage(t);
}
export async function tellOwner(c: Contract, subject: string, body: string) {
  const to = c.ownerId ?? c.createdById;
  if (!to) return;
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, to) });
  if (u?.status === 'ACTIVE') await sendMail({ tenantId: c.tenantId, to: u.email, subject, body: `Hello ${u.name},\n\n${body}`, link: staffLink(c.id) });
}

/* ---------------- reviewers (email link + code) ---------------- */

/** A reviewer row for this email (new link each time we write to them; the old link stops working). */
export async function issueLink(t: Tenant, c: Contract, person: { name: string; email: string }) {
  const email = person.email.trim().toLowerCase();
  const token = randomToken();
  const existing = await db.query.contractReviewers.findFirst({ where: and(eq(R.contractId, c.id), eq(R.email, email)) });
  if (existing) await db.update(R).set({ linkHash: sha256(token), name: person.name, revokedAt: null }).where(eq(R.id, existing.id));
  else await db.insert(R).values({ tenantId: t.id, contractId: c.id, name: person.name, email, linkHash: sha256(token) });
  return reviewLink(token);
}
async function reviewerByLink(token: string) {
  const r = await db.query.contractReviewers.findFirst({ where: and(eq(R.linkHash, sha256(token)), isNull(R.revokedAt)) });
  if (!r) throw new HttpError(404, 'This link is not valid any more. Ask for a new one.');
  const tenant = await db.query.tenants.findFirst({ where: eq(schema.tenants.id, r.tenantId) });
  const c = await db.query.contracts.findFirst({ where: eq(C.id, r.contractId) });
  if (!tenant || tenant.status !== 'ACTIVE' || !c || !SHARED_STATUSES.includes(c.status)) throw new HttpError(404, 'This link is not valid any more. Ask for a new one.');
  return { r, tenant, c };
}
const mask = (e: string) => e.replace(/^(.{2}).*(@.*)$/, (_m, a, b) => `${a}•••${b}`);

export async function linkInfo(token: string) {
  const { r, tenant, c } = await reviewerByLink(token);
  return { contract: { number: c.number, title: c.title }, name: r.name, email: mask(r.email), buyer: { name: tenant.name, branding: tenant.branding } };
}
/** Six-digit code to the reviewer's email: 3 a minute, 10 an hour; 5 tries per code, 20 wrong codes then the link locks. */
export async function sendCode(token: string, lang: 'en' | 'ar' = 'en') {
  const { r, tenant, c } = await reviewerByLink(token);
  const now = Date.now();
  const fresh = !r.codesWindowAt || now - r.codesWindowAt.getTime() > 3_600_000;
  if (!fresh && r.codesSent >= 10) throw new HttpError(429, 'Too many codes requested. Please try again in an hour.');
  if (r.codeExpiresAt && r.codeExpiresAt.getTime() - 10 * 60_000 > now - 20_000) throw new HttpError(429, 'A code was just sent. Please wait a moment.');
  if (r.wrongCodes >= 20) throw new HttpError(429, 'Too many wrong codes. Ask for a new link.');
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await db.update(R).set({ codeHash: await bcrypt.hash(code, 8), codeExpiresAt: new Date(now + 10 * 60_000), codeAttempts: 0, codesSent: fresh ? 1 : r.codesSent + 1, codesWindowAt: fresh ? new Date() : r.codesWindowAt }).where(eq(R.id, r.id));
  await mailSupplier(lang, { tenantId: tenant.id, to: r.email }, 'contractCode', { code, number: c.number, buyer: tenant.name });
  return { sentTo: mask(r.email), ...(env.devShowOtp ? { devOtp: code } : {}) };
}
/** Check the code; answers a session token for the review cookie (8 hours). */
export async function verifyCode(token: string, code: string, ip?: string) {
  const { r, tenant, c } = await reviewerByLink(token);
  if (r.wrongCodes >= 20) throw new HttpError(429, 'Too many wrong codes. Ask for a new link.');
  if (!r.codeHash || !r.codeExpiresAt || r.codeExpiresAt < new Date() || r.codeAttempts >= 5) throw new HttpError(401, 'Code expired — request a new one');
  if (!(await bcrypt.compare(code, r.codeHash))) {
    await db.update(R).set({ codeAttempts: r.codeAttempts + 1, wrongCodes: r.wrongCodes + 1 }).where(eq(R.id, r.id));
    throw new HttpError(401, 'Incorrect code');
  }
  const session = randomToken();
  await db.update(R).set({ codeHash: null, codeExpiresAt: null, wrongCodes: 0, sessionHash: sha256(session), sessionExpiresAt: new Date(Date.now() + 8 * 3_600_000), lastSeenAt: new Date() }).where(eq(R.id, r.id));
  await contractAudit(tenant, c, r.email, 'CONTRACT_REVIEWER_SIGNED_IN', {}, ip);
  return session;
}
/** The review cookie → who is looking at which contract. */
export async function reviewerSession(sessionToken: string): Promise<ReviewCtx & { reviewer: ContractReviewer }> {
  const r = await db.query.contractReviewers.findFirst({ where: and(eq(R.sessionHash, sha256(sessionToken)), isNull(R.revokedAt)) });
  if (!r || !r.sessionExpiresAt || r.sessionExpiresAt < new Date()) throw new HttpError(401, 'Please open the link from your email again.');
  const tenant = await db.query.tenants.findFirst({ where: eq(schema.tenants.id, r.tenantId) });
  if (!tenant || tenant.status !== 'ACTIVE') throw new HttpError(401, 'Please open the link from your email again.');
  await db.update(R).set({ lastSeenAt: new Date() }).where(eq(R.id, r.id));
  return { tenant, contractId: r.contractId, actor: { name: r.name, email: r.email }, reviewerId: r.id, reviewer: r };
}
/** Contracts an onboarded supplier sees in their portal. */
export async function vendorContracts(t: Tenant, vendorId: string) {
  const parties = await db.select({ id: schema.parties.id }).from(schema.parties).where(and(eq(schema.parties.tenantId, t.id), eq(schema.parties.vendorId, vendorId)));
  if (!parties.length) return [];
  const rows = await db.select().from(C).where(and(eq(C.tenantId, t.id), inArray(C.partyId, parties.map((p) => p.id)), inArray(C.status, SHARED_STATUSES))).orderBy(desc(C.updatedAt));
  const shared = new Set((await db.select({ id: V.contractId }).from(V).where(inArray(V.contractId, rows.map((r) => r.id).concat('none')))).map((x) => x.id));
  const signing = new Set((await db.select({ id: schema.contractSignatures.contractId }).from(schema.contractSignatures).where(inArray(schema.contractSignatures.contractId, rows.map((r) => r.id).concat('none')))).map((x) => x.id));
  return rows.filter((r) => shared.has(r.id) || signing.has(r.id)).map((c) => ({ id: c.id, number: c.number, title: c.title, type: typeInfo(c.type).label, status: c.status, endDate: c.endDate, updatedAt: c.updatedAt }));
}
/** A supplier-portal user may open this contract (their supplier is the party, and it was shared). */
export async function assertVendorContract(t: Tenant, vendorId: string, contractId: string) {
  if (!(await vendorContracts(t, vendorId)).some((c) => c.id === contractId)) throw new HttpError(404, 'Contract not found');
}

/* ---------------- sending a version ---------------- */

/** The files that represent the current draft: the generated Word + PDF of the latest version, else the newest uploaded draft. */
export async function currentDraftFiles(c: Contract) {
  const files = await db.select().from(F).where(and(eq(F.contractId, c.id), eq(F.kind, 'DRAFT'))).orderBy(desc(F.uploadedAt));
  const gen = files.filter((f) => f.generated && f.version === c.draft?.generatedVersion);
  if (gen.length) return gen;
  return files.filter((f) => !f.generated).slice(0, 1);
}

const shareInput = z.object({
  people: z.array(z.object({ name: z.string().trim().min(2, 'Give each person’s name').max(120), email: z.string().trim().email('Use a valid email address') })).min(1, 'Choose who reviews it').max(10),
  note: z.string().trim().max(2000).optional(),
});
export async function shareForReview(t: Tenant, id: string, raw: unknown, by: By) {
  if (!optionOn(t, 'counterpartyPortal')) throw new HttpError(409, 'Counterparty review is switched off in Administration → Contracts.');
  const c = await getContract(t.id, id);
  const ok = c.status === 'APPROVED' || c.status === 'WITH_PARTY' || c.status === 'AGREED' || (c.status === 'DRAFT' && !optionOn(t, 'internalApproval'));
  if (!ok) throw new HttpError(409, c.status === 'DRAFT' ? 'Submit the contract for approval first.' : c.status === 'IN_APPROVAL' ? 'The contract is waiting for approval.' : 'This contract can’t be sent for review now.');
  if (c.status === 'DRAFT' && c.draft && c.draft.generatedVersion !== c.draft.version) throw new HttpError(400, 'Make the document first, so they see the current wording.');
  const input = shareInput.parse(raw);
  const files = await currentDraftFiles(c);
  if (!files.length) throw new HttpError(400, 'Make the document, or upload the draft, before sending it.');
  const party = await getParty(t.id, c.partyId);
  const lang = await partyLanguage(t, party);
  const [{ n }] = await db.select({ n: schema.contractVersions.number }).from(V).where(eq(V.contractId, c.id)).orderBy(desc(V.number)).limit(1).then((r) => (r.length ? r : [{ n: 0 }]));
  await db.update(V).set({ status: 'SUPERSEDED' }).where(and(eq(V.contractId, c.id), eq(V.status, 'OPEN')));
  const [version] = await db.insert(V).values({ tenantId: t.id, contractId: c.id, number: n + 1, fileIds: files.map((f) => f.id), note: input.note ?? null, sentByName: by.name }).returning();
  const [row] = await db.update(C).set({ status: 'WITH_PARTY' }).where(eq(C.id, c.id)).returning();
  for (const p of input.people) {
    const link = await issueLink(t, c, p);
    await mailSupplier(lang, { tenantId: t.id, to: p.email, link }, 'contractReview', { first: p.name.split(' ')[0], buyer: t.name, title: c.title, number: c.number, note: input.note ? `\n\n${input.note}` : '' });
  }
  await contractAudit(t, c, by.name, 'CONTRACT_SENT_FOR_REVIEW', { version: version.number, to: input.people.map((p) => p.email) }, by.ip);
  return row;
}

/* ---------------- what the other party sees ---------------- */

export async function reviewView(ctx: ReviewCtx) {
  const t = ctx.tenant;
  const c = await getContract(t.id, ctx.contractId);
  if (!SHARED_STATUSES.includes(c.status)) throw new HttpError(404, 'Contract not found');
  const party = await getParty(t.id, c.partyId);
  const versions = await db.select().from(V).where(eq(V.contractId, c.id)).orderBy(desc(V.number));
  const current = versions[0] ?? null;
  const fileIds = [...new Set([...(current?.fileIds ?? []), ...versions.flatMap((v) => v.fileIds)])];
  const files = fileIds.length ? await db.select().from(F).where(inArray(F.id, fileIds)) : [];
  const signedFiles = await db.select().from(F).where(and(eq(F.contractId, c.id), eq(F.kind, 'SIGNED')));
  const values = await contractFieldValues(t, c, party);
  const comments = await db.select().from(K).where(and(eq(K.contractId, c.id), eq(K.internal, false))).orderBy(asc(K.createdAt));
  const { signingForParty } = await import('./signing.js');
  return {
    contract: { id: c.id, number: c.number, title: c.title, type: typeInfo(c.type).label, status: c.status, value: c.value === null ? null : Number(c.value), currency: c.currency, startDate: c.startDate, endDate: c.endDate, signedDate: c.signedDate },
    buyer: { name: companyDetails(t).legalName || t.name, branding: t.branding },
    party: { name: party.name },
    you: ctx.actor,
    versions: versions.map((v) => ({ id: v.id, number: v.number, sentAt: v.sentAt, note: v.note, status: v.status, response: v.response, respondedByName: v.respondedByName, respondedAt: v.respondedAt,
      files: files.filter((f) => v.fileIds.includes(f.id)).map((f) => ({ id: f.id, fileName: f.fileName, size: f.size })) })),
    signed: signedFiles.map((f) => ({ id: f.id, fileName: f.fileName, size: f.size })),
    clauses: (c.draft?.clauses ?? []).map((x, i) => ({ group: x.group, number: i + 1, title: x.title, text: fill(x.body, values) })),
    comments: comments.map((k) => ({ id: k.id, clauseGroup: k.clauseGroup, side: k.side, authorName: k.authorName, text: k.text, proposedText: k.proposedText, status: k.status, replyTo: k.replyTo, fileId: k.fileId, createdAt: k.createdAt })),
    canComment: c.status === 'WITH_PARTY',
    canRespond: c.status === 'WITH_PARTY' && current?.status === 'OPEN',
    signing: await signingForParty(t, c, ctx.actor.email),
  };
}
/** Files the other party may download: those sent to them, their own uploads and the signed copy. */
export async function reviewFile(ctx: ReviewCtx, fileId: string) {
  const f = await db.query.contractFiles.findFirst({ where: and(eq(F.tenantId, ctx.tenant.id), eq(F.contractId, ctx.contractId), eq(F.id, fileId)) });
  if (!f) throw new HttpError(404, 'File not found');
  const sent = (await db.select({ ids: V.fileIds }).from(V).where(eq(V.contractId, ctx.contractId))).some((v) => v.ids.includes(f.id));
  if (!sent && f.kind !== 'SIGNED' && f.kind !== 'REDLINE') throw new HttpError(404, 'File not found');
  return f;
}

const commentInput = z.object({
  clauseGroup: z.string().max(60).nullable().optional(),
  text: z.string().trim().min(2, 'Write your comment').max(5000),
  proposedText: z.string().trim().max(20_000).nullable().optional(),
  replyTo: z.string().max(40).nullable().optional(),
});
async function addComment(t: Tenant, c: Contract, side: 'US' | 'PARTY', author: string, raw: unknown, extra: { internal?: boolean; fileId?: string } = {}) {
  const input = commentInput.parse(raw);
  if (input.clauseGroup && !(c.draft?.clauses ?? []).some((x) => x.group === input.clauseGroup)) throw new HttpError(400, 'That clause isn’t in this contract.');
  if (input.proposedText && !input.clauseGroup) throw new HttpError(400, 'Choose the clause the new wording is for.');
  const [row] = await db.insert(K).values({ tenantId: t.id, contractId: c.id, versionId: (await db.query.contractVersions.findFirst({ where: eq(V.contractId, c.id), orderBy: desc(V.number) }))?.id ?? null,
    clauseGroup: input.clauseGroup ?? null, side, authorName: author, text: input.text, proposedText: input.proposedText || null, internal: !!extra.internal, replyTo: input.replyTo ?? null, fileId: extra.fileId ?? null }).returning();
  return row;
}

/** The other party comments (optionally proposing wording for a clause). */
export async function partyComment(ctx: ReviewCtx, raw: unknown) {
  const c = await getContract(ctx.tenant.id, ctx.contractId);
  if (c.status !== 'WITH_PARTY') throw new HttpError(409, 'Comments are closed for this contract.');
  const k = await addComment(ctx.tenant, c, 'PARTY', `${ctx.actor.name} (${ctx.actor.email})`, raw);
  await contractAudit(ctx.tenant, c, ctx.actor.email, 'CONTRACT_PARTY_COMMENTED', { clause: k.clauseGroup, proposed: !!k.proposedText });
  return k;
}
/** Their marked-up copy (Word or PDF). */
export async function partyUpload(ctx: ReviewCtx, file: { buffer: Buffer; originalname: string }, note: string) {
  const c = await getContract(ctx.tenant.id, ctx.contractId);
  if (c.status !== 'WITH_PARTY') throw new HttpError(409, 'This contract isn’t open for changes.');
  const stored = await storeUpload(ctx.tenant.id, `contracts/${c.id}`, file, { types: [DOCX, 'application/pdf'] });
  const [f] = await db.insert(F).values({ tenantId: ctx.tenant.id, contractId: c.id, kind: 'REDLINE', ...stored, uploadedByName: `${ctx.actor.name} (${ctx.actor.email})` }).returning();
  await addComment(ctx.tenant, c, 'PARTY', `${ctx.actor.name} (${ctx.actor.email})`, { text: note.trim().length >= 2 ? note : `Marked-up copy: ${f.fileName}` }, { fileId: f.id });
  await contractAudit(ctx.tenant, c, ctx.actor.email, 'CONTRACT_PARTY_UPLOADED', { fileName: f.fileName });
  return f;
}
/** Accept the version as it is (ready to sign), or ask for changes. */
export async function partyRespond(ctx: ReviewCtx, raw: unknown) {
  const { decision, note } = z.object({ decision: z.enum(['ACCEPT', 'CHANGES']), note: z.string().trim().max(2000).optional() }).parse(raw);
  const c = await getContract(ctx.tenant.id, ctx.contractId);
  const v = await db.query.contractVersions.findFirst({ where: eq(V.contractId, c.id), orderBy: desc(V.number) });
  if (c.status !== 'WITH_PARTY' || v?.status !== 'OPEN') throw new HttpError(409, 'This version has already been answered.');
  if (decision === 'CHANGES' && !note && !(await db.select({ id: K.id }).from(K).where(and(eq(K.contractId, c.id), eq(K.versionId, v.id), eq(K.side, 'PARTY'))).limit(1)).length) throw new HttpError(400, 'Say what should change, or comment on the clauses first.');
  await db.update(V).set({ status: decision === 'ACCEPT' ? 'ACCEPTED' : 'CHANGES_REQUESTED', response: note ?? null, respondedByName: `${ctx.actor.name} (${ctx.actor.email})`, respondedAt: new Date() }).where(eq(V.id, v.id));
  if (decision === 'ACCEPT') await db.update(C).set({ status: 'AGREED' }).where(eq(C.id, c.id));
  await contractAudit(ctx.tenant, c, ctx.actor.email, decision === 'ACCEPT' ? 'CONTRACT_PARTY_ACCEPTED' : 'CONTRACT_PARTY_CHANGES', { version: v.number, note });
  await tellOwner(c, `${decision === 'ACCEPT' ? 'Accepted' : 'Changes requested'}: ${c.number} ${c.title}`,
    decision === 'ACCEPT' ? `${ctx.actor.name} accepted version ${v.number} of ${c.number} “${c.title}”. It is ready to send for signature.` : `${ctx.actor.name} asked for changes to ${c.number} “${c.title}”${note ? `:\n\n${note}` : '.'}\n\nOpen the contract to see their comments.`);
}

/* ---------------- our side ---------------- */

export async function staffComment(t: Tenant, id: string, raw: unknown, by: By) {
  const c = await getContract(t.id, id);
  if (!['WITH_PARTY', 'AGREED', 'DRAFT', 'APPROVED'].includes(c.status)) throw new HttpError(409, 'Comments are closed for this contract.');
  const internal = (raw as { internal?: boolean })?.internal === true || c.status === 'DRAFT' || c.status === 'APPROVED';
  const k = await addComment(t, c, 'US', by.name, raw, { internal });
  await contractAudit(t, c, by.name, internal ? 'CONTRACT_NOTE_ADDED' : 'CONTRACT_COMMENT_SENT', { clause: k.clauseGroup }, by.ip);
  return k;
}
/**
 * Decide on one of their comments. Accepting proposed wording puts it into the draft as edited wording (the draft
 * becomes non-standard) and takes the contract back to draft: make the document, get approval again, send again.
 */
export async function decideComment(t: Tenant, id: string, commentId: string, raw: unknown, by: By) {
  const { status } = z.object({ status: z.enum(['ACCEPTED', 'DECLINED', 'RESOLVED']) }).parse(raw);
  const c = await getContract(t.id, id);
  const k = await db.query.contractComments.findFirst({ where: and(eq(K.contractId, c.id), eq(K.id, commentId)) });
  if (!k) throw new HttpError(404, 'Comment not found');
  if (status === 'ACCEPTED' && k.proposedText && k.clauseGroup) {
    if (!['WITH_PARTY', 'AGREED', 'DRAFT', 'APPROVED'].includes(c.status) || !c.draft) throw new HttpError(409, 'Proposed wording can only be taken into a drafted contract that isn’t being signed.');
    const bad = unknownFields(fieldsIn(k.proposedText));
    if (bad.length) throw new HttpError(400, 'The proposed wording has text in double braces that isn’t a merge field. Edit it in the draft instead.');
    const clauses = c.draft.clauses.map((x) => (x.group === k.clauseGroup ? { ...x, variant: 'custom', body: k.proposedText! } : x));
    await db.update(V).set({ status: 'SUPERSEDED' }).where(and(eq(V.contractId, c.id), eq(V.status, 'OPEN')));
    await db.update(C).set({ status: 'DRAFT', draft: { ...c.draft, clauses, nonStandard: true, version: c.draft.version + 1, savedAt: new Date().toISOString(), savedBy: by.name } }).where(eq(C.id, c.id));
  }
  await db.update(K).set({ status }).where(eq(K.id, k.id));
  await contractAudit(t, c, by.name, `CONTRACT_COMMENT_${status}`, { clause: k.clauseGroup }, by.ip);
}

/** Negotiation details for the staff contract page. */
export async function negotiationView(t: Tenant, c: Contract) {
  const versions = await db.select().from(V).where(eq(V.contractId, c.id)).orderBy(desc(V.number));
  const comments = await db.select().from(K).where(eq(K.contractId, c.id)).orderBy(asc(K.createdAt));
  const reviewers = await db.select({ name: R.name, email: R.email, lastSeenAt: R.lastSeenAt }).from(R).where(and(eq(R.contractId, c.id), isNull(R.revokedAt)));
  const party = await getParty(t.id, c.partyId);
  return {
    on: optionOn(t, 'counterpartyPortal'),
    versions: versions.map((v) => ({ id: v.id, number: v.number, status: v.status, note: v.note, sentByName: v.sentByName, sentAt: v.sentAt, response: v.response, respondedByName: v.respondedByName, respondedAt: v.respondedAt, fileIds: v.fileIds })),
    comments,
    reviewers,
    contacts: party.contacts.filter((x) => x.email).map((x) => ({ name: x.name, email: x.email!, signatory: !!x.signatory })),
    portal: !!party.vendorId,
  };
}
export const revokeReviewers = (contractId: string) => db.update(R).set({ revokedAt: new Date(), sessionHash: null }).where(and(eq(R.contractId, contractId), isNull(R.revokedAt), ne(R.email, '')));
