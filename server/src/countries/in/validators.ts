/** Indian identifier formats: GSTIN (with checksum), PAN, TAN, CIN/LLPIN, IFSC, UPI, Udyam. */
import type { Profile, ValidatorDef } from '../types.js';

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

export const indiaValidators: Record<string, ValidatorDef> = {
  gstin: {
    label: 'GSTIN (checksum)', upper: true,
    check: (v) => {
      const s = v.toUpperCase();
      if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(s)) return 'GSTIN must be 15 characters, e.g. 27AAPFU0939F1ZV';
      const state = Number(s.slice(0, 2));
      if (state < 1 || (state > 38 && state !== 97 && state !== 99)) return 'GSTIN state code is not valid';
      if (gstinCheckChar(s.slice(0, 14)) !== s[14]) return 'GSTIN checksum does not match — please re-check the number';
      return null;
    },
  },
  pan: { label: 'PAN', upper: true, check: (v) => (/^[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]$/.test(v.toUpperCase()) ? null : 'PAN must be 10 characters, e.g. AAPFU0939F') },
  tan: { label: 'TAN', upper: true, check: (v) => (/^[A-Z]{4}\d{5}[A-Z]$/.test(v.toUpperCase()) ? null : 'TAN must be 10 characters, e.g. MUMA12345B') },
  cin: {
    label: 'CIN / LLPIN', upper: true,
    check: (v) => {
      const s = v.toUpperCase();
      if (/^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/.test(s)) return null; // CIN
      if (/^[A-Z]{3}-\d{4}$/.test(s)) return null; // LLPIN
      return 'CIN must be 21 characters (e.g. U72200MH2010PTC123456) or LLPIN like AAA-1234';
    },
  },
  ifsc: { label: 'IFSC', upper: true, check: (v) => (/^[A-Z]{4}0[A-Z0-9]{6}$/.test(v.toUpperCase()) ? null : 'IFSC must be 11 characters: 4 letters, 0, then 6 characters (e.g. HDFC0001234)') },
  upi: { label: 'UPI ID', check: (v) => (/^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/.test(v) ? null : 'UPI ID must look like name@bank') },
  udyam: { label: 'Udyam number', upper: true, check: (v) => (/^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/.test(v.toUpperCase()) ? null : 'Udyam number must look like UDYAM-MH-01-0000001') },
};

export const indiaFormats = {
  postalCode: { pattern: /^[1-9]\d{5}$/, message: 'Indian PIN code must be 6 digits' },
  bankAccount: { pattern: /^\d{9,18}$/, message: 'Indian bank account numbers are 9–18 digits' },
};

/** The PAN is embedded in a GSTIN (characters 3–12). */
export function indiaCrossChecks(profile: Profile) {
  const issues: { field: string; message: string }[] = [];
  const gstin = String(profile.tax?.gstin ?? '').toUpperCase();
  const pan = String(profile.tax?.pan ?? '').toUpperCase();
  if (gstin.length === 15 && pan.length === 10 && gstin.slice(2, 12) !== pan) {
    issues.push({ field: 'tax.gstin', message: 'PAN embedded in the GSTIN (characters 3–12) does not match the PAN entered' });
  }
  return issues;
}

export const panFromGstin = (gstin?: string) => (gstin && gstin.length === 15 ? gstin.slice(2, 12) : undefined);
