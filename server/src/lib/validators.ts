/**
 * Format validators for Indian and international vendor identifiers.
 * Each returns null when valid, or an error message.
 * These are offline format/checksum checks only — see lib/verification.ts for
 * the (mocked) online verification against government / bank sources.
 */
export type ValidatorName =
  | 'gstin' | 'pan' | 'tan' | 'cin' | 'ifsc' | 'swift' | 'iban' | 'upi' | 'udyam'
  | 'email' | 'phone' | 'url' | 'postalCode' | 'bankAccount' | 'year';

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(first14[i]);
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const n = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of n) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

type Ctx = { country?: string };

export const validators: Record<ValidatorName, (v: string, ctx?: Ctx) => string | null> = {
  gstin: (v) => {
    const s = v.toUpperCase();
    if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(s)) return 'GSTIN must be 15 characters, e.g. 27AAPFU0939F1ZV';
    const state = Number(s.slice(0, 2));
    if (state < 1 || (state > 38 && state !== 97 && state !== 99)) return 'GSTIN state code is not valid';
    if (gstinCheckChar(s.slice(0, 14)) !== s[14]) return 'GSTIN checksum does not match — please re-check the number';
    return null;
  },
  pan: (v) => (/^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$/.test(v.toUpperCase()) ? null : 'PAN must be 10 characters, e.g. AAPFU0939F'),
  tan: (v) => (/^[A-Z]{4}\d{5}[A-Z]$/.test(v.toUpperCase()) ? null : 'TAN must be 10 characters, e.g. MUMA12345B'),
  cin: (v) => {
    const s = v.toUpperCase();
    if (/^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/.test(s)) return null; // CIN
    if (/^[A-Z]{3}-\d{4}$/.test(s)) return null; // LLPIN
    return 'CIN must be 21 characters (e.g. U72200MH2010PTC123456) or LLPIN like AAA-1234';
  },
  ifsc: (v) => (/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v.toUpperCase()) ? null : 'IFSC must be 11 characters: 4 letters, 0, then 6 characters (e.g. HDFC0001234)'),
  swift: (v) => (/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v.toUpperCase()) ? null : 'SWIFT/BIC must be 8 or 11 characters, e.g. DEUTDEFF'),
  iban: (v) => (ibanValid(v) ? null : 'IBAN is not valid (format or checksum)'),
  upi: (v) => (/^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/.test(v) ? null : 'UPI ID must look like name@bank'),
  udyam: (v) => (/^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/.test(v.toUpperCase()) ? null : 'Udyam number must look like UDYAM-MH-01-0000001'),
  email: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? null : 'Enter a valid email address'),
  phone: (v) => {
    const d = v.replace(/[\s()+-]/g, '');
    return /^\d{8,15}$/.test(d) ? null : 'Enter a valid phone number (8–15 digits, with country code for non-Indian numbers)';
  },
  url: (v) => {
    try {
      const u = new URL(/^https?:\/\//.test(v) ? v : `https://${v}`);
      return u.hostname.includes('.') ? null : 'Enter a valid website URL';
    } catch {
      return 'Enter a valid website URL';
    }
  },
  postalCode: (v, ctx) => {
    if (ctx?.country === 'India') return /^[1-9]\d{5}$/.test(v) ? null : 'Indian PIN code must be 6 digits';
    return /^[A-Za-z0-9 -]{3,10}$/.test(v) ? null : 'Enter a valid postal code';
  },
  bankAccount: (v, ctx) => {
    if (ctx?.country === 'India') return /^\d{9,18}$/.test(v) ? null : 'Indian bank account numbers are 9–18 digits';
    return /^[A-Za-z0-9]{4,34}$/.test(v) ? null : 'Enter a valid account number';
  },
  year: (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1800 && n <= new Date().getFullYear() ? null : 'Enter a valid year';
  },
};

/** Cross-field consistency checks that single-field validators can't express. */
export function crossFieldChecks(profile: Record<string, Record<string, unknown>>): { field: string; message: string }[] {
  const issues: { field: string; message: string }[] = [];
  const gstin = String(profile.tax?.gstin ?? '').toUpperCase();
  const pan = String(profile.tax?.pan ?? '').toUpperCase();
  if (gstin.length === 15 && pan.length === 10 && gstin.slice(2, 12) !== pan) {
    issues.push({ field: 'tax.gstin', message: 'PAN embedded in the GSTIN (characters 3–12) does not match the PAN entered' });
  }
  const holder = String(profile.bank?.accountHolderName ?? '').trim().toLowerCase();
  const name = String(profile.basic?.vendorName ?? '').trim().toLowerCase();
  if (holder && name && !holder.includes(name.split(/\s+/)[0])) {
    issues.push({ field: 'bank.accountHolderName', message: 'Account holder name does not appear to match the vendor name — reviewers will check this' });
  }
  return issues;
}
