/**
 * Reading an uploaded contract (Word or PDF with text) for its key terms — start, end and signing dates, value, notice
 * period, renewal, type and governing law — as suggestions the user accepts.
 *
 * Privacy mode, as for the pre-review: the text is masked HERE before any AI sees it. Known names and numbers (the
 * party, its contacts, tax and registration numbers, our company) and anything that looks like an email, phone, tax
 * id, account or company name become [PARTY-n] / [VALUE-n]; dates [DATE-n]; amounts [AMOUNT-n]; other long numbers
 * [NUMBER-n]. leaks() refuses to send if a known value is still there. The reader answers with tokens; real values
 * are put back here. What left the server is stored on the reading ("What the AI saw").
 * Without the AI option (or no AI configured) VendorGate's own rules read the same masked text.
 */
import PizZip from 'pizzip';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../lib/db.js';
import type { Contract, Tenant } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { readBytes } from '../../integrations/storage/index.js';
import { leaks, pseudonymise } from '../aiPrivacy.js';
import { contractReader, localReader } from '../../integrations/ai/contractReader.js';
import { companyDetails, CONTRACT_TYPE_KEYS, CONTRACT_TYPES, JURISDICTIONS, optionOn, typeOn } from './config.js';
import { getParty } from './parties.js';
import { CONTRACT_FIELD_LABELS } from './contracts.js';

const { contracts: C, contractReadings: RD, contractFiles: F } = schema;
type By = { id: string; name: string; ip?: string };

/* ---------------- text ---------------- */

/** Most a Word document's text part may unpack to (bytes), and most text that is read (characters). */
const MAX_XML = 20_000_000, MAX_TEXT = 400_000;

export async function textOf(buf: Buffer, mime: string) {
  if (mime === 'application/pdf') {
    const { extractText } = await import('unpdf');
    try {
      const r = await extractText(new Uint8Array(buf), { mergePages: true });
      return String(Array.isArray(r.text) ? r.text.join('\n') : r.text);
    } catch { return ''; } // damaged or image-only: treated like a scan
  }
  if (mime.includes('wordprocessingml')) {
    type Part = { asText(): string; _data?: { uncompressedSize?: number } };
    let xml: Part | null;
    try { xml = new PizZip(buf).file('word/document.xml') as unknown as Part | null; } catch { throw new HttpError(400, 'This is not a Word (.docx) file VendorGate can read.'); }
    // A real contract's text is well under this; a file that unpacks to more is refused, not read (zip bombs).
    if ((xml?._data?.uncompressedSize ?? 0) > MAX_XML) throw new HttpError(400, 'This Word file is too large to read.');
    return (xml?.asText() ?? '').replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, ' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  }
  throw new HttpError(400, 'Only Word (.docx) and PDF files can be read.');
}

/* ---------------- masking ---------------- */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_RES: RegExp[] = [
  new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:day\\s+of\\s+)?${MON},?\\s+(\\d{4})\\b`, 'gi'),
  new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'),
  /\b(\d{4})-(\d{2})-(\d{2})\b/g,
  /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g,
];
function isoOf(m: RegExpMatchArray, i: number): string | null {
  let y: number, mo: number, d: number;
  if (i === 0) { d = +m[1]; mo = MONTHS.findIndex((x) => x.startsWith(m[2].toLowerCase().slice(0, 3))) + 1; y = +m[3]; }
  else if (i === 1) { mo = MONTHS.findIndex((x) => x.startsWith(m[1].toLowerCase().slice(0, 3))) + 1; d = +m[2]; y = +m[3]; }
  else if (i === 2) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else { d = +m[1]; mo = +m[2]; y = +m[3]; } // day first (India and the GCC)
  if (!(y > 1950 && y < 2200 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
const CUR: Record<string, string> = { '₹': 'INR', 'rs': 'INR', 'rs.': 'INR', 'inr': 'INR', 'aed': 'AED', 'dhs': 'AED', 'sar': 'SAR', 'usd': 'USD', '$': 'USD', 'eur': 'EUR', '€': 'EUR', 'gbp': 'GBP', '£': 'GBP', 'qar': 'QAR', 'omr': 'OMR', 'bhd': 'BHD', 'kwd': 'KWD' };
const AMOUNT_RE = /(₹|\b(?:rs\.?|inr|aed|dhs|sar|usd|eur|gbp|qar|omr|bhd|kwd)\b|\$|€|£)\s?(\d{1,3}(?:[,\s]\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(\s*(?:lakhs?|crores?|million|mn|thousand))?/gi;
const SCALE: Record<string, number> = { lakh: 1e5, lakhs: 1e5, crore: 1e7, crores: 1e7, million: 1e6, mn: 1e6, thousand: 1e3 };
const PATTERNS: RegExp[] = [
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, // emails
  /\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/g, // GSTIN
  /\b[A-Z]{5}\d{4}[A-Z]\b/g, // PAN
  /\b[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}\b/g, // CIN
  /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, // IBAN
  /\b[A-Z]{4}0[A-Z0-9]{6}\b/g, // IFSC
  /(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,5}\)?[\s-]?)?\d{3,5}[\s-]?\d{4,5}\b/g, // phone numbers
  /\b(?:[A-Z][\w&.'-]*\s+){0,5}[A-Z][\w&.'-]*\s+(?:Private Limited|Pvt\.?\s*Ltd\.?|Limited|Ltd\.?|LLC|L\.L\.C\.?|FZ-?LLC|FZE|FZCO|LLP|Inc\.?|Corporation|Co\.\s*W\.?L\.?L\.?|W\.L\.L\.?)/g, // company names
];

/** Everything VendorGate knows that identifies this contract's parties. */
async function knownIdentifiers(t: Tenant, c: Contract) {
  const party = await getParty(t.id, c.partyId);
  const us = companyDetails(t);
  const v = [party.name, party.legalName, party.code, party.registrationNo, party.taxNo, party.email, party.phone, party.website, party.address?.line1,
    ...party.contacts.flatMap((x) => [x.name, x.email, x.phone]), us.legalName, us.address, us.registrationNo, us.taxNo, us.signatoryName, t.name, c.number, c.reference];
  return new Set(v.filter((x): x is string => !!x && x.trim().length >= 3).map((x) => x.trim()));
}

export function maskText(text: string, ids: Set<string>) {
  const tokens: Record<string, string> = {};
  const dates: Record<string, string> = {};
  const amounts: Record<string, { value: number; currency: string }> = {};
  // 1. Known names and numbers, then anything shaped like an identifier.
  let { text: out } = pseudonymise(text, ids, tokens);
  let n = Object.keys(tokens).length;
  for (const re of PATTERNS) out = out.replace(re, (m) => { if (/^\[[A-Z]+-\d+\]$/.test(m) || m.replace(/\D/g, '').length < 6 && /^\+?[\d\s()-]+$/.test(m)) return m; const k = `[PARTY-${++n}]`; tokens[k] = m; return k; });
  // 2. Dates and amounts, so the reader can point at them without seeing them.
  let d = 0;
  DATE_RES.forEach((re, i) => { out = out.replace(re, (...a) => { const iso = isoOf(a as unknown as RegExpMatchArray, i); if (!iso) return a[0]; const k = `[DATE-${++d}]`; dates[k] = iso; tokens[k] = a[0]; return k; }); });
  let am = 0;
  out = out.replace(AMOUNT_RE, (m, cur: string, num: string, scale?: string) => {
    const value = Number(num.replace(/[,\s]/g, '')) * (scale ? SCALE[scale.trim().toLowerCase()] ?? 1 : 1);
    if (!Number.isFinite(value)) return m;
    const k = `[AMOUNT-${++am}]`; amounts[k] = { value, currency: CUR[cur.toLowerCase()] ?? 'INR' }; tokens[k] = m; return k;
  });
  // 3. Any other long number (account numbers, ids).
  let nn = 0;
  out = out.replace(/\b\d[\d,\s-]{5,}\d\b/g, (m) => (m.replace(/\D/g, '').length >= 6 ? (tokens[`[NUMBER-${++nn}]`] = m, `[NUMBER-${nn}]`) : m));
  return { masked: out, tokens, dates, amounts, count: Object.keys(tokens).length };
}

/* ---------------- reading ---------------- */

const LABEL = CONTRACT_FIELD_LABELS;

export async function readContract(t: Tenant, contractId: string, fileId: string, by: By) {
  const c = await db.query.contracts.findFirst({ where: and(eq(C.tenantId, t.id), eq(C.id, contractId)) });
  if (!c) throw new HttpError(404, 'Contract not found');
  const f = await db.query.contractFiles.findFirst({ where: and(eq(F.contractId, c.id), eq(F.id, fileId)) });
  if (!f) throw new HttpError(404, 'File not found');
  const text = (await textOf(await readBytes(f), f.mimeType)).slice(0, MAX_TEXT).replace(/[ \t]+/g, ' ').trim();
  if (text.length < 200) throw new HttpError(400, 'This file has almost no text (it may be a scan). Upload the Word file or a PDF with text.');
  const ids = await knownIdentifiers(t, c);
  const m = maskText(text, ids);
  const useAi = optionOn(t, 'aiExtraction') && contractReader().live;
  if (useAi && leaks(m.masked, ids, 'contract text')) throw new HttpError(409, 'The text couldn’t be fully masked, so it wasn’t sent to the AI. Try the Word file.');
  const reader = useAi ? contractReader() : localReader;
  const types = CONTRACT_TYPE_KEYS.filter((k) => typeOn(t, k)).map((k) => ({ key: k, label: CONTRACT_TYPES[k].label }));
  const r = await reader.read(m.masked, types);
  const unmask = (s: string) => Object.entries(m.tokens).reduce((x, [k, v]) => x.split(k).join(v), s);
  const ev = (k: string) => (r.evidence[k] ? unmask(r.evidence[k]) : null);
  const s: { field: string; value: string | number | boolean; label: string; evidence: string | null }[] = [];
  for (const k of ['startDate', 'endDate', 'signedDate'] as const) if (r[k] && m.dates[r[k]!]) s.push({ field: k, value: m.dates[r[k]!], label: LABEL[k], evidence: ev(k) });
  if (r.value && m.amounts[r.value]) s.push({ field: 'value', value: m.amounts[r.value].value, label: `${LABEL.value} (${m.amounts[r.value].currency})`, evidence: ev('value') });
  if (r.noticeDays !== undefined) s.push({ field: 'noticeDays', value: r.noticeDays, label: LABEL.noticeDays, evidence: ev('noticeDays') });
  if (r.autoRenew !== undefined) s.push({ field: 'autoRenew', value: r.autoRenew, label: LABEL.autoRenew, evidence: ev('autoRenew') });
  if (r.renewalTermMonths !== undefined) s.push({ field: 'renewalTermMonths', value: r.renewalTermMonths, label: LABEL.renewalTermMonths, evidence: ev('renewalTermMonths') });
  if (r.contractType && r.contractType !== c.type) s.push({ field: 'type', value: r.contractType, label: LABEL.type, evidence: null });
  if (r.governingLaw && r.governingLaw !== 'OTHER') s.push({ field: 'jurisdiction', value: r.governingLaw, label: `${LABEL.jurisdiction} (${JURISDICTIONS[r.governingLaw]})`, evidence: ev('governingLaw') });
  const [row] = await db.insert(RD).values({ tenantId: t.id, contractId: c.id, fileId: f.id, reader: reader.name, sentToAi: useAi ? m.masked.slice(0, 80_000) : null, suggestions: s, notes: r.notes.map(unmask), masked: m.count, createdByName: by.name }).returning();
  await audit({ tenantId: t.id, actor: by.name, action: 'CONTRACT_READ', detail: { subjectId: c.id, number: c.number, file: f.fileName, reader: reader.name, found: s.map((x) => x.field), masked: m.count }, ip: by.ip });
  return row;
}

/** Take chosen suggestions into the contract (through the normal update rules). */
export async function applyReading(t: Tenant, contractId: string, readingId: string, raw: unknown, by: By) {
  const { fields } = z.object({ fields: z.array(z.string()).min(1, 'Choose what to use') }).parse(raw);
  const r = await db.query.contractReadings.findFirst({ where: and(eq(RD.tenantId, t.id), eq(RD.contractId, contractId), eq(RD.id, readingId)) });
  if (!r) throw new HttpError(404, 'Reading not found');
  const patch: Record<string, unknown> = {};
  for (const s of r.suggestions.filter((x) => fields.includes(x.field))) if (s.field !== 'jurisdiction') patch[s.field] = s.value;
  const { updateContract } = await import('./contracts.js');
  if (Object.keys(patch).length) await updateContract(t, contractId, patch, by);
  const j = r.suggestions.find((x) => x.field === 'jurisdiction' && fields.includes('jurisdiction'));
  if (j) await db.update(C).set({ jurisdiction: String(j.value) }).where(eq(C.id, contractId));
  await db.update(RD).set({ appliedFields: [...new Set([...r.appliedFields, ...fields])] }).where(eq(RD.id, r.id));
}

export async function readingsView(t: Tenant, c: Contract) {
  const rows = await db.select().from(RD).where(eq(RD.contractId, c.id)).orderBy(desc(RD.createdAt)).limit(5);
  return { ai: optionOn(t, 'aiExtraction') && contractReader().live, readings: rows };
}
