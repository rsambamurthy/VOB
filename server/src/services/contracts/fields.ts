/**
 * Merge fields for contract documents — one catalogue for clause wording, built-in templates and the workspace's own
 * Word templates. Written {{contract.number}} everywhere. Unknown fields are refused when a clause or template is saved;
 * fields with no value print as [Field name] so the gap is visible in the draft.
 */
import type { Contract, Party, Tenant } from '../../db/schema.js';
import { companyDetails, CONTRACT_TYPES, JURISDICTIONS, type ContractType, typeInfo } from './config.js';

export interface FieldDef { key: string; label: string; group: 'Contract' | 'Other party' | 'Our company' | 'Other' }
export const MERGE_FIELDS: FieldDef[] = [
  { key: 'contract.number', label: 'Contract number', group: 'Contract' },
  { key: 'contract.title', label: 'Title', group: 'Contract' },
  { key: 'contract.type', label: 'Contract type', group: 'Contract' },
  { key: 'contract.reference', label: 'Their reference', group: 'Contract' },
  { key: 'contract.value', label: 'Value (with currency)', group: 'Contract' },
  { key: 'contract.valueInWords', label: 'Value in words', group: 'Contract' },
  { key: 'contract.currency', label: 'Currency', group: 'Contract' },
  { key: 'contract.startDate', label: 'Start date', group: 'Contract' },
  { key: 'contract.endDate', label: 'End date', group: 'Contract' },
  { key: 'contract.term', label: 'Term (start to end)', group: 'Contract' },
  { key: 'contract.noticeDays', label: 'Notice period (days)', group: 'Contract' },
  { key: 'contract.renewalTermMonths', label: 'Renewal term (months)', group: 'Contract' },
  { key: 'contract.description', label: 'Description / scope', group: 'Contract' },
  { key: 'contract.jurisdiction', label: 'Jurisdiction (country)', group: 'Contract' },
  { key: 'party.name', label: 'Name', group: 'Other party' },
  { key: 'party.legalName', label: 'Legal name', group: 'Other party' },
  { key: 'party.address', label: 'Address', group: 'Other party' },
  { key: 'party.country', label: 'Country', group: 'Other party' },
  { key: 'party.registrationNo', label: 'Registration number', group: 'Other party' },
  { key: 'party.taxNo', label: 'Tax number', group: 'Other party' },
  { key: 'party.email', label: 'Email', group: 'Other party' },
  { key: 'party.signatoryName', label: 'Signatory', group: 'Other party' },
  { key: 'party.signatoryRole', label: 'Signatory’s role', group: 'Other party' },
  { key: 'party.role', label: 'Their role (Supplier / Customer)', group: 'Other party' },
  { key: 'us.legalName', label: 'Our legal name', group: 'Our company' },
  { key: 'us.address', label: 'Our address', group: 'Our company' },
  { key: 'us.registrationNo', label: 'Our registration number', group: 'Our company' },
  { key: 'us.taxNo', label: 'Our tax number', group: 'Our company' },
  { key: 'us.signatoryName', label: 'Our signatory', group: 'Our company' },
  { key: 'us.signatoryRole', label: 'Our signatory’s role', group: 'Our company' },
  { key: 'us.city', label: 'Our city (place of signing)', group: 'Our company' },
  { key: 'us.role', label: 'Our role (Buyer / Seller)', group: 'Our company' },
  { key: 'parent.number', label: 'Contract it amends — number', group: 'Contract' },
  { key: 'parent.title', label: 'Contract it amends — title', group: 'Contract' },
  { key: 'parent.signedDate', label: 'Contract it amends — signed on', group: 'Contract' },
  { key: 'amendment.changes', label: 'What the amendment changes', group: 'Contract' },
  { key: 'today', label: 'Today’s date', group: 'Other' },
];
const KNOWN = new Map(MERGE_FIELDS.map((f) => [f.key, f]));
/** Loop tags a Word template may use to print the drafted clauses. */
export const WORD_LOOP_TAGS = ['#clauses', '/clauses', 'number', 'title', 'body'];

const TAG = /\{\{\s*([#/]?[\w.]+)\s*\}\}/g;
/** Merge fields used in a piece of text. */
export const fieldsIn = (text: string) => [...new Set([...text.matchAll(TAG)].map((m) => m[1]))];
/** Fields that aren't in the catalogue (optionally allowing the Word clause loop tags). */
export const unknownFields = (keys: string[], loop = false) => keys.filter((k) => !KNOWN.has(k) && !(loop && WORD_LOOP_TAGS.includes(k)));

const COUNTRY: Record<string, string> = { ...JURISDICTIONS, GB: 'United Kingdom', US: 'United States', SG: 'Singapore', DE: 'Germany', CN: 'China', QA: 'Qatar', BH: 'Bahrain', OM: 'Oman', KW: 'Kuwait' };
const longDate = (d: string | null) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '');

/* Amount in words: Indian system (lakh, crore) for INR, international (million) otherwise. */
const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const below1000 = (n: number): string => {
  const h = Math.floor(n / 100), r = n % 100;
  const rest = r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? `-${ONES[r % 10]}` : ''}`;
  return [h ? `${ONES[h]} hundred` : '', rest].filter(Boolean).join(' and ');
};
export function amountInWords(amount: number, currency: string) {
  const n = Math.floor(Math.abs(amount));
  if (n === 0) return 'zero';
  const scales: [number, string][] = currency === 'INR' ? [[1e7, 'crore'], [1e5, 'lakh'], [1e3, 'thousand']] : [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
  let left = n; const parts: string[] = [];
  for (const [v, name] of scales) { const q = Math.floor(left / v); if (q) { parts.push(`${currency === 'INR' && q >= 100 ? amountInWords(q, currency) : below1000(q)} ${name}`); left %= v; } }
  if (left) parts.push(below1000(left));
  const words = parts.join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
/** An amount as text in the currency's own grouping (INR 18,60,000.00). */
export const money = (v: number, cur: string) => `${cur} ${v.toLocaleString(cur === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const addressOf = (a: Party['address']) => [a?.line1, a?.city, a?.region, a?.postalCode].filter(Boolean).join(', ');

/** Every field's value for one contract (empty string = no value yet). */
export function fieldValues(t: Tenant, c: Contract, party: Party, parent?: Contract | null, changes?: string[]): Record<string, string> {
  const us = companyDetails(t);
  const signer = (party.contacts ?? []).find((x) => x.signatory) ?? null;
  const value = c.value === null ? null : Number(c.value);
  return {
    'contract.number': c.number, 'contract.title': c.title, 'contract.type': typeInfo(c.type).label, 'contract.reference': c.reference ?? '',
    'contract.value': value === null ? '' : money(value, c.currency), 'contract.valueInWords': value === null ? '' : `${c.currency} ${amountInWords(value, c.currency)} only`,
    'contract.currency': c.currency, 'contract.startDate': longDate(c.startDate), 'contract.endDate': longDate(c.endDate),
    'contract.term': c.startDate ? (c.endDate ? `${longDate(c.startDate)} to ${longDate(c.endDate)}` : `from ${longDate(c.startDate)}, with no fixed end date`) : '',
    'contract.noticeDays': c.noticeDays === null ? '' : String(c.noticeDays), 'contract.renewalTermMonths': c.renewalTermMonths === null ? '' : String(c.renewalTermMonths),
    'contract.description': c.description ?? '', 'contract.jurisdiction': COUNTRY[c.jurisdiction ?? ''] ?? c.jurisdiction ?? '',
    'party.name': party.name, 'party.legalName': party.legalName ?? party.name, 'party.address': addressOf(party.address), 'party.country': COUNTRY[party.country] ?? party.country,
    'party.registrationNo': party.registrationNo ?? '', 'party.taxNo': party.taxNo ?? '', 'party.email': party.email ?? '',
    'party.signatoryName': signer?.name ?? '', 'party.signatoryRole': signer?.role ?? '', 'party.role': c.direction === 'SELL' ? 'Customer' : 'Supplier',
    'us.legalName': us.legalName, 'us.address': us.address, 'us.registrationNo': us.registrationNo, 'us.taxNo': us.taxNo,
    'us.signatoryName': us.signatoryName, 'us.signatoryRole': us.signatoryRole, 'us.city': us.city, 'us.role': c.direction === 'SELL' ? 'Seller' : 'Buyer',
    'parent.number': parent?.number ?? '', 'parent.title': parent?.title ?? '', 'parent.signedDate': longDate(parent?.signedDate ?? null),
    'amendment.changes': (changes ?? []).map((x, i) => `(${String.fromCharCode(97 + i)}) ${x}`).join('\n'),
    today: longDate(new Date().toISOString().slice(0, 10)),
  };
}

/** Fill {{fields}} in text. Fields without a value print as [Label] and are reported in `missing`. */
export function fill(text: string, values: Record<string, string>, missing?: Set<string>) {
  return text.replace(TAG, (whole, key: string) => {
    if (!KNOWN.has(key)) return whole;
    const v = values[key];
    if (v) return v;
    missing?.add(key);
    return `[${KNOWN.get(key)!.label}]`;
  });
}
export const fieldLabel = (key: string) => KNOWN.get(key)?.label ?? key;

/** fieldValues with the contract an amendment changes loaded (drafting and the review portal use this). */
export async function contractFieldValues(t: Tenant, c: Contract, party: Party) {
  if (c.type !== 'amendment' || !c.parentId) return fieldValues(t, c, party);
  const { db, schema } = await import('../../lib/db.js');
  const { eq } = await import('drizzle-orm');
  const parent = await db.query.contracts.findFirst({ where: eq(schema.contracts.id, c.parentId) });
  const { amendmentLines } = await import('./manage.js');
  return fieldValues(t, c, party, parent, parent && c.amends ? amendmentLines(parent, c.amends) : []);
}
