/**
 * Bahrain pack (extends the Gulf pack).
 *  - Friday–Saturday weekend, Arabia Standard Time, BHD (3 decimals), +973 mobiles (8 digits, 3xxx xxxx / 6xxx xxxx).
 *  - Company identity is the Commercial Registration (CR) from the Ministry of Industry and Commerce (Sijilat),
 *    written as the CR number and branch, e.g. 12345-1. It is renewed yearly and puts the vendor on hold when it lapses.
 *  - VAT (10%) account numbers from the National Bureau for Revenue are 15 digits.
 *  - Addresses use building, road and block numbers instead of postal codes.
 *  - Personal Data Protection Law (Law No. 30 of 2018) privacy notice. No withholding tax on non-residents.
 * Online checks run in test mode until Sijilat / NBR lookup providers are connected.
 */
import type { CheckDef, CheckProvider, CheckResult, CountryPack, ExtractKey, Profile, ReadableDocument, ValidatorDef } from '../types.js';
import { mask } from '../in/checks.js';
import { ibanCountryCheck } from '../gcc/shared.js';
import { gulfTemplate, isCountry, YES_NO, yes } from '../gcc/template.js';

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const digits = (v?: string) => (v ?? '').replace(/\D/g, '');
const BAHRAIN = 'Bahrain';
const HERE = isCountry(BAHRAIN);

export const bhValidators: Record<string, ValidatorDef> = {
  bhCr: { label: 'Bahrain CR number', check: (v) => (/^\d{1,7}(-\d{1,3})?$/.test(v.replace(/\s+/g, '')) ? null : 'Enter the CR number and branch as on Sijilat, e.g. 12345-1') },
  bhVat: { label: 'Bahrain VAT account number', check: (v) => (/^\d{15}$/.test(v.replace(/[\s-]/g, '')) ? null : 'A Bahrain VAT account number is 15 digits, e.g. 200000445300002') },
};

/* ---------- Online checks (test mode) ---------- */

export const bhChecks: CheckDef[] = [
  {
    kind: 'bh_cr', label: 'Commercial Registration (Sijilat)', anchor: 'tax.crNumber', inputs: { cr: 'tax.crNumber' },
    normalise: (r) => { const cr = (r.cr ?? '').replace(/\s+/g, ''); return { input: { cr }, masked: cr, error: bhValidators.bhCr.check(cr, {}) ?? undefined }; },
  },
  {
    kind: 'bh_vat', label: 'VAT registration (NBR)', anchor: 'tax.vatNumber', inputs: { vat: 'tax.vatNumber' },
    normalise: (r) => { const vat = digits(r.vat); return { input: { vat }, masked: mask(vat, 3, 3), error: bhValidators.bhVat.check(vat, {}) ?? undefined }; },
  },
];

/** Test mode: CRs whose number ends in 0 (before the branch) and VAT numbers whose 10th digit is 9 come back "not found". */
export const bhMockChecks: CheckProvider = {
  name: 'mock', live: false,
  async check(kind, input, { legalName }): Promise<CheckResult> {
    const name = legalName.toUpperCase();
    if (kind === 'bh_cr') {
      if (input.cr.split('-')[0].endsWith('0')) return { status: 'NOT_FOUND', message: 'CR not found on Sijilat (test mode)' };
      const due = new Date(); due.setMonth(due.getMonth() + 8);
      return { status: 'VERIFIED', message: 'CR is active (test mode)', nameOnRecord: name, data: { crStatus: 'Active', expiry: due.toISOString().slice(0, 10) } };
    }
    if (kind === 'bh_vat') {
      if (input.vat[9] === '9') return { status: 'NOT_FOUND', message: 'VAT account not found on NBR (test mode)' };
      return { status: 'VERIFIED', message: 'Registered for VAT (test mode)', nameOnRecord: name, data: { vatStatus: 'Registered' } };
    }
    return { status: 'ERROR', message: `No test provider for ${kind}` };
  },
};

/* ---------- Documents the AI can read ---------- */

const ok = (fn: ValidatorDef) => (v: string) => fn.check(v, {}) === null;
const K = {
  legalName: { key: 'legalName', description: 'Commercial name of the business in English, exactly as printed', target: 'basic.vendorName' },
  nameArabic: { key: 'nameArabic', description: 'Commercial name of the business in Arabic, if printed', target: 'basic.nameArabic' },
  cr: { key: 'crNumber', description: 'CR number with branch, e.g. 12345-1', target: 'tax.crNumber', transform: (v: string) => v.replace(/\s+/g, ''), validate: ok(bhValidators.bhCr) },
  vat: { key: 'vatNumber', description: '15-digit VAT account number', target: 'tax.vatNumber', transform: digits, validate: ok(bhValidators.bhVat) },
} satisfies Record<string, ExtractKey>;

export const bhDocuments: Record<string, ReadableDocument> = {
  BH_CR_CERT: { label: 'Bahrain commercial registration (CR) certificate', keys: [K.cr, K.legalName, K.nameArabic] },
  BH_VAT_CERT: { label: 'Bahrain VAT registration certificate (NBR)', keys: [K.vat, K.legalName] },
};

/* ---------- Template ---------- */

export const bahrainTemplate = () => gulfTemplate({
  country: BAHRAIN,
  ibanExample: 'BH67 BMAG 0000 1299 1234 56',
  swiftExample: 'NBOBBHBM',
  mobilePlaceholder: '+973 3xxx xxxx',
  entityTypes: ['With Limited Liability Company (W.L.L.)', 'Single Person Company (S.P.C.)', 'Individual Establishment', 'Bahraini Shareholding Company (B.S.C.)', 'Partnership Company', 'Branch of a Foreign Company', 'Government Entity'],
  companyFields: [
    { key: 'address', label: 'Address — Building / flat and road', type: 'textarea', required: true, placeholder: 'e.g. Building 1234, Road 2810' },
    { key: 'postalCode', label: 'Block', type: 'text', validator: 'postalCode', required: HERE, showIf: HERE, placeholder: 'e.g. 428' },
    { key: 'region', label: 'Area / Governorate', type: 'text', required: true, placeholder: 'e.g. Seef, Capital Governorate' },
    { key: 'district', label: 'City', type: 'text', required: true, placeholder: 'e.g. Manama' },
  ],
  registrationFields: [
    { key: 'yearEstablished', label: 'Year Established', type: 'number', validator: 'year' },
    { key: 'chamberNumber', label: 'Bahrain Chamber (BCCI) membership number', type: 'text', showIf: HERE },
    { key: 'isSme', label: 'Registered as an SME (Tamkeen / MOIC)?', type: 'radio', options: YES_NO, showIf: HERE },
  ],
  taxGroups: [{
    key: 'registrations', label: 'Registrations',
    fields: [
      { key: 'crNumber', label: 'Commercial Registration (CR) number', type: 'text', validator: 'bhCr', required: HERE, showIf: HERE, placeholder: '12345-1' },
      { key: 'vatRegistered', label: 'Registered for VAT?', type: 'radio', options: YES_NO, required: true },
      { key: 'vatNumber', label: 'VAT Account Number', type: 'text', validator: 'vatNumber', required: yes('tax.vatRegistered'), showIf: yes('tax.vatRegistered'), placeholder: '200000445300002' },
    ],
  }],
  localSection: {
    key: 'localContent', label: 'Bahrainisation',
    groups: [{ key: 'workforce', label: 'Workforce', fields: [
      { key: 'employees', label: 'Number of employees', type: 'number' },
      { key: 'bahrainisationPct', label: 'Bahrainisation rate (%)', type: 'number', showIf: HERE },
      { key: 'lmraCompliant', label: 'Compliant with LMRA Bahrainisation requirements?', type: 'radio', options: YES_NO, showIf: HERE },
    ] }],
  },
  documents: [
    { type: 'BH_CR_CERT', label: 'Commercial Registration (CR) certificate', required: HERE, showIf: HERE, hasExpiry: true, holdOnExpiry: true, help: 'CRs are renewed yearly on Sijilat — enter the expiry date shown on the certificate.' },
    { type: 'BH_VAT_CERT', label: 'VAT registration certificate (NBR)', required: yes('tax.vatRegistered'), showIf: yes('tax.vatRegistered') },
    { type: 'SIO_CERT', label: 'Social Insurance Organisation (SIO) certificate', showIf: HERE, hasExpiry: true },
    { type: 'CHAMBER_CERT', label: 'Bahrain Chamber (BCCI) membership certificate', showIf: HERE, hasExpiry: true },
    { type: 'MOA', label: 'Memorandum of Association', showIf: { field: 'basic.entityType', op: 'in', value: ['With Limited Liability Company (W.L.L.)', 'Bahraini Shareholding Company (B.S.C.)'] } },
    { type: 'OWNER_ID', label: 'CPR or passport of the main owner / manager', required: HERE, showIf: HERE },
  ],
  currencies: ['BHD', 'USD', 'SAR', 'AED', 'EUR', 'GBP', 'QAR', 'KWD', 'OMR', 'INR'],
  guide: [
    { title: 'Step 1: Sign in', body: 'Open the link in our email and sign in with the one-time code sent to your registered email.' },
    { title: 'Step 2: Company, bank and tax details', body: 'Use the name and CR number exactly as on Sijilat, the IBAN from your bank letter, and your VAT account number if registered.' },
    { title: 'Step 3: Ownership', body: 'List every owner holding 25% or more.' },
    { title: 'Step 4: Upload documents', body: 'Upload your CR certificate (with its expiry date), VAT certificate, bank letter and ownership declaration. We remind you before your CR expires.' },
    { title: 'Step 5: Submit for review', body: 'Our Tax, Finance and Master Data teams review in turn. If anything is missing we send it back with remarks.' },
  ],
  levels: { taxLabel: 'Tax Review' },
});

/** Starting text for Bahrain's Personal Data Protection Law. Have it reviewed by counsel before go-live. */
export function bahrainNotice(company: string, contactEmail?: string) {
  return `${company} ("we") collects the information in this registration to evaluate you as a supplier, set you up in our purchasing and payment systems, pay you, and meet our legal and tax obligations. This notice is provided under Bahrain's Personal Data Protection Law (Law No. 30 of 2018).

What we collect: company and contact details, commercial registration and VAT details, the names, nationalities and shareholdings of owners, bank account details, financial and risk information, and the documents you upload.

Why: to assess and register you as a supplier and to pay you (performing a contract with you), and to meet our legal obligations, including sanctions and anti-money-laundering checks.

How it is checked and shared: registrations may be verified with government sources and verification service providers, and names are screened against sanctions lists. Uploaded documents may be read automatically to pre-fill the form. Approved supplier records are sent to our ERP / accounting system. Where data is processed outside Bahrain, we do so only as the law permits. We do not sell your data.

How long we keep it: while you are an active supplier and afterwards for as long as tax and commercial record-keeping rules require. Registrations that are rejected or not completed are deleted after a set period.

Your rights: you can ask for access to your data, correct it (request a change in this portal), object to processing, and ask us to delete it where it is no longer needed. Some records of approved suppliers must be kept by law even after a deletion request. You can also complain to the Personal Data Protection Authority.${contactEmail ? `\n\nContact for data protection questions: ${contactEmail}` : ''}`;
}

export const bahrainPack: CountryPack = {
  code: 'BH',
  name: BAHRAIN,
  extends: 'GCC',
  homeCountry: true,
  registerIds: [{ label: 'CR number', field: 'tax.crNumber' }, { label: 'VAT account', field: 'tax.vatNumber' }],
  currency: 'BHD',
  locale: 'en-GB',
  mobile: { dialCode: '973', nationalDigits: 8, pattern: /^[36]\d{7}$/, example: '3xxx xxxx' },
  timeZone: 'Asia/Bahrain',
  timeZoneLabel: 'AST',
  coreFields: ['basic.nameArabic', 'tax.crNumber', 'tax.vatRegistered'],

  validators: bhValidators,
  formats: {
    postalCode: { pattern: /^\d{3,4}$/, message: 'Bahrain block numbers are 3 or 4 digits' },
    vatNumber: { pattern: /^\d{15}$/, message: 'A Bahrain VAT account number is 15 digits' },
  },
  crossChecks: ibanCountryCheck(BAHRAIN, 'BH', 22),

  checks: bhChecks,
  checkProvider: () => bhMockChecks,
  checksTitle: 'CR (Sijilat) / VAT (NBR) checks',
  documents: bhDocuments,

  template: bahrainTemplate,
  privacy: { law: 'Personal Data Protection Law (Law No. 30 of 2018)', lawShort: 'PDPL', defaultNotice: bahrainNotice },
  erp: {
    domesticTaxId: (p: Profile) => s(p.tax?.vatNumber),
    domesticBlock: (p: Profile) => ({
      key: 'BAHRAIN_LOCALIZATION',
      value: { CR_NUMBER: s(p.tax?.crNumber), VAT_ACCOUNT_NO: s(p.tax?.vatNumber), VENDOR_NAME_AR: s(p.basic?.nameArabic), BLOCK: s(p.basic?.postalCode), SME_FLAG: s(p.basic?.isSme) === 'Yes' ? 'Y' : 'N' },
    }),
  },
};
