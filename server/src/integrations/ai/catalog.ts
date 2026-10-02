/**
 * What we try to read from each document type, and which profile field each value fills.
 * Values are format-checked after extraction; anything that fails is dropped.
 */
import { validators } from '../../lib/validators.js';

export interface ExtractKey { key: string; description: string; target: string; validate?: (v: string) => boolean; transform?: (v: string) => string }

const ok = (fn: (v: string) => string | null) => (v: string) => fn(v) === null;
const upper = (v: string) => v.toUpperCase().replace(/\s+/g, '');
const year = (v: string) => (v.match(/(19|20)\d{2}/)?.[0] ?? '');

const K = {
  legalName: { key: 'legalName', description: 'Legal / registered name of the business exactly as printed', target: 'basic.vendorName' },
  tradeName: { key: 'tradeName', description: 'Trade name, if different from the legal name', target: 'basic.tradingName' },
  address: { key: 'address', description: 'Principal place of business address (street lines only)', target: 'basic.address' },
  gstin: { key: 'gstin', description: '15-character GSTIN', target: 'tax.gstin', validate: ok(validators.gstin), transform: upper },
  pan: { key: 'pan', description: '10-character PAN', target: 'tax.pan', validate: ok(validators.pan), transform: upper },
  cin: { key: 'cin', description: '21-character CIN or LLPIN', target: 'tax.cin', validate: ok(validators.cin), transform: upper },
  incorporationYear: { key: 'incorporationYear', description: 'Year of incorporation or registration (YYYY)', target: 'basic.yearEstablished', transform: year, validate: (v: string) => /^\d{4}$/.test(v) },
  udyamNumber: { key: 'udyamNumber', description: 'Udyam registration number like UDYAM-MH-01-0000001', target: 'basic.udyamNumber', validate: ok(validators.udyam), transform: upper },
  msmeCategory: { key: 'msmeCategory', description: 'Enterprise type: Micro, Small or Medium', target: 'basic.msmeCategory', validate: (v: string) => ['Micro', 'Small', 'Medium'].includes(v), transform: (v: string) => v.trim().replace(/^\w/, (c) => c.toUpperCase()).replace(/ .*/, '') },
  accountHolderName: { key: 'accountHolderName', description: 'Account holder name printed on the cheque', target: 'bank.accountHolderName' },
  accountNumber: { key: 'accountNumber', description: 'Bank account number (digits only)', target: 'bank.accountNumber', transform: (v: string) => v.replace(/\D/g, ''), validate: (v: string) => /^\d{9,18}$/.test(v) },
  ifsc: { key: 'ifsc', description: '11-character IFSC code', target: 'bank.ifsc', validate: ok(validators.ifsc), transform: upper },
  bankName: { key: 'bankName', description: 'Name of the bank', target: 'bank.bankName' },
  branch: { key: 'branch', description: 'Bank branch name', target: 'bank.bankBranch' },
} satisfies Record<string, ExtractKey>;

export const EXTRACTABLE: Record<string, { label: string; keys: ExtractKey[] }> = {
  GST_CERT: { label: 'GST registration certificate (Form GST REG-06)', keys: [K.gstin, K.legalName, K.tradeName, K.address, K.pan] },
  PAN_CARD: { label: 'PAN card', keys: [K.pan, K.legalName] },
  CANCELLED_CHEQUE: { label: 'cancelled cheque or bank letter', keys: [K.accountHolderName, K.accountNumber, K.ifsc, K.bankName, K.branch] },
  INCORPORATION_CERT: { label: 'certificate of incorporation', keys: [K.cin, K.legalName, K.incorporationYear, K.pan] },
  MSME_CERT: { label: 'Udyam (MSME) registration certificate', keys: [K.udyamNumber, K.legalName, K.msmeCategory, K.address] },
};

/** The PAN is embedded in a GSTIN (chars 3–12). */
export function derivePanFromGstin(gstin?: string) { return gstin && gstin.length === 15 ? gstin.slice(2, 12) : undefined; }
