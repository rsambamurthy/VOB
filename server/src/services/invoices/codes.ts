/**
 * Code lists for coding invoices — kept in VendorGate, refreshed from the ERP (Oracle E-Business Suite, nightly and on
 * demand), pushed through the API, or imported from Excel. Codes closed in the ERP are switched off, never deleted, so old
 * invoices keep their coding. Maintained here: whether AP may use a code, and each cost centre's owner (approval matrix).
 *
 * Oracle sources (a REST service over the EBS tables, Integrated SOA Gateway or middleware, at the connector's apCodesUrl):
 *   ENTITY       HR_OPERATING_UNITS (ORGANIZATION_ID, NAME)
 *   ACCOUNT      FND_FLEX_VALUES of the natural-account segment (FLEX_VALUE, DESCRIPTION, ENABLED_FLAG, END_DATE_ACTIVE)
 *   COST_CENTRE  FND_FLEX_VALUES of the cost-centre segment
 *   COMBINATION  GL_CODE_COMBINATIONS (CONCATENATED_SEGMENTS, ENABLED_FLAG, END_DATE_ACTIVE)
 *   PROJECT      PA_PROJECTS_ALL (SEGMENT1, NAME, PROJECT_STATUS_CODE)
 *   TASK         PA_TASKS (TASK_NUMBER, TASK_NAME, PROJECT_NUMBER)
 *   TAX          ZX_RATES_B (TAX_RATE_CODE, PERCENTAGE_RATE, ACTIVE_FLAG)
 *   TERMS        AP_TERMS (NAME, DESCRIPTION, DUE_DAYS, ENABLED_FLAG)
 * Suppliers (apSuppliersUrl): AP_SUPPLIERS + AP_SUPPLIER_SITES_ALL → parties' ERP supplier code, pay site and terms.
 */
import { and, asc, count, eq, ilike, inArray, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../lib/db.js';
import type { Tenant } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { readSheet, sheetTemplate, type RowError, type SheetColumn } from '../../lib/excel.js';
import { getConnection } from '../../integrations/erp/index.js';
import { ErpError, getJson } from '../../integrations/erp/drivers.js';
import { defineJob } from '../../jobs/queue.js';
import { hasFeature } from '../limits.js';
import { assertInvoicesOn, invoicesOn } from './config.js';
import type { By } from './record.js';

const { invoiceCodes, parties, users } = schema;

export const CODE_KINDS = {
  ENTITY: 'Operating units', ACCOUNT: 'GL accounts', COST_CENTRE: 'Cost centres', PROJECT: 'Projects', TASK: 'Tasks', TAX: 'Tax codes', TERMS: 'Payment terms', COMBINATION: 'Valid account combinations',
} as const;
export type CodeKind = keyof typeof CODE_KINDS;
export const CODE_KIND_KEYS = Object.keys(CODE_KINDS) as CodeKind[];
export interface CodeRow { code: string; name: string; parent?: string | null; enabled?: boolean; meta?: Record<string, string | number | null> }

/* ---------------- reading ---------------- */

export async function listCodes(t: Tenant, q: { kind?: string; q?: string; closed?: string; page?: number; pageSize?: number }) {
  const kind = (CODE_KIND_KEYS as string[]).includes(q.kind ?? '') ? q.kind as CodeKind : 'ACCOUNT';
  const pageSize = Math.min(500, Math.max(1, Number(q.pageSize) || 100)), page = Math.max(1, Number(q.page) || 1);
  const where: SQL[] = [eq(invoiceCodes.tenantId, t.id), eq(invoiceCodes.kind, kind)];
  if (q.closed !== '1') where.push(eq(invoiceCodes.enabled, true));
  if (q.q) where.push(or(ilike(invoiceCodes.code, `%${q.q}%`), ilike(invoiceCodes.name, `%${q.q}%`))!);
  const [{ n }] = await db.select({ n: count() }).from(invoiceCodes).where(and(...where));
  const rows = await db.select({ c: invoiceCodes, ownerName: users.name }).from(invoiceCodes).leftJoin(users, eq(users.id, invoiceCodes.ownerId))
    .where(and(...where)).orderBy(asc(invoiceCodes.code)).limit(pageSize).offset((page - 1) * pageSize);
  const totals = await db.select({ kind: invoiceCodes.kind, n: sql<number>`count(*) filter (where ${invoiceCodes.enabled})::int`, last: sql<string | null>`max(${invoiceCodes.refreshedAt})` }).from(invoiceCodes).where(eq(invoiceCodes.tenantId, t.id)).groupBy(invoiceCodes.kind);
  return {
    kind, total: Number(n), page, pageSize,
    rows: rows.map(({ c, ownerName }) => ({ id: c.id, code: c.code, name: c.name, parent: c.parent, enabled: c.enabled, usable: c.usable, source: c.source, ownerId: c.ownerId, ownerName, meta: c.meta, refreshedAt: c.refreshedAt })),
    kinds: CODE_KIND_KEYS.map((k) => ({ key: k, label: CODE_KINDS[k], count: totals.find((x) => x.kind === k)?.n ?? 0, refreshedAt: totals.find((x) => x.kind === k)?.last ?? null })),
  };
}

/** Open, usable codes for pickers (invoice lines). */
export async function codeOptions(t: Tenant, kinds: CodeKind[] = ['ENTITY', 'ACCOUNT', 'COST_CENTRE', 'PROJECT', 'TASK', 'TAX']) {
  const rows = await db.select({ kind: invoiceCodes.kind, code: invoiceCodes.code, name: invoiceCodes.name, parent: invoiceCodes.parent, meta: invoiceCodes.meta }).from(invoiceCodes)
    .where(and(eq(invoiceCodes.tenantId, t.id), inArray(invoiceCodes.kind, kinds), eq(invoiceCodes.enabled, true), eq(invoiceCodes.usable, true))).orderBy(asc(invoiceCodes.code)).limit(20000);
  return Object.fromEntries(kinds.map((k) => [k, rows.filter((r) => r.kind === k).map(({ kind: _k, ...r }) => r)])) as Record<CodeKind, { code: string; name: string; parent: string | null; meta: Record<string, unknown> }[]>;
}

/* ---------------- maintained in VendorGate ---------------- */

const editInput = z.object({ usable: z.boolean().optional(), ownerId: z.string().nullable().optional(), name: z.string().trim().min(1).max(200).optional(), enabled: z.boolean().optional() }).strict();
/** Whether AP may use a code, the cost centre's owner; codes kept here (not from the ERP) also change name and open / closed. */
export async function updateCode(t: Tenant, id: string, raw: unknown, by: By) {
  assertInvoicesOn(t);
  const input = editInput.parse(raw);
  const c = await db.query.invoiceCodes.findFirst({ where: and(eq(invoiceCodes.tenantId, t.id), eq(invoiceCodes.id, id)) });
  if (!c) throw new HttpError(404, 'Code not found');
  if (c.source === 'ERP' && (input.name !== undefined || input.enabled !== undefined)) throw new HttpError(400, 'This code comes from the ERP: its name and whether it is open change there.');
  if (input.ownerId !== undefined && input.ownerId !== null) {
    if (c.kind !== 'COST_CENTRE') throw new HttpError(400, 'Only cost centres have an owner');
    const u = await db.query.users.findFirst({ where: and(eq(users.tenantId, t.id), eq(users.id, input.ownerId), eq(users.status, 'ACTIVE')) });
    if (!u) throw new HttpError(400, 'Choose an active user as the owner');
  }
  const [row] = await db.update(invoiceCodes).set(input).where(eq(invoiceCodes.id, c.id)).returning();
  await audit({ tenantId: t.id, actor: by.name, action: 'INVOICE_CODE_CHANGED', detail: { kind: c.kind, code: c.code, ...input }, ip: by.ip });
  return row;
}

const addInput = z.object({ kind: z.enum(CODE_KIND_KEYS as [CodeKind, ...CodeKind[]]), code: z.string().trim().min(1).max(120), name: z.string().trim().min(1).max(200), parent: z.string().trim().max(120).optional().nullable() });
export async function addCode(t: Tenant, raw: unknown, by: By) {
  assertInvoicesOn(t);
  const input = addInput.parse(raw);
  if (input.kind === 'TASK' && !input.parent) throw new HttpError(400, 'Name the project the task is on');
  const r = await upsertCodes(t, input.kind, [{ code: input.code, name: input.name, parent: input.parent ?? null }], 'MANUAL');
  await audit({ tenantId: t.id, actor: by.name, action: 'INVOICE_CODE_ADDED', detail: { kind: input.kind, code: input.code }, ip: by.ip });
  return r;
}

/* ---------------- loading: ERP, API, Excel ---------------- */

/**
 * Insert or update codes of one kind. With `full`, codes of that kind from the same source that weren't sent are closed
 * (switched off — never deleted).
 */
export async function upsertCodes(t: Tenant, kind: CodeKind, rows: CodeRow[], source: 'ERP' | 'EXCEL' | 'MANUAL', opts: { full?: boolean } = {}) {
  const seen = new Map<string, CodeRow>();
  for (const r of rows) if (r.code?.trim()) seen.set(r.code.trim(), { ...r, code: r.code.trim(), name: (r.name || r.code).trim().slice(0, 200) });
  const list = [...seen.values()];
  const now = new Date();
  let added = 0, changed = 0, closed = 0;
  await db.transaction(async (tx) => {
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      const existing = await tx.select({ code: invoiceCodes.code, name: invoiceCodes.name, enabled: invoiceCodes.enabled, parent: invoiceCodes.parent }).from(invoiceCodes)
        .where(and(eq(invoiceCodes.tenantId, t.id), eq(invoiceCodes.kind, kind), inArray(invoiceCodes.code, chunk.map((c) => c.code))));
      const have = new Map(existing.map((e) => [e.code, e]));
      for (const c of chunk) { const e = have.get(c.code); if (!e) added++; else if (e.name !== c.name || e.enabled !== (c.enabled ?? true) || (e.parent ?? null) !== (c.parent ?? null)) changed++; }
      await tx.insert(invoiceCodes).values(chunk.map((c) => ({ tenantId: t.id, kind, code: c.code, name: c.name, parent: c.parent ?? null, enabled: c.enabled ?? true, source, meta: c.meta ?? {}, refreshedAt: now })))
        .onConflictDoUpdate({ target: [invoiceCodes.tenantId, invoiceCodes.kind, invoiceCodes.code], set: { name: sql`excluded.name`, parent: sql`excluded.parent`, enabled: sql`excluded.enabled`, meta: sql`excluded.meta`, refreshedAt: now, source } });
    }
    if (opts.full) {
      const gone = await tx.update(invoiceCodes).set({ enabled: false, refreshedAt: now })
        .where(and(eq(invoiceCodes.tenantId, t.id), eq(invoiceCodes.kind, kind), eq(invoiceCodes.source, source), eq(invoiceCodes.enabled, true), ...(list.length ? [notInArray(invoiceCodes.code, list.map((c) => c.code))] : []))).returning({ id: invoiceCodes.id });
      closed = gone.length;
    }
  });
  return { kind, received: list.length, added, changed, closed };
}

type Row = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : String(v).trim());
const pick = (o: Row, ...keys: string[]) => { for (const k of keys) { const v = o[k] ?? o[k.toLowerCase()]; if (v !== undefined && v !== null && v !== '') return v; } return undefined; };
/** Oracle: ENABLED_FLAG = Y and not past END_DATE_ACTIVE. */
const open = (o: Row, flag = 'ENABLED_FLAG') => s(pick(o, flag, 'ACTIVE_FLAG')) !== 'N' && !((d) => d && d < new Date().toISOString().slice(0, 10))(s(pick(o, 'END_DATE_ACTIVE', 'EFFECTIVE_TO'))?.slice(0, 10));
const arr = (v: unknown) => (Array.isArray(v) ? (v as Row[]) : []);

/** Map Oracle's rows (one array per list) to code rows — pure, tested with recorded answers. */
export function oracleCodes(body: unknown): Partial<Record<CodeKind, CodeRow[]>> {
  const b = (body ?? {}) as Row;
  const fv = (rows: Row[]) => rows.map((r) => ({ code: s(pick(r, 'FLEX_VALUE', 'CODE'))!, name: s(pick(r, 'DESCRIPTION', 'NAME')) ?? s(pick(r, 'FLEX_VALUE'))!, enabled: open(r) })).filter((r) => r.code);
  const out: Partial<Record<CodeKind, CodeRow[]>> = {};
  if (b.OPERATING_UNITS || b.operatingUnits) out.ENTITY = arr(b.OPERATING_UNITS ?? b.operatingUnits).map((r) => ({ code: s(pick(r, 'ORGANIZATION_ID', 'ORG_ID'))!, name: s(pick(r, 'NAME'))!, enabled: open(r, 'ENABLED_FLAG') })).filter((r) => r.code);
  if (b.ACCOUNTS || b.accounts) out.ACCOUNT = fv(arr(b.ACCOUNTS ?? b.accounts));
  if (b.COST_CENTRES || b.costCentres) out.COST_CENTRE = fv(arr(b.COST_CENTRES ?? b.costCentres));
  if (b.CODE_COMBINATIONS || b.combinations) out.COMBINATION = arr(b.CODE_COMBINATIONS ?? b.combinations).map((r) => ({ code: s(pick(r, 'CONCATENATED_SEGMENTS'))!, name: s(pick(r, 'DESCRIPTION')) ?? s(pick(r, 'CONCATENATED_SEGMENTS'))!, enabled: open(r), meta: { ccid: s(pick(r, 'CODE_COMBINATION_ID')) ?? null } })).filter((r) => r.code);
  if (b.PROJECTS || b.projects) out.PROJECT = arr(b.PROJECTS ?? b.projects).map((r) => ({ code: s(pick(r, 'SEGMENT1', 'PROJECT_NUMBER'))!, name: s(pick(r, 'NAME'))!, enabled: !/CLOSED/i.test(s(pick(r, 'PROJECT_STATUS_CODE')) ?? '') && open(r), meta: { projectId: s(pick(r, 'PROJECT_ID')) ?? null } })).filter((r) => r.code);
  if (b.TASKS || b.tasks) out.TASK = arr(b.TASKS ?? b.tasks).map((r) => ({ code: s(pick(r, 'TASK_NUMBER'))!, name: s(pick(r, 'TASK_NAME'))!, parent: s(pick(r, 'PROJECT_NUMBER', 'SEGMENT1')) ?? null, enabled: s(pick(r, 'CHARGEABLE_FLAG')) !== 'N' && open(r), meta: { taskId: s(pick(r, 'TASK_ID')) ?? null } })).filter((r) => r.code);
  if (b.TAX_RATES || b.taxRates) out.TAX = arr(b.TAX_RATES ?? b.taxRates).map((r) => ({ code: s(pick(r, 'TAX_RATE_CODE'))!, name: s(pick(r, 'TAX_RATE_NAME', 'DESCRIPTION')) ?? s(pick(r, 'TAX_RATE_CODE'))!, enabled: open(r, 'ACTIVE_FLAG'), meta: { rate: Number(pick(r, 'PERCENTAGE_RATE') ?? 0) } })).filter((r) => r.code);
  if (b.TERMS || b.terms) out.TERMS = arr(b.TERMS ?? b.terms).map((r) => ({ code: s(pick(r, 'NAME'))!, name: s(pick(r, 'DESCRIPTION')) ?? s(pick(r, 'NAME'))!, enabled: open(r), meta: { days: Number(pick(r, 'DUE_DAYS') ?? 0) || null } })).filter((r) => r.code);
  return out;
}

/** Oracle suppliers and pay sites → parties: matched on the ERP supplier code, else the tax number, else the exact name. New ones are added. */
export async function upsertSuppliers(t: Tenant, body: unknown, by: By) {
  const rows = arr(((body ?? {}) as Row).SUPPLIERS ?? ((body ?? {}) as Row).suppliers ?? body);
  let linked = 0, added = 0, unchanged = 0;
  const { createParty } = await import('../contracts/parties.js');
  for (const r of rows) {
    const code = s(pick(r, 'SEGMENT1', 'VENDOR_NUM', 'SUPPLIER_NUMBER'));
    const name = s(pick(r, 'VENDOR_NAME', 'SUPPLIER_NAME'));
    if (!code || !name) continue;
    const site = arr(pick(r, 'SITES') ?? []).find((x) => s(pick(x, 'PAY_SITE_FLAG')) !== 'N') ?? arr(pick(r, 'SITES') ?? [])[0];
    const tax = s(pick(r, 'VAT_REGISTRATION_NUM', 'GSTIN', 'TAX_REGISTRATION_NUMBER'));
    const ap = { erpSupplierCode: code, ...(site && s(pick(site, 'VENDOR_SITE_CODE')) ? { erpSiteCode: s(pick(site, 'VENDOR_SITE_CODE')) } : {}), ...(s(pick(r, 'TERMS_NAME', 'PAYMENT_TERMS')) ? { paymentTerms: s(pick(r, 'TERMS_NAME', 'PAYMENT_TERMS')) } : {}) };
    const party = await db.query.parties.findFirst({ where: and(eq(parties.tenantId, t.id), eq(parties.kind, 'SUPPLIER'), or(sql`upper(${parties.ap}->>'erpSupplierCode') = ${code.toUpperCase()}`, ...(tax ? [sql`upper(${parties.taxNo}) = ${tax.toUpperCase()}`] : []), sql`lower(${parties.name}) = ${name.toLowerCase()}`)!) });
    if (party) {
      const merged = { ...party.ap, ...ap };
      if (JSON.stringify(merged) === JSON.stringify(party.ap)) { unchanged++; continue; }
      await db.update(parties).set({ ap: merged }).where(eq(parties.id, party.id));
      linked++;
    } else {
      const p = await createParty(t, { kind: 'SUPPLIER', name, legalName: name, country: (s(pick(r, 'COUNTRY')) ?? t.country).slice(0, 2).toUpperCase(), taxNo: tax ?? null, confirmDuplicate: true }, { id: by.id ?? null, name: by.name, ip: by.ip } as never, { source: 'ERP' });
      await db.update(parties).set({ ap }).where(eq(parties.id, p.id));
      added++;
    }
  }
  return { suppliers: rows.length, linked, added, unchanged };
}

/** Pull code lists (and suppliers) from Oracle now. */
export async function refreshFromErp(t: Tenant, by: By) {
  assertInvoicesOn(t);
  const conn = await getConnection(t.id);
  if (conn.kind !== 'oracle') throw new HttpError(409, 'Refreshing code lists needs the Oracle E-Business Suite connector. Other ERPs send them through the API, or import them from Excel.');
  if (conn.testMode) throw new HttpError(409, 'Test mode is on, so nothing is pulled from Oracle. Import the lists from Excel, or turn test mode off.');
  if (!conn.config.apCodesUrl) throw new HttpError(409, 'Set the code lists URL under ERP integration first.');
  const results: Awaited<ReturnType<typeof upsertCodes>>[] = [];
  let suppliers: Awaited<ReturnType<typeof upsertSuppliers>> | null = null;
  try {
    const lists = oracleCodes(await getJson(conn.config.apCodesUrl, conn));
    for (const k of CODE_KIND_KEYS) if (lists[k]) results.push(await upsertCodes(t, k, lists[k]!, 'ERP', { full: true }));
    if (conn.config.apSuppliersUrl) suppliers = await upsertSuppliers(t, await getJson(conn.config.apSuppliersUrl, conn), by);
  } catch (e) {
    const msg = e instanceof ErpError ? e.message : String((e as Error)?.message ?? e);
    throw new HttpError(502, `Couldn’t refresh from Oracle: ${msg}`);
  }
  await audit({ tenantId: t.id, actor: by.name, action: 'INVOICE_CODES_REFRESHED', detail: { source: 'oracle', lists: results.map((r) => `${r.kind} ${r.received} (+${r.added}, ~${r.changed}, closed ${r.closed})`).join('; '), ...(suppliers ? { suppliers: `${suppliers.suppliers} (+${suppliers.added}, linked ${suppliers.linked})` } : {}) }, ip: by.ip });
  return { lists: results, suppliers };
}

/** Import results from Oracle (apResultsUrl): AP_INVOICES_ALL / AP_INTERFACE_REJECTIONS / AP_HOLDS_ALL for invoices sent from VendorGate. */
export async function pullErpResults(t: Tenant) {
  const conn = await getConnection(t.id);
  if (conn.kind !== 'oracle' || conn.testMode || !conn.config.apResultsUrl) return { updated: 0, notFound: 0, errors: [] as string[] };
  const body = await getJson(conn.config.apResultsUrl, conn);
  const rows = arr(((body ?? {}) as Row).RESULTS ?? ((body ?? {}) as Row).results ?? body);
  const { recordErpResults, resultInput } = await import('./erp.js');
  const items = rows.map((r) => resultInput.safeParse({
    id: s(pick(r, 'ATTRIBUTE1', 'id')), invoiceNumber: s(pick(r, 'INVOICE_NUM')), supplierCode: s(pick(r, 'VENDOR_NUM')),
    status: /REJECT|ERROR/i.test(s(pick(r, 'STATUS', 'IMPORT_STATUS')) ?? '') ? 'REJECTED' : 'IMPORTED', erpInvoiceId: s(pick(r, 'INVOICE_ID')),
    reasons: arr(pick(r, 'REJECTIONS') ?? []).map((x) => s(pick(x, 'REJECT_LOOKUP_CODE', 'DESCRIPTION', 'REASON'))).filter(Boolean),
    holds: arr(pick(r, 'HOLDS') ?? []).map((x) => ({ code: s(pick(x, 'HOLD_LOOKUP_CODE', 'HOLD_CODE')) ?? 'HOLD', reason: s(pick(x, 'HOLD_REASON', 'DESCRIPTION')) })),
  })).filter((x) => x.success).map((x) => x.data!);
  return recordErpResults(t, items);
}

/** Nightly: code lists and import results from Oracle for every workspace with the add-on and a live Oracle connector. */
defineJob('invoices.erp', async () => {
  for (const t of await db.select().from(schema.tenants).where(eq(schema.tenants.status, 'ACTIVE'))) {
    if (!invoicesOn(t) || !hasFeature(t, 'erp')) continue;
    const c = await getConnection(t.id);
    if (c.kind !== 'oracle' || c.testMode) continue;
    if (c.config.apCodesUrl) await refreshFromErp(t, { name: 'system (nightly refresh)' }).catch((err) => logger.warn({ err, tenant: t.slug }, 'invoice code refresh failed'));
    if (c.config.apResultsUrl) await pullErpResults(t).catch((err) => logger.warn({ err, tenant: t.slug }, 'invoice import results pull failed'));
  }
}, { retryLimit: 1, expireInSeconds: 1800 });

/* ---------------- Excel ---------------- */

const COLUMNS: SheetColumn[] = [
  { header: 'List', width: 18, required: true }, { header: 'Code', width: 18, required: true }, { header: 'Name', width: 36, required: true },
  { header: 'Project (tasks only)', width: 18 }, { header: 'Open', width: 10 }, { header: 'Owner email (cost centres)', width: 28 },
];
export const codesTemplate = () => sheetTemplate({
  sheet: 'Codes', columns: COLUMNS, examplesOnOwnSheet: true, lists: { List: Object.values(CODE_KINDS), Open: ['Yes', 'No'] },
  examples: [[CODE_KINDS.COST_CENTRE, '110', 'Plant 1 — production', '', 'Yes', 'plant.head@yourcompany.com'], [CODE_KINDS.ACCOUNT, '5100', 'Rent expense', '', 'Yes', ''], [CODE_KINDS.TASK, '1.2', 'Civil works', 'PRJ-104', 'Yes', '']],
  help: [['List', 'Which list the code belongs to.'], ['Open', 'No = closed: kept for old invoices, not offered for new ones.'], ['Owner email', 'Cost centres only: who approves invoices coded to it (the “Budget owner” level).'], ['Import', 'Codes are added or updated; codes not in the sheet are kept. Lists refreshed from the ERP are better changed there.']],
});

/** Codes from one sheet (check first, then import). */
export async function importCodes(t: Tenant, buffer: Buffer, by: By, commit: boolean) {
  assertInvoicesOn(t);
  const rows = await readSheet(buffer, { sheet: 'Codes', columns: COLUMNS, maxRows: 20000 });
  const owners = new Map((await db.select({ id: users.id, email: users.email }).from(users).where(and(eq(users.tenantId, t.id), eq(users.status, 'ACTIVE')))).map((u) => [u.email.toLowerCase(), u.id]));
  const ready: { row: number; kind: CodeKind; code: string; name: string; parent: string | null; enabled: boolean; ownerId: string | null }[] = []; const errors: RowError[] = [];
  for (const r of rows) {
    const list = r.get('List').trim().toLowerCase();
    const kind = CODE_KIND_KEYS.find((k) => k.toLowerCase() === list.replace(/\s+/g, '_') || CODE_KINDS[k].toLowerCase() === list);
    if (!kind) { errors.push({ row: r.row, message: `Unknown list “${r.get('List')}”` }); continue; }
    const code = r.get('Code').trim(), parent = r.get('Project (tasks only)').trim() || null, email = r.get('Owner email (cost centres)').trim().toLowerCase();
    if (!code) { errors.push({ row: r.row, message: 'Code is required' }); continue; }
    if (kind === 'TASK' && !parent) { errors.push({ row: r.row, message: 'A task needs its project' }); continue; }
    if (email && kind !== 'COST_CENTRE') { errors.push({ row: r.row, message: 'Only cost centres have an owner' }); continue; }
    if (email && !owners.has(email)) { errors.push({ row: r.row, message: `No active user with the email ${email}` }); continue; }
    ready.push({ row: r.row, kind, code, name: r.get('Name').trim() || code, parent, enabled: !/^n/i.test(r.get('Open') || 'Yes'), ownerId: email ? owners.get(email)! : null });
  }
  if (!rows.length) errors.push({ row: 0, message: 'No codes found in the sheet.' });
  const results: Awaited<ReturnType<typeof upsertCodes>>[] = [];
  if (commit && !errors.length) {
    for (const k of CODE_KIND_KEYS) { const list = ready.filter((x) => x.kind === k); if (list.length) results.push(await upsertCodes(t, k, list, 'EXCEL')); }
    for (const x of ready.filter((y) => y.ownerId)) await db.update(invoiceCodes).set({ ownerId: x.ownerId }).where(and(eq(invoiceCodes.tenantId, t.id), eq(invoiceCodes.kind, 'COST_CENTRE'), eq(invoiceCodes.code, x.code)));
    await audit({ tenantId: t.id, actor: by.name, action: 'INVOICE_CODES_IMPORTED', detail: { rows: ready.length }, ip: by.ip });
  }
  return { ready: ready.map((x) => ({ row: x.row, list: CODE_KINDS[x.kind], code: x.code, name: x.name })), errors, created: results };
}
