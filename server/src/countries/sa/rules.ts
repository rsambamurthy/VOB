/** Saudi formats, consistency checks, online checks (test mode until Wathq/ZATCA providers are connected) and readable documents. */
import type { CheckDef, CheckProvider, CheckResult, ExtractKey, Profile, ReadableDocument, ValidatorDef } from '../types.js';
import { mask } from '../in/checks.js';

export const saValidators: Record<string, ValidatorDef> = {
  saVat: { label: 'Saudi VAT number', check: (v) => (/^3\d{13}3$/.test(v.replace(/\s+/g, '')) ? null : 'Saudi VAT numbers are 15 digits and start and end with 3, e.g. 300000000000003') },
  saCr: { label: 'Saudi CR / unified number', check: (v) => (/^\d{10}$/.test(v.replace(/\s+/g, '')) ? null : 'The CR (unified national) number is 10 digits') },
};

export const saFormats = {
  postalCode: { pattern: /^\d{5}$/, message: 'Saudi postal codes are 5 digits' },
  vatNumber: { pattern: /^3\d{13}3$/, message: 'Saudi VAT numbers are 15 digits and start and end with 3' },
};

export function saCrossChecks(p: Profile) {
  const issues: { field: string; message: string }[] = [];
  const iban = String(p.bank?.iban ?? '').replace(/\s+/g, '').toUpperCase();
  if (String(p.bank?.bankCountry ?? '') === 'Saudi Arabia' && iban && !/^SA\d{2}[A-Z0-9]{20}$/.test(iban)) {
    issues.push({ field: 'bank.iban', message: 'A Saudi bank account’s IBAN starts with SA and has 24 characters' });
  }
  return issues;
}

/* ---------- Online checks ---------- */

const digits = (v?: string) => (v ?? '').replace(/\D/g, '');

export const saChecks: CheckDef[] = [
  {
    kind: 'sa_cr', label: 'Commercial Registration (Wathq)', anchor: 'tax.crNumber', inputs: { cr: 'tax.crNumber' },
    normalise: (r) => { const cr = digits(r.cr); return { input: { cr }, masked: mask(cr, 3, 2), error: saValidators.saCr.check(cr, {}) ?? undefined }; },
  },
  {
    kind: 'sa_vat', label: 'VAT registration (ZATCA)', anchor: 'tax.vatNumber', inputs: { vat: 'tax.vatNumber' },
    normalise: (r) => { const vat = digits(r.vat); return { input: { vat }, masked: mask(vat, 3, 3), error: saValidators.saVat.check(vat, {}) ?? undefined }; },
  },
];

/** Test mode: CR numbers ending in 0, and VAT numbers whose 13th digit is 9, come back "not found". */
export const saMockChecks: CheckProvider = {
  name: 'mock', live: false,
  async check(kind, input, { legalName }): Promise<CheckResult> {
    const name = legalName.toUpperCase();
    if (kind === 'sa_cr') {
      if (input.cr.endsWith('0')) return { status: 'NOT_FOUND', message: 'CR not found on Wathq (test mode)' };
      const due = new Date(); due.setMonth(due.getMonth() + 7);
      return { status: 'VERIFIED', message: 'CR is active (test mode)', nameOnRecord: name, data: { crStatus: 'Active', city: 'Riyadh', annualConfirmationDue: due.toISOString().slice(0, 10) } };
    }
    if (kind === 'sa_vat') {
      if (input.vat[12] === '9') return { status: 'NOT_FOUND', message: 'VAT number not found on ZATCA (test mode)' };
      return { status: 'VERIFIED', message: 'Registered for VAT (test mode)', nameOnRecord: name, data: { vatStatus: 'Registered' } };
    }
    return { status: 'ERROR', message: `No test provider for ${kind}` };
  },
};

/* ---------- Documents the AI can read ---------- */

const ok = (fn: ValidatorDef) => (v: string) => fn.check(v, {}) === null;
const onlyDigits = (v: string) => v.replace(/\D/g, '');
const K = {
  legalName: { key: 'legalName', description: 'Legal name of the business in English, exactly as printed', target: 'basic.vendorName' },
  nameArabic: { key: 'nameArabic', description: 'Legal name of the business in Arabic, exactly as printed', target: 'basic.nameArabic' },
  cr: { key: 'crNumber', description: '10-digit commercial registration (unified national) number', target: 'tax.crNumber', transform: onlyDigits, validate: ok(saValidators.saCr) },
  vat: { key: 'vatNumber', description: '15-digit VAT registration number', target: 'tax.vatNumber', transform: onlyDigits, validate: ok(saValidators.saVat) },
  city: { key: 'city', description: 'City of the head office', target: 'basic.district' },
  holder: { key: 'accountHolderName', description: 'Account holder (beneficiary) name', target: 'bank.accountHolderName' },
  iban: { key: 'iban', description: 'IBAN, starting with SA (24 characters)', target: 'bank.iban', transform: (v: string) => v.toUpperCase().replace(/\s+/g, ''), validate: (v: string) => /^SA\d{2}[A-Z0-9]{20}$/.test(v) },
  bankName: { key: 'bankName', description: 'Name of the bank', target: 'bank.bankName' },
  swift: { key: 'swift', description: 'SWIFT / BIC code of the bank', target: 'bank.swift', transform: (v: string) => v.toUpperCase().replace(/\s+/g, '') },
} satisfies Record<string, ExtractKey>;

export const saDocuments: Record<string, ReadableDocument> = {
  CR_CERT: { label: 'Saudi commercial registration (CR) certificate', keys: [K.cr, K.legalName, K.nameArabic, K.city] },
  VAT_CERT: { label: 'Saudi VAT registration certificate (ZATCA)', keys: [K.vat, K.legalName, K.nameArabic] },
  BANK_LETTER: { label: 'bank letter or IBAN certificate', keys: [K.holder, K.iban, K.bankName, K.swift] },
};
