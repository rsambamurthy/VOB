/**
 * United Arab Emirates pack (extends the Gulf pack).
 *  - Saturday–Sunday weekend (since 2022), Gulf Standard Time, AED, +971 mobiles (05x xxx xxxx).
 *  - Company identity is the trade licence, issued per emirate (DED) or by a free zone authority, renewed
 *    every year — it puts the vendor on hold when it lapses.
 *  - VAT and corporate tax registrations both use a 15-digit TRN from the Federal Tax Authority.
 *  - In-Country Value (ICV) certificates matter for ADNOC and federal buyers; UAE PDPL privacy notice.
 *  - No withholding tax on payments to non-residents, so no foreign-tax block in the ERP record.
 * Online checks run in test mode until an FTA TRN lookup provider is connected.
 */
import type { CheckDef, CheckProvider, CheckResult, CountryPack, ExtractKey, Profile, ReadableDocument, ValidatorDef } from '../types.js';
import { mask } from '../in/checks.js';
import { ibanCountryCheck } from '../gcc/shared.js';
import { gulfTemplate, isCountry, YES_NO, yes, filled } from '../gcc/template.js';

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const digits = (v?: string) => (v ?? '').replace(/\D/g, '');
const UAE = 'United Arab Emirates';
const HERE = isCountry(UAE);
export const EMIRATES = ['Abu Dhabi', 'Dubai', 'Sharjah', 'Ajman', 'Umm Al Quwain', 'Ras Al Khaimah', 'Fujairah'];

export const aeValidators: Record<string, ValidatorDef> = {
  aeTrn: { label: 'UAE TRN (FTA)', check: (v) => (/^1\d{14}$/.test(v.replace(/[\s-]/g, '')) ? null : 'A UAE TRN is 15 digits starting with 1, e.g. 100123456700003') },
  aeLicence: { label: 'UAE trade licence number', upper: true, check: (v) => (/^[A-Z0-9][A-Z0-9/-]{2,24}$/i.test(v.trim()) ? null : 'Enter the licence number as printed (letters, digits, / or -)') },
};

/* ---------- Online checks (test mode) ---------- */

export const aeChecks: CheckDef[] = [
  {
    kind: 'ae_trn', label: 'TRN (Federal Tax Authority)', anchor: 'tax.vatNumber', inputs: { trn: 'tax.vatNumber' },
    normalise: (r) => { const trn = digits(r.trn); return { input: { trn }, masked: mask(trn, 3, 3), error: aeValidators.aeTrn.check(trn, {}) ?? undefined }; },
  },
];

/** Test mode: TRNs whose 11th digit is 9 come back "not found". */
export const aeMockChecks: CheckProvider = {
  name: 'mock', live: false,
  async check(kind, input, { legalName }): Promise<CheckResult> {
    if (kind !== 'ae_trn') return { status: 'ERROR', message: `No test provider for ${kind}` };
    if (input.trn[10] === '9') return { status: 'NOT_FOUND', message: 'TRN not found on the FTA register (test mode)' };
    return { status: 'VERIFIED', message: 'TRN is registered (test mode)', nameOnRecord: legalName.toUpperCase(), data: { register: 'VAT', status: 'Active' } };
  },
};

/* ---------- Documents the AI can read ---------- */

const ok = (fn: ValidatorDef) => (v: string) => fn.check(v, {}) === null;
const K = {
  legalName: { key: 'legalName', description: 'Legal / trade name of the business in English, exactly as printed', target: 'basic.vendorName' },
  nameArabic: { key: 'nameArabic', description: 'Name of the business in Arabic, if printed', target: 'basic.nameArabic' },
  licence: { key: 'licenceNumber', description: 'Trade licence number exactly as printed', target: 'tax.licenceNumber', transform: (v: string) => v.trim().toUpperCase(), validate: ok(aeValidators.aeLicence) },
  authority: { key: 'licenceAuthority', description: 'Issuing authority (e.g. Dubai Economy and Tourism, DMCC, JAFZA)', target: 'tax.licenceAuthority' },
  trn: { key: 'trn', description: '15-digit Tax Registration Number (TRN)', target: 'tax.vatNumber', transform: digits, validate: ok(aeValidators.aeTrn) },
} satisfies Record<string, ExtractKey>;

export const aeDocuments: Record<string, ReadableDocument> = {
  TRADE_LICENCE: { label: 'UAE trade licence', keys: [K.licence, K.authority, K.legalName, K.nameArabic] },
  TRN_CERT: { label: 'UAE VAT / tax registration certificate (FTA)', keys: [K.trn, K.legalName, K.nameArabic] },
};

/* ---------- Template ---------- */

export const uaeTemplate = () => gulfTemplate({
  country: UAE,
  ibanExample: 'AE07 0331 2345 6789 0123 456',
  swiftExample: 'EBILAEAD',
  mobilePlaceholder: '+971 5x xxx xxxx',
  entityTypes: ['Limited Liability Company (LLC)', 'Free Zone Company (FZE / FZCO / FZ-LLC)', 'Sole Establishment', 'Civil Company', 'Private Joint Stock Company', 'Public Joint Stock Company', 'Branch of a Foreign Company', 'Government Entity'],
  companyFields: [
    { key: 'address', label: 'Address — Building, street and area', type: 'textarea', required: true, placeholder: 'e.g. Office 1204, Bay Square 7, Business Bay' },
    { key: 'region', label: 'Emirate / Region', type: 'select', required: true, options: [...EMIRATES, 'Outside the UAE'] },
    { key: 'district', label: 'City', type: 'text', required: true },
    { key: 'postalCode', label: 'P.O. Box', type: 'text', validator: 'postalCode', help: 'The UAE has no postal codes — give your P.O. Box if you have one' },
    { key: 'makaniNumber', label: 'Makani number (Dubai)', type: 'text', showIf: { field: 'basic.region', op: 'eq', value: 'Dubai' } },
  ],
  registrationFields: [
    { key: 'yearEstablished', label: 'Year Established', type: 'number', validator: 'year' },
    { key: 'freeZone', label: 'Licensed in a free zone?', type: 'radio', options: YES_NO, required: HERE, showIf: HERE },
    { key: 'chamberNumber', label: 'Chamber of Commerce membership number', type: 'text', showIf: HERE },
  ],
  taxGroups: [{
    key: 'registrations', label: 'Licence & Tax Registrations',
    fields: [
      { key: 'licenceNumber', label: 'Trade Licence Number', type: 'text', validator: 'aeLicence', required: HERE, showIf: HERE },
      { key: 'licenceAuthority', label: 'Licensing Authority', type: 'text', required: HERE, showIf: HERE, placeholder: 'e.g. Dubai Economy and Tourism, DMCC, JAFZA, ADGM' },
      { key: 'vatRegistered', label: 'Registered for VAT?', type: 'radio', options: YES_NO, required: true },
      { key: 'vatNumber', label: 'VAT Tax Registration Number (TRN)', type: 'text', validator: 'vatNumber', required: yes('tax.vatRegistered'), showIf: yes('tax.vatRegistered'), placeholder: '100123456700003' },
      { key: 'ctTrn', label: 'Corporate Tax Registration Number', type: 'text', validator: 'aeTrn', showIf: HERE, help: 'From the FTA, if registered for corporate tax' },
    ],
  }],
  localSection: {
    key: 'localContent', label: 'Emiratisation & In-Country Value',
    groups: [
      { key: 'workforce', label: 'Workforce', fields: [
        { key: 'employees', label: 'Number of employees', type: 'number' },
        { key: 'emiratisationPct', label: 'Emiratisation rate (%)', type: 'number', showIf: HERE },
      ] },
      { key: 'icv', label: 'In-Country Value (ICV)', fields: [
        { key: 'icvCertified', label: 'Do you hold an ICV certificate?', type: 'radio', options: YES_NO, showIf: HERE },
        { key: 'icvScore', label: 'ICV score (%)', type: 'number', required: yes('localContent.icvCertified'), showIf: yes('localContent.icvCertified') },
        { key: 'icvBody', label: 'Certifying body', type: 'text', showIf: yes('localContent.icvCertified') },
      ] },
    ],
  },
  documents: [
    { type: 'TRADE_LICENCE', label: 'Trade licence', required: HERE, showIf: HERE, hasExpiry: true, holdOnExpiry: true, help: 'Licences are renewed every year — enter the expiry date shown on the licence.' },
    { type: 'TRN_CERT', label: 'VAT registration certificate (FTA)', required: yes('tax.vatRegistered'), showIf: yes('tax.vatRegistered') },
    { type: 'CT_CERT', label: 'Corporate tax registration certificate', showIf: filled('tax.ctTrn') },
    { type: 'MOA', label: 'Memorandum of Association', showIf: { field: 'basic.entityType', op: 'in', value: ['Limited Liability Company (LLC)', 'Private Joint Stock Company', 'Public Joint Stock Company'] } },
    { type: 'CHAMBER_CERT', label: 'Chamber of Commerce membership certificate', showIf: HERE, hasExpiry: true },
    { type: 'ICV_CERT', label: 'ICV certificate', hasExpiry: true, required: yes('localContent.icvCertified'), showIf: yes('localContent.icvCertified') },
    { type: 'OWNER_ID', label: 'Emirates ID or passport of the main owner / manager', required: HERE, showIf: HERE },
  ],
  currencies: ['AED', 'USD', 'SAR', 'EUR', 'GBP', 'BHD', 'QAR', 'KWD', 'OMR', 'INR'],
  guide: [
    { title: 'Step 1: Sign in', body: 'Open the link in our email and sign in with the one-time code sent to your registered email.' },
    { title: 'Step 2: Company, bank and tax details', body: 'Use the legal name exactly as on your trade licence, the IBAN from your bank letter, and your TRN if you are registered for VAT.' },
    { title: 'Step 3: Ownership and ICV', body: 'List every owner holding 25% or more, and give your ICV score if you are certified.' },
    { title: 'Step 4: Upload documents', body: 'Upload your trade licence (with its expiry date), VAT certificate, bank letter and ownership declaration. We remind you before your licence expires.' },
    { title: 'Step 5: Submit for review', body: 'Our Tax, Finance and Master Data teams review in turn. If anything is missing we send it back with remarks.' },
  ],
  levels: { taxLabel: 'Tax Review' },
});

/** Starting text for the UAE Personal Data Protection Law. Have it reviewed by counsel; DIFC and ADGM have their own laws. */
export function uaeNotice(company: string, contactEmail?: string) {
  return `${company} ("we") collects the information in this registration to evaluate you as a supplier, set you up in our purchasing and payment systems, pay you, and meet our legal and tax obligations. This notice is provided under Federal Decree-Law No. 45 of 2021 on the Protection of Personal Data (PDPL).

What we collect: company and contact details, trade licence and tax registrations, the names, nationalities and shareholdings of owners, bank account details, financial and risk information, and the documents you upload.

Why: to assess and register you as a supplier and to pay you (performing a contract with you), and to meet our obligations under UAE law, including sanctions and anti-money-laundering checks.

How it is checked and shared: registrations may be verified with government sources and verification service providers, and names are screened against sanctions lists. Uploaded documents may be read automatically to pre-fill the form. Approved supplier records are sent to our ERP / accounting system. Where a service provider processes data outside the UAE, we make sure the transfer is permitted. We do not sell your data.

How long we keep it: while you are an active supplier and afterwards for as long as tax and commercial record-keeping rules require. Registrations that are rejected or not completed are deleted after a set period.

Your rights: you can ask for access to your data, correct it (request a change in this portal), restrict or object to processing, and ask us to delete it where it is no longer needed. Some records of approved suppliers must be kept by law even after a deletion request.${contactEmail ? `\n\nContact for data protection questions: ${contactEmail}` : ''}`;
}

export const uaePack: CountryPack = {
  code: 'AE',
  name: UAE,
  extends: 'GCC',
  homeCountry: true,
  currency: 'AED',
  locale: 'en-GB',
  weekend: [6, 0],
  mobile: { dialCode: '971', nationalDigits: 9, pattern: /^5\d{8}$/, example: '05x xxx xxxx' },
  timeZone: 'Asia/Dubai',
  timeZoneLabel: 'GST',
  coreFields: ['basic.nameArabic', 'tax.licenceNumber', 'tax.licenceAuthority', 'tax.vatRegistered'],

  validators: aeValidators,
  formats: {
    postalCode: { pattern: /^\d{1,7}$/, message: 'Enter the P.O. Box number (digits only)' },
    vatNumber: { pattern: /^1\d{14}$/, message: 'A UAE TRN is 15 digits starting with 1, e.g. 100123456700003' },
  },
  crossChecks: ibanCountryCheck(UAE, 'AE', 23),

  checks: aeChecks,
  checkProvider: () => aeMockChecks,
  checksTitle: 'TRN (FTA) checks',
  documents: aeDocuments,

  template: uaeTemplate,
  privacy: { law: 'Federal Decree-Law No. 45 of 2021 (PDPL)', lawShort: 'PDPL', defaultNotice: uaeNotice },
  erp: {
    domesticTaxId: (p: Profile) => s(p.tax?.vatNumber),
    domesticBlock: (p: Profile) => ({
      key: 'UAE_LOCALIZATION',
      value: {
        TRADE_LICENCE_NO: s(p.tax?.licenceNumber), LICENSING_AUTHORITY: s(p.tax?.licenceAuthority), EMIRATE: s(p.basic?.region), FREE_ZONE: s(p.basic?.freeZone) === 'Yes' ? 'Y' : 'N',
        TRN: s(p.tax?.vatNumber), CT_TRN: s(p.tax?.ctTrn), VENDOR_NAME_AR: s(p.basic?.nameArabic), ICV_SCORE: s(p.localContent?.icvScore),
      },
    }),
  },
};

