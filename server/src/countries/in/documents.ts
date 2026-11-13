/** Indian documents the AI can read, and which profile field each printed value fills. */
import type { ExtractKey, ExtractedField, ReadableDocument } from '../types.js';
import { indiaValidators, panFromGstin } from './validators.js';

const ok = (k: string) => (v: string) => indiaValidators[k].check(v, {}) === null;
const upper = (v: string) => v.toUpperCase().replace(/\s+/g, '');
const year = (v: string) => (v.match(/(19|20)\d{2}/)?.[0] ?? '');

const K = {
  legalName: { key: 'legalName', description: 'Legal / registered name of the business exactly as printed', target: 'basic.vendorName' },
  tradeName: { key: 'tradeName', description: 'Trade name, if different from the legal name', target: 'basic.tradingName' },
  address: { key: 'address', description: 'Principal place of business address (street lines only)', target: 'basic.address' },
  gstin: { key: 'gstin', description: '15-character GSTIN', target: 'tax.gstin', validate: ok('gstin'), transform: upper },
  pan: { key: 'pan', description: '10-character PAN', target: 'tax.pan', validate: ok('pan'), transform: upper },
  tan: { key: 'tan', description: '10-character TAN (Tax Deduction and Collection Account Number)', target: 'tax.tan', validate: ok('tan'), transform: upper },
  cin: { key: 'cin', description: '21-character CIN or LLPIN', target: 'tax.cin', validate: ok('cin'), transform: upper },
  incorporationYear: { key: 'incorporationYear', description: 'Year of incorporation or registration (YYYY)', target: 'basic.yearEstablished', transform: year, validate: (v: string) => /^\d{4}$/.test(v) },
  udyamNumber: { key: 'udyamNumber', description: 'Udyam registration number like UDYAM-MH-01-0000001', target: 'basic.udyamNumber', validate: ok('udyam'), transform: upper },
  msmeCategory: { key: 'msmeCategory', description: 'Enterprise type: Micro, Small or Medium', target: 'basic.msmeCategory', validate: (v: string) => ['Micro', 'Small', 'Medium'].includes(v), transform: (v: string) => v.trim().replace(/^\w/, (c) => c.toUpperCase()).replace(/ .*/, '') },
  accountHolderName: { key: 'accountHolderName', description: 'Account holder name printed on the cheque', target: 'bank.accountHolderName' },
  accountNumber: { key: 'accountNumber', description: 'Bank account number (digits only)', target: 'bank.accountNumber', transform: (v: string) => v.replace(/\D/g, ''), validate: (v: string) => /^\d{9,18}$/.test(v) },
  ifsc: { key: 'ifsc', description: '11-character IFSC code', target: 'bank.ifsc', validate: ok('ifsc'), transform: upper },
  bankName: { key: 'bankName', description: 'Name of the bank', target: 'bank.bankName' },
  branch: { key: 'branch', description: 'Bank branch name', target: 'bank.bankBranch' },
} satisfies Record<string, ExtractKey>;

export const indiaDocuments: Record<string, ReadableDocument> = {
  GST_CERT: { label: 'GST registration certificate (Form GST REG-06)', keys: [K.gstin, K.legalName, K.tradeName, K.address, K.pan] },
  PAN_CARD: { label: 'PAN card', keys: [K.pan, K.legalName] },
  CANCELLED_CHEQUE: { label: 'cancelled cheque or bank letter', keys: [K.accountHolderName, K.accountNumber, K.ifsc, K.bankName, K.branch] },
  INCORPORATION_CERT: { label: 'certificate of incorporation', keys: [K.cin, K.legalName, K.incorporationYear, K.pan, K.tan] },
  MSME_CERT: { label: 'Udyam (MSME) registration certificate', keys: [K.udyamNumber, K.legalName, K.msmeCategory, K.address] },
};

/** State codes inside a CIN (letters) and a GSTIN (digits). */
const CIN_STATES: Record<string, string> = { AN: 'Andaman and Nicobar Islands', AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar', CH: 'Chandigarh', CT: 'Chhattisgarh', CG: 'Chhattisgarh', DD: 'Daman and Diu', DL: 'Delhi', DN: 'Dadra and Nagar Haveli', GA: 'Goa', GJ: 'Gujarat', HP: 'Himachal Pradesh', HR: 'Haryana', JH: 'Jharkhand', JK: 'Jammu and Kashmir', KA: 'Karnataka', KL: 'Kerala', LA: 'Ladakh', LD: 'Lakshadweep', MH: 'Maharashtra', ML: 'Meghalaya', MN: 'Manipur', MP: 'Madhya Pradesh', MZ: 'Mizoram', NL: 'Nagaland', OR: 'Odisha', OD: 'Odisha', PB: 'Punjab', PY: 'Puducherry', RJ: 'Rajasthan', SK: 'Sikkim', TN: 'Tamil Nadu', TG: 'Telangana', TS: 'Telangana', TR: 'Tripura', UP: 'Uttar Pradesh', UR: 'Uttarakhand', UK: 'Uttarakhand', WB: 'West Bengal' };
const GST_STATES: Record<string, string> = { '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh' };

/**
 * Values implied by others: a GSTIN carries the PAN and the state; a CIN carries the type of entity,
 * the state and the year of incorporation; an LLPIN means a limited liability partnership.
 */
export function indiaDerive(fields: ExtractedField[]): ExtractedField[] {
  const out: ExtractedField[] = [];
  const has = (id: string) => fields.some((f) => f.fieldId === id) || out.some((f) => f.fieldId === id);
  const add = (fieldId: string, label: string, value: string | undefined, confidence: number) => { if (value && !has(fieldId)) out.push({ fieldId, label, value, confidence }); };
  const cin = fields.find((f) => f.fieldId === 'tax.cin');
  if (cin) {
    const m = cin.value.match(/^[LU]\d{5}([A-Z]{2})(\d{4})([A-Z]{3})\d{6}$/);
    if (m) {
      add('basic.entityType', 'Type of entity (from CIN)', ['GOI', 'SGC'].includes(m[3]) ? 'Government Organisation' : 'Company (Pvt / Public Ltd)', cin.confidence);
      add('basic.region', 'State (from CIN)', CIN_STATES[m[1]], cin.confidence);
      add('basic.yearEstablished', 'Year of incorporation (from CIN)', m[2], cin.confidence);
    } else if (/^[A-Z]{3}-\d{4}$/.test(cin.value)) add('basic.entityType', 'Type of entity (from LLPIN)', 'Limited Liability Partnership', cin.confidence);
  }
  const g = fields.find((f) => f.fieldId === 'tax.gstin');
  if (g) {
    add('tax.pan', 'PAN (from GSTIN)', panFromGstin(g.value) ?? undefined, g.confidence);
    add('basic.region', 'State (from GSTIN)', GST_STATES[g.value.slice(0, 2)], g.confidence);
  }
  return out;
}
