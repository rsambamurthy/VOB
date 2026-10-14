/**
 * The Arabic translations as one spreadsheet.
 *
 *   npm run i18n:export [-- file.csv] [-- --missing]   write every supplier-facing text with its Arabic (UTF-8 CSV, opens in Excel)
 *   npm run i18n:import -- file.csv                    read the Arabic column back into the translation files
 *   npm run i18n:check                                 list missing Arabic and {placeholder} mistakes (exit 1 if any)
 *
 * Areas (the "Area" column):
 *   screen   web/src/i18n/{en,ar}.json          portal screen text
 *   message  server/src/i18n/messages.ar.json   errors and check results the server sends to suppliers
 *   template server/src/i18n/config.ar.json     the built-in Gulf onboarding form (labels, help, options, documents, guide)
 *   email    server/src/i18n/emails.json        supplier emails and SMS
 *   help     web/src/help/articles.ar.json      supplier help topics
 *
 * Only the Arabic column is imported. A blank Arabic cell leaves the file unchanged. Rows whose
 * {placeholders} don't match the English are skipped and reported.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKS } from '../src/countries/registry.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const P = {
  webEn: 'web/src/i18n/en.json',
  webAr: 'web/src/i18n/ar.json',
  messages: 'server/src/i18n/messages.ar.json',
  template: 'server/src/i18n/config.ar.json',
  emails: 'server/src/i18n/emails.json',
  helpAr: 'web/src/help/articles.ar.json',
  helpEn: 'web/src/help/articles.ts',
};
const read = (p: string) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));
const write = (p: string, v: unknown) => writeFileSync(resolve(ROOT, p), JSON.stringify(v, null, 2) + '\n');
const sorted = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export type Row = { area: string; key: string; en: string; ar: string };

/* ---------- Collecting ---------- */

/** English text of the built-in templates for packs that offer Arabic. */
function templateStrings(): string[] {
  const out = new Set<string>();
  const add = (s?: string | null) => { if (s && s.trim()) out.add(s); };
  for (const p of PACKS) {
    if (!p.template || !(p.languages ?? []).includes('ar')) continue;
    const c = p.template();
    for (const s of c.sections) {
      add(s.label);
      for (const g of s.groups) {
        add(g.label);
        for (const f of g.fields) { add(f.label); add(f.help); add(f.placeholder); f.options?.forEach(add); }
      }
    }
    for (const d of c.documents) { add(d.label); add(d.help); }
    for (const g of c.guide) { add(g.title); add(g.body); }
    for (const l of c.workflow.levels) add(l.label);
  }
  return [...out];
}

/** English help topics (title/summary/keywords/body) by id, read from articles.ts without running it. */
function helpEnglish(ids: string[]): Record<string, Record<string, string>> {
  const src = readFileSync(resolve(ROOT, P.helpEn), 'utf8');
  const out: Record<string, Record<string, string>> = {};
  for (const id of ids) {
    const at = src.indexOf(`id: '${id}'`);
    if (at < 0) continue;
    const end = src.indexOf('\n  },', at);
    const chunk = src.slice(at, end < 0 ? undefined : end);
    const o: Record<string, string> = {};
    for (const k of ['title', 'summary', 'keywords', 'body']) {
      const m = new RegExp(`\\b${k}:\\s*(\`([\\s\\S]*?)\`|'((?:[^'\\\\]|\\\\.)*)')`).exec(chunk);
      if (m) o[k] = m[2] ?? m[3].replace(/\\'/g, "'");
    }
    out[id] = o;
  }
  return out;
}

export function collect(): Row[] {
  const rows: Row[] = [];
  const webEn: Record<string, string> = read(P.webEn), webAr: Record<string, string> = read(P.webAr);
  for (const k of Object.keys(webEn).sort()) rows.push({ area: 'screen', key: k, en: webEn[k], ar: webAr[k] ?? '' });

  const msgs: Record<string, string> = read(P.messages);
  for (const k of Object.keys(msgs).sort()) rows.push({ area: 'message', key: k, en: k, ar: msgs[k] });

  const tpl: Record<string, string> = read(P.template);
  const keys = new Set([...templateStrings(), ...Object.keys(tpl)]);
  for (const k of [...keys].sort()) rows.push({ area: 'template', key: k, en: k, ar: tpl[k] ?? '' });

  const emails: Record<string, Record<string, { subject: string; body: string }>> = read(P.emails);
  for (const [k, v] of Object.entries(emails)) {
    for (const part of ['subject', 'body'] as const) {
      if (!v.en[part] && !v.ar?.[part]) continue;
      rows.push({ area: 'email', key: `${k}.${part}`, en: v.en[part], ar: v.ar?.[part] ?? '' });
    }
  }

  const helpAr: Record<string, Record<string, string>> = read(P.helpAr);
  const supplierIds = [...readFileSync(resolve(ROOT, P.helpEn), 'utf8').matchAll(/id: '([\w-]+)'[\s\S]*?audience: \[([^\]]*)\]/g)]
    .filter((m) => m[2].includes('supplier')).map((m) => m[1]);
  const ids = [...new Set([...supplierIds, ...Object.keys(helpAr)])];
  const en = helpEnglish(ids);
  for (const id of ids) {
    for (const part of ['title', 'summary', 'keywords', 'body']) {
      const e = en[id]?.[part] ?? '', a = helpAr[id]?.[part] ?? '';
      if (e || a) rows.push({ area: 'help', key: `${id}.${part}`, en: e, ar: a });
    }
  }
  return rows;
}

/* ---------- Checks ---------- */

const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
export function problem(r: Pick<Row, 'en' | 'ar' | 'area'>): string | null {
  if (!r.ar.trim()) return 'missing';
  if (r.area !== 'help' && holes(r.en) !== holes(r.ar)) return `placeholders differ: English {${holes(r.en)}} vs Arabic {${holes(r.ar)}}`;
  return null;
}

/* ---------- CSV ---------- */

const cell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
export function toCsv(rows: Row[]): string {
  const lines = [['Area', 'Key', 'English', 'Arabic', 'Status'].join(',')];
  for (const r of rows) lines.push([r.area, r.key, r.en, r.ar, problem(r) ?? ''].map(cell).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const out: string[][] = [];
  let row: string[] = [], f = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); out.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); out.push(row); }
  return out.filter((r) => r.some((x) => x.trim()));
}

/* ---------- Import ---------- */

export function applyRows(input: { area: string; key: string; ar: string }[]) {
  const current = new Map(collect().map((r) => [`${r.area}\u0000${r.key}`, r]));
  const webAr: Record<string, string> = read(P.webAr), msgs: Record<string, string> = read(P.messages), tpl: Record<string, string> = read(P.template);
  const emails = read(P.emails), helpAr: Record<string, Record<string, string>> = read(P.helpAr);
  const report = { changed: 0, unchanged: 0, blank: 0, unknown: [] as string[], skipped: [] as string[] };
  for (const { area, key, ar: raw } of input) {
    const ar = raw.replace(/\r\n?/g, '\n');
    const cur = current.get(`${area}\u0000${key}`);
    if (!cur) { report.unknown.push(`${area} ${key}`); continue; }
    if (!ar.trim()) { report.blank++; continue; }
    if (ar === cur.ar) { report.unchanged++; continue; }
    const p = problem({ ...cur, ar });
    if (p) { report.skipped.push(`${area} ${key}: ${p}`); continue; }
    if (area === 'screen') webAr[key] = ar;
    else if (area === 'message') msgs[key] = ar;
    else if (area === 'template') tpl[key] = ar;
    else if (area === 'email') { const [k, part] = key.split('.'); emails[k].ar ??= { subject: '', body: '' }; emails[k].ar[part] = ar; }
    else if (area === 'help') { const i = key.lastIndexOf('.'); const id = key.slice(0, i); (helpAr[id] ??= {} as any)[key.slice(i + 1)] = ar; }
    report.changed++;
  }
  if (report.changed) { write(P.webAr, sorted(webAr)); write(P.messages, msgs); write(P.template, sorted(tpl)); write(P.emails, emails); write(P.helpAr, helpAr); }
  return report;
}

/* ---------- CLI ---------- */

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'export') {
    const file = resolve(process.env.INIT_CWD ?? process.cwd(), args.find((a) => !a.startsWith('--')) ?? 'translations-ar.csv');
    const rows = collect().filter((r) => !args.includes('--missing') || problem(r));
    writeFileSync(file, toCsv(rows));
    console.log(`Wrote ${rows.length} rows to ${file} (${rows.filter((r) => problem(r)).length} need attention).`);
  } else if (cmd === 'import') {
    const f = args[0];
    if (!f) { console.error('Usage: npm run i18n:import -- translations-ar.csv'); process.exit(2); }
    const [head, ...body] = parseCsv(readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), f), 'utf8'));
    const col = (n: string) => head.findIndex((h) => h.trim().toLowerCase() === n);
    const [a, k, ar] = [col('area'), col('key'), col('arabic')];
    if (a < 0 || k < 0 || ar < 0) { console.error('The file needs the columns Area, Key and Arabic (as exported). If Excel saved it, use "CSV UTF-8".'); process.exit(2); }
    const r = applyRows(body.map((x) => ({ area: x[a] ?? '', key: x[k] ?? '', ar: x[ar] ?? '' })));
    console.log(`Updated ${r.changed}, unchanged ${r.unchanged}, blank ${r.blank}.`);
    for (const s of r.skipped) console.log(`  skipped — ${s}`);
    for (const u of r.unknown) console.log(`  unknown row — ${u}`);
    if (r.skipped.length || r.unknown.length) process.exitCode = 1;
  } else if (cmd === 'check') {
    const bad = collect().map((r) => [r, problem(r)] as const).filter(([, p]) => p);
    for (const [r, p] of bad) console.log(`${r.area}\t${r.key}\t${p}`);
    console.log(bad.length ? `${bad.length} problem(s).` : 'All supplier-facing text has Arabic.');
    if (bad.length) process.exitCode = 1;
  } else {
    console.log('Usage: npm run i18n:export [-- file.csv] [-- --missing] | i18n:import -- file.csv | i18n:check');
  }
}
