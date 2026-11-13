/** Audited financial statements, read the same way in every country. Fills the Financial Risk Evaluation tab. */
import type { ExtractKey, ReadableDocument } from './types.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-03-31" / "31 March 2026" / "Mar-26" → "March". */
const monthOf = (v: string) => {
  const iso = v.match(/^\d{4}-(\d{2})-\d{2}$/);
  if (iso) return MONTHS[Number(iso[1]) - 1] ?? '';
  const named = MONTHS.find((m) => new RegExp(`\\b${m.slice(0, 3)}`, 'i').test(v));
  return named ?? '';
};
/** "2025-26" / "FY25-26" / "2025-2026" → "FY 2025-26"; "2025" → "FY 2025". */
const fyLabel = (v: string) => {
  const two = v.match(/(20\d{2})\s*[-–/]\s*(?:20)?(\d{2})\b/);
  if (two) return `FY ${two[1]}-${two[2]}`;
  const short = v.match(/\bFY\s*'?(\d{2})\s*[-–/]\s*(\d{2})\b/i);
  if (short) return `FY 20${short[1]}-${short[2]}`;
  const one = v.match(/\b(20\d{2})\b/);
  return one ? `FY ${one[1]}` : '';
};
/** "1,23,45,678.50" → "12345678.50"; "(1,200)" → "-1200". */
const amount = (v: string) => {
  const neg = /^\s*\(.*\)\s*$/.test(v) || /^\s*-/.test(v);
  const n = v.replace(/[^\d.]/g, '');
  return n ? (neg ? '-' : '') + n : '';
};
const isAmount = (v: string) => /^-?\d+(\.\d+)?$/.test(v) && v.replace(/\D/g, '').length <= 16;

const UNITS = 'Give the full amount in the reporting currency as digits only — if the statement says "in lakhs", "in crores", "in thousands" or "in millions", multiply it out. If you are not sure of the unit, give a low confidence.';

export const financialsKeys: ExtractKey[] = [
  { key: 'periodEnd', description: 'Date the financial year ended (balance sheet date), as YYYY-MM-DD', target: 'risk.fiscalYearEnd', transform: monthOf, validate: (v) => MONTHS.includes(v) },
  { key: 'financialYear', description: 'Financial year of the latest figures: FY YYYY-YY when the year does not end in December (e.g. FY 2025-26 for April 2025 – March 2026), FY YYYY for a calendar year', target: 'risk.turnoverYear', transform: fyLabel, validate: (v) => v !== '' },
  { key: 'currency', description: 'Currency the figures are reported in, as an ISO code (INR, USD, SAR, AED…)', target: 'risk.currency', transform: (v) => v.trim().toUpperCase().replace(/^RS\.?$|^₹$/, 'INR'), validate: (v) => /^[A-Z]{3}$/.test(v) },
  { key: 'turnover', description: `Revenue from operations (total turnover / sales) for the latest year. ${UNITS}`, target: 'risk.annualTurnover', transform: amount, validate: isAmount, confirm: true },
  { key: 'netWorth', description: `Net worth / total equity (share capital plus reserves and surplus) at the end of the latest year. ${UNITS}`, target: 'risk.netWorth', transform: amount, validate: isAmount, confirm: true },
  { key: 'audited', description: 'Are these audited statements (an independent auditor’s report or opinion is included)? Answer Yes or No', target: 'risk.sourceOfInfo', transform: (v) => (/^y/i.test(v.trim()) ? 'Audited financial statements' : ''), validate: (v) => v !== '' },
];

export const financialsDocument: Record<string, ReadableDocument> = {
  FINANCIALS: { label: 'audited financial statements (balance sheet and profit & loss)', keys: financialsKeys },
};
