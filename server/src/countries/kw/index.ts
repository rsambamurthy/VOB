/**
 * Kuwait pack (extends the Gulf pack).
 *  - Friday–Saturday weekend, AST, KWD (3 decimals), +965 mobiles (8 digits, 5/6/9…).
 *  - No VAT. Companies hold a Commercial Registration and a commercial licence from the Ministry of Commerce and
 *    Industry, and Kuwait Chamber (KCCI) membership. The licence is renewed and puts the vendor on hold when it lapses.
 *  - Addresses use area / block / street; postal codes are 5 digits. Each building has a PACI number.
 *  - Privacy: Kuwait has no general data protection law yet; CITRA Resolution No. 26 of 2024 applies to
 *    communications and IT providers. The notice is written as good practice.
 *  - Local content: Kuwaitization (national labour) quotas.
 */
import type { CheckDef, CountryPack, ExtractKey, Profile, ReadableDocument, ValidatorDef } from '../types.js';
import { gulfNotice, ibanCountryCheck, registryMock } from '../gcc/shared.js';
import { gulfTemplate, isCountry, notCountry, YES_NO } from '../gcc/template.js';

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const KUWAIT = 'Kuwait';
const HERE = isCountry(KUWAIT);

export const kwValidators: Record<string, ValidatorDef> = {
  kwCr: { label: 'Kuwait CR number', check: (v) => (/^\d{3,8}$/.test(v.replace(/\s+/g, '')) ? null : 'Enter the commercial registration number (digits), e.g. 123456') },
};

export const kwChecks: CheckDef[] = [
  { kind: 'kw_cr', label: 'Commercial Registration (MOCI)', anchor: 'tax.crNumber', inputs: { cr: 'tax.crNumber' },
    normalise: (r) => { const cr = (r.cr ?? '').replace(/\s+/g, ''); return { input: { cr }, masked: cr, error: kwValidators.kwCr.check(cr, {}) ?? undefined }; } },
];

const K = {
  legalName: { key: 'legalName', description: 'Trade name of the business in English, exactly as printed', target: 'basic.vendorName' },
  nameArabic: { key: 'nameArabic', description: 'Trade name in Arabic, if printed', target: 'basic.nameArabic' },
  cr: { key: 'crNumber', description: 'Commercial registration number', target: 'tax.crNumber', transform: (v: string) => v.replace(/\D/g, ''), validate: (v: string) => kwValidators.kwCr.check(v, {}) === null },
  licence: { key: 'licenceNumber', description: 'Commercial licence number', target: 'tax.licenceNumber', transform: (v: string) => v.trim() },
} satisfies Record<string, ExtractKey>;
export const kwDocuments: Record<string, ReadableDocument> = {
  KW_LICENCE: { label: 'Kuwait commercial licence', keys: [K.licence, K.cr, K.legalName, K.nameArabic] },
};

export const kuwaitTemplate = () => gulfTemplate({
  country: KUWAIT,
  ibanExample: 'KW81 CBKU 0000 0000 0000 1234 5601 01',
  swiftExample: 'NBOKKWKW',
  mobilePlaceholder: '+965 5xxx xxxx',
  entityTypes: ['With Limited Liability Company (W.L.L.)', 'Single Person Company', 'Individual Establishment', 'Kuwaiti Shareholding Company (K.S.C.)', 'Partnership Company', 'Branch of a Foreign Company', 'Government Entity'],
  companyFields: [
    { key: 'address', label: 'Address — Block, street and building', type: 'textarea', required: true, placeholder: 'e.g. Block 3, Street 25, Building 12' },
    { key: 'region', label: 'Area / Governorate', type: 'text', required: true, placeholder: 'e.g. Sharq, Capital Governorate' },
    { key: 'district', label: 'City', type: 'text', required: true, placeholder: 'e.g. Kuwait City' },
    { key: 'postalCode', label: 'Postal Code', type: 'text', validator: 'postalCode' },
    { key: 'paciNumber', label: 'PACI address number', type: 'text', showIf: HERE, help: 'The number on the building’s PACI plate' },
  ],
  registrationFields: [
    { key: 'yearEstablished', label: 'Year Established', type: 'number', validator: 'year' },
    { key: 'chamberNumber', label: 'Kuwait Chamber (KCCI) membership number', type: 'text', showIf: HERE },
  ],
  taxGroups: [{
    key: 'registrations', label: 'Registrations',
    fields: [
      { key: 'crNumber', label: 'Commercial Registration (CR) number', type: 'text', validator: 'kwCr', required: HERE, showIf: HERE },
      { key: 'licenceNumber', label: 'Commercial licence number', type: 'text', required: HERE, showIf: HERE },
      { key: 'signatoryName', label: 'Authorised signatory (as on the signatory certificate)', type: 'text', required: HERE, showIf: HERE },
      { key: 'vatNumber', label: 'VAT number in your country (if any)', type: 'text', validator: 'vatNumber', showIf: notCountry(KUWAIT), help: 'Kuwait does not have VAT' },
    ],
  }],
  localSection: {
    key: 'localContent', label: 'Kuwaitization',
    groups: [{ key: 'workforce', label: 'Workforce', fields: [
      { key: 'employees', label: 'Number of employees', type: 'number' },
      { key: 'kuwaitizationPct', label: 'Kuwaitization rate (%)', type: 'number', showIf: HERE },
      { key: 'kuwaitiProducts', label: 'Do you supply Kuwaiti-made products (local product preference)?', type: 'radio', options: YES_NO, showIf: HERE },
    ] }],
  },
  documents: [
    { type: 'KW_LICENCE', label: 'Commercial licence', required: HERE, showIf: HERE, hasExpiry: true, holdOnExpiry: true },
    { type: 'KW_CR_CERT', label: 'Commercial Registration certificate (extract)', required: HERE, showIf: HERE },
    { type: 'SIGNATORY_CERT', label: 'Authorised signatory certificate', required: HERE, showIf: HERE, hasExpiry: true },
    { type: 'CHAMBER_CERT', label: 'Kuwait Chamber (KCCI) membership certificate', required: HERE, showIf: HERE, hasExpiry: true },
    { type: 'MOA', label: 'Memorandum / Articles of Association', showIf: { field: 'basic.entityType', op: 'in', value: ['With Limited Liability Company (W.L.L.)', 'Kuwaiti Shareholding Company (K.S.C.)'] } },
    { type: 'OWNER_ID', label: 'Civil ID or passport of the main owner / signatory', required: HERE, showIf: HERE },
  ],
  currencies: ['KWD', 'USD', 'SAR', 'AED', 'EUR', 'GBP', 'BHD', 'QAR', 'OMR', 'INR'],
  guide: [
    { title: 'Step 1: Sign in', body: 'Open the link in our email and sign in with the one-time code sent to your registered email.' },
    { title: 'Step 2: Company, bank and registration details', body: 'Use the name and numbers exactly as on your commercial licence and CR, and the IBAN from your bank letter.' },
    { title: 'Step 3: Ownership', body: 'List every owner holding 25% or more.' },
    { title: 'Step 4: Upload documents', body: 'Upload your commercial licence (with its expiry date), CR extract, signatory and Chamber certificates, a bank letter and the ownership declaration.' },
    { title: 'Step 5: Submit for review', body: 'Our Tax, Finance and Master Data teams review in turn. If anything is missing we send it back with remarks.' },
  ],
  levels: { taxLabel: 'Compliance Review' },
  taxSectionLabel: 'Registrations',
});

export const kuwaitPack: CountryPack = {
  code: 'KW',
  name: KUWAIT,
  extends: 'GCC',
  homeCountry: true,
  currency: 'KWD',
  locale: 'en-GB',
  mobile: { dialCode: '965', nationalDigits: 8, pattern: /^[569]\d{7}$/, example: '5xxx xxxx' },
  timeZone: 'Asia/Kuwait',
  timeZoneLabel: 'AST',
  coreFields: ['basic.nameArabic', 'tax.crNumber', 'tax.licenceNumber'],
  validators: kwValidators,
  formats: { postalCode: { pattern: /^\d{5}$/, message: 'Kuwait postal codes are 5 digits' } },
  crossChecks: ibanCountryCheck(KUWAIT, 'KW', 30),
  checks: kwChecks,
  checkProvider: () => registryMock({ kw_cr: { source: 'the MOCI register', field: 'cr' } }),
  checksTitle: 'CR (MOCI) checks',
  documents: kwDocuments,
  template: kuwaitTemplate,
  privacy: {
    law: 'Kuwaiti law (CITRA Resolution No. 26 of 2024 where it applies)', lawShort: '',
    defaultNotice: gulfNotice({
      lawSentence: 'We handle it in line with Kuwaiti law and good data-protection practice.',
      abroad: 'Where data is processed outside Kuwait, we protect it to the same standard.',
    }),
  },
  erp: {
    domesticTaxId: () => '',
    domesticBlock: (p: Profile) => ({ key: 'KUWAIT_LOCALIZATION', value: { CR_NUMBER: s(p.tax?.crNumber), COMMERCIAL_LICENCE_NO: s(p.tax?.licenceNumber), PACI_NO: s(p.basic?.paciNumber), VENDOR_NAME_AR: s(p.basic?.nameArabic), SIGNATORY: s(p.tax?.signatoryName) } }),
  },
};
