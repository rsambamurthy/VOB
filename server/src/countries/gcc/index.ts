/**
 * Shared Gulf (GCC) pack. Saudi Arabia, and later Bahrain, Qatar, UAE, Kuwait and Oman, extend it.
 * It carries what Gulf buyers expect everywhere: a Friday–Saturday working week (UAE overrides it),
 * deadlines in working days, and sanctions screening of every supplier.
 */
import type { CheckDef, CheckProvider, CheckResult, CountryPack } from '../types.js';

/** Test-mode list: names that come back as a possible match, so the "hit" path can be tried. */
const TEST_LIST = ['sanctioned', 'embargo test', 'blocked trading'];

export const gccMockChecks: CheckProvider = {
  name: 'mock', live: false,
  async check(kind, input): Promise<CheckResult> {
    if (kind !== 'sanctions') return { status: 'ERROR', message: `No test provider for ${kind}` };
    const name = (input.name ?? '').toLowerCase();
    const hit = TEST_LIST.find((t) => name.includes(t));
    if (hit) return { status: 'NOT_FOUND', message: `Possible match on a sanctions list (test mode) — a reviewer must check before approving`, data: { list: 'UN Security Council (test)', matchedOn: hit } };
    return { status: 'VERIFIED', message: 'No match on UN, OFAC, EU, UK or local lists (test mode)', data: { lists: 'UN, OFAC, EU, UK, local' } };
  },
};

export const sanctionsCheck: CheckDef = {
  kind: 'sanctions', label: 'Sanctions screening', anchor: 'basic.vendorName', buttonLabel: 'Screen',
  inputs: { name: 'basic.vendorName', country: 'basic.supplierCountry' },
  scope: 'home', runOnSubmit: true, resultLabels: { ok: 'Clear', fail: 'Possible match' },
  normalise: (r) => {
    const name = (r.name ?? '').trim().replace(/\s+/g, ' ');
    return { input: { name, country: (r.country ?? '').trim() }, masked: name, error: name.length < 2 ? 'Enter the legal name first' : undefined };
  },
};

export const gccPack: CountryPack = {
  code: 'GCC',
  name: 'Gulf',
  locale: 'en-GB',
  weekend: [5, 6],
  skipWeekendsByDefault: true,
  checks: [sanctionsCheck],
  checkProvider: () => gccMockChecks,
  checksTitle: 'Sanctions screening',
};
