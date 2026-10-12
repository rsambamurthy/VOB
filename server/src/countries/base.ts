/**
 * The shared building blocks every pack inherits: international formats (email, phone, website,
 * SWIFT, IBAN) and the generic postal-code / bank-account rules used when a country has none of its own.
 */
import type { CountryPack, ValidatorDef } from './types.js';

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

export const baseValidators: Record<string, ValidatorDef> = {
  swift: { label: 'SWIFT / BIC', upper: true, check: (v) => (/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v.toUpperCase()) ? null : 'SWIFT/BIC must be 8 or 11 characters, e.g. DEUTDEFF') },
  iban: { label: 'IBAN (mod-97)', upper: true, check: (v) => (ibanValid(v) ? null : 'IBAN is not valid (format or checksum)') },
  email: { label: 'Email', check: (v) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? null : 'Enter a valid email address') },
  phone: {
    label: 'Phone',
    check: (v) => (/^\d{8,15}$/.test(v.replace(/[\s()+-]/g, '')) ? null : 'Enter a valid phone number (8–15 digits, with country code for non-Indian numbers)'),
  },
  url: {
    label: 'Website URL',
    check: (v) => {
      try {
        const u = new URL(/^https?:\/\//.test(v) ? v : `https://${v}`);
        return u.hostname.includes('.') ? null : 'Enter a valid website URL';
      } catch { return 'Enter a valid website URL'; }
    },
  },
  year: {
    label: 'Year',
    check: (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1800 && n <= new Date().getFullYear() ? null : 'Enter a valid year'; },
  },
  // postalCode and bankAccount are added by the registry: they look up the supplier country's own format.
};

export const basePack: CountryPack = {
  code: 'BASE',
  name: 'International',
  currency: 'USD',
  locale: 'en-GB',
  weekend: [0, 6],
  timeZone: 'UTC',
  timeZoneLabel: 'UTC',
  validators: baseValidators,
  formats: {
    postalCode: { pattern: /^[A-Za-z0-9 -]{3,10}$/, message: 'Enter a valid postal code' },
    bankAccount: { pattern: /^[A-Za-z0-9]{4,34}$/, message: 'Enter a valid account number' },
    vatNumber: { pattern: /^[A-Za-z0-9 .-]{4,20}$/, message: 'Enter a valid VAT number' },
  },
};
