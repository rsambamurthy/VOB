/**
 * Shared Gulf (GCC) pack. Saudi Arabia, and later Bahrain, Qatar, UAE, Kuwait and Oman, extend it.
 * It carries what Gulf buyers expect everywhere: a Friday–Saturday working week (UAE overrides it),
 * deadlines in working days, and sanctions screening of every supplier.
 */
import type { CheckDef, CheckProvider, CheckResult, CountryPack } from '../types.js';
import { baseValidators } from '../base.js';
import { gccDocuments } from './shared.js';

/** Test-mode list: names that come back as a possible match, so the "hit" path can be tried. */
const TEST_LIST = ['sanctioned', 'embargo test', 'blocked trading'];

export const gccMockChecks: CheckProvider = {
  name: 'mock', live: false,
  async check(kind, input, ctx): Promise<CheckResult> {
    if (kind === 'gcc_iban') {
      const iban = input.iban ?? '';
      if (iban.endsWith('0')) return { status: 'NOT_FOUND', message: 'The bank could not confirm this account (test mode)' };
      return { status: 'VERIFIED', message: `Account ${iban.slice(0, 4)}… is open; holder name returned by the bank (test mode)`, nameOnRecord: (input.holder || ctx.legalName).toUpperCase(), data: { bankCountry: iban.slice(0, 2) } };
    }
    if (kind !== 'sanctions') return { status: 'ERROR', message: `No test provider for ${kind}` };
    const names = [input.name, ...(input.owners ? input.owners.split('|') : [])].filter(Boolean);
    for (const n of names) {
      const hit = TEST_LIST.find((t) => n.toLowerCase().includes(t));
      if (hit) return { status: 'NOT_FOUND', message: `Possible match for “${n}” on a sanctions list (test mode) — a reviewer must check before approving`, data: { list: 'UN Security Council (test)', matchedOn: n } };
    }
    return { status: 'VERIFIED', message: `No match on UN, OFAC, EU, UK or local lists for the company${names.length > 1 ? ` and ${names.length - 1} owner(s)` : ''} (test mode)`, data: { lists: 'UN, OFAC, EU, UK, local', screened: String(names.length) } };
  },
};

/** Screens the supplier and its owners (UBOs) against sanctions lists. Internal: suppliers never see it. */
export const sanctionsCheck: CheckDef = {
  kind: 'sanctions', label: 'Sanctions screening', anchor: 'basic.vendorName', buttonLabel: 'Screen',
  inputs: { name: 'basic.vendorName', country: 'basic.supplierCountry', owner1: 'ownership.owner1Name', owner2: 'ownership.owner2Name', owner3: 'ownership.owner3Name' },
  optionalInputs: ['country', 'owner1', 'owner2', 'owner3'],
  scope: 'home', runOnSubmit: true, resultLabels: { ok: 'Clear', fail: 'Possible match' },
  normalise: (r) => {
    const clean = (v?: string) => (v ?? '').trim().replace(/\s+/g, ' ');
    const name = clean(r.name);
    const owners = [r.owner1, r.owner2, r.owner3].map(clean).filter((o) => o.length > 1);
    return { input: { name, country: clean(r.country), owners: owners.join('|') }, masked: owners.length ? `${name} + ${owners.length} owner(s)` : name, error: name.length < 2 ? 'Enter the legal name first' : undefined };
  },
};

/** Gulf bank accounts: the IBAN is open and the holder name matches (account verification through the bank or an aggregator). */
export const ibanCheck: CheckDef = {
  kind: 'gcc_iban', label: 'Bank account (IBAN)', anchor: 'bank.iban', buttonLabel: 'Verify account',
  inputs: { iban: 'bank.iban', holder: 'bank.accountHolderName' }, nameField: 'bank.accountHolderName', onBankChange: true, optionalInputs: ['holder'],
  normalise: (r) => {
    const iban = (r.iban ?? '').replace(/\s+/g, '').toUpperCase();
    const bad = baseValidators.iban.check(iban, {});
    return { input: { iban, holder: (r.holder ?? '').trim() }, masked: iban.length > 8 ? `${iban.slice(0, 4)}••••${iban.slice(-4)}` : iban, error: !iban ? 'Enter the IBAN first' : bad ?? undefined };
  },
};

export const gccPack: CountryPack = {
  code: 'GCC',
  name: 'Gulf',
  locale: 'en-GB',
  weekend: [5, 6],
  skipWeekendsByDefault: true,
  checks: [sanctionsCheck, ibanCheck],
  checkProvider: () => gccMockChecks,
  checksTitle: 'Sanctions screening / IBAN checks',
  documents: gccDocuments,
  vendorTypeLabels: { DOMESTIC: 'Local', IMPORT: 'Foreign', GOVERNMENT: 'Government entity' },
  keyChangeFields: ['basic.nameArabic', 'tax.crNumber', 'tax.vatNumber', 'tax.licenceNumber'],
};
