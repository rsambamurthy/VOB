/**
 * Oman pack (extends the Gulf pack).
 *  - Friday–Saturday weekend, Gulf Standard Time, OMR (3 decimals), +968 mobiles (8 digits, 7/9…).
 *  - VAT (5%) since 2021: VAT numbers are OM followed by 10 characters (e.g. OM1100012379).
 *  - Commercial Registration from the Ministry of Commerce, Industry and Investment Promotion (Invest Easy) and
 *    Oman Chamber (OCCI) membership; the CR has an expiry and puts the vendor on hold when it lapses.
 *  - Privacy: Personal Data Protection Law (Royal Decree 6/2022). Withholding tax applies to some payments
 *    to non-residents. Local content: Omanisation and the In-Country Value (ICV) programme.
 */
import type { CheckDef, CountryPack, ExtractKey, Profile, ReadableDocument, ValidatorDef } from '../types.js';
import { gulfNotice, ibanCountryCheck, registryMock } from '../gcc/shared.js';
import { gulfTemplate, isCountry, YES_NO, yes } from '../gcc/template.js';

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const OMAN = 'Oman';
const HERE = isCountry(OMAN);

export const omValidators: Record<string, ValidatorDef> = {
  omCr: { label: 'Oman CR number', check: (v) => (/^\d{6,8}$/.test(v.replace(/\s+/g, '')) ? null : 'The Oman CR number is 6 to 8 digits, e.g. 1234567') },
};
const OM_VAT = /^OM\d{9}[\dX]$/i;

export const omChecks: CheckDef[] = [
  { kind: 'om_cr', label: 'Commercial Registration (Invest Easy)', anchor: 'tax.crNumber', inputs: { cr: 'tax.crNumber' },
    normalise: (r) => { const cr = (r.cr ?? '').replace(/\s+/g, ''); return { input: { cr }, masked: cr, error: omValidators.omCr.check(cr, {}) ?? undefined }; } },
  { kind: 'om_vat', label: 'VAT registration (Tax Authority)', anchor: 'tax.vatNumber', inputs: { vat: 'tax.vatNumber' },
    normalise: (r) => { const vat = (r.vat ?? '').replace(/\s+/g, '').toUpperCase(); return { input: { vat }, masked: `${vat.slice(0, 4)}•••${vat.slice(-2)}`, error: OM_VAT.test(vat) ? undefined : 'An Oman VAT number is OM followed by 10 characters, e.g. OM1100012379' }; } },
];

const K = {
  legalName: { key: 'legalName', description: 'Name of the business in English, exactly as printed', target: 'basic.vendorName' },
  nameArabic: { key: 'nameArabic', description: 'Name in Arabic, if printed', target: 'basic.nameArabic' },
  cr: { key: 'crNumber', description: 'Commercial registration number', target: 'tax.crNumber', transform: (v: string) => v.replace(/\D/g, ''), validate: (v: string) => omValidators.omCr.check(v, {}) === null },
  vat: { key: 'vatNumber', description: 'VAT number starting with OM', target: 'tax.vatNumber', transform: (v: string) => v.replace(/\s+/g, '').toUpperCase(), validate: (v: string) => OM_VAT.test(v) },
} satisfies Record<string, ExtractKey>;
export const omDocuments: Record<string, ReadableDocument> = {
  OM_CR_CERT: { label: 'Oman commercial registration (CR) certificate', keys: [K.cr, K.legalName, K.nameArabic] },
  OM_VAT_CERT: { label: 'Oman VAT registration certificate', keys: [K.vat, K.legalName] },
};

export const omanTemplate = () => gulfTemplate({
  country: OMAN,
  ibanExample: 'OM26 0180 0000 0012 9912 345',
  swiftExample: 'BMUSOMRX',
  mobilePlaceholder: '+968 9xxx xxxx',
  entityTypes: ['Limited Liability Company (LLC)', 'Sole Proprietorship', 'One Person Company (OPC)', 'Closed Joint Stock Company (SAOC)', 'Public Joint Stock Company (SAOG)', 'Branch of a Foreign Company', 'Government Entity'],
  companyFields: [
    { key: 'address', label: 'Address — Building, way and area', type: 'textarea', required: true, placeholder: 'e.g. Building 1234, Way 3017, Al Khuwair' },
    { key: 'region', label: 'Governorate', type: 'text', required: true, placeholder: 'e.g. Muscat' },
    { key: 'district', label: 'City / Wilayat', type: 'text', required: true, placeholder: 'e.g. Bawshar' },
    { key: 'postalCode', label: 'Postal Code', type: 'text', validator: 'postalCode', placeholder: 'e.g. 133' },
    { key: 'poBox', label: 'P.O. Box', type: 'text' },
  ],
  registrationFields: [
    { key: 'yearEstablished', label: 'Year Established', type: 'number', validator: 'year' },
    { key: 'chamberNumber', label: 'Oman Chamber (OCCI) membership number', type: 'text', showIf: HERE },
    { key: 'isSme', label: 'Registered as an SME (Riyada card)?', type: 'radio', options: YES_NO, showIf: HERE },
  ],
  taxGroups: [{
    key: 'registrations', label: 'Registrations',
    fields: [
      { key: 'crNumber', label: 'Commercial Registration (CR) number', type: 'text', validator: 'omCr', required: HERE, showIf: HERE },
      { key: 'vatRegistered', label: 'Registered for VAT?', type: 'radio', options: YES_NO, required: true },
      { key: 'vatNumber', label: 'VAT Registration Number', type: 'text', validator: 'vatNumber', required: yes('tax.vatRegistered'), showIf: yes('tax.vatRegistered'), placeholder: 'OM1100012379' },
      { key: 'taxCardNumber', label: 'Tax card number (Tax Authority)', type: 'text', showIf: HERE },
    ],
  }],
  localSection: {
    key: 'localContent', label: 'Omanisation & In-Country Value',
    groups: [
      { key: 'workforce', label: 'Workforce', fields: [
        { key: 'employees', label: 'Number of employees', type: 'number' },
        { key: 'omanisationPct', label: 'Omanisation rate (%)', type: 'number', showIf: HERE },
      ] },
      { key: 'icv', label: 'In-Country Value (ICV)', fields: [
        { key: 'icvCertified', label: 'Do you hold an ICV certificate (e.g. for oil & gas buyers)?', type: 'radio', options: YES_NO, showIf: HERE },
        { key: 'icvScore', label: 'ICV score (%)', type: 'number', required: yes('localContent.icvCertified'), showIf: yes('localContent.icvCertified') },
      ] },
    ],
  },
  documents: [
    { type: 'OM_CR_CERT', label: 'Commercial Registration (CR) certificate', required: HERE, showIf: HERE, hasExpiry: true, holdOnExpiry: true },
    { type: 'OM_VAT_CERT', label: 'VAT registration certificate', required: yes('tax.vatRegistered'), showIf: yes('tax.vatRegistered') },
    { type: 'CHAMBER_CERT', label: 'Oman Chamber (OCCI) membership certificate', required: HERE, showIf: HERE, hasExpiry: true },
    { type: 'OMANISATION_CERT', label: 'Omanisation certificate (Ministry of Labour)', showIf: HERE, hasExpiry: true },
    { type: 'ICV_CERT', label: 'ICV certificate', hasExpiry: true, required: yes('localContent.icvCertified'), showIf: yes('localContent.icvCertified') },
    { type: 'OWNER_ID', label: 'Resident card or passport of the main owner / manager', required: HERE, showIf: HERE },
  ],
  currencies: ['OMR', 'USD', 'SAR', 'AED', 'EUR', 'GBP', 'BHD', 'QAR', 'KWD', 'INR'],
  guide: [
    { title: 'Step 1: Sign in', body: 'Open the link in our email and sign in with the one-time code sent to your registered email.' },
    { title: 'Step 2: Company, bank and tax details', body: 'Use the name and CR number exactly as on your CR certificate, the IBAN from your bank letter, and your VAT number (OM…) if registered.' },
    { title: 'Step 3: Ownership and ICV', body: 'List every owner holding 25% or more, and give your ICV score if you are certified.' },
    { title: 'Step 4: Upload documents', body: 'Upload your CR (with its expiry date), Chamber certificate, VAT certificate, a bank letter and the ownership declaration.' },
    { title: 'Step 5: Submit for review', body: 'Our Tax, Finance and Master Data teams review in turn. If anything is missing we send it back with remarks.' },
  ],
  levels: { taxLabel: 'Tax Review' },
});

export const omanPack: CountryPack = {
  code: 'OM',
  name: OMAN,
  extends: 'GCC',
  homeCountry: true,
  currency: 'OMR',
  locale: 'en-GB',
  mobile: { dialCode: '968', nationalDigits: 8, pattern: /^[79]\d{7}$/, example: '9xxx xxxx' },
  timeZone: 'Asia/Muscat',
  timeZoneLabel: 'GST',
  coreFields: ['basic.nameArabic', 'tax.crNumber', 'tax.vatRegistered', 'tax.hasTrc'],
  validators: omValidators,
  formats: {
    postalCode: { pattern: /^\d{3}$/, message: 'Oman postal codes are 3 digits' },
    vatNumber: { pattern: OM_VAT, message: 'An Oman VAT number is OM followed by 10 characters, e.g. OM1100012379' },
  },
  crossChecks: ibanCountryCheck(OMAN, 'OM', 23),
  checks: omChecks,
  checkProvider: () => registryMock({ om_cr: { source: 'Invest Easy (MOCIIP)', field: 'cr' }, om_vat: { source: 'the Tax Authority VAT register', field: 'vat' } }),
  checksTitle: 'CR (Invest Easy) / VAT checks',
  documents: omDocuments,
  template: omanTemplate,
  privacy: {
    law: 'Personal Data Protection Law (Royal Decree 6/2022)', lawShort: 'PDPL',
    defaultNotice: gulfNotice({
      lawSentence: 'This notice is provided under Oman’s Personal Data Protection Law (Royal Decree 6/2022).',
      abroad: 'Where data is processed outside Oman, we do so only as the law permits.',
      complaint: 'You can also complain to the Ministry of Transport, Communications and Information Technology.',
    }),
  },
  erp: {
    domesticTaxId: (p: Profile) => s(p.tax?.vatNumber),
    domesticBlock: (p: Profile) => ({ key: 'OMAN_LOCALIZATION', value: { CR_NUMBER: s(p.tax?.crNumber), VAT_NUMBER: s(p.tax?.vatNumber), TAX_CARD_NO: s(p.tax?.taxCardNumber), VENDOR_NAME_AR: s(p.basic?.nameArabic), ICV_SCORE: s(p.localContent?.icvScore), SME_FLAG: s(p.basic?.isSme) === 'Yes' ? 'Y' : 'N' } }),
    // Payments to non-residents for services, royalties and similar can attract Omani withholding tax.
    foreignBlock: (p: Profile) => ({ key: 'FOREIGN_TAX', value: { TIN: s(p.tax?.foreignTin), TRC_HELD: s(p.tax?.hasTrc) } }),
  },
};
