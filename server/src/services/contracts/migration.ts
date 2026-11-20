/**
 * Contracts migration: bringing a customer's existing contracts in (Contracts → Migration).
 *
 * - Bulk signed copies: many files or .zip files; each file is matched to one contract by the contract number or the
 *   contract's reference in the file name ("check first", then import). Files that match no contract, or several, go
 *   to the inbox (`contract_inbox`), where someone attaches them, makes a new contract from them, or removes them.
 * - Bulk reading: read every uploaded contract file that hasn't been read yet (the same masked reading as one at a
 *   time), then a review queue of the values found that the contract doesn't have yet.
 * - The checklist: active contracts with no signed copy, owner, end date or notice period; drafts waiting to be
 *   marked signed; readings to review; files in the inbox.
 * Parties, contracts (with master agreements) and obligations come in through the Excel imports.
 */
import PizZip from 'pizzip';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import type { Contract, Tenant } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { removeStored, storeUpload } from '../../integrations/storage/index.js';
import { attachStored, CONTRACT_FILE_TYPES, createContract, editableFields } from './contracts.js';
import { applyReading, readContract } from './reading.js';

const { contracts: C, contractFiles: F, contractInbox: I, contractReadings: RD, parties: P } = schema;
type By = { id: string; name: string; ip?: string };
type Upload = { buffer: Buffer; originalname: string };

/* ---------------- unpacking ---------------- */

/** Limits for a .zip of contracts: no more than this many files, each and all together no bigger than this once unpacked. */
export const ZIP_LIMITS = { files: 500, eachBytes: 25 * 1024 * 1024, totalBytes: 300 * 1024 * 1024 };
const FILE_RE = /\.(pdf|docx|png|jpe?g)$/i;

/** Uploaded files, with any .zip unpacked (only contract files inside; folders, hidden and Mac resource files skipped). */
export function unpack(files: Upload[]): { files: Upload[]; skipped: string[] } {
  const out: Upload[] = [], skipped: string[] = [];
  for (const f of files) {
    const isZip = /\.zip$/i.test(f.originalname) || (f.buffer.subarray(0, 2).toString('latin1') === 'PK' && !/\.docx$/i.test(f.originalname));
    if (!isZip) { out.push(f); continue; }
    let zip: PizZip;
    try { zip = new PizZip(f.buffer); } catch { throw new HttpError(400, `${f.originalname} is not a .zip file VendorGate can open.`); }
    const entries = Object.values(zip.files).filter((e) => !e.dir);
    if (entries.length > ZIP_LIMITS.files) throw new HttpError(400, `${f.originalname} has ${entries.length} files — upload at most ${ZIP_LIMITS.files} at a time.`);
    let total = 0;
    for (const e of entries) {
      const base = e.name.split('/').pop() ?? '';
      if (!base || base.startsWith('.') || e.name.startsWith('__MACOSX/')) continue;
      if (!FILE_RE.test(base)) { skipped.push(`${base} (not a Word, PDF or image file)`); continue; }
      const size = (e as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
      total += size;
      if (size > ZIP_LIMITS.eachBytes) { skipped.push(`${base} (larger than 25 MB)`); continue; }
      if (total > ZIP_LIMITS.totalBytes) throw new HttpError(400, `${f.originalname} unpacks to more than 300 MB — split it into smaller .zip files.`);
      out.push({ buffer: e.asNodeBuffer(), originalname: base });
    }
  }
  return { files: out, skipped };
}

/* ---------------- matching file names to contracts ---------------- */

const norm = (x: string) => x.toUpperCase().replace(/[^A-Z0-9]/g, '');
type Target = { id: string; number: string; title: string; reference: string | null; status: string };

/** The contract a file name points to: its contract number, else its reference (letters and digits only, 4+). */
export function matchName(fileName: string, contracts: Target[]): { match?: Target; candidates: Target[] } {
  const name = norm(fileName.replace(/\.[a-z0-9]+$/i, ''));
  const byNumber = contracts.filter((c) => name.includes(norm(c.number)));
  // The longest number wins (AMD-2026-0001 inside a name that also has SVC-2026-0001 is unlikely, but numbers can nest).
  if (byNumber.length) { const best = byNumber.filter((c) => norm(c.number).length === Math.max(...byNumber.map((x) => norm(x.number).length))); return best.length === 1 ? { match: best[0], candidates: [] } : { candidates: best }; }
  const byRef = contracts.filter((c) => c.reference && norm(c.reference).length >= 4 && name.includes(norm(c.reference)));
  if (byRef.length === 1) return { match: byRef[0], candidates: [] };
  return { candidates: byRef };
}

/** Bulk signed copies: what would happen (check) or do it (commit). Matched files are attached as `kind`; the rest go to the inbox. */
export async function bulkFiles(t: Tenant, uploads: Upload[], by: By, opts: { commit: boolean; kind: string }) {
  if (!['SIGNED', 'ANNEXURE', 'OTHER'].includes(opts.kind)) throw new HttpError(400, 'Choose what the files are');
  if (!uploads.length) throw new HttpError(400, 'Choose the files to upload.');
  const { files, skipped } = unpack(uploads);
  const contracts = await db.select({ id: C.id, number: C.number, title: C.title, reference: C.reference, status: C.status }).from(C)
    .where(and(eq(C.tenantId, t.id), inArray(C.status, ['DRAFT', 'APPROVED', 'WITH_PARTY', 'AGREED', 'ACTIVE'])));
  const plan: { file: string; contract?: { id: string; number: string; title: string }; result: 'attach' | 'inbox' | 'duplicate' | 'error'; note?: string }[] = [];
  const hashes = new Map<string, Set<string>>();
  for (const f of files) {
    const m = matchName(f.originalname, contracts);
    if (!m.match) {
      plan.push({ file: f.originalname, result: 'inbox', note: m.candidates.length ? `Matches ${m.candidates.length} contracts: ${m.candidates.slice(0, 3).map((c) => c.number).join(', ')}` : 'No contract number or reference in the file name' });
      if (opts.commit) await toInbox(t, f, by, m.candidates, plan[plan.length - 1]);
      continue;
    }
    const c = m.match;
    if (!hashes.has(c.id)) hashes.set(c.id, new Set((await db.select({ sha: F.sha256 }).from(F).where(eq(F.contractId, c.id))).map((x) => x.sha ?? '')));
    const sha = (await import('node:crypto')).createHash('sha256').update(f.buffer).digest('hex');
    if (hashes.get(c.id)!.has(sha)) { plan.push({ file: f.originalname, contract: c, result: 'duplicate', note: 'Already on this contract' }); continue; }
    plan.push({ file: f.originalname, contract: { id: c.id, number: c.number, title: c.title }, result: 'attach' });
    if (opts.commit) {
      try {
        const row = (await db.query.contracts.findFirst({ where: eq(C.id, c.id) }))!;
        const stored = await storeUpload(t.id, `contracts/${c.id}`, f, { types: CONTRACT_FILE_TYPES });
        await attachStored(t, row, opts.kind, stored, by);
        hashes.get(c.id)!.add(sha);
      } catch (e) { Object.assign(plan[plan.length - 1], { result: 'error', note: (e as Error).message }); }
    }
  }
  const count = (r: string) => plan.filter((p) => p.result === r).length;
  return { plan, skipped, attach: count('attach'), inbox: count('inbox'), duplicate: count('duplicate'), errors: count('error'), committed: opts.commit };
}

async function toInbox(t: Tenant, f: Upload, by: By, candidates: Target[], line: { result: string; note?: string }) {
  try {
    const stored = await storeUpload(t.id, 'contracts/inbox', f, { types: CONTRACT_FILE_TYPES });
    await db.insert(I).values({ tenantId: t.id, ...stored, reason: line.note ?? 'Not matched', candidates: candidates.slice(0, 10).map((c) => ({ id: c.id, number: c.number, title: c.title })), uploadedByName: by.name });
  } catch (e) { Object.assign(line, { result: 'error', note: (e as Error).message }); }
}

/* ---------------- the inbox ---------------- */

export async function inboxList(t: Tenant) {
  return db.select({ id: I.id, fileName: I.fileName, size: I.size, mimeType: I.mimeType, reason: I.reason, candidates: I.candidates, uploadedByName: I.uploadedByName, uploadedAt: I.uploadedAt })
    .from(I).where(eq(I.tenantId, t.id)).orderBy(desc(I.uploadedAt)).limit(500);
}
async function inboxFile(t: Tenant, id: string) {
  const f = await db.query.contractInbox.findFirst({ where: and(eq(I.tenantId, t.id), eq(I.id, id)) });
  if (!f) throw new HttpError(404, 'File not found');
  return f;
}
export const inboxDownload = inboxFile;

/** Attach an inbox file to a contract. */
export async function inboxAttach(t: Tenant, id: string, raw: { contractId?: string; kind?: string }, by: By) {
  const f = await inboxFile(t, id);
  const c = await db.query.contracts.findFirst({ where: and(eq(C.tenantId, t.id), eq(C.id, String(raw.contractId ?? ''))) });
  if (!c) throw new HttpError(400, 'Choose the contract.');
  await attachStored(t, c, raw.kind ?? 'SIGNED', f, by);
  await db.delete(I).where(eq(I.id, f.id));
  return { contractId: c.id };
}

/** Make a new draft contract from an inbox file: the file becomes its signed copy and is read (masked) for the terms. */
export async function inboxNewContract(t: Tenant, id: string, raw: Record<string, unknown>, by: By) {
  const f = await inboxFile(t, id);
  const title = String(raw.title ?? '').trim() || f.fileName.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim();
  const c = await createContract(t, { ...raw, title, ownerId: raw.ownerId ?? by.id }, by);
  const file = await attachStored(t, c, 'SIGNED', f, by);
  await db.delete(I).where(eq(I.id, f.id));
  let read: string | null = null;
  if (/pdf|wordprocessingml/.test(file.mimeType)) {
    try { await readContract(t, c.id, file.id, by); read = 'read'; } catch (e) { read = (e as Error).message; }
  }
  return { contractId: c.id, number: c.number, read };
}

export async function inboxRemove(t: Tenant, id: string) {
  const f = await inboxFile(t, id);
  await db.delete(I).where(eq(I.id, f.id));
  await removeStored(f).catch((err) => logger.warn({ err }, 'inbox file not removed from storage'));
}

/* ---------------- bulk reading ---------------- */

/** Contract files that can be read and haven't been: Word / PDF, uploaded (not made by VendorGate), on a draft or active contract. */
async function unread(t: Tenant, limit: number) {
  return db.select({ contractId: F.contractId, fileId: F.id, number: C.number }).from(F).innerJoin(C, eq(C.id, F.contractId))
    .where(and(eq(F.tenantId, t.id), eq(F.generated, false), inArray(F.kind, ['SIGNED', 'DRAFT', 'OTHER']), inArray(F.mimeType, ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
      inArray(C.status, ['DRAFT', 'ACTIVE']), sql`not exists (select 1 from contract_readings r where r.contract_id = ${F.contractId})`))
    .orderBy(asc(F.uploadedAt)).limit(limit);
}

/** Read up to `batch` unread contracts (one file each); the screen calls again until nothing is left. */
export async function bulkRead(t: Tenant, by: By, batch = 20) {
  const todo = await unread(t, 400);
  const seen = new Set<string>();
  const pick = todo.filter((x) => !seen.has(x.contractId) && seen.add(x.contractId)).slice(0, batch);
  let read = 0;
  const failed: { number: string; error: string }[] = [];
  for (const x of pick) {
    try { await readContract(t, x.contractId, x.fileId, by); read++; }
    catch (e) {
      failed.push({ number: x.number, error: (e as Error).message });
      // Remember that it was tried (an empty local reading), so a scan isn't tried again and again.
      await db.insert(RD).values({ tenantId: t.id, contractId: x.contractId, fileId: x.fileId, reader: 'local', suggestions: [], notes: [(e as Error).message], createdByName: by.name });
    }
  }
  const left = new Set((await unread(t, 2000)).map((x) => x.contractId)).size;
  return { read, failed, remaining: left };
}

/** Values found by reading that the contract doesn't have yet and that can still be filled in. */
export async function readingReview(t: Tenant, limit = 100) {
  const rows = await db.select({ r: RD, c: C }).from(RD).innerJoin(C, eq(C.id, RD.contractId))
    .where(and(eq(RD.tenantId, t.id), inArray(C.status, ['DRAFT', 'ACTIVE']), sql`jsonb_array_length(${RD.suggestions}) > 0`, sql`${RD.id} = (select r2.id from contract_readings r2 where r2.contract_id = ${RD.contractId} order by r2.created_at desc limit 1)`))
    .orderBy(desc(RD.createdAt)).limit(limit * 3);
  const out: { contractId: string; number: string; title: string; status: string; readingId: string; fields: { field: string; label: string; value: string | number | boolean; current: unknown }[] }[] = [];
  for (const { r, c } of rows) {
    const editable = editableFields(c);
    const fields = r.suggestions.filter((s) => !r.appliedFields.includes(s.field) && s.field !== 'jurisdiction' && (editable === 'all' || editable.includes(s.field)))
      .map((s) => ({ field: s.field, label: s.label, value: s.value, current: (c as Record<string, unknown>)[s.field] ?? null }))
      .filter((s) => JSON.stringify(s.current === null ? null : typeof s.value === 'number' ? Number(s.current) : s.current) !== JSON.stringify(s.value));
    if (fields.length) out.push({ contractId: c.id, number: c.number, title: c.title, status: c.status, readingId: r.id, fields });
    if (out.length >= limit) break;
  }
  return out;
}

/** "Use all" from the review queue (through the normal update rules). */
export async function useReading(t: Tenant, contractId: string, readingId: string, fields: string[], by: By) {
  await applyReading(t, contractId, readingId, { fields }, by);
}

/* ---------------- the checklist ---------------- */

const list = async (where: ReturnType<typeof and>, limit = 50) => db.select({ id: C.id, number: C.number, title: C.title, status: C.status, party: P.name }).from(C).innerJoin(P, eq(P.id, C.partyId)).where(where).orderBy(asc(C.number)).limit(limit);
const n = async (q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: { n: number }[] }).rows[0].n;

export async function migrationStatus(t: Tenant) {
  const active = and(eq(C.tenantId, t.id), eq(C.status, 'ACTIVE'), sql`${C.type} <> 'amendment'`);
  const noSigned = sql`not exists (select 1 from contract_files f where f.contract_id = ${C.id} and f.kind = 'SIGNED')`;
  const checks = {
    noSignedCopy: { label: 'Active contracts with no signed copy', where: and(active, noSigned) },
    noOwner: { label: 'Active contracts with no owner', where: and(active, sql`(${C.ownerId} is null or exists (select 1 from users u where u.id = ${C.ownerId} and u.status = 'DISABLED'))`) },
    noEndDate: { label: 'Active contracts with no end date', where: and(active, sql`${C.endDate} is null`) },
    noNotice: { label: 'Active contracts with an end date but no notice period', where: and(active, sql`${C.endDate} is not null and ${C.noticeDays} is null`) },
    draftsSigned: { label: 'Drafts with a signed copy, waiting to be marked as signed', where: and(eq(C.tenantId, t.id), eq(C.status, 'DRAFT'), sql`not ${noSigned}`) },
  } as const;
  const out: Record<string, { label: string; count: number; contracts: Awaited<ReturnType<typeof list>> }> = {};
  for (const [k, v] of Object.entries(checks)) {
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(C).where(v.where);
    out[k] = { label: v.label, count, contracts: count ? await list(v.where) : [] };
  }
  return {
    totals: {
      parties: await n(sql`select count(*)::int n from parties where tenant_id = ${t.id} and status = 'ACTIVE'`),
      contracts: await n(sql`select count(*)::int n from contracts where tenant_id = ${t.id} and type <> 'amendment'`),
      active: await n(sql`select count(*)::int n from contracts where tenant_id = ${t.id} and status = 'ACTIVE' and type <> 'amendment'`),
      withSignedCopy: await n(sql`select count(*)::int n from contracts c where c.tenant_id = ${t.id} and c.status = 'ACTIVE' and exists (select 1 from contract_files f where f.contract_id = c.id and f.kind = 'SIGNED')`),
      obligations: await n(sql`select count(*)::int n from contract_obligations where tenant_id = ${t.id}`),
      inbox: await n(sql`select count(*)::int n from contract_inbox where tenant_id = ${t.id}`),
      unread: new Set((await unread(t, 5000)).map((x) => x.contractId)).size,
    },
    checks: out,
    review: await readingReview(t, 50),
  };
}
export type MigrationContract = Pick<Contract, 'id' | 'number'>;
