/**
 * Invoice duplicate check (Invoices add-on and supplier-portal invoices) — a configurable algorithm (lib/algorithms.ts).
 * Called only from checkInvoice (checks.ts), so every source — portal, AP, bulk, Excel, email — gets the same rules.
 */
import { and, eq, gte, inArray, ne, notInArray, or, sql } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import { defineAlgorithm, type RuleAction } from '../../lib/algorithms.js';
import type { Tenant } from '../../db/schema.js';
import type { Check, CheckInput, CheckSubject, InvoiceKind } from './checks.js';
import { invoicesLicensed } from './config.js';

const { supplierInvoices, supplierInvoiceLines, parties } = schema;
const DAY = 86_400_000;

export const DUPLICATES = defineAlgorithm({
  key: 'invoiceDuplicates', name: 'Invoice duplicate check', module: 'Invoices',
  summary: 'Stops the same invoice being paid twice: exact repeats are blocked, near repeats are flagged for a person to look at.',
  runs: 'On every save and submit (AP), on supplier-portal submission, and when an invoice arrives by email or bulk upload. One shared check for every source.',
  steps: [
    { title: 'Normalise the new invoice', text: 'Invoice number → key (upper case, letters and digits only) and core (the serial: the last run of digits that isn’t a year or financial year such as 2026 or 26-27, leading zeros dropped). Supplier → party and legal identity (PAN taken from the GSTIN, or the tax number). Amount, invoice date, IRN and the PDF’s fingerprint (SHA-256).' },
    { title: 'Find candidates', text: 'Same workspace and same kind (invoice, credit note or debit note); same party or same PAN / tax number; invoice date within the look-back; not cancelled or rejected (a corrected invoice may be sent again). Drafts count only for warnings. IRN and file fingerprint are compared across all suppliers.' },
    { title: 'Apply the rules', text: 'Each earlier invoice is matched against the rules in order; the first rule it meets applies. Block = an error (it can’t be submitted); Warn = an exception (touchless is skipped and a person must look); Off = not checked.' },
    { title: 'Show the matches', text: 'The check names the matching invoices (up to three per rule) with their date and amount.' },
    { title: 'A person decides', text: '“Not a duplicate” with a note clears that pair — recorded with who and when, and not raised again. Otherwise the invoice is cancelled or rejected.' },
  ],
  params: [
    { key: 'lookbackMonths', label: 'Look-back', help: 'Earlier invoices dated within this many months are compared.', type: 'number', default: 18, min: 1, max: 60, unit: 'months' },
    { key: 'dateWindowDays', label: 'Date window', help: 'How close the invoice dates must be for P2, P3 and P4.', type: 'number', default: 7, min: 0, max: 90, unit: 'days' },
    { key: 'amountTolerance', label: 'Amount tolerance', help: 'Totals this close count as the same amount.', type: 'number', default: 1, min: 0, max: 100000, unit: 'currency' },
    { key: 'minCoreDigits', label: 'Short numbers', help: 'In P1 and P4, a core number shorter than this many digits (1, 07, 123) matches only with the same amount too — short numbers repeat across unrelated invoices.', type: 'number', default: 4, min: 1, max: 10, unit: 'digits' },
    { key: 'ocrLookalikes', label: 'Look-alike characters', help: 'In P2, treat O and 0, I / L and 1, S and 5, B and 8 as the same (typing and PDF-reading slips).', type: 'boolean', default: true },
  ],
  rules: [
    { key: 'H1', label: 'Same number', when: 'Same supplier, same kind, same number key on a submitted invoice', catches: 'Re-entered invoice: INV-001 = inv 001 = INV/001', default: 'block', actions: ['block', 'warn'] },
    { key: 'H2', label: 'Same IRN', when: 'Same e-invoice IRN on another invoice (any supplier)', catches: 'The same e-invoice twice (an IRN is unique by law)', default: 'block', actions: ['block'], locked: 'an IRN is unique by law' },
    { key: 'H3', label: 'Same PDF', when: 'The same PDF file (fingerprint) on another invoice (any supplier)', catches: 'The same file mailed twice, or uploaded and mailed', default: 'block', actions: ['block', 'warn', 'off'] },
    { key: 'P1', label: 'Number written differently', when: 'Same supplier; same core number; key differs (a core shorter than “Short numbers” also needs the same amount)', catches: 'KST/2026/1187 vs 1187; INV-001 vs 1 for the same amount', default: 'warn', actions: ['block', 'warn', 'off'] },
    { key: 'P2', label: 'Number one slip apart', when: 'Same supplier; numbers one slip apart — two characters swapped, one added or dropped, or look-alike characters — with the same amount or dates within the window. One changed character counts only with the same amount and dates within the window (consecutive numbers such as 001 and 002 are normal and not flagged on their own)', catches: 'Typing and PDF-reading slips: 4512 vs 4521, INVO12 vs INV012, 1187 vs 11877', default: 'warn', actions: ['block', 'warn', 'off'] },
    { key: 'P3', label: 'Same amount, close dates', when: 'Same supplier; same total (within the tolerance); dates within the window; different number', catches: 'The same bill sent again with a new number (a monthly bill 30 days apart is not flagged)', default: 'warn', actions: ['block', 'warn', 'off'] },
    { key: 'P4', label: 'Same supplier, another code', when: 'Another party with the same PAN / tax number; same number key or core (as in P1), or same total with dates within the window', catches: 'A supplier set up twice (two codes or sites) and billed through both', default: 'warn', actions: ['block', 'warn', 'off'] },
    { key: 'P5', label: 'Same PO lines again', when: 'Same purchase order; the same lines with the same quantities and prices as an earlier invoice', catches: 'The same delivery billed twice under different numbers', default: 'warn', actions: ['block', 'warn', 'off'] },
    { key: 'P6', label: 'Same note again', when: 'A credit or debit note against the same invoice for the same amount as an earlier note', catches: 'A credit note entered twice, or a debit note raised twice', default: 'warn', actions: ['block', 'warn', 'off'] },
  ],
  examples: [
    { before: 'KST/2026/1187 · 01 Nov · 1,79,950', after: 'kst 2026 1187 · 01 Nov · 1,79,950', rule: 'H1', result: 'Blocked — already submitted' },
    { before: 'KST/2026/1187 · 01 Nov · 1,79,950', after: '1187 · 01 Nov · 1,79,950', rule: 'P1', result: 'Possible duplicate' },
    { before: 'KST/2026/1187 · 01 Nov · 1,79,950', after: 'KST/2026/1188 · 03 Nov · 22,000', rule: '—', result: 'Clean — the next invoice in the supplier’s series' },
    { before: 'KST/2026/1187 · 01 Nov · 1,79,950', after: 'KST/2026/1178 · 02 Nov · 1,79,950', rule: 'P2', result: 'Possible duplicate (two digits swapped)' },
    { before: 'KST/2026/1187 · 01 Nov · 1,79,950', after: 'KST/2026/1201 · 05 Nov · 1,79,950', rule: 'P3', result: 'Possible duplicate (same amount, 4 days apart)' },
    { before: 'Rent PE/0412 · 01 Oct · 2,95,000', after: 'Rent PE/0498 · 01 Nov · 2,95,000', rule: '—', result: 'Clean — monthly bill, 31 days apart' },
    { before: 'KST/2026/1187 under SUP-00002', after: 'KST/2026/1187 under SUP-00019 (same PAN)', rule: 'P4', result: 'Possible duplicate — supplier set up twice' },
  ],
  notes: [
    'Warnings never stop entry; they need a person: touchless is skipped and the AP review level applies.',
    '“Not a duplicate” stores who, when, why and the matched invoices; the same pair is not flagged again.',
    'Email and bulk arrivals are checked on arrival, so the flag shows before anyone opens the invoice.',
    'Debit notes are numbered by VendorGate, so the number rules (H1, P1, P2) don’t apply to them.',
    'Candidates come from indexed columns (party, PAN, IRN, fingerprint, date); similarity is worked out on at most 2,000 earlier invoices.',
  ],
  enabled: (t: Tenant) => invoicesLicensed(t),
});

/* ---------------- number helpers (exported for tests) ---------------- */

export const numberKey = (n: string) => n.toUpperCase().replace(/[^A-Z0-9]/g, '');
/**
 * The invoice's serial: the last run of digits that isn't a year or financial year (2026, 26-27, 2026-27), leading zeros
 * dropped. HX/26-27/001 → 1, KST/2026/1187 → 1187, 1187/2026-27 → 1187, INV-000 → 0.
 */
export function numberCore(n: string) {
  const runs = [...n.matchAll(/\d+/g)].map((m) => ({ v: m[0], at: m.index! }));
  const fy = (i: number) => {
    const r = runs[i], next = runs[i + 1], prev = runs[i - 1];
    const pairNext = next && n.slice(r.at + r.v.length, next.at) === '-' && /^\d{2}$/.test(next.v) && /^(\d{2}|\d{4})$/.test(r.v) && Number(next.v) === (Number(r.v.slice(-2)) + 1) % 100;
    const pairPrev = prev && n.slice(prev.at + prev.v.length, r.at) === '-' && /^\d{2}$/.test(r.v) && /^(\d{2}|\d{4})$/.test(prev.v) && Number(r.v) === (Number(prev.v.slice(-2)) + 1) % 100;
    return pairNext || pairPrev || (/^(19|20)\d{2}$/.test(r.v) && runs.length > 1);
  };
  const serial = runs.filter((_, i) => !fy(i));
  const pick = (serial.length ? serial : runs).at(-1)?.v ?? '';
  return pick ? pick.replace(/^0+(?=\d)/, '') : '';
}
const LOOKALIKE: Record<string, string> = { O: '0', I: '1', L: '1', S: '5', B: '8' };
export const lookalikeKey = (k: string) => k.replace(/[OILSB]/g, (c) => LOOKALIKE[c]);
/** Edit distance with adjacent swaps (optimal string alignment), stopping early above `limit`. */
export function editDistance(a: string, b: string, limit = 1) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > limit) return limit + 1;
  }
  return d[a.length][b.length];
}
/** What kind of single slip turns one key into the other: two neighbours swapped, one character added / dropped, or one changed. */
export function slipKind(a: string, b: string): 'swap' | 'indel' | 'change' | null {
  if (a === b) return null;
  if (a.length === b.length) {
    const diff = [...a].map((c, i) => (c !== b[i] ? i : -1)).filter((i) => i >= 0);
    if (diff.length === 1) return 'change';
    if (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]) return 'swap';
    return null;
  }
  return editDistance(a, b) === 1 ? 'indel' : null;
}
/** PAN from a GSTIN (characters 3–12), else the tax number itself. */
export function panOf(tax: string | null | undefined) {
  const t = (tax ?? '').toUpperCase().replace(/\s/g, '');
  if (/^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(t)) return t.slice(2, 12);
  return t.length >= 6 ? t : null;
}

/* ---------------- the check ---------------- */

interface Cand { id: string; number: string; total: number; date: string; status: string; partyId: string | null; vendorId: string | null; poId: string | null; relatedId: string | null; taxNo: string | null }
const MESSAGES: Record<string, string> = {
  H1: 'already submitted', H2: 'same e-invoice IRN', H3: 'the same PDF file', P1: 'same number written differently', P2: 'number one slip apart',
  P3: 'same amount, close dates', P4: 'same PAN under another supplier code', P5: 'same order lines, quantities and prices', P6: 'same note again',
};
const CODE: Record<string, string> = { H1: 'DUPLICATE', H2: 'DUPLICATE_IRN', H3: 'DUPLICATE_FILE' };
const fmt = (c: Cand) => `${c.number} (${c.date}, ${c.total.toLocaleString('en-IN')})`;

export async function duplicateChecks(s: CheckSubject, input: CheckInput, total: number, kind: InvoiceKind): Promise<Check[]> {
  const t = s.tenant;
  const { params: p, rules } = DUPLICATES.resolve(t);
  const on = (r: string) => rules[r] !== 'off';
  const exclude = s.excludeInvoiceId ? [ne(supplierInvoices.id, s.excludeInvoiceId)] : [];
  const pan = panOf(s.supplierGstin ?? s.party?.taxNo);
  const since = new Date(new Date(input.invoiceDate).getTime() - Number(p.lookbackMonths) * 30.44 * DAY).toISOString().slice(0, 10);
  const who = [
    ...(s.party ? [eq(supplierInvoices.partyId, s.party.id)] : []),
    ...(s.vendorId ? [eq(supplierInvoices.vendorId, s.vendorId)] : []),
    ...(pan ? [sql`(upper(replace(${parties.taxNo}, ' ', '')) = ${pan} or substr(upper(replace(${parties.taxNo}, ' ', '')), 3, 10) = ${pan})`] : []),
  ];
  const cands: Cand[] = who.length ? (await db.select({ id: supplierInvoices.id, number: supplierInvoices.invoiceNumber, total: supplierInvoices.total, date: supplierInvoices.invoiceDate, status: supplierInvoices.status,
    partyId: supplierInvoices.partyId, vendorId: supplierInvoices.vendorId, poId: supplierInvoices.poId, relatedId: supplierInvoices.relatedInvoiceId, taxNo: parties.taxNo })
    .from(supplierInvoices).leftJoin(parties, eq(parties.id, supplierInvoices.partyId))
    .where(and(eq(supplierInvoices.tenantId, t.id), eq(supplierInvoices.kind, kind), notInArray(supplierInvoices.status, ['CANCELLED', 'REJECTED']), gte(supplierInvoices.invoiceDate, since), or(...who), ...exclude))
    .orderBy(sql`${supplierInvoices.invoiceDate} desc`).limit(2000)).map((r) => ({ ...r, total: Number(r.total) })) : [];

  const hits = new Map<string, Cand[]>();
  const hit = (rule: string, c: Cand) => { const l = hits.get(rule) ?? []; if (!l.some((x) => x.id === c.id)) l.push(c); hits.set(rule, l); };
  const cleared = new Set(s.cleared ?? []);

  // H2 / H3 across all suppliers.
  const irn = input.einvoice?.irn?.trim().toLowerCase();
  if (irn) {
    const rows = await db.select({ id: supplierInvoices.id, number: supplierInvoices.invoiceNumber, total: supplierInvoices.total, date: supplierInvoices.invoiceDate }).from(supplierInvoices)
      .where(and(eq(supplierInvoices.tenantId, t.id), sql`lower(${supplierInvoices.einvoice}->>'irn') = ${irn}`, notInArray(supplierInvoices.status, ['CANCELLED', 'REJECTED']), ...exclude)).limit(3);
    for (const r of rows) hit('H2', { ...r, total: Number(r.total) } as Cand);
  }
  if (input.fileSha256 && on('H3')) {
    const rows = await db.select({ id: supplierInvoices.id, number: supplierInvoices.invoiceNumber, total: supplierInvoices.total, date: supplierInvoices.invoiceDate }).from(supplierInvoices)
      .where(and(eq(supplierInvoices.tenantId, t.id), sql`${supplierInvoices.file}->>'sha256' = ${input.fileSha256}`, notInArray(supplierInvoices.status, ['CANCELLED', 'REJECTED']), ...exclude)).limit(3);
    for (const r of rows) if (!cleared.has(r.id) || rules.H3 === 'block') hit('H3', { ...r, total: Number(r.total) } as Cand);
  }

  const numbered = kind !== 'DEBIT' && !!input.invoiceNumber && input.invoiceNumber !== 'DRAFT';
  const key = numberKey(input.invoiceNumber), core = numberCore(input.invoiceNumber);
  const lk = p.ocrLookalikes ? lookalikeKey(key) : key;
  const sameAmount = (c: Cand) => Math.abs(c.total - total) <= Number(p.amountTolerance);
  const closeDates = (c: Cand) => Math.abs(new Date(c.date).getTime() - new Date(input.invoiceDate).getTime()) <= Number(p.dateWindowDays) * DAY;
  // P5: earlier invoices on the same PO with the same lines.
  const sig = (ls: { lineId: string | null; quantity: number; unitPrice: number }[]) => ls.filter((l) => l.lineId).map((l) => `${l.lineId}:${+l.quantity.toFixed(4)}:${+l.unitPrice.toFixed(4)}`).sort().join('|');
  const mine = sig(input.lines.filter((l) => l.quantity > 0).map((l) => ({ lineId: l.lineId ?? null, quantity: l.quantity, unitPrice: l.unitPrice })));
  const samePo = s.po && mine && on('P5') ? cands.filter((c) => c.poId === s.po!.id) : [];
  const poSigs = new Map<string, string>();
  if (samePo.length) {
    const ls = await db.select({ inv: supplierInvoiceLines.invoiceId, lineId: supplierInvoiceLines.lineId, q: supplierInvoiceLines.quantity, u: supplierInvoiceLines.unitPrice }).from(supplierInvoiceLines)
      .where(inArray(supplierInvoiceLines.invoiceId, samePo.map((c) => c.id)));
    for (const c of samePo) poSigs.set(c.id, sig(ls.filter((l) => l.inv === c.id).map((l) => ({ lineId: l.lineId, quantity: Number(l.q), unitPrice: Number(l.u) }))));
  }

  for (const c of cands) {
    const sameParty = (!!s.party && c.partyId === s.party.id) || (!!s.vendorId && c.vendorId === s.vendorId);
    const samePan = !sameParty && !!pan && panOf(c.taxNo) === pan;
    const live = c.status !== 'DRAFT';
    const ck = numberKey(c.number), cc = numberCore(c.number);
    const coreMatch = !!core && cc === core && (core.length >= Number(p.minCoreDigits) || sameAmount(c));
    const tests: [string, boolean][] = [
      ['H1', numbered && sameParty && live && ck === key],
      ['P1', numbered && sameParty && coreMatch && ck !== key],
      ['P2', numbered && sameParty && ck !== key && (() => {
        const slip = slipKind(ck, key);
        const lookalike = !!p.ocrLookalikes && lookalikeKey(ck) === lk;
        if (lookalike || slip === 'swap' || slip === 'indel') return sameAmount(c) || closeDates(c);
        return slip === 'change' && sameAmount(c) && closeDates(c);
      })()],
      ['P3', sameParty && ck !== key && sameAmount(c) && closeDates(c)],
      ['P4', samePan && ((numbered && (ck === key || coreMatch)) || (sameAmount(c) && closeDates(c)))],
      ['P5', !!mine && poSigs.get(c.id) === mine],
      ['P6', kind !== 'INVOICE' && !!input.relatedInvoiceId && c.relatedId === input.relatedInvoiceId && sameAmount(c)],
    ];
    const first = tests.find(([r, ok]) => ok && on(r));
    if (!first) continue;
    const [rule] = first;
    // Cleared pairs: only warnings can be cleared.
    if (cleared.has(c.id) && rules[rule] === 'warn') continue;
    // Drafts never block.
    hit(!live && rules[rule] === 'block' ? `${rule}~` : rule, c);
  }

  const out: Check[] = [];
  for (const [r, list] of hits) {
    const rule = r.replace('~', '');
    const action: RuleAction = r.endsWith('~') ? 'warn' : rules[rule];
    if (action === 'off') continue;
    const level = action === 'block' ? 'error' : 'warning';
    const rank = (c: Cand) => (c.status === 'DRAFT' ? 100 : 0) + (numberKey(c.number) === key ? 0 : numberCore(c.number) === core ? 10 : 20) + Math.min(9, Math.abs(new Date(c.date).getTime() - new Date(input.invoiceDate).getTime()) / DAY / 10);
    const sorted = [...list].sort((a, b) => rank(a) - rank(b));
    const shown = sorted.slice(0, 3);
    const lead = rule === 'H1' && level === 'error' ? `${input.invoiceNumber} has already been submitted` : `Possible duplicate of ${shown.map(fmt).join(', ')}${list.length > 3 ? ` and ${list.length - 3} more` : ''}`;
    out.push({ code: CODE[rule] ?? 'POSSIBLE_DUPLICATE', level, rule, refs: sorted.slice(0, 20).map((c) => ({ id: c.id, number: c.number })),
      message: rule === 'H1' && level === 'error' ? lead : `${lead} — ${MESSAGES[rule]} (${rule})` });
  }
  return out;
}
