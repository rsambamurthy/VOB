/**
 * Facts read from an invoice's text (PDF text from unpdf, or an email body) — no AI, nothing leaves VendorGate. Used by the
 * email inbox to fill a new draft; AP checks and corrects them before submitting. Pure functions (tested on their own).
 */
export interface InvoiceFacts { invoiceNumber?: string; invoiceDate?: string; total?: number; irn?: string; gstins?: string[] }

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** 05/11/2026, 5-11-26, 05.11.2026 (day first), 2026-11-05, 5 Nov 2026, 05-Nov-2026, November 5, 2026 → 2026-11-05. */
export function isoDate(s: string): string | undefined {
  const t = s.trim();
  let y: number, m: number, d: number;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (r) [y, m, d] = [+r[1], +r[2], +r[3]];
  else if ((r = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(t))) [d, m, y] = [+r[1], +r[2], +r[3] < 100 ? 2000 + +r[3] : +r[3]];
  else if ((r = /^(\d{1,2})(?:st|nd|rd|th)?[\s\-]+([A-Za-z]{3,9})[\s\-,]+(\d{2,4})$/.exec(t))) [d, m, y] = [+r[1], MONTHS.indexOf(r[2].slice(0, 3).toLowerCase()) + 1, +r[3] < 100 ? 2000 + +r[3] : +r[3]];
  else if ((r = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/.exec(t))) [m, d, y] = [MONTHS.indexOf(r[1].slice(0, 3).toLowerCase()) + 1, +r[2], +r[3]];
  else return undefined;
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100)) return undefined;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d ? iso : undefined;
}

const DATE = String.raw`(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?[\s\-]+[A-Za-z]{3,9}[\s\-,]+\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})`;
const AMOUNT = String.raw`(?:rs\.?|inr|₹|aed|sar|usd|\$)?\s*([\d,]+(?:\.\d{1,2})?)`;

export function readInvoiceText(text: string, own?: { gstin?: string | null }): InvoiceFacts {
  const t = text.replace(/ /g, ' ');
  const out: InvoiceFacts = {};
  const num = new RegExp(String.raw`(?:tax\s+)?(?:invoice|inv|bill)\s*(?:no|number|num|#)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/\-_.]{1,30})`, 'i').exec(t);
  if (num && /\d/.test(num[1])) out.invoiceNumber = num[1].replace(/[.\-/]+$/, '');
  const date = new RegExp(String.raw`(?:invoice\s*date|inv\.?\s*date|bill\s*date|dated)\s*[:\-]?\s*${DATE}`, 'i').exec(t) ?? new RegExp(String.raw`\bdate\s*[:\-]?\s*${DATE}`, 'i').exec(t);
  if (date) out.invoiceDate = isoDate(date[1]);
  const totals = [...t.matchAll(new RegExp(String.raw`(?:grand\s*total|total\s*invoice\s*(?:value|amount)|invoice\s*(?:total|value|amount)|total\s*amount(?:\s*payable)?|amount\s*payable|net\s*payable|total\s*(?:value|due))\s*(?:\([^)]{0,12}\))?\s*[:\-]?\s*${AMOUNT}`, 'gi'))]
    .map((m) => Number(m[1].replace(/,/g, ''))).filter((n) => Number.isFinite(n) && n > 0);
  if (totals.length) out.total = Math.max(...totals);
  const irn = /\b([0-9a-f]{64})\b/i.exec(t);
  if (irn) out.irn = irn[1].toLowerCase();
  const gstins = [...new Set([...t.toUpperCase().matchAll(/\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/g)].map((m) => m[0]))].filter((g) => g !== own?.gstin?.toUpperCase());
  if (gstins.length) out.gstins = gstins;
  return out;
}
