/**
 * Suppliers from Excel, two ways:
 *   invite   — a list of suppliers to invite; each gets the usual onboarding invitation (or not, per row).
 *   approved — the existing supplier master: suppliers created as already approved, with their form answers
 *              (one column per form field, generated from the published form) and ERP supplier code.
 * Download the template, fill it in, upload: a preview lists every row's problems; nothing is created until
 * the whole file is clean, then all rows are created together.
 */
import { Router } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { and, count, eq, isNull, ne, sql } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { getPublished } from '../services/config.js';
import { buildChecklist, sanitizeSection, type Profile } from '../lib/profileEngine.js';
import { effectiveLimits } from '../lib/plans.js';
import { assertCanAddVendor } from '../services/limits.js';
import { supplierLanguages } from '../i18n/index.js';
import { packFor } from '../countries/registry.js';
import { basicProblems, createSchema, createVendor, type CreateInput } from '../services/vendors.js';
import { identityKeys, KIND_LABEL } from '../services/duplicates.js';
import { agreementsFor } from '../services/agreements.js';
import type { FieldDef, OnboardingConfig } from '../config/types.js';
import type { Tenant } from '../db/schema.js';

export const vendorImportRouter = Router();
const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const MAX_ROWS = 1000;
type Mode = 'invite' | 'approved';
const modeOf = (q: unknown): Mode => (q === 'approved' ? 'approved' : 'invite');

const TYPES: Record<string, CreateInput['vendorType']> = { domestic: 'DOMESTIC', import: 'IMPORT', foreign: 'IMPORT', government: 'GOVERNMENT' };
const BASIC = ['Supplier name', 'Vendor type', 'Contact first name', 'Contact last name', 'Contact email', 'Contact mobile'];
/** Fields the basic columns already fill. */
const FROM_BASIC = new Set(['basic.vendorName', 'basic.contactName', 'basic.contactEmail', 'basic.contactMobile']);

function formFields(cfg: OnboardingConfig) {
  return cfg.sections.flatMap((s) => s.groups.flatMap((g) => g.fields.map((f) => ({ id: `${s.key}.${f.key}`, tab: s.label, f }))))
    .filter((x) => !FROM_BASIC.has(x.id));
}
const fieldHeader = (x: { id: string; tab: string; f: FieldDef }) => `${x.tab} › ${x.f.label} [${x.id}]`;

function columnsFor(mode: Mode, tenant: Tenant, cfg: OnboardingConfig) {
  const arabic = supplierLanguages(tenant).includes('ar');
  const cols = [...BASIC, ...(arabic ? ['Language'] : [])];
  if (mode === 'invite') return [...cols, 'Send invitation'];
  return [...cols, 'ERP supplier code', ...formFields(cfg).map(fieldHeader)];
}

/* ---------- Template ---------- */

vendorImportRouter.get('/template.xlsx', requireStaff('vendors.create'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  const mode = modeOf(req.query.mode);
  const { config } = await getPublished(tenant.id);
  const cols = columnsFor(mode, tenant, config);
  const wb = new ExcelJS.Workbook();
  const how = wb.addWorksheet('How to fill in');
  const ws = wb.addWorksheet('Suppliers');
  const head = ws.addRow(cols);
  head.font = { bold: true }; head.alignment = { wrapText: true, vertical: 'top' }; head.height = mode === 'approved' ? 48 : 20;
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = i < 6 ? 22 : Math.min(40, Math.max(16, c.length * 0.7)); head.getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i < 6 ? 'FFFDE68A' : 'FFDBEAFE' } }; });
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }];
  const home = packFor(tenant.country);
  ws.addRow(cols.map((c) => ({
    'Supplier name': 'Example Traders Pvt Ltd', 'Vendor type': 'Domestic', 'Contact first name': 'Asha', 'Contact last name': 'Kumar',
    'Contact email': 'asha@example.com', 'Contact mobile': home.mobile?.example ?? '', Language: 'en', 'Send invitation': 'Yes', 'ERP supplier code': 'S-10001',
  } as Record<string, string>)[c] ?? ''));
  ws.getRow(2).font = { italic: true, color: { argb: 'FF64748B' } };

  // Pick-lists: vendor type, yes/no, language and every list field's options (on a hidden sheet).
  const lists = wb.addWorksheet('Lists', { state: 'hidden' });
  const listCol = (values: string[], n: number) => { values.forEach((v, i) => { lists.getCell(i + 1, n).value = v; }); return `Lists!$${colName(n)}$1:$${colName(n)}$${Math.max(1, values.length)}`; };
  const dv = (col: number, formula: string) => { for (let r = 2; r <= MAX_ROWS + 1; r++) ws.getCell(r, col).dataValidation = { type: 'list', allowBlank: true, formulae: [formula], showErrorMessage: true }; };
  let n = 1;
  dv(cols.indexOf('Vendor type') + 1, listCol(['Domestic', 'Import', 'Government'], n++));
  if (cols.includes('Send invitation')) dv(cols.indexOf('Send invitation') + 1, listCol(['Yes', 'No'], n++));
  if (cols.includes('Language')) dv(cols.indexOf('Language') + 1, listCol(['en', 'ar'], n++));
  if (mode === 'approved') for (const x of formFields(config)) if (x.f.options?.length) dv(cols.indexOf(fieldHeader(x)) + 1, listCol(x.f.options, n++));

  how.columns = [{ width: 24 }, { width: 110 }];
  const lines: [string, string][] = mode === 'invite' ? [
    ['Invite suppliers', 'One row per supplier. Each gets the usual invitation to register (unless Send invitation is No — you can send it later from their page).'],
    ['Required', 'Supplier name, Vendor type (Domestic / Import / Government), contact first and last name, email and mobile.'],
    ['Mobile', `Domestic and government suppliers: the ${home.name} format${home.mobile?.example ? ` (e.g. ${home.mobile.example})` : ''}. Import (foreign) suppliers: with the country code, e.g. +44 20 7946 0000.`],
    ['Example row', 'Row 2 is an example — replace or delete it.'],
  ] : [
    ['Import approved suppliers', 'Bring in your existing supplier master. Each row becomes an approved supplier straight away — no onboarding, no approval steps.'],
    ['Required', 'Supplier name, Vendor type, contact first and last name, email and mobile. The yellow columns.'],
    ['Form columns', 'The blue columns are your onboarding form (tab › field [key]). Fill what you have; leave the rest blank. List fields have a drop-down.'],
    ['Checks', 'Filled values are checked like in the form (GSTIN, PAN, IBAN, dates…); a wrong value stops the import with its row. Missing values and documents are listed as warnings and don’t stop it.'],
    ['ERP supplier code', 'Your ERP’s code for the supplier; purchase orders with this code are linked to them.'],
    ['Afterwards', 'Optionally email each supplier to sign in, check their details and upload missing documents.'],
    ['Example row', 'Row 2 is an example — replace or delete it.'],
  ];
  for (const [a, b] of lines) { const r = how.addRow([a, b]); r.getCell(1).font = { bold: true }; r.getCell(2).alignment = { wrapText: true }; }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${mode === 'invite' ? 'invite-suppliers' : 'import-approved-suppliers'}-${tenant.slug}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));
const colName = (n: number) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

/* ---------- Upload: preview, then create ---------- */

interface RowResult { row: number; name: string; errors: string[]; warnings: string[] }

vendorImportRouter.post('/', requireStaff('vendors.create'), fileUpload.single('file'), ah(async (req, res) => {
  const s = staffCtx(req);
  const mode = modeOf(req.query.mode);
  if (!req.file) throw new HttpError(400, 'Choose the Excel file to upload');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(req.file.buffer as any); } catch { throw new HttpError(400, 'This isn’t an Excel (.xlsx) file VendorGate can read.'); }
  const ws = wb.getWorksheet('Suppliers') ?? wb.worksheets.find((w) => w.state !== 'hidden' && w.name !== 'How to fill in');
  if (!ws) throw new HttpError(400, 'No Suppliers sheet found. Start from the template.');
  const { config } = await getPublished(s.tenant.id);
  const header = new Map<string, number>();
  ws.getRow(1).eachCell((c, i) => header.set(String(c.text).trim().toLowerCase(), i));
  const missing = BASIC.filter((h) => !header.has(h.toLowerCase()));
  if (missing.length) throw new HttpError(400, `Missing column(s): ${missing.join(', ')}. Start from the template.`);
  const fields = formFields(config).map((x) => ({ ...x, col: [...header.entries()].find(([h]) => h.endsWith(`[${x.id.toLowerCase()}]`))?.[1] }));

  const rows: { result: RowResult; input: CreateInput; profile: Profile; erpCode?: string; keys: string[] }[] = [];
  const seenNames = new Map<string, number>(); const seenCodes = new Map<string, number>();
  const existingCodes = new Set((await db.select({ code: schema.supplierCodes.code }).from(schema.supplierCodes).where(eq(schema.supplierCodes.tenantId, s.tenant.id))).map((r) => r.code.toLowerCase()));
  // Imported suppliers accept the workspace's agreements when they next sign in.
  const agreementsToAccept: Record<string, number> = mode === 'approved' ? Object.fromEntries(await Promise.all((['DOMESTIC', 'IMPORT', 'GOVERNMENT'] as const).map(async (t) =>
    [t, (await agreementsFor({ id: '-', tenantId: s.tenant.id, vendorType: t, status: 'APPROVED', decidedAt: new Date() })).filter((x) => x.required && x.outstanding).length]))) : {};
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const get = (h: string) => { const i = header.get(h.toLowerCase()); return i ? cellValue(row.getCell(i)) : ''; };
    if (BASIC.every((h) => !get(h))) return;
    if (get('Supplier name') === 'Example Traders Pvt Ltd') return; // the template's example row
    const result: RowResult = { row: n, name: get('Supplier name'), errors: [], warnings: [] };
    const type = TYPES[get('Vendor type').toLowerCase()];
    if (!type) result.errors.push('Vendor type must be Domestic, Import or Government');
    const parsed = createSchema.safeParse({
      name: get('Supplier name'), vendorType: type ?? 'DOMESTIC', contactFirstName: get('Contact first name'), contactLastName: get('Contact last name'),
      contactEmail: get('Contact email'), contactMobile: get('Contact mobile'),
      notify: mode === 'invite' ? !/^no$/i.test(get('Send invitation')) : false,
      language: ['en', 'ar'].includes(get('Language').toLowerCase()) ? get('Language').toLowerCase() : undefined,
    });
    if (!parsed.success) result.errors.push(...parsed.error.issues.map((i) => i.message));
    const input = parsed.success ? parsed.data : ({} as CreateInput);
    if (parsed.success && type) result.errors.push(...basicProblems(s.tenant, input));
    const key = result.name.toLowerCase();
    if (key && seenNames.has(key)) result.errors.push(`Same supplier name as row ${seenNames.get(key)}`); else if (key) seenNames.set(key, n);
    // Approved import: the form answers, checked like the form.
    let profile: Profile = {}; let erpCode: string | undefined; let keys: string[] = [];
    if (mode === 'approved') {
      erpCode = get('ERP supplier code') || undefined;
      if (erpCode) {
        const k = erpCode.toLowerCase();
        if (existingCodes.has(k)) result.errors.push(`ERP supplier code ${erpCode} is already linked to another supplier`);
        else if (seenCodes.has(k)) result.errors.push(`Same ERP supplier code as row ${seenCodes.get(k)}`); else seenCodes.set(k, n);
      }
      const raw: Record<string, Record<string, unknown>> = {};
      for (const x of fields) {
        if (!x.col) continue;
        const v = cellValue(row.getCell(x.col), x.f.type);
        if (!v) continue;
        if (x.f.options?.length && !x.f.options.includes(v)) { result.errors.push(`${x.f.label}: “${v}” isn’t one of the choices (${x.f.options.slice(0, 6).join(', ')}${x.f.options.length > 6 ? '…' : ''})`); continue; }
        const [sec, k] = x.id.split('.');
        raw[sec] = { ...(raw[sec] ?? {}), [k]: v };
      }
      for (const [sec, vals] of Object.entries(raw)) profile[sec] = sanitizeSection(config, sec, vals);
      if (parsed.success && type) {
        // Same defaults as an invited supplier, then check like the form does.
        const home = packFor(s.tenant.country).name;
        const full: Profile = { ...profile, basic: { vendorName: input.name, supplierCountry: type === 'IMPORT' ? '' : home, contactName: `${input.contactFirstName} ${input.contactLastName}`, contactEmail: input.contactEmail.toLowerCase(), contactMobile: input.contactMobile, ...(profile.basic ?? {}) }, bank: { bankCountry: type === 'IMPORT' ? '' : home, ...(profile.bank ?? {}) } };
        const missingFields: string[] = []; let missingDocs = 0;
        for (const c of buildChecklist(config, full, [], type)) {
          if (c.ok) continue;
          if (c.section === 'documents') { if (c.severity === 'error') missingDocs++; continue; }
          const [sec, k] = c.id.replace(/^cross\./, '').split('.');
          const filled = !!String(full[sec]?.[k] ?? '').trim();
          if (filled && !c.id.startsWith('cross.')) result.errors.push(`${c.label}: ${c.message ?? 'not valid'}`);
          else if (c.severity === 'error' && !filled) missingFields.push(c.label);
          else result.warnings.push(`${c.label}: ${c.message ?? ''}`.trim());
        }
        if (missingFields.length) result.warnings.push(`Not filled: ${missingFields.slice(0, 5).join(', ')}${missingFields.length > 5 ? ` and ${missingFields.length - 5} more` : ''}`);
        if (missingDocs) result.warnings.push(`${missingDocs} required document${missingDocs > 1 ? 's' : ''} to be uploaded by the supplier`);
        const ags = agreementsToAccept[type] ?? 0;
        if (ags) result.warnings.push(`${ags} agreement${ags > 1 ? 's' : ''} to be accepted by the supplier`);
        keys = identityKeys(full);
      }
    }
    rows.push({ result, input, profile, erpCode, keys });
  });
  if (!rows.length) throw new HttpError(400, 'The file has no supplier rows.');
  if (rows.length > MAX_ROWS) throw new HttpError(400, `Up to ${MAX_ROWS} suppliers per file. Split the list.`);
  // Names already in the workspace.
  const names = new Set((await db.select({ name: schema.vendors.name }).from(schema.vendors).where(and(eq(schema.vendors.tenantId, s.tenant.id), ne(schema.vendors.status, 'REJECTED')))).map((v) => v.name.toLowerCase()));
  for (const r of rows) if (names.has(r.result.name.toLowerCase())) r.result.errors.push('A supplier with this name already exists');
  // Same tax / registration number or bank account as another row or an existing supplier. Only a shared PAN is a
  // warning (one company can have a GSTIN per state); anything else stops the import.
  const allKeys = [...new Set(rows.flatMap((r) => r.keys))];
  const existing = allKeys.length ? await db.select({ code: schema.vendors.code, name: schema.vendors.name, keys: schema.vendors.identityKeys }).from(schema.vendors)
    .where(and(eq(schema.vendors.tenantId, s.tenant.id), isNull(schema.vendors.erasedAt), sql`${schema.vendors.identityKeys} && ARRAY[${sql.join(allKeys.map((k) => sql`${k}`), sql`, `)}]::text[]`)) : [];
  const seenKeys = new Map<string, number>();
  for (const r of rows) {
    const push = (kind: string, msg: string) => (kind === 'pan' ? r.result.warnings : r.result.errors).push(msg);
    for (const k of r.keys) {
      const kind = k.split(':')[0];
      const label = KIND_LABEL[kind as keyof typeof KIND_LABEL];
      const other = existing.find((e) => e.keys?.includes(k));
      if (other) push(kind, `Same ${label} as ${other.code} ${other.name}`);
      if (seenKeys.has(k)) push(kind, `Same ${label} as row ${seenKeys.get(k)}`); else seenKeys.set(k, r.result.row);
    }
  }
  // Plan limit for the whole file.
  const max = effectiveLimits(s.tenant).maxVendors;
  const [{ n: have }] = await db.select({ n: count() }).from(schema.vendors).where(eq(schema.vendors.tenantId, s.tenant.id));
  const limitError = max !== null && have + rows.length > max ? `Your plan allows ${max} suppliers; this file would bring you to ${have + rows.length}.` : null;

  const results = rows.map((r) => r.result);
  const summary = { rows: rows.length, withErrors: results.filter((r) => r.errors.length).length, withWarnings: results.filter((r) => !r.errors.length && r.warnings.length).length, invitations: mode === 'invite' ? rows.filter((r) => r.input.notify).length : 0 };
  const ok = !summary.withErrors && !limitError;
  if (!ok || req.query.apply !== '1') return res.json({ ok, applied: false, mode, summary, limitError, rows: results });

  await assertCanAddVendor(s.tenant);
  const notifyApproved = req.query.notify === '1';
  const created: { row: number; id: string; code: string; name: string }[] = [];
  for (const r of rows) {
    const v = await createVendor(s.tenant, { ...r.input, notify: mode === 'invite' ? r.input.notify : notifyApproved }, { id: s.user.id, name: s.user.name }, { ip: req.ip, ...(mode === 'approved' ? { approved: { profile: r.profile, erpCode: r.erpCode } } : {}) });
    created.push({ row: r.result.row, id: v.id, code: v.code, name: v.name });
  }
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: mode === 'invite' ? 'SUPPLIERS_INVITED_FROM_EXCEL' : 'SUPPLIERS_IMPORTED_FROM_EXCEL', detail: { file: req.file.originalname, count: created.length, emails: mode === 'invite' ? summary.invitations : notifyApproved ? created.length : 0 }, ip: req.ip });
  res.json({ ok: true, applied: true, mode, summary, created, rows: results });
}));

/** A cell as text: dates as YYYY-MM-DD, numbers without Excel's formatting, formulas by their result. */
function cellValue(c: ExcelJS.Cell, type?: string): string {
  let v: any = c.value;
  if (v && typeof v === 'object' && 'result' in v) v = v.result;
  if (v && typeof v === 'object' && 'richText' in v) v = v.richText.map((t: any) => t.text).join('');
  if (v && typeof v === 'object' && 'text' in v) v = v.text; // hyperlink cells (emails, websites)
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return type === 'date' && v > 20000 && v < 80000 ? new Date(Math.round((v - 25569) * 86_400_000)).toISOString().slice(0, 10) : String(v);
  return String(v ?? '').trim();
}
