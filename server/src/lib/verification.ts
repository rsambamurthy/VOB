/**
 * MOCK online verification. In production, replace each function with a call to a
 * verification provider (e.g. GSTN public API / GSP, NSDL PAN verification, a
 * penny-drop bank account check, MCA for CIN). Results are deterministic so demos
 * are repeatable: identifiers ending in "0" (digits) are reported as "not found".
 */
import { validators } from './validators.js';

export type VerifyKind = 'gstin' | 'pan' | 'bank' | 'cin';

export interface VerifyResult {
  kind: VerifyKind;
  status: 'VERIFIED' | 'NOT_FOUND' | 'INVALID_FORMAT';
  mock: true;
  message: string;
  data?: Record<string, string>;
  checkedAt: string;
}

const STATES: Record<string, string> = { '27': 'Maharashtra', '29': 'Karnataka', '33': 'Tamil Nadu', '36': 'Telangana', '07': 'Delhi', '24': 'Gujarat', '09': 'Uttar Pradesh', '19': 'West Bengal', '32': 'Kerala', '06': 'Haryana' };

export function verify(kind: VerifyKind, input: Record<string, string>, legalName: string): VerifyResult {
  const now = new Date().toISOString();
  const base = { kind, mock: true as const, checkedAt: now };
  if (kind === 'gstin') {
    const g = (input.gstin ?? '').toUpperCase();
    const err = validators.gstin(g);
    if (err) return { ...base, status: 'INVALID_FORMAT', message: err };
    if (g[12] === '0') return { ...base, status: 'NOT_FOUND', message: 'GSTIN not found on the GST portal (mock)' };
    return { ...base, status: 'VERIFIED', message: 'GSTIN is active (mock)', data: { legalName: legalName.toUpperCase(), state: STATES[g.slice(0, 2)] ?? `State code ${g.slice(0, 2)}`, status: 'Active', taxpayerType: 'Regular', registeredOn: '2017-07-01' } };
  }
  if (kind === 'pan') {
    const p = (input.pan ?? '').toUpperCase();
    const err = validators.pan(p);
    if (err) return { ...base, status: 'INVALID_FORMAT', message: err };
    if (p[8] === '0') return { ...base, status: 'NOT_FOUND', message: 'PAN not found (mock)' };
    const holderType: Record<string, string> = { C: 'Company', P: 'Individual', F: 'Firm / LLP', H: 'HUF', A: 'AOP', T: 'Trust', G: 'Government', B: 'BOI', L: 'Local Authority', J: 'Artificial Juridical Person' };
    return { ...base, status: 'VERIFIED', message: 'PAN is valid (mock)', data: { nameOnPan: legalName.toUpperCase(), holderType: holderType[p[3]] ?? 'Unknown', aadhaarLinked: 'Yes' } };
  }
  if (kind === 'bank') {
    const acct = input.accountNumber ?? '';
    const ifsc = (input.ifsc ?? '').toUpperCase();
    if (!acct || (ifsc && validators.ifsc(ifsc))) return { ...base, status: 'INVALID_FORMAT', message: 'Enter a valid account number and IFSC first' };
    if (acct.endsWith('0')) return { ...base, status: 'NOT_FOUND', message: 'Penny-drop failed: account not found (mock)' };
    return { ...base, status: 'VERIFIED', message: '₹1 penny-drop succeeded (mock)', data: { nameAtBank: (input.accountHolderName || legalName).toUpperCase(), bank: ifsc ? ifsc.slice(0, 4) : 'N/A' } };
  }
  const c = (input.cin ?? '').toUpperCase();
  const err = validators.cin(c);
  if (err) return { ...base, status: 'INVALID_FORMAT', message: err };
  return { ...base, status: 'VERIFIED', message: 'Company is Active on MCA (mock)', data: { companyName: legalName.toUpperCase(), status: 'Active', incorporated: c.length === 21 ? c.slice(8, 12) : 'N/A' } };
}
