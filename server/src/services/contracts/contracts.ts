/**
 * The contract repository (Step 0): record contracts with suppliers (BUY) and customers (SELL), their dates, value,
 * renewal and notice terms, owner and files; link statements of work to master agreements; import existing contracts
 * from Excel; expire or roll over contracts as their end date passes (job `contracts.daily`).
 * Authoring, approval, negotiation, signature and obligations come in later steps (see services/contracts/config.ts).
 */
import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../lib/db.js';
import type { AmendmentChanges, Contract, ContractFile, Tenant } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { nextYearlyNumber } from '../../lib/numbering.js';
import { readSheet, sheetTemplate, type RowError, type SheetColumn } from '../../lib/excel.js';
import { localeFor } from '../../countries/registry.js';
import { defineJob } from '../../jobs/queue.js';
import { logger } from '../../lib/logger.js';
import { DOCX, removeStored, storeUpload } from '../../integrations/storage/index.js';
import { CONTRACT_TYPES, CONTRACT_TYPE_KEYS, typeInfo, assertTypeOn, contractRules, typeState, directionsOn, optionOn, ruleDefaults, type ContractType, type Direction } from './config.js';
import { createParty, getParty, KIND_LABEL } from './parties.js';
import { draftView, touchDraft } from './drafting.js';
import { negotiationView } from './negotiation.js';
import { signingView } from './signing.js';

const { contracts: C, parties: P, contractFiles: F, users: U } = schema;
type By = { id: string; name: string; ip?: string };

/** Contract statuses in Step 0 (later steps add approval, negotiation and signature). */
export const STATUS_LABEL: Record<string, string> = { DRAFT: 'Draft', IN_APPROVAL: 'In approval', APPROVED: 'Approved', WITH_PARTY: 'With the other party', AGREED: 'Agreed', SIGNING: 'Out for signature', ACTIVE: 'Active', EXPIRED: 'Expired', TERMINATED: 'Terminated' };
export const DIRECTION_LABEL: Record<Direction, string> = { BUY: 'Supplier contract', SELL: 'Customer contract' };
export const PARTY_KIND_FOR: Record<Direction, 'SUPPLIER' | 'CUSTOMER'> = { BUY: 'SUPPLIER', SELL: 'CUSTOMER' };
export const FILE_KINDS = { SIGNED: 'Signed copy', DRAFT: 'Draft', ANNEXURE: 'Annexure / schedule', OTHER: 'Other', REDLINE: 'Their marked-up copy', SIGNING: 'Being signed' } as const;
/** Kinds staff can upload (the others are added by VendorGate). */
export const UPLOAD_KINDS = ['SIGNED', 'DRAFT', 'ANNEXURE', 'OTHER'];
export const today = () => new Date().toISOString().slice(0, 10);
const addMonths = (d: string, m: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); };
const addDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

/* ---------------- input ---------------- */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-04-01').refine((v) => !Number.isNaN(Date.parse(v)), 'Use a real date').nullable().optional().or(z.literal('').transform(() => null));
export const contractInput = z.object({
  title: z.string().trim().min(3, 'Give the contract a title').max(200),
  direction: z.enum(['BUY', 'SELL']),
  type: z.string(),
  partyId: z.string().min(1, 'Choose the other party'),
  reference: z.string().trim().max(100).nullable().optional().transform((v) => v || null),
  value: z.number({ invalid_type_error: 'Enter the value as a number' }).min(0, 'The value can’t be negative').max(1e13).nullable().optional(),
  currency: z.string().trim().toUpperCase().length(3, 'Use a 3-letter currency code').optional(),
  startDate: day, endDate: day, signedDate: day,
  autoRenew: z.boolean().default(false),
  renewalTermMonths: z.number().int().min(1).max(120).nullable().optional(),
  noticeDays: z.number().int().min(0).max(730).nullable().optional(),
  ownerId: z.string().nullable().optional(),
  parentId: z.string().nullable().optional(),
  description: z.string().trim().max(5000).nullable().optional().transform((v) => v || null),
  category: z.string().trim().max(100).nullable().optional().transform((v) => v || null),
});
export type ContractInput = z.input<typeof contractInput>;

/** Plain-English names of contract fields (history, reading suggestions). One list — use it, don't re-type labels. */
export const CONTRACT_FIELD_LABELS: Record<string, string> = {
  title: 'Title', direction: 'Supplier or customer', type: 'Contract type', partyId: 'Other party', reference: 'Reference', value: 'Value', currency: 'Currency',
  startDate: 'Start date', endDate: 'End date', signedDate: 'Signed on', autoRenew: 'Renews automatically', renewalTermMonths: 'Renewal term (months)',
  noticeDays: 'Notice period (days)', ownerId: 'Owner', parentId: 'Master agreement', description: 'Description', category: 'Category', jurisdiction: 'Governing law',
};
const fieldNames = (d: unknown) => {
  const x = d as { fields?: unknown } | null;
  return x && Array.isArray(x.fields) ? { ...x, fields: (x.fields as string[]).map((f) => CONTRACT_FIELD_LABELS[f] ?? f) } : d;
};

/** Fields that can still be changed once a contract is active (anything else needs an amendment — Step 3). */
const ACTIVE_EDITABLE = ['ownerId', 'description', 'category', 'noticeDays', 'autoRenew', 'renewalTermMonths', 'reference'] as const;
/** Details that may be filled in on an active contract while they are still empty (completing a contract brought in from Excel or paper) — not changed once set. */
const FILL_IF_EMPTY = ['endDate', 'value'] as const;
/** What can change on a contract now: everything on a draft; on an approved / active one the editable fields plus any still-empty FILL_IF_EMPTY field. */
export function editableFields(c: Contract): 'all' | string[] {
  if (c.status === 'DRAFT') return 'all';
  if (!['ACTIVE', 'APPROVED', 'WITH_PARTY', 'AGREED'].includes(c.status)) return [];
  return [...ACTIVE_EDITABLE, ...(c.status === 'ACTIVE' ? FILL_IF_EMPTY.filter((k) => c[k] === null) : [])];
}

async function check(t: Tenant, input: z.infer<typeof contractInput>, self?: Contract) {
  const amendment = input.type === 'amendment';
  if (!amendment && !(CONTRACT_TYPE_KEYS as string[]).includes(input.type)) throw new HttpError(400, 'Choose a contract type');
  const type = input.type as ContractType;
  if (!amendment) {
    assertTypeOn(t, type);
    if (!directionsOn(t).includes(input.direction)) throw new HttpError(400, 'Customer contracts are switched off in Administration → Contracts.');
    if (!(CONTRACT_TYPES[type].directions as readonly string[]).includes(input.direction)) throw new HttpError(400, `${CONTRACT_TYPES[type].label} is only for ${input.direction === 'BUY' ? 'customer' : 'supplier'} contracts.`);
  } else if (!input.parentId) throw new HttpError(400, 'An amendment needs the contract it changes.');
  const party = await getParty(t.id, input.partyId);
  if (party.kind !== PARTY_KIND_FOR[input.direction]) throw new HttpError(400, `A ${DIRECTION_LABEL[input.direction].toLowerCase()} needs a ${KIND_LABEL[PARTY_KIND_FOR[input.direction]].toLowerCase()} as the other party.`);
  if (party.status !== 'ACTIVE' && party.id !== self?.partyId) throw new HttpError(400, `${party.name} is archived.`);
  if (input.startDate && input.endDate && input.endDate < input.startDate) throw new HttpError(400, 'The end date is before the start date.');
  if (input.autoRenew && !input.endDate) throw new HttpError(400, 'An automatically renewing contract needs an end date.');
  // Locked rules (e.g. the notice period) and their ranges apply to the contract's own terms.
  const rules = contractRules(t, { noticeDays: input.noticeDays ?? undefined, renewalTermMonths: input.renewalTermMonths ?? undefined });
  if (rules.valueRequired === 'required' && type !== 'nda' && !amendment && input.value == null) throw new HttpError(400, 'Enter the contract value.');
  if (input.ownerId) {
    const owner = await db.query.users.findFirst({ where: and(eq(U.tenantId, t.id), eq(U.id, input.ownerId)) });
    if (!owner || owner.status === 'DISABLED') throw new HttpError(400, 'Choose an owner from your team.');
  }
  if (input.parentId && amendment) {
    const parent = await db.query.contracts.findFirst({ where: and(eq(C.tenantId, t.id), eq(C.id, input.parentId)) });
    if (!parent || parent.partyId !== input.partyId || parent.type === 'amendment') throw new HttpError(400, 'An amendment changes a signed contract with the same party.');
  } else if (input.parentId) {
    if (!optionOn(t, 'contractHierarchy')) throw new HttpError(400, 'Linked contracts are switched off.');
    const parent = await db.query.contracts.findFirst({ where: and(eq(C.tenantId, t.id), eq(C.id, input.parentId)) });
    if (!parent) throw new HttpError(400, 'The master agreement wasn’t found.');
    if (parent.id === self?.id) throw new HttpError(400, 'A contract can’t sit under itself.');
    if (parent.partyId !== input.partyId) throw new HttpError(400, 'A contract can only sit under a master agreement with the same party.');
    if (parent.parentId) throw new HttpError(400, 'Choose a master agreement (it can’t itself sit under another contract).');
  }
}

/** What the record looks like with defaults filled in: currency from the workspace, notice and renewal from the rules. */
function withDefaults(t: Tenant, input: z.infer<typeof contractInput>) {
  const r = ruleDefaults(t);
  return {
    ...input, value: input.value == null ? null : input.value.toFixed(2), currency: input.currency ?? localeFor(t.country).currency,
    noticeDays: input.noticeDays === undefined ? (r.noticeDays as number | null) : input.noticeDays,
    renewalTermMonths: input.autoRenew ? (input.renewalTermMonths ?? (r.renewalTermMonths as number | null)) : null,
    ownerId: input.ownerId ?? null, parentId: input.parentId ?? null,
  };
}

/** Status for a signed contract by its dates. */
const signedStatus = (endDate: string | null) => (endDate && endDate < today() ? 'EXPIRED' : 'ACTIVE');

/* ---------------- create / update / lifecycle ---------------- */

export async function getContract(tenantId: string, id: string) {
  const c = await db.query.contracts.findFirst({ where: and(eq(C.tenantId, tenantId), eq(C.id, id)) });
  if (!c) throw new HttpError(404, 'Contract not found');
  return c;
}
const contractAudit = (t: Tenant, c: Pick<Contract, 'id' | 'number'>, by: By, action: string, extra: Record<string, unknown> = {}) =>
  audit({ tenantId: t.id, actor: by.name, action, detail: { subjectId: c.id, number: c.number, ...extra }, ip: by.ip });

/** New contract: a draft, or — with `signed` — a contract already signed outside VendorGate (status by its dates). */
export async function createContract(t: Tenant, raw: unknown, by: By, opts: { signed?: boolean; source?: 'MANUAL' | 'IMPORT' | 'AWARD'; sourcingEventId?: string; amends?: AmendmentChanges } = {}) {
  const input = contractInput.parse(raw);
  await check(t, input);
  if (opts.signed && !input.signedDate) throw new HttpError(400, 'Enter the date it was signed.');
  const data = withDefaults(t, input);
  const prefix = typeInfo(input.type).prefix;
  const c = await db.transaction(async (tx) => {
    const number = await nextYearlyNumber(tx, { table: C, tenantCol: C.tenantId, numberCol: C.number }, t.id, prefix);
    const [row] = await tx.insert(C).values({ ...data, tenantId: t.id, number, status: opts.signed ? signedStatus(data.endDate ?? null) : 'DRAFT', source: opts.source ?? 'MANUAL', sourcingEventId: opts.sourcingEventId ?? null, amends: opts.amends ?? null, createdById: by.id, createdByName: by.name }).returning();
    return row;
  });
  await contractAudit(t, c, by, 'CONTRACT_CREATED', { title: c.title, status: c.status, source: c.source });
  return c;
}

export async function updateContract(t: Tenant, id: string, raw: unknown, by: By) {
  const c = await getContract(t.id, id);
  if (c.status === 'TERMINATED' || c.status === 'EXPIRED') throw new HttpError(409, 'Ended contracts can’t be changed.');
  if (c.status === 'IN_APPROVAL') throw new HttpError(409, 'The contract is waiting for approval. Withdraw it to make changes.');
  if (c.status === 'SIGNING') throw new HttpError(409, 'The contract is out for signature. Cancel the signature request to change it.');
  const input = contractInput.parse({ ...contractToInput(c), ...(raw as object) });
  if (['ACTIVE', 'APPROVED', 'WITH_PARTY', 'AGREED', 'SIGNING'].includes(c.status)) {
    const before = contractToInput(c) as Record<string, unknown>;
    const allowed = editableFields(c) as string[];
    const changedLocked = Object.keys(raw as object).filter((k) => !allowed.includes(k) && JSON.stringify((input as Record<string, unknown>)[k] ?? null) !== JSON.stringify(before[k] ?? null));
    if (changedLocked.length) throw new HttpError(409, ['APPROVED', 'WITH_PARTY', 'AGREED'].includes(c.status) ? 'The contract is approved. Reopen it as a draft to change its parties, dates or value (it then needs approval again).' : 'An active contract’s parties, dates and value change through an amendment. You can change the owner, description, category, reference and renewal terms.', { fields: changedLocked });
  }
  await check(t, input, c);
  const data = withDefaults(t, input);
  const changedAny = Object.keys(data).some((k) => JSON.stringify((data as Record<string, unknown>)[k] ?? null) !== JSON.stringify((c as Record<string, unknown>)[k] ?? null));
  // A made document shows these details, so changing them puts the document out of date.
  const [row] = await db.update(C).set({ ...data, ...(changedAny && c.status === 'DRAFT' && c.draft ? { draft: touchDraft(c) } : {}) }).where(eq(C.id, c.id)).returning();
  const changed = Object.keys(data).filter((k) => JSON.stringify((data as Record<string, unknown>)[k] ?? null) !== JSON.stringify((c as Record<string, unknown>)[k] ?? null));
  if (changed.length) await contractAudit(t, c, by, 'CONTRACT_UPDATED', { fields: changed });
  return row;
}

/** Mark a draft as signed (outside VendorGate for now — e-signature arrives in Step 2). */
export async function markSigned(t: Tenant, id: string, raw: unknown, by: By) {
  const c = await getContract(t.id, id);
  if (!['DRAFT', 'APPROVED', 'AGREED', 'WITH_PARTY'].includes(c.status)) throw new HttpError(409, c.status === 'IN_APPROVAL' ? 'The contract is still waiting for approval.' : c.status === 'SIGNING' ? 'It is out for e-signature — cancel that first to record a paper signature.' : 'Only a draft, approved or agreed contract can be marked as signed.');
  if (c.status === 'DRAFT' && c.draft && optionOn(t, 'internalApproval')) throw new HttpError(409, 'Submit the contract for approval first.');
  const { signedDate } = z.object({ signedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date it was signed') }).parse(raw);
  if (signedDate > today()) throw new HttpError(400, 'The signing date can’t be in the future.');
  if (!c.startDate) throw new HttpError(400, 'Enter the start date first.');
  const [signed] = await db.select({ n: count() }).from(F).where(and(eq(F.contractId, c.id), eq(F.kind, 'SIGNED')));
  if (!signed.n) throw new HttpError(400, 'Upload the signed copy first.');
  const [row] = await db.update(C).set({ signedDate, status: c.type === 'amendment' ? 'ACTIVE' : signedStatus(c.endDate) }).where(eq(C.id, c.id)).returning();
  await contractAudit(t, c, by, 'CONTRACT_SIGNED', { signedDate, status: row.status });
  await (await import('./manage.js')).onSigned(t, row, by.name);
  return row;
}

export async function terminateContract(t: Tenant, id: string, raw: unknown, by: By) {
  const c = await getContract(t.id, id);
  if (c.status !== 'ACTIVE') throw new HttpError(409, 'Only an active contract can be terminated.');
  const { reason, effectiveDate } = z.object({ reason: z.string().trim().min(5, 'Say why the contract is ending').max(1000), effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(raw);
  const end = effectiveDate ?? today();
  const [row] = await db.update(C).set({ status: 'TERMINATED', terminatedAt: new Date(), terminationReason: reason, endDate: c.endDate && c.endDate < end ? c.endDate : end, autoRenew: false }).where(eq(C.id, c.id)).returning();
  await contractAudit(t, c, by, 'CONTRACT_TERMINATED', { reason, effectiveDate: end });
  return row;
}

export async function deleteDraft(t: Tenant, id: string, by: By) {
  const c = await getContract(t.id, id);
  if (c.status !== 'DRAFT') throw new HttpError(409, 'Only drafts can be deleted. End an active contract by terminating it.');
  const [kids] = await db.select({ n: count() }).from(C).where(eq(C.parentId, c.id));
  if (kids.n) throw new HttpError(409, 'Other contracts sit under this one. Move or delete them first.');
  const files = await db.select().from(F).where(eq(F.contractId, c.id));
  await db.delete(C).where(eq(C.id, c.id));
  for (const f of files) await removeStored(f);
  await contractAudit(t, c, by, 'CONTRACT_DELETED', { title: c.title });
}

const contractToInput = (c: Contract) => ({
  title: c.title, direction: c.direction, type: c.type, partyId: c.partyId, reference: c.reference, value: c.value === null ? null : Number(c.value), currency: c.currency,
  startDate: c.startDate, endDate: c.endDate, signedDate: c.signedDate, autoRenew: c.autoRenew, renewalTermMonths: c.renewalTermMonths, noticeDays: c.noticeDays,
  ownerId: c.ownerId, parentId: c.parentId, description: c.description, category: c.category,
});

/* ---------------- files ---------------- */

export async function addFile(t: Tenant, id: string, kind: string, file: { buffer: Buffer; originalname: string }, by: By) {
  const c = await getContract(t.id, id);
  if (!UPLOAD_KINDS.includes(kind)) throw new HttpError(400, 'Choose what the file is');
  if (c.status === 'TERMINATED' || c.status === 'EXPIRED') throw new HttpError(409, 'Ended contracts can’t take new files.');
  const stored = await storeUpload(t.id, `contracts/${c.id}`, file, { types: CONTRACT_FILE_TYPES });
  return attachStored(t, c, kind, stored, by);
}
/** File types a contract can hold (Word, PDF, images). */
export const CONTRACT_FILE_TYPES = [DOCX, 'application/pdf', 'image/png', 'image/jpeg'];
/** Attach an already stored file to a contract (uploads, and files from the migration inbox). */
export async function attachStored(t: Tenant, c: Contract, kind: string, stored: { fileName: string; mimeType: string; size: number; storagePath: string; storageDriver: string; sha256: string | null; scanStatus: string }, by: By) {
  if (!UPLOAD_KINDS.includes(kind)) throw new HttpError(400, 'Choose what the file is');
  if (c.status === 'TERMINATED' || c.status === 'EXPIRED') throw new HttpError(409, 'Ended contracts can’t take new files.');
  const [row] = await db.insert(F).values({ tenantId: t.id, contractId: c.id, kind, fileName: stored.fileName, mimeType: stored.mimeType, size: stored.size, storagePath: stored.storagePath, storageDriver: stored.storageDriver, sha256: stored.sha256, scanStatus: stored.scanStatus, uploadedByName: by.name }).returning();
  await contractAudit(t, c, by, 'CONTRACT_FILE_ADDED', { kind, fileName: row.fileName });
  return row;
}
export async function removeFile(t: Tenant, id: string, fileId: string, by: By) {
  const c = await getContract(t.id, id);
  const f = await db.query.contractFiles.findFirst({ where: and(eq(F.tenantId, t.id), eq(F.contractId, c.id), eq(F.id, fileId)) });
  if (!f) throw new HttpError(404, 'File not found');
  if (c.status !== 'DRAFT' && f.kind === 'SIGNED') throw new HttpError(409, 'The signed copy of a signed contract is kept.');
  if (f.kind === 'SIGNING' || f.kind === 'REDLINE') throw new HttpError(409, 'This file is kept with the contract’s history.');
  const sent = await db.select({ ids: schema.contractVersions.fileIds }).from(schema.contractVersions).where(eq(schema.contractVersions.contractId, c.id));
  const signing = await db.select({ id: schema.contractSignatures.id }).from(schema.contractSignatures).where(and(eq(schema.contractSignatures.contractId, c.id), eq(schema.contractSignatures.documentFileId, f.id))).limit(1);
  if (sent.some((v) => v.ids.includes(f.id)) || signing.length) throw new HttpError(409, 'This file was sent to the other party, so it is kept with the contract’s history.');
  await db.delete(F).where(eq(F.id, f.id));
  await removeStored(f);
  await contractAudit(t, c, by, 'CONTRACT_FILE_REMOVED', { kind: f.kind, fileName: f.fileName });
}
export async function getFile(tenantId: string, fileId: string): Promise<ContractFile> {
  const f = await db.query.contractFiles.findFirst({ where: and(eq(F.tenantId, tenantId), eq(F.id, fileId)) });
  if (!f) throw new HttpError(404, 'File not found');
  return f;
}

/* ---------------- lists and detail ---------------- */

/** Days until the end date, and whether it counts as "expiring" under the workspace's rule. */
function timing(t: Tenant, c: Pick<Contract, 'status' | 'endDate' | 'noticeDays' | 'autoRenew'>) {
  const window = Number(ruleDefaults(t).expiringDays ?? 90);
  const daysLeft = c.endDate ? Math.round((Date.parse(`${c.endDate}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86_400_000) : null;
  const noticeBy = c.endDate && c.noticeDays != null ? addDays(c.endDate, -c.noticeDays) : null;
  return { daysLeft, expiring: c.status === 'ACTIVE' && daysLeft !== null && daysLeft >= 0 && daysLeft <= window, noticeBy };
}

export async function listContracts(t: Tenant, q: Record<string, unknown>) {
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
  const page = Math.max(1, Math.floor(Number(q.page) || 1));
  const where: SQL[] = [eq(C.tenantId, t.id)];
  const s = (k: string) => (typeof q[k] === 'string' && q[k] ? (q[k] as string) : undefined);
  if (s('direction') === 'BUY' || s('direction') === 'SELL') where.push(eq(C.direction, s('direction')!));
  if (s('type')) where.push(eq(C.type, s('type')!));
  if (s('partyId')) where.push(eq(C.partyId, s('partyId')!));
  if (s('ownerId')) where.push(eq(C.ownerId, s('ownerId')!));
  if (s('status') === 'ENDED') where.push(inArray(C.status, ['EXPIRED', 'TERMINATED']));
  else if (s('status') && STATUS_LABEL[s('status')!]) where.push(eq(C.status, s('status')!));
  if (s('filter') === 'expiring') {
    where.push(eq(C.status, 'ACTIVE'), isNotNull(C.endDate), gte(C.endDate, today()), lte(C.endDate, addDays(today(), Number(ruleDefaults(t).expiringDays ?? 90))));
  }
  if (s('q')) { const like = `%${s('q')}%`; where.push(or(ilike(C.number, like), ilike(C.title, like), ilike(C.reference, like), ilike(P.name, like), ilike(P.code, like))!); }
  const base = db.select({ c: C, partyName: P.name, partyCode: P.code, owner: U.name }).from(C).innerJoin(P, eq(P.id, C.partyId)).leftJoin(U, eq(U.id, C.ownerId)).where(and(...where));
  const [{ n: total }] = await db.select({ n: count() }).from(C).innerJoin(P, eq(P.id, C.partyId)).where(and(...where));
  const order = s('sort') === 'end' ? [sql`${C.endDate} asc nulls last`, asc(C.number)] : [desc(C.updatedAt), asc(C.id)];
  const rows = await base.orderBy(...order).limit(pageSize).offset((page - 1) * pageSize);
  const counts = await db.select({ status: C.status, n: count() }).from(C).where(eq(C.tenantId, t.id)).groupBy(C.status);
  const [{ n: expiring }] = await db.select({ n: count() }).from(C).where(and(eq(C.tenantId, t.id), eq(C.status, 'ACTIVE'), isNotNull(C.endDate), gte(C.endDate, today()), lte(C.endDate, addDays(today(), Number(ruleDefaults(t).expiringDays ?? 90)))));
  return {
    total, page, pageSize, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), expiring,
    contracts: rows.map(({ c, partyName, partyCode, owner }) => ({ ...summary(c), party: { id: c.partyId, name: partyName, code: partyCode }, owner, ...timing(t, c) })),
  };
}

const summary = (c: Contract) => ({
  id: c.id, number: c.number, reference: c.reference, title: c.title, direction: c.direction, type: c.type, status: c.status, value: c.value === null ? null : Number(c.value), currency: c.currency,
  startDate: c.startDate, endDate: c.endDate, signedDate: c.signedDate, autoRenew: c.autoRenew, updatedAt: c.updatedAt,
});

export async function contractDetail(t: Tenant, id: string, userId: string) {
  const c = await getContract(t.id, id);
  const party = await getParty(t.id, c.partyId);
  const owner = c.ownerId ? await db.query.users.findFirst({ where: eq(U.id, c.ownerId), columns: { id: true, name: true } }) : null;
  const parent = c.parentId ? await db.query.contracts.findFirst({ where: and(eq(C.tenantId, t.id), eq(C.id, c.parentId)) }) : null;
  const children = await db.select().from(C).where(and(eq(C.tenantId, t.id), eq(C.parentId, c.id))).orderBy(asc(C.number));
  const files = await db.select().from(F).where(eq(F.contractId, c.id)).orderBy(desc(F.uploadedAt));
  const history = await db.select({ actor: schema.auditLogs.actor, action: schema.auditLogs.action, detail: schema.auditLogs.detail, createdAt: schema.auditLogs.createdAt }).from(schema.auditLogs)
    .where(and(eq(schema.auditLogs.tenantId, t.id), sql`${schema.auditLogs.detail}->>'subjectId' = ${c.id}`)).orderBy(desc(schema.auditLogs.createdAt)).limit(100);
  return {
    contract: { ...summary(c), partyId: c.partyId, renewalTermMonths: c.renewalTermMonths, noticeDays: c.noticeDays, ownerId: c.ownerId, parentId: c.parentId, description: c.description, category: c.category,
      source: c.source, terminatedAt: c.terminatedAt, terminationReason: c.terminationReason, createdByName: c.createdByName, createdAt: c.createdAt, ...timing(t, c) },
    party: { id: party.id, code: party.code, name: party.name, kind: party.kind, country: party.country, contacts: party.contacts },
    owner: owner ?? null,
    parent: parent ? summary(parent) : null,
    children: children.map(summary),
    files: files.map((f) => ({ id: f.id, kind: f.kind, fileName: f.fileName, size: f.size, uploadedByName: f.uploadedByName, uploadedAt: f.uploadedAt, generated: f.generated, version: f.version })),
    history: history.map((h) => ({ ...h, detail: fieldNames(h.detail) as typeof h.detail })),
    editable: editableFields(c),
    drafting: await draftView(t, c, userId),
    negotiation: await negotiationView(t, c),
    manage: await (await import('./manage.js')).manageView(t, c),
    reading: await (await import('./reading.js')).readingsView(t, c),
    watch: await (await import('./watch.js')).contractSuggestions(t, c),
    signing: await signingView(t, c, (await db.query.users.findFirst({ where: eq(U.id, userId), columns: { email: true } }))?.email ?? ''),
  };
}

/** Master agreements a new contract with this party can sit under. */
export async function parentOptions(t: Tenant, partyId: string) {
  return db.select({ id: C.id, number: C.number, title: C.title }).from(C)
    .where(and(eq(C.tenantId, t.id), eq(C.partyId, partyId), sql`${C.parentId} is null`, inArray(C.status, ['DRAFT', 'ACTIVE']))).orderBy(asc(C.number)).limit(500);
}

/** People who can own contracts (anyone with contracts.view). */
export async function ownerOptions(t: Tenant) {
  const rows = await db.execute(sql`select distinct u.id, u.name from users u join user_roles ur on ur.user_id = u.id join roles r on r.id = ur.role_id
    where u.tenant_id = ${t.id} and u.status <> 'DISABLED' and (r.permissions ? 'contracts.view' or r.key = 'ADMIN') order by u.name`);
  return (rows as unknown as { rows: { id: string; name: string }[] }).rows;
}

/* ---------------- Excel import of existing contracts ---------------- */

const CONTRACT_COLUMNS: SheetColumn[] = [
  { header: 'Party type', width: 12, required: true }, { header: 'Party', width: 32, required: true }, { header: 'Party country', width: 10 },
  { header: 'Contract type', width: 26, required: true }, { header: 'Title', width: 36, required: true }, { header: 'Their reference', width: 18 },
  { header: 'Value', width: 14 }, { header: 'Currency', width: 9 }, { header: 'Start date', width: 12, required: true, type: 'date' }, { header: 'End date', width: 12, type: 'date' },
  { header: 'Signed date', width: 12, required: true, type: 'date' }, { header: 'Renews automatically', width: 12 }, { header: 'Renewal months', width: 10 }, { header: 'Notice days', width: 10 },
  { header: 'Owner email', width: 26 }, { header: 'Category', width: 16 }, { header: 'Description', width: 40 }, { header: 'Master agreement', width: 22 },
];
export function contractsTemplate(t: Tenant) {
  const types = CONTRACT_TYPE_KEYS.filter((k) => typeState(t, k).on).map((k) => CONTRACT_TYPES[k].label);
  const cur = localeFor(t.country).currency;
  return sheetTemplate({
    sheet: 'Contracts', columns: CONTRACT_COLUMNS, examplesOnOwnSheet: true, lists: { 'Party type': ['Supplier', 'Customer'], 'Contract type': types, 'Renews automatically': ['Yes', 'No'] },
    examples: [['Supplier', 'Precision Valves Pvt Ltd', t.country, CONTRACT_TYPES.supply.label, 'Valves rate contract 2026', 'PV/RC/26/014', 1800000, cur, '2026-04-01', '2027-03-31', '2026-03-20', 'Yes', 12, 60, '', 'Valves', '', ''],
      ['Customer', 'Northwind Retail LLC', 'AE', CONTRACT_TYPES.nda.label, 'Mutual NDA — Northwind', '', '', '', '2026-01-10', '2028-01-09', '2026-01-10', 'No', '', 30, '', '', '', ''],
      ['Supplier', 'Precision Valves Pvt Ltd', t.country, CONTRACT_TYPES.sow.label, 'SOW 1 — valve audit', 'PV/SOW/26/001', 250000, cur, '2026-05-01', '2026-09-30', '2026-04-25', 'No', '', '', '', 'Valves', '', 'PV/MSA/24/002']],
    help: [
      ['Contracts', 'One row per contract already signed outside VendorGate. They come in as Active (or Expired if the end date has passed).'],
      ['Party', 'The supplier or customer name, or its code (SUP-00001). If it doesn’t exist yet, tick “Create missing parties” when importing (Party country is then needed).'],
      ['Contract type', 'One of the types switched on in Administration → Contracts — pick from the list.'],
      ['Dates', 'Start date and Signed date are needed; End date is empty for contracts with no fixed end. Use YYYY-MM-DD or an Excel date.'],
      ['Master agreement', 'For a statement of work or order under a master agreement: the master agreement’s contract number (e.g. MSA-2026-0001) or its reference. It can be in this same sheet, on an earlier row.'],
      ['Files', 'Then upload the signed copies in bulk (Contracts → Migration): each file is matched to its contract by the contract number or the reference in the file name.'],
      ['Example', 'The Example sheet shows two filled-in rows. Only the Contracts sheet is imported.'],
    ],
  });
}

/** Read existing contracts from the template; with `commit` they are created (and missing parties too if asked). */
export async function importContracts(t: Tenant, buffer: Buffer, by: By, opts: { commit: boolean; createParties: boolean }) {
  if (!optionOn(t, 'excelImport')) throw new HttpError(400, 'Importing contracts is switched off in Administration → Contracts.');
  const rows = await readSheet(buffer, { sheet: 'Contracts', columns: CONTRACT_COLUMNS, maxRows: 2000 });
  const typeByLabel = new Map(CONTRACT_TYPE_KEYS.map((k) => [CONTRACT_TYPES[k].label.toLowerCase(), k]));
  const owners = new Map((await db.select({ id: U.id, email: U.email }).from(U).where(eq(U.tenantId, t.id))).map((u) => [u.email.toLowerCase(), u.id]));
  const allParties = await db.select({ id: P.id, code: P.code, name: P.name, kind: P.kind }).from(P).where(and(eq(P.tenantId, t.id), eq(P.status, 'ACTIVE')));
  const errors: RowError[] = [];
  const ready: { row: number; input: ContractInput; newParty?: { kind: 'SUPPLIER' | 'CUSTOMER'; name: string; country: string }; parentRow?: number }[] = [];
  const existing = await db.select({ id: C.id, number: C.number, reference: C.reference, type: C.type, partyId: C.partyId, parentId: C.parentId }).from(C).where(eq(C.tenantId, t.id));
  for (const { row, get } of rows) {
    const pt = get('Party type').toLowerCase();
    const kind = pt.startsWith('sup') ? 'SUPPLIER' : pt.startsWith('cus') ? 'CUSTOMER' : null;
    if (!kind) { errors.push({ row, message: 'Party type must be Supplier or Customer' }); continue; }
    const direction: Direction = kind === 'SUPPLIER' ? 'BUY' : 'SELL';
    const typeKey = typeByLabel.get(get('Contract type').toLowerCase()) ?? (CONTRACT_TYPE_KEYS as string[]).find((k) => k === get('Contract type').toLowerCase());
    if (!typeKey) { errors.push({ row, message: `Unknown contract type “${get('Contract type')}”` }); continue; }
    const name = get('Party');
    const party = allParties.find((p) => p.kind === kind && (p.code.toLowerCase() === name.toLowerCase() || p.name.toLowerCase() === name.toLowerCase()));
    let newParty: { kind: 'SUPPLIER' | 'CUSTOMER'; name: string; country: string } | undefined;
    if (!party) {
      if (!opts.createParties) { errors.push({ row, message: `${KIND_LABEL[kind]} “${name}” not found (tick “Create missing parties” to add it)` }); continue; }
      const country = get('Party country').toUpperCase();
      if (!/^[A-Z]{2}$/.test(country)) { errors.push({ row, message: `Party country is needed to create “${name}” (two letters, e.g. IN)` }); continue; }
      newParty = { kind, name, country };
    }
    const num = (h: string) => { const v = get(h).replace(/,/g, ''); return v === '' ? null : Number(v); };
    const ownerEmail = get('Owner email').toLowerCase();
    if (ownerEmail && !owners.has(ownerEmail)) { errors.push({ row, message: `No user with the email ${ownerEmail}` }); continue; }
    const input: ContractInput = {
      title: get('Title'), direction, type: typeKey, partyId: party?.id ?? 'new', reference: get('Their reference') || null, value: num('Value'), currency: get('Currency') || undefined,
      startDate: get('Start date'), endDate: get('End date') || null, signedDate: get('Signed date'), autoRenew: /^y/i.test(get('Renews automatically')),
      renewalTermMonths: num('Renewal months'), noticeDays: num('Notice days'), ownerId: ownerEmail ? owners.get(ownerEmail)! : by.id, category: get('Category') || null, description: get('Description') || null,
    };
    // Master agreement: an existing contract (number or reference), or an earlier row of this sheet (its reference).
    const master = get('Master agreement').trim().toLowerCase();
    let parentRow: number | undefined;
    if (master) {
      const inDb = existing.filter((x) => x.number.toLowerCase() === master || x.reference?.toLowerCase() === master);
      const inSheet = ready.filter((x) => x.input.reference?.toLowerCase() === master);
      if (inDb.length === 1) input.parentId = inDb[0].id;
      else if (!inDb.length && inSheet.length === 1) {
        const m = inSheet[0];
        if (m.input.type !== 'msa') { errors.push({ row, message: `Row ${m.row} (“${m.input.title}”) is not a master agreement` }); continue; }
        if (m.input.partyId !== input.partyId || (m.newParty && m.newParty.name.toLowerCase() !== name.toLowerCase())) { errors.push({ row, message: `The master agreement on row ${m.row} is with another party` }); continue; }
        parentRow = m.row;
      } else { errors.push({ row, message: inDb.length > 1 || inSheet.length > 1 ? `More than one contract has the reference “${get('Master agreement')}” — use its contract number` : `Master agreement “${get('Master agreement')}” not found (use its contract number or reference; in this sheet it must be on an earlier row)` }); continue; }
    }
    const parsed = contractInput.safeParse(input);
    if (!parsed.success) { errors.push({ row, message: parsed.error.issues.map((i) => `${String(i.path[0] ?? '')}: ${i.message}`).join('; ') }); continue; }
    if (!parsed.data.startDate || !parsed.data.signedDate) { errors.push({ row, message: 'Start date and Signed date are needed' }); continue; }
    try {
      if (party) await check(t, parsed.data);
      else assertTypeOn(t, typeKey as ContractType);
    } catch (e) { errors.push({ row, message: (e as Error).message }); continue; }
    ready.push({ row, input, newParty, parentRow });
  }
  if (!rows.length) errors.push({ row: 0, message: 'No contracts found in the sheet.' });
  const created: { row: number; number: string; title: string }[] = [];
  if (opts.commit) {
    const made = new Map<string, string>();
    const byRow = new Map<number, string>();
    for (const r of ready) {
      let partyId = r.input.partyId;
      if (r.newParty) {
        const key = `${r.newParty.kind}:${r.newParty.name.toLowerCase()}`;
        if (!made.has(key)) made.set(key, (await createParty(t, { ...r.newParty, confirmDuplicate: true }, by, { source: 'contract import' })).id);
        partyId = made.get(key)!;
      }
      const c = await createContract(t, { ...r.input, partyId, ...(r.parentRow ? { parentId: byRow.get(r.parentRow) } : {}) }, by, { signed: true, source: 'IMPORT' });
      byRow.set(r.row, c.id);
      created.push({ row: r.row, number: c.number, title: c.title });
    }
  }
  return { ready: ready.map((r) => ({ row: r.row, title: r.input.title, party: r.newParty ? `${r.newParty.name} (new)` : allParties.find((p) => p.id === r.input.partyId)?.name, type: r.input.type })), errors, created };
}

/* ---------------- daily: end dates ---------------- */

/** Active contracts past their end date expire — or, if they renew automatically, roll on by their renewal term. */
export async function runContractEndDates() {
  const due = await db.select().from(C).where(and(eq(C.status, 'ACTIVE'), isNotNull(C.endDate), lt(C.endDate, today())));
  let expired = 0, renewed = 0;
  for (const c of due) {
    const by = { id: '', name: 'system' };
    const t = { id: c.tenantId } as Tenant;
    if (c.autoRenew && c.renewalTermMonths) {
      let end = c.endDate!;
      while (end < today()) end = addMonths(end, c.renewalTermMonths);
      await db.update(C).set({ endDate: end }).where(eq(C.id, c.id));
      await contractAudit(t, c, by, 'CONTRACT_RENEWED', { from: c.endDate, to: end, automatic: true });
      renewed++;
    } else {
      await db.update(C).set({ status: 'EXPIRED' }).where(eq(C.id, c.id));
      await contractAudit(t, c, by, 'CONTRACT_EXPIRED', { endDate: c.endDate });
      expired++;
    }
  }
  if (expired || renewed) logger.info({ expired, renewed }, 'contract end dates');
  return { expired, renewed };
}
defineJob('contracts.daily', async () => { await runContractEndDates(); await (await import('./manage.js')).runContractReminders(); await (await import('./watch.js')).runWatch(); }, { retryLimit: 1, expireInSeconds: 1800 });
