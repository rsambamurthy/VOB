/** Small Excel helpers shared by every import (suppliers, sourcing event lines…). */
import type ExcelJS from 'exceljs';

/** Spreadsheet column letters: 1 → A, 27 → AA. */
export const colName = (n: number) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

/** A cell as text: dates as YYYY-MM-DD, numbers without Excel's formatting, formulas by their result. */
export function cellValue(c: ExcelJS.Cell, type?: string): string {
  let v: any = c.value;
  if (v && typeof v === 'object' && 'result' in v) v = v.result;
  if (v && typeof v === 'object' && 'richText' in v) v = v.richText.map((t: any) => t.text).join('');
  if (v && typeof v === 'object' && 'text' in v) v = v.text; // hyperlink cells (emails, websites)
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return type === 'date' && v > 20000 && v < 80000 ? new Date(Math.round((v - 25569) * 86_400_000)).toISOString().slice(0, 10) : String(v);
  return String(v ?? '').trim();
}

/* ---------------- templates and reading (every import) ---------------- */

export interface SheetColumn { header: string; width?: number; required?: boolean; type?: 'date' }
export interface RowError { row: number; message: string }

/**
 * An import template: a "How to fill in" sheet and the data sheet with frozen, coloured headers (yellow = required),
 * optional example rows (shown in grey) and drop-down lists for chosen columns.
 */
export async function sheetTemplate(opts: { sheet: string; columns: SheetColumn[]; examples?: (string | number)[][]; examplesOnOwnSheet?: boolean; help: [string, string][]; lists?: Record<string, string[]> }) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const how = wb.addWorksheet('How to fill in');
  const ws = wb.addWorksheet(opts.sheet);
  const head = ws.addRow(opts.columns.map((c) => c.header));
  head.font = { bold: true };
  opts.columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width ?? 18; head.getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.required ? 'FFFDE68A' : 'FFDBEAFE' } }; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  // Examples on their own sheet can't be imported by mistake; inline examples are greyed rows the user replaces.
  const exWs = opts.examplesOnOwnSheet && opts.examples?.length ? wb.addWorksheet('Example') : ws;
  if (exWs !== ws) { exWs.addRow(opts.columns.map((c) => c.header)).font = { bold: true }; opts.columns.forEach((c, i) => { exWs.getColumn(i + 1).width = c.width ?? 18; }); }
  for (const ex of opts.examples ?? []) exWs.addRow(ex).font = { italic: true, color: { argb: 'FF64748B' } };
  for (const [header, values] of Object.entries(opts.lists ?? {})) {
    const col = opts.columns.findIndex((c) => c.header === header) + 1;
    if (col) for (let r = 2; r <= 1001; r++) ws.getCell(r, col).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${values.join(',')}"`], showErrorMessage: true };
  }
  how.columns = [{ width: 22 }, { width: 100 }];
  for (const [a, b] of opts.help) { const r = how.addRow([a, b]); r.getCell(1).font = { bold: true }; r.getCell(2).alignment = { wrapText: true }; }
  return wb.xlsx.writeBuffer();
}

/**
 * Read the data sheet of an import: checks the required headers exist, skips empty rows, and gives each row a
 * `get(header)` (headers matched without case or a trailing "(…)"; date columns read as YYYY-MM-DD).
 */
export async function readSheet(buffer: Buffer, opts: { sheet: string; columns: SheetColumn[]; maxRows?: number }) {
  const { default: ExcelJS } = await import('exceljs');
  const { HttpError } = await import('./http.js');
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer as any); } catch { throw new HttpError(400, 'This isn’t an Excel (.xlsx) file VendorGate can read.'); }
  const ws = wb.getWorksheet(opts.sheet) ?? wb.worksheets.find((w) => w.state !== 'hidden' && w.name !== 'How to fill in');
  if (!ws) throw new HttpError(400, `No ${opts.sheet} sheet found. Start from the template.`);
  const key = (h: string) => h.trim().toLowerCase().replace(/\s*\(.*\)$/, '');
  const header = new Map<string, number>();
  ws.getRow(1).eachCell((c, i) => header.set(key(String(c.text)), i));
  const missing = opts.columns.filter((c) => c.required && !header.has(key(c.header))).map((c) => c.header);
  if (missing.length) throw new HttpError(400, `Missing column(s): ${missing.join(', ')}. Start from the template.`);
  const types = new Map(opts.columns.map((c) => [key(c.header), c.type]));
  const rows: { row: number; get: (h: string) => string }[] = [];
  ws.eachRow((r, n) => {
    if (n === 1) return;
    const get = (h: string) => { const i = header.get(key(h)); return i ? cellValue(r.getCell(i), types.get(key(h))) : ''; };
    if (opts.columns.every((c) => !get(c.header))) return;
    rows.push({ row: n, get });
  });
  if (rows.length > (opts.maxRows ?? 2000)) throw new HttpError(400, `At most ${opts.maxRows ?? 2000} rows in one import.`);
  return rows;
}
