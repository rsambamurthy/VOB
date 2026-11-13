/** The onboarding form as Excel: download, edit, preview, apply to the draft. */
import { afterAll, describe, expect, test } from 'vitest';
import ExcelJS from 'exceljs';
import { login } from './helpers.js';

const binary = (res: any, cb: (e: Error | null, b: Buffer) => void) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };
async function download(admin: Awaited<ReturnType<typeof login>>) {
  const r = await admin.agent.get('/api/admin/config/excel').set('X-Requested-With', 'fetch').buffer(true).parse(binary);
  expect(r.status).toBe(200);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.body); return wb;
}
async function upload(admin: Awaited<ReturnType<typeof login>>, wb: ExcelJS.Workbook, apply = false) {
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  return (await admin.agent.post(`/api/admin/config/excel${apply ? '?apply=1' : ''}`).set('X-Requested-With', 'fetch').attach('file', buf, 'form.xlsx')).body;
}
const header = (ws: ExcelJS.Worksheet) => { const h: string[] = []; ws.getRow(1).eachCell((c, i) => { h[i] = String(c.text); }); return h; };
const addRow = (ws: ExcelJS.Worksheet, values: Record<string, string>) => { const h = header(ws); ws.addRow(h.map((name) => values[name] ?? '')); };
const setCell = (ws: ExcelJS.Worksheet, match: (get: (h: string) => string) => boolean, col: string, value: string) => {
  const h = header(ws); let hit = 0;
  ws.eachRow((row, n) => { if (n === 1) return; const get = (x: string) => String(row.getCell(h.indexOf(x)).text); if (match(get)) { row.getCell(h.indexOf(col)).value = value; hit++; } });
  expect(hit).toBe(1);
};

afterAll(async () => {
  const admin = await login('admin@acme.test');
  await admin.del('/api/admin/config/draft');
});

describe('form as Excel', () => {
  test('download has the current tabs, fields, documents and a how-to sheet', async () => {
    const admin = await login('admin@acme.test');
    const wb = await download(admin);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['How to fill in', 'Tabs', 'Fields', 'Documents', 'Lists']);
    const fields = wb.getWorksheet('Fields')!;
    const h = header(fields);
    const gstin = fields.getRows(2, fields.rowCount - 1)!.find((r) => r.getCell(h.indexOf('Field key')).text === 'gstin')!;
    expect(gstin.getCell(h.indexOf('Show only if')).text).toBe('tax.hasGst = Yes');
    expect(gstin.getCell(h.indexOf('Required')).text).toBe('tax.hasGst = Yes');
    const vendorName = fields.getRows(2, fields.rowCount - 1)!.find((r) => r.getCell(h.indexOf('Field key')).text === 'vendorName')!;
    expect(vendorName.getCell(h.indexOf('Built-in')).text).toBe('Yes');
  });

  test('a mistake anywhere stops the upload, with sheet and row', async () => {
    const admin = await login('admin@acme.test');
    const wb = await download(admin);
    const f = wb.getWorksheet('Fields')!;
    addRow(f, { 'Tab key': 'bnak', 'Field key': 'x', Label: 'X', Type: 'text' });
    addRow(f, { 'Tab key': 'tax', 'Field key': 'isoCert', Label: 'ISO certified?', Type: 'radio' });
    addRow(f, { 'Tab key': 'tax', 'Field key': 'isoNo', Label: 'ISO number', Type: 'text', 'Show only if': 'tax.isoCertificate = Yes' });
    setCell(f, (g) => g('Field key') === 'vendorName', 'Action', 'Remove');
    const r = await upload(admin, wb);
    expect(r.ok).toBe(false);
    const msgs = r.errors.map((e: any) => `${e.sheet} ${e.row}: ${e.message}`).join('\n');
    expect(msgs).toMatch(/Unknown tab “bnak”/);
    expect(msgs).toMatch(/radio and needs Options/);
    expect(msgs).toMatch(/isoCertificate”, which isn’t a field/);
    expect(msgs).toMatch(/basic.vendorName is built-in and can’t be removed/);
  });

  test('new tab, fields with conditions, a relabel, a removal and a document: previewed, then applied to the draft', async () => {
    const admin = await login('admin@acme.test');
    const wb = await download(admin);
    addRow(wb.getWorksheet('Tabs')!, { 'Tab key': 'quality', 'Tab label': 'Quality & Certifications', 'Arabic label': 'الجودة والشهادات' });
    const f = wb.getWorksheet('Fields')!;
    // The field depends on one further down the sheet: conditions are read after every row.
    addRow(f, { 'Tab key': 'quality', 'Group key': 'iso', 'Group label': 'ISO', 'Field key': 'isoNumber', Label: 'ISO 9001 certificate number', Type: 'text', Required: 'quality.isoCertified = Yes', 'Show only if': 'Quality & Certifications › ISO 9001 certified? = Yes' });
    addRow(f, { 'Tab key': 'quality', 'Group key': 'iso', 'Group label': 'ISO', 'Field key': 'isoCertified', Label: 'ISO 9001 certified?', Type: 'radio', Options: 'Yes; No', Required: 'Yes' });
    addRow(f, { 'Tab key': 'quality', 'Group key': 'iso', 'Field key': 'audits', Label: 'Audits last year', Type: 'number', 'Show only if': 'risk.annualTurnover > 5,00,00,000' });
    setCell(f, (g) => g('Field key') === 'vendorName', 'Label', 'Legal name of the company');
    setCell(f, (g) => g('Field key') === 'websiteUrl', 'Action', 'Remove');
    addRow(wb.getWorksheet('Documents')!, { 'Document code': 'ISO_CERT', Label: 'ISO 9001 certificate', Required: 'quality.isoCertified = Yes', 'Show only if': 'quality.isoCertified = Yes', 'Track expiry': 'Yes' });

    const preview = await upload(admin, wb);
    expect((preview.errors ?? []).map((e: any) => e.message)).toEqual([]);
    expect(preview.changes).toMatchObject({
      tabsAdded: ['Quality & Certifications'],
      fieldsAdded: ['Quality & Certifications › ISO 9001 certificate number', 'Quality & Certifications › ISO 9001 certified?', 'Quality & Certifications › Audits last year'],
      fieldsUpdated: ['Basic Information › Legal name of the company'], fieldsRemoved: ['Basic Information › Website URL'], documentsAdded: ['ISO 9001 certificate'],
    });
    expect((await admin.get('/api/admin/config')).body.draft).toBeNull(); // preview saves nothing

    const applied = await upload(admin, wb, true);
    expect(applied.applied).toBe(true);
    const draft = (await admin.get('/api/admin/config')).body.draft.config;
    const q = draft.sections.find((s: any) => s.key === 'quality');
    expect(q).toMatchObject({ label: 'Quality & Certifications', tr: { ar: { label: 'الجودة والشهادات' } } });
    const [isoNumber, isoCertified, audits] = q.groups[0].fields;
    expect(isoNumber).toMatchObject({ key: 'isoNumber', required: { field: 'quality.isoCertified', op: 'eq', value: 'Yes' }, showIf: { field: 'quality.isoCertified', op: 'eq', value: 'Yes' } });
    expect(isoCertified).toMatchObject({ type: 'radio', options: ['Yes', 'No'], required: true });
    expect(audits.showIf).toEqual({ field: 'risk.annualTurnover', op: 'gt', value: 50000000 });
    const basic = draft.sections.find((s: any) => s.key === 'basic').groups.flatMap((g: any) => g.fields);
    expect(basic.find((x: any) => x.key === 'vendorName').label).toBe('Legal name of the company');
    expect(basic.find((x: any) => x.key === 'websiteUrl')).toBeUndefined();
    expect(draft.documents.find((d: any) => d.type === 'ISO_CERT')).toMatchObject({ hasExpiry: true, required: { field: 'quality.isoCertified', op: 'eq', value: 'Yes' } });

    // Downloading again gives back what was uploaded: uploading it unchanged changes nothing.
    const again = await download(admin);
    const r = await upload(admin, again);
    expect(r).toMatchObject({ ok: true, nothing: true });
  });

  test('not an Excel file', async () => {
    const admin = await login('admin@acme.test');
    const r = (await admin.agent.post('/api/admin/config/excel').set('X-Requested-With', 'fetch').attach('file', Buffer.from('hello'), 'form.xlsx')).body;
    expect(r.errors[0].message).toMatch(/isn’t an Excel/);
  });
});
