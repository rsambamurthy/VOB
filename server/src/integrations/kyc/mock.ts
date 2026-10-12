/**
 * Test-mode provider: deterministic, no network. Identifiers whose 9th/13th character is "0"
 * (or bank accounts ending in 0) come back NOT_FOUND so the unhappy path can be demoed.
 */
import type { KycProvider, KycResult } from './types.js';

const STATES: Record<string, string> = { '27': 'Maharashtra', '29': 'Karnataka', '33': 'Tamil Nadu', '36': 'Telangana', '07': 'Delhi', '24': 'Gujarat', '09': 'Uttar Pradesh', '19': 'West Bengal', '32': 'Kerala', '06': 'Haryana' };
const HOLDER: Record<string, string> = { C: 'Company', P: 'Individual', F: 'Firm / LLP', H: 'HUF', A: 'AOP', T: 'Trust', G: 'Government', B: 'BOI', L: 'Local Authority', J: 'Artificial Juridical Person' };

export const mockKyc: KycProvider = {
  name: 'mock', live: false,
  async check(kind, input, { legalName }): Promise<KycResult> {
    const name = legalName.toUpperCase();
    if (kind === 'gstin') {
      const g = input.gstin!;
      if (g[12] === '0') return { status: 'NOT_FOUND', message: 'GSTIN not found on the GST portal (test mode)' };
      return { status: 'VERIFIED', message: 'GSTIN is active (test mode)', nameOnRecord: name, data: { state: STATES[g.slice(0, 2)] ?? `State code ${g.slice(0, 2)}`, gstStatus: 'Active', taxpayerType: 'Regular', registeredOn: '2017-07-01' } };
    }
    if (kind === 'pan') {
      const p = input.pan!;
      if (p[8] === '0') return { status: 'NOT_FOUND', message: 'PAN not found (test mode)' };
      return { status: 'VERIFIED', message: 'PAN is valid (test mode)', nameOnRecord: name, data: { holderType: HOLDER[p[3]] ?? 'Unknown', aadhaarLinked: 'Yes' } };
    }
    if (kind === 'bank') {
      if (input.accountNumber!.endsWith('0')) return { status: 'NOT_FOUND', message: 'Penny-drop failed: account not found (test mode)' };
      return { status: 'VERIFIED', message: '₹1 penny-drop succeeded (test mode)', nameOnRecord: name, data: { bank: input.ifsc ? input.ifsc.slice(0, 4) : 'N/A' } };
    }
    const c = input.cin!;
    return { status: 'VERIFIED', message: 'Company is Active on MCA (test mode)', nameOnRecord: name, data: { companyStatus: 'Active', incorporated: c.length === 21 ? c.slice(8, 12) : 'N/A' } };
  },
};
