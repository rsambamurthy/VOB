/**
 * Shared pieces of the Gulf onboarding templates (UAE, Bahrain, and later Qatar, Kuwait, Oman).
 * Each country pack supplies its own company/registration fields, tax fields, workforce section and
 * documents; bank, ownership, contacts, procurement and risk are the same across the Gulf.
 */
import type { Condition, DocumentRequirement, FieldDef, GroupDef, OnboardingConfig, SectionDef } from '../../config/types.js';

export const GULF_COUNTRIES = ['United Arab Emirates', 'Saudi Arabia', 'Bahrain', 'Qatar', 'Kuwait', 'Oman', 'India', 'United States', 'United Kingdom', 'Germany', 'China', 'Japan', 'Singapore', 'Other'];
export const YES_NO = ['Yes', 'No'];
export const yes = (field: string): Condition => ({ field, op: 'eq', value: 'Yes' });
export const filled = (field: string): Condition => ({ field, op: 'notEmpty' });
export const isCountry = (country: string): Condition => ({ field: 'basic.supplierCountry', op: 'eq', value: country });
export const notCountry = (country: string): Condition => ({ field: 'basic.supplierCountry', op: 'neq', value: country });

const ownership: SectionDef = {
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
};

const risk = (currencies: string[], fiscalFirst: string): SectionDef => ({
  key: 'risk', label: 'Financial Risk Evaluation',
  groups: [
    {
      key: 'financials', label: 'Financial Data',
      fields: [
        { key: 'fiscalYearEnd', label: 'Fiscal Year Ending', type: 'select', required: true, options: [fiscalFirst, ...['December', 'March', 'June', 'September'].filter((m) => m !== fiscalFirst)] },
        { key: 'currency', label: 'Reporting Currency', type: 'select', required: true, options: currencies },
        { key: 'turnoverYear', label: 'Year of Figures', type: 'select', required: true, options: ['FY 2025', 'FY 2024', 'FY 2023'] },
        { key: 'annualTurnover', label: 'Annual Turnover', type: 'number', required: true },
        { key: 'netWorth', label: 'Net Worth', type: 'number' },
        { key: 'sourceOfInfo', label: 'Source of Financial Information', type: 'select', required: true, options: ['Audited financial statements', 'Management accounts', 'Tax return', 'Self-declared'] },
      ],
    },
    {
      key: 'rating', label: 'Credit Rating & Declarations',
      fields: [
        { key: 'hasRating', label: 'Do you have an external credit rating?', type: 'radio', options: YES_NO, required: true },
        { key: 'ratingAgency', label: 'Rating Agency', type: 'select', options: ["Moody's", 'S&P', 'Fitch', 'Al Etihad Credit Bureau', 'Capital Intelligence', 'Other'], required: yes('risk.hasRating'), showIf: yes('risk.hasRating') },
        { key: 'rating', label: 'Rating', type: 'text', required: yes('risk.hasRating'), showIf: yes('risk.hasRating') },
        { key: 'bankruptcy5y', label: 'Any bankruptcy, liquidation or financial restructuring in the last 5 years?', type: 'radio', options: YES_NO, required: true },
        { key: 'bankruptcyDetails', label: 'Please give details', type: 'textarea', required: yes('risk.bankruptcy5y'), showIf: yes('risk.bankruptcy5y') },
        { key: 'litigation', label: 'Any material litigation pending against the company?', type: 'radio', options: YES_NO, required: true },
        { key: 'litigationDetails', label: 'Litigation details', type: 'textarea', required: yes('risk.litigation'), showIf: yes('risk.litigation') },
      ],
    },
  ],
});

export interface GulfTemplateSpec {
  /** "United Arab Emirates", "Bahrain" */
  country: string;
  ibanExample: string;
  swiftExample: string;
  mobilePlaceholder: string;
  entityTypes: string[];
  /** Address and company fields after the legal names (country, address lines, region, …). */
  companyFields: FieldDef[];
  registrationFields: FieldDef[];
  /** Tax group(s); a non-resident group is added for foreign suppliers. */
  taxGroups: GroupDef[];
  /** Workforce / local content section (Emiratisation & ICV, Bahrainisation…). */
  localSection: SectionDef;
  documents: DocumentRequirement[];
  currencies: string[];
  guide: { title: string; body: string }[];
  levels: { taxLabel: string };
  /** Title of the tax tab (default "Tax"); e.g. "Registrations" where there is no VAT. */
  taxSectionLabel?: string;
}

/** Builds a Gulf workspace's starting template from the shared parts and the country's own. */
export function gulfTemplate(s: GulfTemplateSpec): OnboardingConfig {
  const ABROAD = notCountry(s.country);
  const BANK_ABROAD: Condition = { field: 'bank.bankCountry', op: 'neq', value: s.country };
  const sections: SectionDef[] = [
    {
      key: 'basic', label: 'Company',
      groups: [
        {
          key: 'vendorInfo', label: 'Company Information',
          fields: [
            { key: 'vendorName', label: 'Legal Name (English)', type: 'text', required: true },
            { key: 'nameArabic', label: 'Legal Name (Arabic)', type: 'text', dir: 'rtl', help: 'As on the licence / registration, if it shows an Arabic name' },
            { key: 'tradingName', label: 'Trade Name', type: 'text' },
            { key: 'entityType', label: 'Type of Entity', type: 'select', required: true, options: s.entityTypes },
            { key: 'supplierCountry', label: 'Country', type: 'select', required: true, options: [s.country, ...GULF_COUNTRIES.filter((c) => c !== s.country)] },
            ...s.companyFields,
            { key: 'websiteUrl', label: 'Website', type: 'url', validator: 'url' },
          ],
        },
        { key: 'registration', label: 'Registration', fields: s.registrationFields },
        {
          key: 'communication', label: 'Contacts',
          fields: [
            { key: 'contactName', label: 'Primary Contact Name', type: 'text', required: true },
            { key: 'contactEmail', label: 'Primary Contact Email', type: 'email', required: true, validator: 'email' },
            { key: 'contactMobile', label: 'Primary Contact Mobile', type: 'tel', required: true, validator: 'phone', placeholder: s.mobilePlaceholder },
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
      groups: [{
        key: 'account', label: 'Bank Account',
        fields: [
          { key: 'bankCountry', label: 'Bank Country', type: 'select', required: true, options: [s.country, ...GULF_COUNTRIES.filter((c) => c !== s.country)] },
          { key: 'bankName', label: 'Bank Name', type: 'text', required: true },
          { key: 'accountHolderName', label: 'Account Holder (Beneficiary) Name', type: 'text', required: true, help: 'Must match the legal name' },
          { key: 'iban', label: 'IBAN', type: 'text', validator: 'iban', required: true, placeholder: s.ibanExample },
          { key: 'swift', label: 'SWIFT / BIC Code', type: 'text', validator: 'swift', required: BANK_ABROAD, placeholder: s.swiftExample },
          { key: 'accountNumber', label: 'Account Number', type: 'text', validator: 'bankAccount', required: BANK_ABROAD, showIf: BANK_ABROAD },
          { key: 'bankBranch', label: 'Branch', type: 'text' },
        ],
      }],
    },
    {
      key: 'tax', label: s.taxSectionLabel ?? 'Tax',
      groups: [
        ...s.taxGroups,
        {
          key: 'foreign', label: 'Non-resident Supplier',
          fields: [
            { key: 'foreignTin', label: 'Tax Identification Number in home country', type: 'text', required: ABROAD, showIf: ABROAD },
            { key: 'hasTrc', label: 'Do you hold a Tax Residency Certificate?', type: 'radio', options: YES_NO, showIf: ABROAD },
          ],
        },
      ],
    },
    ownership,
    s.localSection,
    risk(s.currencies, 'December'),
  ];
  return {
    sections,
    documents: [
      ...s.documents,
      { type: 'BANK_LETTER', label: 'Bank letter showing the IBAN (on bank letterhead)', required: true },
      { type: 'UBO_DECLARATION', label: 'Ownership (beneficial owner) declaration, signed', required: true },
      { type: 'TRC', label: 'Tax Residency Certificate', hasExpiry: true, required: yes('tax.hasTrc'), showIf: ABROAD },
      { type: 'FINANCIALS', label: 'Latest audited financial statements', hasExpiry: true, help: 'Valid until the next year’s accounts are due.' },
      { type: 'OTHER', label: 'Other supporting document' },
    ],
    workflow: {
      levels: [
        { id: 'tax', label: s.levels.taxLabel, roleKey: 'TAX_MANAGER', slaHours: 48 },
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
    guide: s.guide,
  };
}
