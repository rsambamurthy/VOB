/**
 * The onboarding form as an Excel workbook, and back.
 *
 * Download: the current form (draft, else published) as sheets Tabs / Fields / Documents, plus a
 * "How to fill in" sheet. Upload: rows are matched by key and merged into the draft —
 *   - a row with a new key adds it, a row with an existing key replaces that item's settings,
 *   - "Remove" in the Action column deletes it (leaving a row out never deletes anything),
 *   - row order sets the order of what is listed.
 * Nothing is saved on preview; apply writes the draft only (publishing stays a separate step).
 */
import ExcelJS from 'exceljs';
import { FIELD_TYPES, VENDOR_ATTRIBUTES, type Condition, type DocumentRequirement, type FieldDef, type OnboardingConfig, type SectionDef } from '../config/types.js';
import { validatorList } from '../countries/registry.js';

export interface RowError { sheet: string; row: number; message: string }
export interface ExcelChanges {
  tabsAdded: string[]; tabsUpdated: string[]; tabsRemoved: string[];
  fieldsAdded: string[]; fieldsUpdated: string[]; fieldsRemoved: string[];
  documentsAdded: string[]; documentsUpdated: string[]; documentsRemoved: string[];
}

const TABS = ['Action', 'Tab key', 'Tab label', 'Arabic label'];
const FIELDS = ['Action', 'Tab key', 'Group key', 'Group label', 'Field key', 'Label', 'Type', 'Required', 'Options', 'Format check', 'Show only if', 'Help text', 'Placeholder', 'Arabic label', 'Arabic help', 'Arabic options', 'Built-in'];
const DOCS = ['Action', 'Document code', 'Label', 'Required', 'Show only if', 'Track expiry', 'Hold on expiry', 'Help text', 'Arabic label'];
const SEP = '; ';

/* ---------- Conditions as text ---------- */

const OP_TEXT: Record<Condition['op'], string> = { eq: '=', neq: '!=', in: 'in', notIn: 'not in', gt: '>', gte: '>=', lt: '<', lte: '<=', empty: 'is empty', notEmpty: 'is filled' };
export function conditionText(c: Condition | undefined): string {
  if (!c) return '';
  if (c.op === 'empty' || c.op === 'notEmpty') return `${c.field} ${OP_TEXT[c.op]}`;
  const v = Array.isArray(c.value) ? c.value.join(SEP) : String(c.value ?? '');
  return `${c.field} ${OP_TEXT[c.op]} ${v}`;
}
/** Parses "tab.field = value" (or "Tab label › Field label = value"); returns an error message on failure. */
export function parseCondition(text: string, cfg: OnboardingConfig): Condition | string {
  const t = text.trim();
  const m = /^(.+?)\s+(is filled|is empty|not in|in|!=|<>|>=|<=|=|>|<)\s*(.*)$/i.exec(t);
  if (!m) return `Can’t read the condition “${t}”. Write it like: basic.supplierCountry = India`;
  const ref = resolveField(m[1].trim(), cfg);
  if (!ref) return `The condition refers to “${m[1].trim()}”, which isn’t a field (use tab.field keys, e.g. tax.hasGst)`;
  const opWord = m[2].toLowerCase();
  const op: Condition['op'] = opWord === 'is filled' ? 'notEmpty' : opWord === 'is empty' ? 'empty' : opWord === 'not in' ? 'notIn' : opWord === 'in' ? 'in'
    : opWord === '!=' || opWord === '<>' ? 'neq' : opWord === '>=' ? 'gte' : opWord === '<=' ? 'lte' : opWord === '>' ? 'gt' : opWord === '<' ? 'lt' : 'eq';
  const raw = m[3].trim();
  if (op === 'empty' || op === 'notEmpty') return { field: ref, op };
  if (!raw) return `The condition “${t}” needs a value after “${m[2]}”`;
  if (op === 'in' || op === 'notIn') return { field: ref, op, value: splitList(raw) };
  if (['gt', 'gte', 'lt', 'lte'].includes(op)) {
    const n = Number(raw.replace(/,/g, ''));
    if (Number.isNaN(n)) return `“${raw}” isn’t a number`;
    return { field: ref, op, value: n };
  }
  return { field: ref, op, value: raw };
}
function resolveField(ref: string, cfg: OnboardingConfig): string | null {
  if (VENDOR_ATTRIBUTES.some((a) => a.key === ref)) return ref;
  const all = cfg.sections.flatMap((s) => s.groups.flatMap((g) => g.fields.map((f) => ({ id: `${s.key}.${f.key}`, s, f }))));
  if (all.some((x) => x.id === ref)) return ref;
  const parts = ref.split(/\s*[›>]\s*/);
  if (parts.length === 2) {
    const hit = all.filter((x) => x.s.label.toLowerCase() === parts[0].toLowerCase() && x.f.label.toLowerCase() === parts[1].toLowerCase());
    if (hit.length === 1) return hit[0].id;
  }
  return null;
}
const splitList = (v: string) => v.split(/\s*;\s*|\n+/).map((x) => x.trim()).filter(Boolean);

/* ---------- Download ---------- */

export async function exportConfig(cfg: OnboardingConfig, opts: { workspace: string; builtIn: string[] }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VendorGate';
  const how = wb.addWorksheet('How to fill in');
  const head = (ws: ExcelJS.Worksheet, cols: string[], widths: number[]) => {
    const r = ws.addRow(cols); r.font = { bold: true }; r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
    ws.columns.forEach((c, i) => { c.width = widths[i] ?? 18; });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  const tabs = wb.addWorksheet('Tabs');
  head(tabs, TABS, [10, 16, 32, 32]);
  for (const s of cfg.sections) tabs.addRow(['', s.key, s.label, s.tr?.ar?.label ?? '']);
  const fields = wb.addWorksheet('Fields');
  head(fields, FIELDS, [10, 12, 16, 22, 22, 34, 11, 24, 36, 16, 36, 36, 20, 28, 28, 28, 9]);
  for (const s of cfg.sections) for (const g of s.groups) for (const f of g.fields) {
    fields.addRow(['', s.key, g.key, g.label, f.key, f.label, f.type,
      f.required === true ? 'Yes' : f.required ? conditionText(f.required) : 'No',
      (f.options ?? []).join(SEP), f.validator ?? '', conditionText(f.showIf), f.help ?? '', f.placeholder ?? '',
      f.tr?.ar?.label ?? '', f.tr?.ar?.help ?? '', (f.tr?.ar?.options ?? []).join(SEP), opts.builtIn.includes(`${s.key}.${f.key}`) ? 'Yes' : '']);
  }
  const docs = wb.addWorksheet('Documents');
  head(docs, DOCS, [10, 22, 36, 26, 30, 12, 14, 40, 30]);
  for (const d of cfg.documents) docs.addRow(['', d.type, d.label, d.required === true ? 'Yes' : d.required ? conditionText(d.required) : 'No', conditionText(d.showIf), d.hasExpiry ? 'Yes' : 'No', d.holdOnExpiry ? 'Yes' : 'No', d.help ?? '', d.tr?.ar?.label ?? '']);

  // Pick-lists for the columns that only take fixed values.
  const lists = wb.addWorksheet('Lists', { state: 'hidden' });
  const validators = validatorList();
  const types = [...FIELD_TYPES];
  types.forEach((t, i) => { lists.getCell(i + 1, 1).value = t; });
  validators.forEach((v, i) => { lists.getCell(i + 1, 2).value = v.key; });
  ['Yes', 'No'].forEach((v, i) => { lists.getCell(i + 1, 3).value = v; });
  lists.getCell(1, 4).value = 'Remove';
  const dv = (ws: ExcelJS.Worksheet, col: number, formula: string, allowOther = false) => {
    for (let r = 2; r <= 600; r++) ws.getCell(r, col).dataValidation = { type: 'list', allowBlank: true, formulae: [formula], showErrorMessage: !allowOther };
  };
  for (const ws of [tabs, fields, docs]) dv(ws, 1, 'Lists!$D$1:$D$1');
  // Tab key: the keys on the Tabs sheet (live — a tab added there appears in the list at once).
  for (let r = 2; r <= 600; r++) fields.getCell(r, 2).dataValidation = { type: 'list', allowBlank: true, formulae: ['Tabs!$B$2:$B$100'], showErrorMessage: true, errorTitle: 'Unknown tab', error: 'Pick a tab key from the Tabs sheet (add new tabs there first).' };
  dv(fields, 7, `Lists!$A$1:$A$${types.length}`);
  dv(fields, 10, `Lists!$B$1:$B$${validators.length}`);
  dv(docs, 6, 'Lists!$C$1:$C$2'); dv(docs, 7, 'Lists!$C$1:$C$2');

  how.columns = [{ width: 26 }, { width: 110 }];
  const lines: [string, string][] = [
    ['VendorGate form', `Workspace “${opts.workspace}”. Edit the Tabs, Fields and Documents sheets, then upload this file in Administration → Configuration.`],
    ['', ''],
    ['How rows are used', 'Rows are matched by key (Tab key, Tab key + Field key, Document code). A new key adds an item; an existing key replaces its settings with the row.'],
    ['Removing', 'Write Remove in the Action column. Leaving a row out never deletes anything.'],
    ['Order', 'The order of the rows sets the order of tabs, fields and documents.'],
    ['Keys', 'Keys can’t be changed once suppliers have answered: to rename, change the Label. Keys start with a letter and use letters, digits or _ (e.g. hasIsoCert). Document codes are UPPER_CASE.'],
    ['Built-in fields', 'Fields marked Built-in are used by VendorGate (ERP export, checks). They can be relabelled, moved and made optional/required, but not removed.'],
    ['Groups', 'Fields with the same Group key are shown together under the Group label. A new Group key creates a group.'],
    ['Type', `One of: ${types.join(', ')}. select and radio need Options.`],
    ['Options', 'Separate with semicolons: Micro; Small; Medium'],
    ['Required', 'Yes, No, or a condition (required only when it holds).'],
    ['Show only if', 'A condition, or blank to always show.'],
    ['Conditions', 'tab.field = value · tab.field != value · tab.field in A; B · tab.field not in A; B · tab.field > 5000000 (also >=, <, <=) · tab.field is filled · tab.field is empty · vendor.vendorType = IMPORT'],
    ['', 'Examples: basic.supplierCountry = India · tax.hasGst = Yes · basic.entityType in Company (Pvt / Public Ltd); Limited Liability Partnership'],
    ['Arabic', 'Optional: Arabic label / help / options shown to suppliers who use the portal in Arabic.'],
    ['After uploading', 'You see a preview of what will change. Applying saves the draft; suppliers see it only after you Publish.'],
    ['', ''],
    ['Format checks', validators.map((v) => `${v.key} (${v.label}${v.country ? `, ${v.country}` : ''})`).join(' · ')],
  ];
  for (const [a, b] of lines) { const r = how.addRow([a, b]); r.getCell(1).font = { bold: true }; r.getCell(2).alignment = { wrapText: true, vertical: 'top' }; }
  how.getRow(1).font = { bold: true, size: 13 };
  return wb;
}

/* ---------- Upload ---------- */

const cellText = (row: ExcelJS.Row, i: number) => { const c = row.getCell(i); const v = c.value as any; const s = v && typeof v === 'object' && 'result' in v ? String(v.result ?? '') : c.text; return String(s ?? '').trim(); };
const yes = (v: string) => /^(yes|y|true|1)$/i.test(v);
const isRemove = (v: string) => /^(remove|delete)$/i.test(v);

/** Reads a sheet into objects by header name (tolerates extra / reordered columns). */
function rowsOf(ws: ExcelJS.Worksheet | undefined, expected: string[]) {
  if (!ws) return null;
  const header = ws.getRow(1);
  const idx = new Map<string, number>();
  header.eachCell((c, i) => idx.set(String(c.text).trim().toLowerCase(), i));
  const missing = expected.filter((h) => h !== 'Built-in' && h !== 'Action' && !idx.has(h.toLowerCase()));
  const out: { row: number; get: (h: string) => string }[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const get = (h: string) => (idx.has(h.toLowerCase()) ? cellText(row, idx.get(h.toLowerCase())!) : '');
    if (expected.every((h) => !get(h))) return;
    out.push({ row: n, get });
  });
  return { rows: out, missing };
}

export async function importConfig(buffer: Buffer, base: OnboardingConfig, opts: { builtIn: string[] }) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer as any); } catch { return { errors: [{ sheet: 'File', row: 0, message: 'This isn’t an Excel (.xlsx) file VendorGate can read.' }], changes: null, config: null }; }
  const errors: RowError[] = [];
  const cfg: OnboardingConfig = structuredClone(base);
  const changes: ExcelChanges = { tabsAdded: [], tabsUpdated: [], tabsRemoved: [], fieldsAdded: [], fieldsUpdated: [], fieldsRemoved: [], documentsAdded: [], documentsUpdated: [], documentsRemoved: [] };
  const sheets = { tabs: rowsOf(wb.getWorksheet('Tabs'), TABS), fields: rowsOf(wb.getWorksheet('Fields'), FIELDS), docs: rowsOf(wb.getWorksheet('Documents'), DOCS) };
  if (!sheets.tabs && !sheets.fields && !sheets.docs) return { errors: [{ sheet: 'File', row: 0, message: 'No Tabs, Fields or Documents sheet found. Start from “Download as Excel”.' }], changes: null, config: null };
  for (const [name, s] of [['Tabs', sheets.tabs], ['Fields', sheets.fields], ['Documents', sheets.docs]] as const) {
    if (s?.missing.length) errors.push({ sheet: name, row: 1, message: `Missing column(s): ${s.missing.join(', ')}` });
  }
  if (errors.length) return { errors, changes: null, config: null };

  /* Tabs */
  const tabOrder: string[] = [];
  for (const { row, get } of sheets.tabs?.rows ?? []) {
    const key = get('Tab key'); const label = get('Tab label'); const ar = get('Arabic label');
    if (!key) { errors.push({ sheet: 'Tabs', row, message: 'Tab key is empty' }); continue; }
    const existing = cfg.sections.find((s) => s.key === key);
    if (isRemove(get('Action'))) {
      if (!existing) { errors.push({ sheet: 'Tabs', row, message: `No tab “${key}” to remove` }); continue; }
      cfg.sections = cfg.sections.filter((s) => s !== existing); changes.tabsRemoved.push(existing.label); continue;
    }
    if (!label) { errors.push({ sheet: 'Tabs', row, message: `Tab “${key}” needs a label` }); continue; }
    const tr = ar ? { ar: { label: ar } } : undefined;
    if (!existing) { cfg.sections.push({ key, label, groups: [], ...(tr ? { tr } : {}) }); changes.tabsAdded.push(label); }
    else if (existing.label !== label || (existing.tr?.ar?.label ?? '') !== ar) { existing.label = label; existing.tr = tr; changes.tabsUpdated.push(label); }
    tabOrder.push(key);
  }
  if (tabOrder.length) cfg.sections = reorder(cfg.sections, tabOrder, (s) => s.key);

  /* Fields */
  const fieldOrder = new Map<string, string[]>();
  // Conditions are read once every row is in, so a field may depend on one added further down.
  const pendingConds: { row: number; id: string; field: FieldDef; required: string; showIf: string }[] = [];
  const updatedIfChanged: { id: string; label: string; before: string; field: FieldDef; moved: boolean }[] = [];
  for (const { row, get } of sheets.fields?.rows ?? []) {
    const tabKey = get('Tab key'); const key = get('Field key');
    const id = `${tabKey}.${key}`;
    const section = cfg.sections.find((s) => s.key === tabKey);
    if (!tabKey || !key) { errors.push({ sheet: 'Fields', row, message: 'Tab key and Field key are both needed' }); continue; }
    if (!section) { errors.push({ sheet: 'Fields', row, message: `Unknown tab “${tabKey}” — add it on the Tabs sheet first` }); continue; }
    const found = findField(section, key);
    if (isRemove(get('Action'))) {
      if (!found) { errors.push({ sheet: 'Fields', row, message: `No field ${id} to remove` }); continue; }
      if (opts.builtIn.includes(id)) { errors.push({ sheet: 'Fields', row, message: `${id} is built-in and can’t be removed (you can relabel it or make it optional)` }); continue; }
      found.group.fields.splice(found.group.fields.indexOf(found.field), 1); changes.fieldsRemoved.push(`${section.label} › ${found.field.label}`); continue;
    }
    const label = get('Label'); const type = get('Type').toLowerCase() as FieldDef['type'];
    if (!label) { errors.push({ sheet: 'Fields', row, message: `${id} needs a Label` }); continue; }
    if (!(FIELD_TYPES as readonly string[]).includes(type)) { errors.push({ sheet: 'Fields', row, message: `${id}: Type must be one of ${FIELD_TYPES.join(', ')}` }); continue; }
    const options = splitList(get('Options'));
    if ((type === 'select' || type === 'radio') && !options.length) { errors.push({ sheet: 'Fields', row, message: `${id} is a ${type} and needs Options (separated by ;)` }); continue; }
    const groupKey = get('Group key') || found?.group.key || 'details';
    const groupLabel = get('Group label');
    const next: FieldDef = { key, label, type };
    if (options.length) next.options = options;
    const validator = get('Format check'); if (validator) next.validator = validator;
    const help = get('Help text'); if (help) next.help = help;
    const placeholder = get('Placeholder'); if (placeholder) next.placeholder = placeholder;
    if (found?.field.dir) next.dir = found.field.dir;
    const ar = { label: get('Arabic label') || undefined, help: get('Arabic help') || undefined, options: get('Arabic options') ? splitList(get('Arabic options')) : undefined };
    if (ar.label || ar.help || ar.options) next.tr = { ar: Object.fromEntries(Object.entries({ ...found?.field.tr?.ar, ...ar }).filter(([, v]) => v !== undefined)) };
    if (key.length > 40 || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) { errors.push({ sheet: 'Fields', row, message: `Field key “${key}” must start with a letter and use only letters, digits or _` }); continue; }
    pendingConds.push({ row, id, field: next, required: get('Required'), showIf: get('Show only if') });
    let group = section.groups.find((g) => g.key === groupKey);
    if (!group) { group = { key: groupKey, label: groupLabel || groupKey, fields: [] }; section.groups.push(group); }
    else if (groupLabel && group.label !== groupLabel) group.label = groupLabel;
    if (found) {
      const before = JSON.stringify(found.field); const movedGroup = found.group !== group;
      if (movedGroup) { found.group.fields.splice(found.group.fields.indexOf(found.field), 1); group.fields.push(next); }
      else found.group.fields[found.group.fields.indexOf(found.field)] = next;
      updatedIfChanged.push({ id, label: `${section.label} › ${label}`, before, field: next, moved: movedGroup });
    } else {
      group.fields.push(next); changes.fieldsAdded.push(`${section.label} › ${label}`);
    }
    const order = fieldOrder.get(`${tabKey}/${groupKey}`) ?? []; order.push(key); fieldOrder.set(`${tabKey}/${groupKey}`, order);
  }
  for (const p of pendingConds) {
    const req = p.required;
    if (!req || /^no$/i.test(req)) delete p.field.required;
    else if (yes(req)) p.field.required = true;
    else { const c = parseCondition(req, cfg); if (typeof c === 'string') errors.push({ sheet: 'Fields', row: p.row, message: `${p.id} Required: ${c}` }); else p.field.required = c; }
    if (p.showIf) { const c = parseCondition(p.showIf, cfg); if (typeof c === 'string') errors.push({ sheet: 'Fields', row: p.row, message: `${p.id} Show only if: ${c}` }); else p.field.showIf = c; }
  }
  for (const u of updatedIfChanged) if (u.moved || canon(JSON.parse(u.before)) !== canon(u.field)) changes.fieldsUpdated.push(u.label);
  for (const s of cfg.sections) for (const g of s.groups) { const o = fieldOrder.get(`${s.key}/${g.key}`); if (o) g.fields = reorder(g.fields, o, (f) => f.key); }
  for (const s of cfg.sections) s.groups = s.groups.filter((g) => g.fields.length);

  /* Documents */
  const docOrder: string[] = [];
  for (const { row, get } of sheets.docs?.rows ?? []) {
    const code = get('Document code').toUpperCase();
    if (!code) { errors.push({ sheet: 'Documents', row, message: 'Document code is empty' }); continue; }
    const existing = cfg.documents.find((d) => d.type === code);
    if (isRemove(get('Action'))) {
      if (!existing) { errors.push({ sheet: 'Documents', row, message: `No document ${code} to remove` }); continue; }
      cfg.documents = cfg.documents.filter((d) => d !== existing); changes.documentsRemoved.push(existing.label); continue;
    }
    const label = get('Label');
    if (!label) { errors.push({ sheet: 'Documents', row, message: `${code} needs a Label` }); continue; }
    if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(code)) { errors.push({ sheet: 'Documents', row, message: `Document code “${code}” must be UPPER_CASE letters, digits or _` }); continue; }
    const d: DocumentRequirement = { type: code, label };
    const req = get('Required');
    if (yes(req)) d.required = true;
    else if (req && !/^no$/i.test(req)) { const c = parseCondition(req, cfg); if (typeof c === 'string') { errors.push({ sheet: 'Documents', row, message: `${code} Required: ${c}` }); continue; } d.required = c; }
    const show = get('Show only if');
    if (show) { const c = parseCondition(show, cfg); if (typeof c === 'string') { errors.push({ sheet: 'Documents', row, message: `${code} Show only if: ${c}` }); continue; } d.showIf = c; }
    if (yes(get('Track expiry'))) d.hasExpiry = true;
    if (yes(get('Hold on expiry'))) d.holdOnExpiry = true;
    const help = get('Help text'); if (help) d.help = help;
    const ar = get('Arabic label'); if (ar || existing?.tr) d.tr = { ar: { ...existing?.tr?.ar, label: ar || undefined } };
    if (d.tr && !d.tr.ar?.label && !Object.values(d.tr.ar ?? {}).some(Boolean)) delete d.tr;
    if (!existing) { cfg.documents.push(d); changes.documentsAdded.push(label); }
    else { if (canon(existing) !== canon(d)) changes.documentsUpdated.push(label); cfg.documents[cfg.documents.indexOf(existing)] = d; }
    docOrder.push(code);
  }
  if (docOrder.length) cfg.documents = reorder(cfg.documents, docOrder, (d) => d.type);
  return { errors, changes, config: errors.length ? null : cfg };
}

/** Same meaning, whatever the property order: `required: false`, empty lists and blank texts count as not set. */
function canon(v: unknown): string {
  const clean = (x: any): any => {
    if (Array.isArray(x)) return x.length ? x.map(clean) : undefined;
    if (x && typeof x === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x).sort()) { const c = clean(x[k]); if (c !== undefined && !(k === 'required' && c === false)) out[k] = c; }
      return Object.keys(out).length ? out : undefined;
    }
    return x === '' || x === null ? undefined : x;
  };
  return JSON.stringify(clean(v) ?? null);
}

function findField(s: SectionDef, key: string) {
  for (const g of s.groups) { const f = g.fields.find((x) => x.key === key); if (f) return { group: g, field: f }; }
  return null;
}
/** Listed items in the listed order, then everything not listed in its previous order. */
function reorder<T>(items: T[], order: string[], keyOf: (t: T) => string) {
  const listed = order.map((k) => items.find((i) => keyOf(i) === k)).filter((x): x is T => !!x);
  return [...listed, ...items.filter((i) => !order.includes(keyOf(i)))];
}
