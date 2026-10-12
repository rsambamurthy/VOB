/** India's online checks (GST portal, PAN, ₹1 penny-drop, MCA) and the provider that runs them. */
import { env } from '../../lib/env.js';
import type { CheckDef, CheckProvider } from '../types.js';
import { indiaValidators } from './validators.js';
import { indiaMockChecks } from './mockChecks.js';
import { surepassChecks } from './surepass.js';

export const mask = (s: string, keepStart = 2, keepEnd = 2) => (s.length <= keepStart + keepEnd ? s : `${s.slice(0, keepStart)}${'•'.repeat(Math.min(8, s.length - keepStart - keepEnd))}${s.slice(-keepEnd)}`);
const up = (v?: string) => (v ?? '').toUpperCase().replace(/\s+/g, '');
const err = (fn: (v: string) => string | null, v: string) => fn(v) ?? undefined;
const fmt = (k: string) => (v: string) => indiaValidators[k].check(v, {});

export const indiaChecks: CheckDef[] = [
  {
    kind: 'gstin', label: 'GSTIN', anchor: 'tax.gstin', inputs: { gstin: 'tax.gstin' },
    normalise: (r) => { const gstin = up(r.gstin); return { input: { gstin }, masked: mask(gstin, 4, 3), error: err(fmt('gstin'), gstin) }; },
  },
  {
    kind: 'pan', label: 'PAN', anchor: 'tax.pan', inputs: { pan: 'tax.pan' },
    normalise: (r) => { const pan = up(r.pan); return { input: { pan }, masked: mask(pan, 3, 1), error: err(fmt('pan'), pan) }; },
  },
  {
    kind: 'bank', label: 'Bank account', anchor: 'bank.ifsc', buttonLabel: 'Verify account', inputs: { accountNumber: 'bank.accountNumber', ifsc: 'bank.ifsc' },
    nameField: 'bank.accountHolderName', onBankChange: true,
    normalise: (r) => {
      const accountNumber = (r.accountNumber ?? '').replace(/\s+/g, ''); const ifsc = up(r.ifsc);
      const error = !/^\d{9,18}$/.test(accountNumber) ? 'Enter a valid account number first' : err(fmt('ifsc'), ifsc);
      return { input: { accountNumber, ifsc }, masked: `${mask(accountNumber, 0, 4)} · ${ifsc}`, error };
    },
  },
  {
    kind: 'cin', label: 'CIN / MCA', anchor: 'tax.cin', inputs: { cin: 'tax.cin' },
    normalise: (r) => { const cin = up(r.cin); return { input: { cin }, masked: mask(cin, 6, 3), error: err(fmt('cin'), cin) }; },
  },
];

export function indiaCheckProvider(): CheckProvider {
  const i = env.int;
  return i.KYC_PROVIDER === 'surepass'
    ? surepassChecks({ baseUrl: i.SUREPASS_BASE_URL, token: i.SUREPASS_TOKEN!, paths: { gstin: i.SUREPASS_PATH_GSTIN, pan: i.SUREPASS_PATH_PAN, bank: i.SUREPASS_PATH_BANK, cin: i.SUREPASS_PATH_CIN } })
    : indiaMockChecks;
}
