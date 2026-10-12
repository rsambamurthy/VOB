/**
 * Saudi Arabia pack — DEFAULT TEMPLATE for a new workspace whose home country is Saudi Arabia.
 * Each workspace gets a copy and edits it in Admin → Configuration.
 *
 * Notes on Saudi specifics:
 *  - Under the Commercial Register Law in force since April 2025, a CR no longer expires but must be
 *    confirmed every year; the CR certificate's "expiry" here is that annual confirmation date.
 *  - Zakat, GOSI and Saudization (Nitaqat) certificates lapse and are needed to keep getting paid,
 *    so they put the vendor on hold automatically when they lapse.
 */
import type { Condition, DocumentRequirement, OnboardingConfig, SectionDef } from '../../config/types.js';

const COUNTRIES = ['Saudi Arabia', 'United Arab Emirates', 'Bahrain', 'Qatar', 'Kuwait', 'Oman', 'India', 'United States', 'United Kingdom', 'Germany', 'China', 'Japan', 'Singapore', 'Other'];
const SA: Condition = { field: 'basic.supplierCountry', op: 'eq', value: 'Saudi Arabia' };
const NOT_SA: Condition = { field: 'basic.supplierCountry', op: 'neq', value: 'Saudi Arabia' };
const BANK_SA: Condition = { field: 'bank.bankCountry', op: 'eq', value: 'Saudi Arabia' };
const BANK_NOT_SA: Condition = { field: 'bank.bankCountry', op: 'neq', value: 'Saudi Arabia' };
const YES_NO = ['Yes', 'No'];
const yes = (field: string): Condition => ({ field, op: 'eq', value: 'Yes' });
const filled = (field: string): Condition => ({ field, op: 'notEmpty' });

const sections: SectionDef[] = [
  {
    key: 'basic', label: 'Company',
    groups: [
      {
        key: 'vendorInfo', label: 'Company Information',
        fields: [
          { key: 'vendorName', label: 'Legal Name (English)', type: 'text', required: true },
          { key: 'nameArabic', label: 'Legal Name (Arabic)', type: 'text', required: SA, dir: 'rtl', help: 'Exactly as on the commercial registration' },
          { key: 'tradingName', label: 'Trade Name', type: 'text' },
          {
            key: 'entityType', label: 'Type of Entity', type: 'select', required: true,
            options: ['Limited Liability Company (LLC)', 'Joint Stock Company', 'Simplified Joint Stock Company', 'Sole Proprietorship (Establishment)', 'General / Limited Partnership', 'Branch of a Foreign Company', 'Professional Company', 'Government Entity'],
          },
          { key: 'supplierCountry', label: 'Country', type: 'select', required: true, options: COUNTRIES },
          { key: 'address', label: 'National Address — Building number and street', type: 'textarea', required: true, placeholder: 'e.g. 8228 King Fahd Road' },
          { key: 'region', label: 'Region / Province', type: 'text', required: true, placeholder: 'e.g. Riyadh Region' },
          { key: 'district', label: 'City', type: 'text', required: true },
          { key: 'postalCode', label: 'Postal Code', type: 'text', required: SA, validator: 'postalCode' },
          { key: 'additionalNumber', label: 'Additional Number (National Address)', type: 'text', showIf: SA },
          { key: 'websiteUrl', label: 'Website', type: 'url', validator: 'url' },
        ],
      },
      {
        key: 'registration', label: 'Registration',
        fields: [
          { key: 'yearEstablished', label: 'Year Established', type: 'number', validator: 'year' },
          { key: 'chamberNumber', label: 'Chamber of Commerce Membership Number', type: 'text', showIf: SA },
          { key: 'isSme', label: 'Registered as an SME with Monsha’at?', type: 'radio', options: YES_NO, showIf: SA },
        ],
      },
      {
        key: 'communication', label: 'Contacts',
        fields: [
          { key: 'contactName', label: 'Primary Contact Name', type: 'text', required: true },
          { key: 'contactEmail', label: 'Primary Contact Email', type: 'email', required: true, validator: 'email' },
          { key: 'contactMobile', label: 'Primary Contact Mobile', type: 'tel', required: true, validator: 'phone', placeholder: '+966 5x xxx xxxx' },
          { key: 'accountsEmail', label: 'Accounts / Remittance Email', type: 'email', validator: 'email', help: 'Payment advices will be sent here' },
        ],
      },
      {
        key: 'procurement', label: 'Procurement',
        fields: [
          { key: 'supplyCategory', label: 'Category of Supply', type: 'select', required: true, options: ['Goods', 'Services', 'Goods & Services', 'Contracting / Construction'] },
          { key: 'itemsSupplied', label: 'Products / Services Supplied', type: 'textarea' },
          { key: 'paymentTerms', label: 'Requested Payment Terms', type: 'select', options: ['Advance', 'Net 15', 'Net 30', 'Net 45', 'Net 60', 'Net 90'] },
        ],
      },
    ],
  },
  {
    key: 'bank', label: 'Bank Details',
    groups: [
      {
        key: 'account', label: 'Bank Account',
        fields: [
          { key: 'bankCountry', label: 'Bank Country', type: 'select', required: true, options: COUNTRIES },
          { key: 'bankName', label: 'Bank Name', type: 'text', required: true },
          { key: 'accountHolderName', label: 'Account Holder (Beneficiary) Name', type: 'text', required: true, help: 'Must match the legal name' },
          { key: 'iban', label: 'IBAN', type: 'text', validator: 'iban', required: true, placeholder: 'SA03 8000 0000 6080 1016 7519', help: 'Saudi IBANs start with SA and have 24 characters' },
          { key: 'swift', label: 'SWIFT / BIC Code', type: 'text', validator: 'swift', required: BANK_NOT_SA, placeholder: 'RJHISARI' },
          { key: 'accountNumber', label: 'Account Number', type: 'text', validator: 'bankAccount', required: BANK_NOT_SA, showIf: BANK_NOT_SA },
          { key: 'bankBranch', label: 'Branch', type: 'text' },
        ],
      },
    ],
  },
  {
    key: 'tax', label: 'Tax & Zakat',
    groups: [
      {
        key: 'registrations', label: 'Registrations',
        fields: [
          { key: 'crNumber', label: 'Commercial Registration (CR) / Unified Number', type: 'text', validator: 'saCr', required: SA, showIf: SA, placeholder: '7001234567' },
          { key: 'vatRegistered', label: 'Registered for VAT?', type: 'radio', options: YES_NO, required: true },
          { key: 'vatNumber', label: 'VAT Registration Number', type: 'text', validator: 'vatNumber', required: yes('tax.vatRegistered'), showIf: yes('tax.vatRegistered'), placeholder: '300000000000003' },
        ],
      },
      {
        key: 'foreign', label: 'Non-resident Supplier (Withholding Tax)',
        fields: [
          { key: 'foreignTin', label: 'Tax Identification Number in home country', type: 'text', required: NOT_SA, showIf: NOT_SA },
          { key: 'hasTrc', label: 'Do you hold a Tax Residency Certificate (for treaty relief)?', type: 'radio', options: YES_NO, required: NOT_SA, showIf: NOT_SA },
          { key: 'hasSaudiPe', label: 'Do you have a permanent establishment in Saudi Arabia?', type: 'radio', options: YES_NO, showIf: NOT_SA },
        ],
      },
    ],
  },
  {
    key: 'ownership', label: 'Ownership',
    groups: [
      {
        key: 'owners', label: 'Owners holding 25% or more (beneficial owners)',
        fields: [
          { key: 'owner1Name', label: 'Owner 1 — Full name', type: 'text', required: true },
          { key: 'owner1Nationality', label: 'Owner 1 — Nationality', type: 'text', required: filled('ownership.owner1Name') },
          { key: 'owner1Share', label: 'Owner 1 — Share (%)', type: 'number', required: filled('ownership.owner1Name') },
          { key: 'owner2Name', label: 'Owner 2 — Full name', type: 'text', showIf: filled('ownership.owner1Name') },
          { key: 'owner2Nationality', label: 'Owner 2 — Nationality', type: 'text', showIf: filled('ownership.owner2Name'), required: filled('ownership.owner2Name') },
          { key: 'owner2Share', label: 'Owner 2 — Share (%)', type: 'number', showIf: filled('ownership.owner2Name'), required: filled('ownership.owner2Name') },
          { key: 'owner3Name', label: 'Owner 3 — Full name', type: 'text', showIf: filled('ownership.owner2Name') },
          { key: 'owner3Nationality', label: 'Owner 3 — Nationality', type: 'text', showIf: filled('ownership.owner3Name'), required: filled('ownership.owner3Name') },
          { key: 'owner3Share', label: 'Owner 3 — Share (%)', type: 'number', showIf: filled('ownership.owner3Name'), required: filled('ownership.owner3Name') },
          { key: 'moreOwners', label: 'Are there more owners holding 25% or more?', type: 'radio', options: YES_NO, required: true, help: 'If yes, list them all in the ownership declaration you upload' },
        ],
      },
      {
        key: 'pep', label: 'Declarations',
        fields: [
          { key: 'pep', label: 'Is any owner, director or senior manager a politically exposed person (PEP)?', type: 'radio', options: YES_NO, required: true },
          { key: 'pepDetails', label: 'PEP details', type: 'textarea', required: yes('ownership.pep'), showIf: yes('ownership.pep') },
          { key: 'relatedToBuyer', label: 'Is any owner or manager related to an employee of ours?', type: 'radio', options: YES_NO, required: true },
          { key: 'relatedDetails', label: 'Relationship details', type: 'textarea', required: yes('ownership.relatedToBuyer'), showIf: yes('ownership.relatedToBuyer') },
        ],
      },
    ],
  },
  {
    key: 'localContent', label: 'Saudization & Local Content',
    groups: [
      {
        key: 'workforce', label: 'Workforce',
        fields: [
          { key: 'nitaqatBand', label: 'Nitaqat (Saudization) band', type: 'select', options: ['Platinum', 'High Green', 'Medium Green', 'Low Green', 'Red'], required: SA, showIf: SA },
          { key: 'employees', label: 'Number of employees', type: 'number' },
          { key: 'saudizationPct', label: 'Saudization rate (%)', type: 'number', showIf: SA },
        ],
      },
      {
        key: 'content', label: 'Local Content',
        fields: [
          { key: 'iktvaScore', label: 'IKTVA score (%)', type: 'number', help: 'If certified under Aramco’s IKTVA programme' },
          { key: 'lcgpaCertified', label: 'Holds a local content certificate from the Local Content and Government Procurement Authority?', type: 'radio', options: YES_NO, showIf: SA },
          { key: 'localContentScore', label: 'Local content score (%)', type: 'number', showIf: yes('localContent.lcgpaCertified') },
        ],
      },
    ],
  },
  {
    key: 'risk', label: 'Financial Risk Evaluation',
    groups: [
      {
        key: 'financials', label: 'Financial Data',
        fields: [
          { key: 'fiscalYearEnd', label: 'Fiscal Year Ending', type: 'select', required: true, options: ['December', 'March', 'June', 'September'] },
          { key: 'currency', label: 'Reporting Currency', type: 'select', required: true, options: ['SAR', 'USD', 'AED', 'EUR', 'GBP', 'BHD', 'QAR', 'KWD', 'OMR', 'INR'] },
          { key: 'turnoverYear', label: 'Year of Figures', type: 'select', required: true, options: ['FY 2025', 'FY 2024', 'FY 2023'] },
          { key: 'annualTurnover', label: 'Annual Turnover', type: 'number', required: true },
          { key: 'netWorth', label: 'Net Worth', type: 'number' },
          { key: 'sourceOfInfo', label: 'Source of Financial Information', type: 'select', required: true, options: ['Audited financial statements', 'Management accounts', 'Zakat return', 'Self-declared'] },
        ],
      },
      {
        key: 'rating', label: 'Credit Rating & Declarations',
        fields: [
          { key: 'hasRating', label: 'Do you have an external credit rating?', type: 'radio', options: YES_NO, required: true },
          { key: 'ratingAgency', label: 'Rating Agency', type: 'select', options: ['Tassnief', 'SIMAH', "Moody's", 'S&P', 'Fitch', 'Other'], required: yes('risk.hasRating'), showIf: yes('risk.hasRating') },
          { key: 'rating', label: 'Rating', type: 'text', required: yes('risk.hasRating'), showIf: yes('risk.hasRating') },
          { key: 'bankruptcy5y', label: 'Any bankruptcy, liquidation or financial restructuring in the last 5 years?', type: 'radio', options: YES_NO, required: true },
          { key: 'bankruptcyDetails', label: 'Please give details', type: 'textarea', required: yes('risk.bankruptcy5y'), showIf: yes('risk.bankruptcy5y') },
          { key: 'litigation', label: 'Any material litigation pending against the company?', type: 'radio', options: YES_NO, required: true },
          { key: 'litigationDetails', label: 'Litigation details', type: 'textarea', required: yes('risk.litigation'), showIf: yes('risk.litigation') },
        ],
      },
    ],
  },
];

const documents: DocumentRequirement[] = [
  { type: 'CR_CERT', label: 'Commercial Registration (CR) certificate', required: SA, showIf: SA, hasExpiry: true, holdOnExpiry: true, help: 'CRs no longer expire, but must be confirmed every year — enter the date the next annual confirmation is due.' },
  { type: 'NATIONAL_ADDRESS', label: 'National Address certificate', required: SA, showIf: SA },
  { type: 'VAT_CERT', label: 'VAT registration certificate', required: yes('tax.vatRegistered'), showIf: yes('tax.vatRegistered') },
  { type: 'ZAKAT_CERT', label: 'Zakat certificate (ZATCA)', required: SA, showIf: SA, hasExpiry: true, holdOnExpiry: true },
  { type: 'GOSI_CERT', label: 'GOSI certificate', required: SA, showIf: SA, hasExpiry: true, holdOnExpiry: true },
  { type: 'NITAQAT_CERT', label: 'Saudization (Nitaqat) certificate', required: SA, showIf: SA, hasExpiry: true, holdOnExpiry: true },
  { type: 'CHAMBER_CERT', label: 'Chamber of Commerce membership certificate', showIf: SA, hasExpiry: true },
  { type: 'BANK_LETTER', label: 'Bank letter showing the IBAN (on bank letterhead)', required: true },
  { type: 'UBO_DECLARATION', label: 'Ownership (beneficial owner) declaration, signed', required: true },
  { type: 'ARTICLES', label: 'Articles of Association', showIf: { field: 'basic.entityType', op: 'in', value: ['Limited Liability Company (LLC)', 'Joint Stock Company', 'Simplified Joint Stock Company'] } },
  { type: 'IKTVA_CERT', label: 'IKTVA certificate', hasExpiry: true, showIf: filled('localContent.iktvaScore') },
  { type: 'LOCAL_CONTENT_CERT', label: 'Local content certificate (LCGPA)', hasExpiry: true, required: yes('localContent.lcgpaCertified'), showIf: yes('localContent.lcgpaCertified') },
  { type: 'TRC', label: 'Tax Residency Certificate', hasExpiry: true, required: yes('tax.hasTrc'), showIf: NOT_SA },
  { type: 'FINANCIALS', label: 'Latest audited financial statements', hasExpiry: true, help: 'Valid until the next year’s accounts are due.' },
  { type: 'OTHER', label: 'Other supporting document' },
];

const guide = [
  { title: 'Step 1: Sign in', body: 'Open the link in our email and sign in with the one-time code sent to your registered email.' },
  { title: 'Step 2: Company, bank and tax details', body: 'Complete each tab. Use your legal name in English and Arabic exactly as on your commercial registration, and the IBAN from your bank letter.' },
  { title: 'Step 3: Ownership and Saudization', body: 'List every owner holding 25% or more, and give your Nitaqat band and any local content certification.' },
  { title: 'Step 4: Upload documents', body: 'Upload your CR, National Address, VAT, Zakat, GOSI and Saudization certificates and a bank letter. Enter the expiry or renewal date where asked — we remind you before they lapse.' },
  { title: 'Step 5: Submit for review', body: 'Our Tax & Zakat, Finance and Master Data teams review in turn. If anything is missing we send it back with remarks.' },
];

const config: OnboardingConfig = {
  sections,
  documents,
  workflow: {
    levels: [
      { id: 'tax', label: 'Tax & Zakat Review', roleKey: 'TAX_MANAGER', slaHours: 48 },
      { id: 'finance', label: 'Finance & Compliance Review', roleKey: 'FINANCE_MANAGER', slaHours: 48 },
      { id: 'mdm', label: 'Master Data Approval', roleKey: 'MDM_MANAGER', slaHours: 24 },
    ],
    changes: {
      rules: [
        { match: ['bank.*'], levelIds: ['finance', 'mdm'] },
        { match: ['tax.*'], levelIds: ['tax', 'mdm'] },
        { match: ['ownership.*'], levelIds: ['finance', 'mdm'] },
      ],
      defaultLevelIds: ['mdm'],
    },
  },
  guide,
};

export const saudiTemplate = (): OnboardingConfig => structuredClone(config);
