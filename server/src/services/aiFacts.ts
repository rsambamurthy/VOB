/**
 * Facts for the AI pre-review that are worked out on our server, so the AI gets answers instead of values
 * (privacy mode):
 *  - consistency: yes/no comparisons between the supplier's own values (country packs + general ones);
 *  - peers: where the supplier sits among your approved suppliers (percentiles, only with 5 or more to compare);
 *  - amounts: as ranges, or exact (no names) when the workspace chose that precision.
 */
import { and, eq, ne } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import type { Profile } from '../lib/profileEngine.js';
import type { Tenant, Vendor } from '../db/schema.js';
import { consistencyFacts } from '../countries/registry.js';
import { nameMatch } from '../integrations/kyc/nameMatch.js';

export type AiPrecision = 'ranges' | 'exact';
export const aiPrecision = (t: Tenant): AiPrecision => (t.settings.aiPrecision === 'exact' ? 'exact' : 'ranges');

const num = (x: unknown) => { const n = Number(String(x ?? '').replace(/[,\s]/g, '')); return Number.isFinite(n) && n > 0 ? n : undefined; };
export const turnoverOf = (p: Profile) => num(p.risk?.annualTurnover);
export const ageOf = (p: Profile) => { const y = Number(p.basic?.yearEstablished); return y > 1800 && y <= new Date().getFullYear() ? new Date().getFullYear() - y : undefined; };
/** "Advance" → 0, "Net 45" → 45. */
export const termsDaysOf = (p: Profile) => { const t = String(p.basic?.paymentTerms ?? ''); return /advance/i.test(t) ? 0 : /(\d+)/.test(t) ? Number(RegExp.$1) : undefined; };

const band = (n: number, steps: [number, string][]) => steps.find(([lim]) => n < lim)?.[1] ?? steps[steps.length - 1][1];
export function describeAge(age: number | undefined, precision: AiPrecision) {
  if (age === undefined) return 'unknown';
  return precision === 'exact' ? `${age} year${age === 1 ? '' : 's'}` : band(age, [[2, 'under 2 years'], [5, '2–5 years'], [10, '5–10 years'], [25, '10–25 years'], [Infinity, 'over 25 years']]);
}
export function describeTurnover(n: number | undefined, currency: string, precision: AiPrecision) {
  if (n === undefined) return 'not given';
  const text = precision === 'exact' ? n.toLocaleString('en-US') : band(n, [[1e6, 'under 1 million'], [1e7, '1–10 million'], [1e8, '10–100 million'], [1e9, '100 million – 1 billion'], [Infinity, 'over 1 billion']]);
  return `${text} ${currency}`.trim();
}

const FREE_MAIL = /^(gmail|yahoo|hotmail|outlook|live|icloud|aol|proton|protonmail|rediffmail|ymail|zoho)\./;
/** Yes/no comparisons, any country, plus the supplier country's own (GSTIN state vs address, PIN code…). */
export function comparisons(v: Vendor): Record<string, boolean> {
  const p = v.profile as Profile;
  const out: Record<string, boolean> = {};
  const domain = v.contactEmail.split('@')[1]?.toLowerCase() ?? '';
  const site = String(p.basic?.websiteUrl ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  const free = FREE_MAIL.test(domain);
  out['Contact email is a free webmail address'] = free;
  if (!free && domain) {
    out['Contact email domain resembles the company name'] = (nameMatch(domain.split('.')[0], v.name) ?? 0) >= 60 || v.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(domain.split('.')[0].replace(/[^a-z0-9]/g, ''));
    if (site) out['Contact email domain is the same as the website'] = site === domain || site.endsWith(`.${domain}`) || domain.endsWith(`.${site}`);
  }
  const holder = String(p.bank?.accountHolderName ?? '');
  if (holder) out['Bank account holder name matches the company name'] = (nameMatch(holder, v.name) ?? 0) >= 80;
  const trading = String(p.basic?.tradingName ?? '');
  if (trading) out['Trading name is similar to the legal name'] = (nameMatch(trading, v.name) ?? 0) >= 60;
  if (p.bank?.bankCountry && p.basic?.supplierCountry) out['Bank is in the supplier’s country'] = p.bank.bankCountry === p.basic.supplierCountry;
  return { ...out, ...consistencyFacts(p) };
}

const MIN_PEERS = 5;
/** Where the supplier sits among your approved suppliers: same vendor type and category when there are enough, else wider. */
export async function peerComparison(tenant: Tenant, v: Vendor) {
  const p = v.profile as Profile;
  const rows = await db.select({ vendorType: schema.vendors.vendorType, profile: schema.vendors.profile }).from(schema.vendors)
    .where(and(eq(schema.vendors.tenantId, tenant.id), eq(schema.vendors.status, 'APPROVED'), ne(schema.vendors.id, v.id))).limit(5000);
  const cat = String(p.basic?.supplyCategory ?? '');
  const groups: [string, typeof rows][] = [
    [`approved ${v.vendorType.toLowerCase()} suppliers of ${cat ? cat.toLowerCase() : 'any category'}`, rows.filter((r) => r.vendorType === v.vendorType && cat && String((r.profile as Profile).basic?.supplyCategory ?? '') === cat)],
    [`approved ${v.vendorType.toLowerCase()} suppliers`, rows.filter((r) => r.vendorType === v.vendorType)],
    ['all approved suppliers', rows],
  ];
  const [label, peers] = groups.find(([, g]) => g.length >= MIN_PEERS) ?? [];
  if (!peers || !label) return null;
  const currency = String(p.risk?.currency ?? '');
  const place = (mine: number | undefined, theirs: (number | undefined)[]) => {
    const xs = theirs.filter((x): x is number => x !== undefined);
    if (mine === undefined || xs.length < MIN_PEERS) return undefined;
    const below = xs.filter((x) => x < mine).length, same = xs.filter((x) => x === mine).length;
    const pc = (k: number) => Math.round((k / xs.length) * 100);
    const above = xs.length - below - same;
    const text = [below && `higher than ${pc(below)}%`, same && `the same as ${pc(same)}%`, above && `lower than ${pc(above)}%`].filter(Boolean).join(', ') + ' of them';
    return { text, median: xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] };
  };
  const profiles = peers.map((r) => r.profile as Profile);
  const out: Record<string, unknown> = { comparedWith: `${peers.length} ${label}` };
  const t = place(turnoverOf(p), profiles.filter((x) => String(x.risk?.currency ?? '') === currency).map(turnoverOf));
  if (t) out.annualTurnover = t.text;
  const a = place(ageOf(p), profiles.map(ageOf));
  if (a) out.companyAge = a.text;
  const d = place(termsDaysOf(p), profiles.map(termsDaysOf));
  if (d) out.requestedPaymentTerms = `${d.text} (typical: ${d.median === 0 ? 'advance' : `Net ${d.median}`})`;
  return Object.keys(out).length > 1 ? out : null;
}

/** Comparisons worth attention, as findings (shown with or without the AI): staff wording, and the supplier's (“your”). */
const CONCERN: Record<string, { when: boolean; severity: 'medium' | 'info'; tab?: string; text: string; supplier: string }> = {
  'Contact email is a free webmail address': { when: true, severity: 'info', tab: 'basic', text: 'The contact email is a free webmail address, not a company domain', supplier: 'Your contact email is a free webmail address. A company email address is usually expected.' },
  'Contact email domain resembles the company name': { when: false, severity: 'info', tab: 'basic', text: 'The contact email domain doesn’t resemble the company name', supplier: 'Your contact email’s domain doesn’t look like your company name. Approvers may ask about it.' },
  'Contact email domain is the same as the website': { when: false, severity: 'info', tab: 'basic', text: 'The contact email domain differs from the website', supplier: 'Your contact email’s domain is different from your website. Approvers may ask about it.' },
  'Bank account holder name matches the company name': { when: false, severity: 'medium', tab: 'bank', text: 'The bank account holder name doesn’t match the company name', supplier: 'The bank account holder name doesn’t match your company name. Payments usually go only to an account in the company’s own name.' },
  'Bank is in the supplier’s country': { when: false, severity: 'info', tab: 'bank', text: 'The bank is outside the supplier’s country', supplier: 'Your bank is outside your country. Approvers may ask why.' },
  'GSTIN state matches the address state': { when: false, severity: 'medium', tab: 'tax', text: 'The GSTIN is registered in a different state from the address', supplier: 'Your GSTIN is registered in a different state from your address. Check the GSTIN and the state.' },
  'PIN code matches the address state': { when: false, severity: 'medium', tab: 'basic', text: 'The PIN code belongs to a different state from the one in the address', supplier: 'Your PIN code belongs to a different state from the one in your address. Check both.' },
  'PAN type matches the type of entity': { when: false, severity: 'medium', tab: 'tax', text: 'The PAN’s holder type (4th character) doesn’t fit the type of entity', supplier: 'Your PAN’s 4th character doesn’t fit the type of entity you chose (for example, a company PAN has “C”). Check both.' },
};
export function comparisonConcerns(c: Record<string, boolean>) {
  return Object.entries(c).flatMap(([k, val]) => { const x = CONCERN[k]; return x && val === x.when ? [{ key: k, severity: x.severity, text: x.text, supplierText: x.supplier, tab: x.tab }] : []; });
}
