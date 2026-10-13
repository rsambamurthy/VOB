/** Building blocks shared by the Gulf country packs. */
import { baseValidators } from '../base.js';
import type { ExtractKey, Profile, ReadableDocument } from '../types.js';

/** A bank in this country must have an IBAN with its prefix and length (SA 24, AE 23, BH 22, QA 29…). */
export function ibanCountryCheck(country: string, prefix: string, length: number) {
  return (p: Profile) => {
    const iban = String(p.bank?.iban ?? '').replace(/\s+/g, '').toUpperCase();
    if (String(p.bank?.bankCountry ?? '') !== country || !iban) return [];
    return iban.startsWith(prefix) && iban.length === length ? [] : [{ field: 'bank.iban', message: `A ${country} bank account’s IBAN starts with ${prefix} and has ${length} characters` }];
  };
}

const compact = (v: string) => v.toUpperCase().replace(/\s+/g, '');
export const BANK_KEYS = {
  holder: { key: 'accountHolderName', description: 'Account holder (beneficiary) name', target: 'bank.accountHolderName' },
  iban: { key: 'iban', description: 'IBAN (starts with two letters, e.g. SA, AE, BH)', target: 'bank.iban', transform: compact, validate: (v: string) => baseValidators.iban.check(v, {}) === null },
  bankName: { key: 'bankName', description: 'Name of the bank', target: 'bank.bankName' },
  swift: { key: 'swift', description: 'SWIFT / BIC code of the bank', target: 'bank.swift', transform: compact, validate: (v: string) => baseValidators.swift.check(v, {}) === null },
} satisfies Record<string, ExtractKey>;

/** Gulf bank letters (IBAN certificates) look the same everywhere. */
export const gccDocuments: Record<string, ReadableDocument> = {
  BANK_LETTER: { label: 'bank letter or IBAN certificate', keys: [BANK_KEYS.holder, BANK_KEYS.iban, BANK_KEYS.bankName, BANK_KEYS.swift] },
};
