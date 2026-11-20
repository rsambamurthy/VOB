/**
 * Clause library and contract templates (Contracts → Templates / Clause library).
 * Built-in content comes from library.ts; everything here edits the workspace's own copy.
 */
import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { z } from 'zod';
import { db, schema } from '../../lib/db.js';
import type { ContractClause, ContractTemplate, Tenant } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { DOCX, readBytes, removeStored, storeUpload } from '../../integrations/storage/index.js';
import { CONTRACT_TYPE_KEYS, JURISDICTIONS, optionOn } from './config.js';
import { fieldsIn, unknownFields, fieldLabel } from './fields.js';
import { builtInClause, ensureLibrary } from './library.js';

const { contractClauses: CL, contractTemplates: TP } = schema;
type By = { id?: string; name: string; ip?: string };
const JUR = ['ALL', ...Object.keys(JURISDICTIONS)] as const;

const libAudit = (t: Tenant, by: By, action: string, detail: Record<string, unknown>) => audit({ tenantId: t.id, actor: by.name, action, detail, ip: by.ip });
function assertKnown(text: string, where: string, loop = false) {
  const bad = unknownFields(fieldsIn(text), loop);
  if (bad.length) throw new HttpError(400, `${where} uses ${bad.map((b) => `{{${b}}}`).join(', ')}, which ${bad.length === 1 ? 'isn’t a merge field' : 'aren’t merge fields'}. Pick fields from the list.`, { fields: bad });
}
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'clause';

/* ---------------- clauses ---------------- */

export const clauseInput = z.object({
  title: z.string().trim().min(2, 'Give the clause a title').max(120),
  category: z.string().trim().min(2, 'Choose a category').max(60),
  jurisdiction: z.enum(JUR).default('ALL'),
  group: z.string().regex(/^[a-z0-9-]{2,40}$/).optional(),
  body: z.string().trim().min(10, 'Write the standard wording').max(20_000),
  fallbacks: z.array(z.object({ key: z.string().regex(/^[a-z0-9-]{1,30}$/).optional(), label: z.string().trim().min(2, 'Name each fallback').max(80), body: z.string().trim().min(10, 'Write each fallback’s wording').max(20_000) })).max(6).default([]),
  guidance: z.string().trim().max(2000).nullable().optional(),
});

export async function listClauses(t: Tenant, q: { q?: string; category?: string; jurisdiction?: string; status?: string } = {}) {
  await ensureLibrary(t);
  const rows = await db.select().from(CL).where(and(eq(CL.tenantId, t.id), eq(CL.status, q.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE'),
    q.category ? eq(CL.category, q.category) : undefined, q.jurisdiction ? eq(CL.jurisdiction, q.jurisdiction) : undefined,
    q.q ? or(ilike(CL.title, `%${q.q}%`), ilike(CL.body, `%${q.q}%`)) : undefined)).orderBy(asc(CL.category), asc(CL.title), asc(CL.jurisdiction));
  const cats = await db.selectDistinct({ c: CL.category }).from(CL).where(eq(CL.tenantId, t.id)).orderBy(asc(CL.category));
  return { clauses: rows.map(clauseView), categories: cats.map((c) => c.c), jurisdictions: { ALL: 'All countries', ...JURISDICTIONS } };
}
const clauseView = (c: ContractClause) => ({ ...c, changed: c.builtIn && !!builtInClause(c.group, c.jurisdiction) && builtInClause(c.group, c.jurisdiction)!.body !== c.body });

export async function getClause(t: Tenant, id: string) {
  const c = await db.query.contractClauses.findFirst({ where: and(eq(CL.tenantId, t.id), eq(CL.id, id)) });
  if (!c) throw new HttpError(404, 'Clause not found');
  return c;
}

export async function saveClause(t: Tenant, id: string | null, raw: unknown, by: By) {
  const input = clauseInput.parse(raw);
  assertKnown(input.body, 'The wording');
  input.fallbacks.forEach((f) => assertKnown(f.body, `Fallback “${f.label}”`));
  const fallbacks = input.fallbacks.map((f, i) => ({ key: f.key ?? (slug(f.label) || `fallback-${i + 1}`), label: f.label, body: f.body }));
  if (new Set(fallbacks.map((f) => f.key)).size !== fallbacks.length) throw new HttpError(400, 'Two fallbacks have the same name.');
  if (id) {
    const c = await getClause(t, id);
    const [row] = await db.update(CL).set({ title: input.title, category: input.category, body: input.body, fallbacks, guidance: input.guidance ?? null, updatedByName: by.name }).where(eq(CL.id, c.id)).returning();
    await libAudit(t, by, 'CONTRACT_CLAUSE_UPDATED', { subjectId: c.id, title: row.title });
    return row;
  }
  const group = input.group ?? slug(input.title);
  const clash = await db.query.contractClauses.findFirst({ where: and(eq(CL.tenantId, t.id), eq(CL.group, group), eq(CL.jurisdiction, input.jurisdiction)) });
  if (clash) throw new HttpError(409, `There is already a “${clash.title}” clause for ${input.jurisdiction === 'ALL' ? 'all countries' : JURISDICTIONS[input.jurisdiction as keyof typeof JURISDICTIONS]}. Edit that one instead.`);
  const [row] = await db.insert(CL).values({ tenantId: t.id, group, jurisdiction: input.jurisdiction, title: input.title, category: input.category, body: input.body, fallbacks, guidance: input.guidance ?? null, updatedByName: by.name }).returning();
  await libAudit(t, by, 'CONTRACT_CLAUSE_CREATED', { subjectId: row.id, title: row.title });
  return row;
}

/** Built-in clause back to the standard wording and fallbacks. */
export async function resetClause(t: Tenant, id: string, by: By) {
  const c = await getClause(t, id);
  const b = c.builtIn ? builtInClause(c.group, c.jurisdiction) : null;
  if (!b) throw new HttpError(409, 'Only built-in clauses can be reset.');
  const [row] = await db.update(CL).set({ title: b.title, category: b.category, body: b.body, fallbacks: b.fallbacks ?? [], guidance: b.guidance ?? null, status: 'ACTIVE', updatedByName: by.name }).where(eq(CL.id, c.id)).returning();
  await libAudit(t, by, 'CONTRACT_CLAUSE_RESET', { subjectId: c.id, title: row.title });
  return row;
}
export async function setClauseArchived(t: Tenant, id: string, archived: boolean, by: By) {
  const c = await getClause(t, id);
  const [row] = await db.update(CL).set({ status: archived ? 'ARCHIVED' : 'ACTIVE', updatedByName: by.name }).where(eq(CL.id, c.id)).returning();
  await libAudit(t, by, archived ? 'CONTRACT_CLAUSE_ARCHIVED' : 'CONTRACT_CLAUSE_RESTORED', { subjectId: c.id, title: c.title });
  return row;
}

/** Clause groups for the template editor: one entry per group with the jurisdictions it has. */
export async function clauseGroups(t: Tenant) {
  await ensureLibrary(t);
  const rows = await db.select({ group: CL.group, title: CL.title, category: CL.category, jurisdiction: CL.jurisdiction }).from(CL).where(and(eq(CL.tenantId, t.id), eq(CL.status, 'ACTIVE'))).orderBy(asc(CL.category), asc(CL.title));
  const map = new Map<string, { group: string; title: string; category: string; jurisdictions: string[] }>();
  for (const r of rows) {
    const g = map.get(r.group) ?? { group: r.group, title: r.title, category: r.category, jurisdictions: [] };
    g.jurisdictions.push(r.jurisdiction);
    map.set(r.group, g);
  }
  return [...map.values()];
}

/* ---------------- templates ---------------- */

export const templateInput = z.object({
  name: z.string().trim().min(3, 'Give the template a name').max(120),
  types: z.array(z.enum(CONTRACT_TYPE_KEYS as [string, ...string[]])).min(1, 'Choose at least one contract type'),
  direction: z.enum(['BUY', 'SELL', 'BOTH']).default('BOTH'),
  heading: z.string().trim().max(200).nullable().optional(),
  preamble: z.string().trim().max(5000).nullable().optional(),
  sections: z.array(z.object({ group: z.string().min(1), required: z.boolean().default(true) })).max(60).default([]),
});

export async function listTemplates(t: Tenant, q: { status?: string } = {}) {
  await ensureLibrary(t);
  const rows = await db.select().from(TP).where(and(eq(TP.tenantId, t.id), eq(TP.status, q.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE'))).orderBy(sql`${TP.builtIn} desc`, asc(TP.name));
  return { templates: rows.map(templateView), word: optionOn(t, 'wordTemplates'), clauses: optionOn(t, 'templates') };
}
const templateView = (r: ContractTemplate) => ({ id: r.id, name: r.name, kind: r.kind, types: r.types, direction: r.direction, heading: r.heading, preamble: r.preamble, sections: r.sections,
  fileName: r.fileName, fields: r.fields, builtIn: r.builtIn, status: r.status, updatedAt: r.updatedAt, updatedByName: r.updatedByName });

export async function getTemplate(t: Tenant, id: string) {
  const r = await db.query.contractTemplates.findFirst({ where: and(eq(TP.tenantId, t.id), eq(TP.id, id)) });
  if (!r) throw new HttpError(404, 'Template not found');
  return r;
}
export async function templateDetail(t: Tenant, id: string) {
  return { template: templateView(await getTemplate(t, id)), groups: await clauseGroups(t) };
}

async function checkSections(t: Tenant, sections: { group: string }[]) {
  const groups = new Set((await clauseGroups(t)).map((g) => g.group));
  const missing = sections.filter((s) => !groups.has(s.group));
  if (missing.length) throw new HttpError(400, `These clauses aren’t in the library: ${missing.map((m) => m.group).join(', ')}`);
  if (new Set(sections.map((s) => s.group)).size !== sections.length) throw new HttpError(400, 'A clause is in the template twice.');
}

export async function saveTemplate(t: Tenant, id: string | null, raw: unknown, by: By) {
  const input = templateInput.parse(raw);
  const existing = id ? await getTemplate(t, id) : null;
  const kind = existing?.kind ?? 'CLAUSES';
  if (kind === 'CLAUSES' && !optionOn(t, 'templates')) throw new HttpError(409, 'Templates from the clause library are switched off in Administration → Contracts.');
  if (kind === 'CLAUSES' && !input.sections.length) throw new HttpError(400, 'Add at least one clause.');
  await checkSections(t, input.sections);
  if (input.heading) assertKnown(input.heading, 'The heading');
  if (input.preamble) assertKnown(input.preamble, 'The opening paragraph');
  const values = { name: input.name, types: input.types, direction: input.direction, heading: input.heading ?? null, preamble: input.preamble ?? null, sections: input.sections, updatedByName: by.name };
  if (existing) {
    const [row] = await db.update(TP).set(values).where(eq(TP.id, existing.id)).returning();
    await libAudit(t, by, 'CONTRACT_TEMPLATE_UPDATED', { subjectId: row.id, name: row.name });
    return templateView(row);
  }
  const [row] = await db.insert(TP).values({ ...values, tenantId: t.id, kind: 'CLAUSES' }).returning();
  await libAudit(t, by, 'CONTRACT_TEMPLATE_CREATED', { subjectId: row.id, name: row.name, kind: 'CLAUSES' });
  return templateView(row);
}

/** Merge fields in a Word file (body, headers and footers). Word splits text into runs, so tags are found in the joined text. */
export function wordFields(buffer: Buffer) {
  let zip: PizZip;
  try { zip = new PizZip(buffer); } catch { throw new HttpError(400, 'This isn’t a Word .docx file that can be read.'); }
  const parts = Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n));
  const text = parts.map((n) => zip.file(n)!.asText().replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (p) => `${p.replace(/<[^>]+>/g, '')}\n`).replace(/<[^>]+>/g, '')).join('\n');
  try { new Docxtemplater(zip, { delimiters: { start: '{{', end: '}}' }, paragraphLoop: true, linebreaks: true }); }
  catch (e) {
    const errs = ((e as { properties?: { errors?: { properties?: { explanation?: string } }[] } }).properties?.errors ?? []).map((x) => x.properties?.explanation).filter(Boolean);
    throw new HttpError(400, `The merge fields in this Word file aren’t written correctly${errs.length ? `: ${errs.slice(0, 3).join('; ')}` : ''}. Write each as {{party.name}}.`);
  }
  return fieldsIn(text);
}

/** New or replacement Word template. Fields must all be known; {{#clauses}}…{{/clauses}} prints the drafted clauses. */
export async function saveWordTemplate(t: Tenant, id: string | null, raw: unknown, file: { buffer: Buffer; originalname: string } | undefined, by: By) {
  if (!optionOn(t, 'wordTemplates')) throw new HttpError(409, 'Word templates are switched off in Administration → Contracts.');
  const input = templateInput.parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
  const existing = id ? await getTemplate(t, id) : null;
  if (existing && existing.kind !== 'WORD') throw new HttpError(409, 'This template is built from the clause library, not a Word file.');
  if (!existing && !file) throw new HttpError(400, 'Choose the Word (.docx) file.');
  await checkSections(t, input.sections);
  let stored: Awaited<ReturnType<typeof storeUpload>> | null = null; let fields = existing?.fields ?? [];
  if (file) {
    fields = wordFields(file.buffer);
    const bad = unknownFields(fields, true);
    if (bad.length) throw new HttpError(400, `The Word file uses ${bad.map((b) => `{{${b}}}`).join(', ')}, which ${bad.length === 1 ? 'isn’t a merge field' : 'aren’t merge fields'}. Use the fields in the list.`, { fields: bad });
    if (fields.includes('#clauses') && !input.sections.length) throw new HttpError(400, 'The Word file prints clauses ({{#clauses}}), so choose which clauses the template has.');
    stored = await storeUpload(t.id, 'contract-templates', file, { types: [DOCX] });
  }
  const values = { name: input.name, types: input.types, direction: input.direction, sections: input.sections, fields, updatedByName: by.name, ...(stored ? { fileName: stored.fileName, mimeType: stored.mimeType, size: stored.size, storagePath: stored.storagePath, storageDriver: stored.storageDriver, sha256: stored.sha256 } : {}) };
  if (existing) {
    const [row] = await db.update(TP).set(values).where(eq(TP.id, existing.id)).returning();
    if (stored && existing.storagePath) await removeStored({ storagePath: existing.storagePath, storageDriver: existing.storageDriver ?? 'local' }).catch(() => {});
    await libAudit(t, by, 'CONTRACT_TEMPLATE_UPDATED', { subjectId: row.id, name: row.name, file: !!stored });
    return templateView(row);
  }
  const [row] = await db.insert(TP).values({ ...values, tenantId: t.id, kind: 'WORD' }).returning();
  await libAudit(t, by, 'CONTRACT_TEMPLATE_CREATED', { subjectId: row.id, name: row.name, kind: 'WORD' });
  return templateView(row);
}
export async function templateFile(t: Tenant, id: string) {
  const r = await getTemplate(t, id);
  if (r.kind !== 'WORD' || !r.storagePath) throw new HttpError(404, 'This template has no Word file.');
  return { storagePath: r.storagePath, storageDriver: r.storageDriver ?? 'local', fileName: r.fileName ?? 'template.docx', mimeType: r.mimeType ?? DOCX };
}
export const templateBytes = async (t: Tenant, r: ContractTemplate) => readBytes(await templateFile(t, r.id));

export async function setTemplateArchived(t: Tenant, id: string, archived: boolean, by: By) {
  const r = await getTemplate(t, id);
  const [row] = await db.update(TP).set({ status: archived ? 'ARCHIVED' : 'ACTIVE', updatedByName: by.name }).where(eq(TP.id, r.id)).returning();
  await libAudit(t, by, archived ? 'CONTRACT_TEMPLATE_ARCHIVED' : 'CONTRACT_TEMPLATE_RESTORED', { subjectId: r.id, name: r.name });
  return templateView(row);
}

/** Templates a contract can be drafted from: active, for its type and direction, and of a kind that is switched on. */
export async function templatesFor(t: Tenant, c: { type: string; direction: string }) {
  await ensureLibrary(t);
  const kinds = [optionOn(t, 'templates') && 'CLAUSES', optionOn(t, 'wordTemplates') && 'WORD'].filter(Boolean) as string[];
  if (!kinds.length) return [];
  const rows = await db.select().from(TP).where(and(eq(TP.tenantId, t.id), eq(TP.status, 'ACTIVE'))).orderBy(sql`${TP.builtIn} desc`, asc(TP.name));
  return rows.filter((r) => kinds.includes(r.kind) && r.types.includes(c.type) && (r.direction === 'BOTH' || r.direction === c.direction)).map(templateView);
}
export { fieldLabel };
