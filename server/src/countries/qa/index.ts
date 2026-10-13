/**
 * Qatar pack (extends the Gulf pack).
 *  - Friday–Saturday weekend, AST, QAR, +974 mobiles (8 digits, 3/5/6/7…).
 *  - No VAT yet (planned; the e-invoicing law was approved in 2026). Companies have a Commercial Registration and a
 *    commercial licence from the Ministry of Commerce and Industry, an establishment card from the Ministry of Interior,
 *    and a 10-digit Tax Identification Number (starting with 5) from the General Tax Authority (Dhareeba).
 *  - CR and commercial licence are renewed yearly and put the vendor on hold when they lapse.
 *  - Withholding tax applies to some payments to non-residents, so the ERP record gets a foreign-tax block.
 *  - Addresses use zone / street / building numbers. Privacy: Law No. 13 of 2016 (PDPPL).
 *  - Local content: Qatarization and QatarEnergy's TAWTEEN programme.
 */
import type { CheckDef, CountryPack, ExtractKey, Profile, ReadableDocument, ValidatorDef } from '../types.js';
import { gulfNotice, ibanCountryCheck, registryMock } from '../gcc/shared.js';
import { gulfTemplate, isCountry, notCountry, YES_NO, yes } from '../gcc/template.js';

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const QATAR = 'Qatar';
const HERE = isCountry(QATAR);

export const qaValidators: Record<string, ValidatorDef> = {
  qaTin: { label: 'Qatar TIN (GTA)', check: (v) => (/^5\d{9}$/.test(v.replace(/[\s-]/g, '')) ? null : 'A Qatar TIN is 10 digits starting with 5') },
  qaCr: { label: 'Qatar CR number', check: (v) => (/^\d{1,7}(\/\d{1,3})?$/.test(v.replace(/\s+/g, '')) ? null : 'Enter the CR number as printed, e.g. 123456 or 123456/1') },
};

export const qaChecks: CheckDef[] = [
  { kind: 'qa_cr', label: 'Commercial Registration (MOCI)', anchor: 'tax.crNumber', inputs: { cr: 'tax.crNumber' },
    normalise: (r) => { const cr = (r.cr ?? '').replace(/\s+/g, ''); return { input: { cr }, masked: cr, error: qaValidators.qaCr.check(cr, {}) ?? undefined }; } },
  { kind: 'qa_tin', label: 'Tax registration (GTA)', anchor: 'tax.tinNumber', inputs: { tin: 'tax.tinNumber' },
    normalise: (r) => { const tin = (r.tin ?? '').replace(/\D/g, ''); return { input: { tin }, masked: `${tin.slice(0, 3)}••••${tin.slice(-2)}`, error: qaValidators.qaTin.check(tin, {}) ?? undefined }; } },
];

const ok = (fn: ValidatorDef) => (v: string) => fn.check(v, {}) === null;
const K = {
  legalName: { key: 'legalName', description: 'Trade name of the business in English, exactly as printed', target: 'basic.vendorName' },
  nameArabic: { key: 'nameArabic', description: 'Trade name in Arabic, if printed', target: 'basic.nameArabic' },
  cr: { key: 'crNumber', description: 'Commercial registration number', target: 'tax.crNumber', transform: (v: string) => v.replace(/\s+/g, ''), validate: ok(qaValidators.qaCr) },
  tin: { key: 'tin', description: '10-digit Tax Identification Number', target: 'tax.tinNumber', transform: (v: string) => v.replace(/\D/g, ''), validate: ok(qaValidators.qaTin) },
} satisfies Record<string, ExtractKey>;
export const qaDocuments: Record<string, ReadableDocument> = {
  QA_CR_CERT: { label: 'Qatar commercial registration (CR) certificate', keys: [K.cr, K.legalName, K.nameArabic] },
  QA_TAX_CARD: { label: 'Qatar tax card (GTA)', keys: [K.tin, K.legalName] },
};

export const qatarTemplate = () => gulfTemplate({
  country: QATAR,
  ibanExample: 'QA58 DOHB 0000 1234 5678 90AB CDEF G',
  swiftExample: 'QNBAQAQA',
  mobilePlaceholder: '+974 5xxx xxxx',
  entityTypes: ['Limited Liability Company (W.L.L.)', 'Single Person Company (S.P.C.)', 'Individual Establishment', 'Qatari Shareholding Company (Q.S.C. / Q.P.S.C.)', 'QFC Company', 'Free Zone Company (QFZ)', 'Branch of a Foreign Company', 'Government Entity'],
  companyFields: [
    { key: 'address', label: 'Address — Building and street number', type: 'textarea', required: true, placeholder: 'e.g. Building 22, Street 840' },
    { key: 'postalCode', label: 'Zone', type: 'text', validator: 'postalCode', required: HERE, showIf: HERE, placeholder: 'e.g. 63' },
    { key: 'region', label: 'Area / Municipality', type: 'text', required: true, placeholder: 'e.g. West Bay, Doha' },
    { key: 'district', label: 'City', type: 'text', required: true, placeholder: 'e.g. Doha' },
    { key: 'poBox', label: 'P.O. Box', type: 'text' },
  ],
  registrationFields: [
    { key: 'yearEstablished', label: 'Year Established', type: 'number', validator: 'year' },
    { key: 'chamberNumber', label: 'Qatar Chamber membership number', type: 'text', showIf: HERE },
  ],
  taxGroups: [{
    key: 'registrations', label: 'Registrations',
    fields: [
      { key: 'crNumber', label: 'Commercial Registration (CR) number', type: 'text', validator: 'qaCr', required: HERE, showIf: HERE },
      { key: 'licenceNumber', label: 'Commercial licence number', type: 'text', required: HERE, showIf: HERE },
      { key: 'establishmentId', label: 'Establishment card (computer card) number', type: 'text', required: HERE, showIf: HERE },
      { key: 'tinNumber', label: 'Tax Identification Number (GTA)', type: 'text', validator: 'qaTin', required: HERE, showIf: HERE, placeholder: '5xxxxxxxxx' },
      { key: 'vatNumber', label: 'VAT number in your country (if any)', type: 'text', validator: 'vatNumber', showIf: notCountry(QATAR), help: 'Qatar does not have VAT yet' },
    ],
  }],
  localSection: {
    key: 'localContent', label: 'Qatarization & Local Content',
    groups: [{ key: 'workforce', label: 'Workforce & Local Content', fields: [
      { key: 'employees', label: 'Number of employees', type: 'number' },
      { key: 'qatarizationPct', label: 'Qatarization rate (%)', type: 'number', showIf: HERE },
      { key: 'tawteenRegistered', label: 'Registered in QatarEnergy’s TAWTEEN programme?', type: 'radio', options: YES_NO, showIf: HERE },
    ] }],
  },
  documents: [
    { type: 'QA_CR_CERT', label: 'Commercial Registration (CR) certificate', required: HERE, showIf: HERE, hasExpiry: true, holdOnExpiry: true },
    { type: 'QA_LICENCE', label: 'Commercial licence', required: HERE, showIf: HERE, hasExpiry: true, holdOnExpiry: true },
    { type: 'QA_EST_CARD', label: 'Establishment card (computer card)', required: HERE, showIf: HERE, hasExpiry: true },
    { type: 'QA_TAX_CARD', label: 'Tax card (GTA)', required: HERE, showIf: HERE },
    { type: 'CHAMBER_CERT', label: 'Qatar Chamber membership certificate', showIf: HERE, hasExpiry: true },
    { type: 'TAWTEEN_CERT', label: 'TAWTEEN registration', showIf: yes('localContent.tawteenRegistered') },
    { type: 'OWNER_ID', label: 'QID or passport of the main owner / manager', required: HERE, showIf: HERE },
  ],
  currencies: ['QAR', 'USD', 'SAR', 'AED', 'EUR', 'GBP', 'BHD', 'KWD', 'OMR', 'INR'],
  guide: [
    { title: 'Step 1: Sign in', body: 'Open the link in our email and sign in with the one-time code sent to your registered email.' },
    { title: 'Step 2: Company, bank and tax details', body: 'Use the name and numbers exactly as on your CR, commercial licence, establishment card and tax card, and the IBAN from your bank letter.' },
    { title: 'Step 3: Ownership', body: 'List every owner holding 25% or more.' },
    { title: 'Step 4: Upload documents', body: 'Upload your CR, commercial licence and establishment card with their expiry dates, your tax card, a bank letter and the ownership declaration. We remind you before they expire.' },
    { title: 'Step 5: Submit for review', body: 'Our Tax, Finance and Master Data teams review in turn. If anything is missing we send it back with remarks.' },
  ],
  levels: { taxLabel: 'Tax Review' },
});

export const qatarPack: CountryPack = {
  code: 'QA',
  name: QATAR,
  extends: 'GCC',
  homeCountry: true,
  currency: 'QAR',
  locale: 'en-GB',
  mobile: { dialCode: '974', nationalDigits: 8, pattern: /^[3567]\d{7}$/, example: '5xxx xxxx' },
  timeZone: 'Asia/Qatar',
  timeZoneLabel: 'AST',
  coreFields: ['basic.nameArabic', 'tax.crNumber', 'tax.licenceNumber', 'tax.establishmentId', 'tax.tinNumber', 'tax.hasTrc'],
  validators: qaValidators,
  formats: { postalCode: { pattern: /^\d{1,3}$/, message: 'Qatar zone numbers are 1 to 3 digits' } },
  crossChecks: ibanCountryCheck(QATAR, 'QA', 29),
  checks: qaChecks,
  checkProvider: () => registryMock({ qa_cr: { source: 'the MOCI register', field: 'cr' }, qa_tin: { source: 'Dhareeba (GTA)', field: 'tin' } }),
  checksTitle: 'CR (MOCI) / TIN (GTA) checks',
  documents: qaDocuments,
  template: qatarTemplate,
  privacy: {
    law: 'Law No. 13 of 2016 on Personal Data Privacy Protection (PDPPL)', lawShort: 'PDPPL',
    defaultNotice: gulfNotice({
      lawSentence: 'This notice is provided under Qatar’s Law No. 13 of 2016 on Personal Data Privacy Protection (PDPPL).',
      abroad: 'Where data is processed outside Qatar, we do so only as the law permits.',
      complaint: 'You can also complain to the competent authority under the PDPPL.',
    }),
  },
  erp: {
    domesticTaxId: (p: Profile) => s(p.tax?.tinNumber),
    domesticBlock: (p: Profile) => ({ key: 'QATAR_LOCALIZATION', value: { CR_NUMBER: s(p.tax?.crNumber), COMMERCIAL_LICENCE_NO: s(p.tax?.licenceNumber), ESTABLISHMENT_ID: s(p.tax?.establishmentId), TIN: s(p.tax?.tinNumber), VENDOR_NAME_AR: s(p.basic?.nameArabic), ZONE: s(p.basic?.postalCode) } }),
    // Payments to non-residents for services and royalties can attract Qatari withholding tax.
    foreignBlock: (p: Profile) => ({ key: 'FOREIGN_TAX', value: { TIN: s(p.tax?.foreignTin), TRC_HELD: s(p.tax?.hasTrc) } }),
  },
};
