/**
 * DEFAULT TEMPLATE for a new workspace's onboarding configuration.
 * Each tenant gets a copy (version 1) and edits it in Admin → Configuration; after that the
 * tenant's published config in the database is what the app uses, not this file.
 *
 * Config-driven definition of the vendor profile.
 *
 * Everything the vendor fills in — tabs, groups, fields, dropdown values, required
 * rules, format validators and conditional visibility — is defined here. The web app
 * renders forms from this config (GET /api/meta) and the server validates against it,
 * so changing a field only requires editing this file.
 *
 * Field values are stored in Vendor.profile as { [sectionKey]: { [fieldKey]: value } }.
 * Conditions reference other fields as "section.field", e.g. "basic.supplierCountry".
 */
import type { Condition, DocumentRequirement, OnboardingConfig, SectionDef } from './types.js';

const COUNTRIES = ['India', 'United Arab Emirates', 'United States', 'United Kingdom', 'Germany', 'Singapore', 'Kuwait', 'Saudi Arabia', 'China', 'Japan', 'Other'];
const INDIA: Condition = { field: 'basic.supplierCountry', op: 'eq', value: 'India' };
const NOT_INDIA: Condition = { field: 'basic.supplierCountry', op: 'neq', value: 'India' };
const BANK_INDIA: Condition = { field: 'bank.bankCountry', op: 'eq', value: 'India' };
const BANK_NOT_INDIA: Condition = { field: 'bank.bankCountry', op: 'neq', value: 'India' };
const YES_NO = ['Yes', 'No'];

const sections: SectionDef[] = [
  {
    key: 'basic',
    label: 'Basic Information',
    groups: [
      {
        key: 'vendorInfo',
        label: 'Vendor Information',
        fields: [
          { key: 'vendorName', label: 'Vendor Name', type: 'text', required: true },
          { key: 'tradingName', label: 'Trading Name', type: 'text' },
          { key: 'proprietorName', label: 'Proprietor Name', type: 'text', showIf: { field: 'basic.entityType', op: 'eq', value: 'Individual / Proprietorship' } },
          {
            key: 'entityType', label: 'Type of Entity', type: 'select', required: true,
            options: ['Company (Pvt / Public Ltd)', 'Limited Liability Partnership', 'Partnership Firm', 'Individual / Proprietorship', 'Hindu Undivided Family (HUF)', 'Association of Persons', 'Trust', 'Government Organisation'],
          },
          { key: 'supplierCountry', label: 'Supplier Country', type: 'select', required: true, options: COUNTRIES },
          { key: 'address', label: 'Address', type: 'textarea', required: true, placeholder: 'Street / house number' },
          { key: 'region', label: 'State / Region', type: 'text', required: true },
          { key: 'district', label: 'District / City', type: 'text', required: true },
          { key: 'postalCode', label: 'Postal Code', type: 'text', required: true, validator: 'postalCode' },
          { key: 'faxNumber', label: 'Fax Number', type: 'tel' },
          { key: 'telexNumber', label: 'Telex Number', type: 'text' },
          { key: 'websiteUrl', label: 'Website URL', type: 'url', validator: 'url' },
        ],
      },
      {
        key: 'registration',
        label: 'Registration Details',
        fields: [
          { key: 'yearEstablished', label: 'Year of Establishment', type: 'number', validator: 'year' },
          { key: 'msmeRegistered', label: 'Registered as MSME (Udyam)?', type: 'radio', options: YES_NO, required: INDIA, showIf: INDIA },
          { key: 'udyamNumber', label: 'Udyam Registration Number', type: 'text', validator: 'udyam', placeholder: 'UDYAM-MH-01-0000001', required: { field: 'basic.msmeRegistered', op: 'eq', value: 'Yes' }, showIf: { field: 'basic.msmeRegistered', op: 'eq', value: 'Yes' } },
          { key: 'msmeCategory', label: 'MSME Category', type: 'select', options: ['Micro', 'Small', 'Medium'], showIf: { field: 'basic.msmeRegistered', op: 'eq', value: 'Yes' } },
        ],
      },
      {
        key: 'communication',
        label: 'Communication',
        fields: [
          { key: 'contactName', label: 'Primary Contact Name', type: 'text', required: true },
          { key: 'contactEmail', label: 'Primary Contact Email', type: 'email', required: true, validator: 'email' },
          { key: 'contactMobile', label: 'Primary Contact Mobile', type: 'tel', required: true, validator: 'phone' },
          { key: 'accountsEmail', label: 'Accounts / Remittance Email', type: 'email', validator: 'email', help: 'Payment advices will be sent here' },
        ],
      },
      {
        key: 'procurement',
        label: 'Procurement',
        fields: [
          { key: 'supplyCategory', label: 'Category of Supply', type: 'select', required: true, options: ['Goods', 'Services', 'Goods & Services'] },
          { key: 'itemsSupplied', label: 'Products / Services Supplied', type: 'textarea' },
          { key: 'paymentTerms', label: 'Requested Payment Terms', type: 'select', options: ['Advance', 'Net 15', 'Net 30', 'Net 45', 'Net 60', 'Net 90'] },
        ],
      },
    ],
  },
  {
    key: 'bank',
    label: 'Bank Details',
    groups: [
      {
        key: 'account',
        label: 'Bank Account',
        fields: [
          { key: 'bankCountry', label: 'Bank Country', type: 'select', required: true, options: COUNTRIES },
          { key: 'bankName', label: 'Bank Name', type: 'text', required: true },
          { key: 'accountHolderName', label: 'Account Holder Name', type: 'text', required: true, help: 'Must match the vendor’s legal name' },
          { key: 'accountNumber', label: 'Account Number', type: 'text', required: true, validator: 'bankAccount' },
          { key: 'bankBranch', label: 'Bank Branch', type: 'text', required: true },
          { key: 'ifsc', label: 'IFSC Code', type: 'text', validator: 'ifsc', required: BANK_INDIA, showIf: BANK_INDIA, placeholder: 'HDFC0001234' },
          { key: 'swift', label: 'SWIFT / BIC Code', type: 'text', validator: 'swift', required: BANK_NOT_INDIA, placeholder: 'DEUTDEFF' },
          { key: 'iban', label: 'IBAN', type: 'text', validator: 'iban', showIf: BANK_NOT_INDIA },
          { key: 'routingNumber', label: 'Bank / Routing Number', type: 'text', showIf: BANK_NOT_INDIA },
          { key: 'upiId', label: 'UPI ID', type: 'text', validator: 'upi', showIf: BANK_INDIA, placeholder: 'name@bank' },
        ],
      },
      {
        key: 'branchAddress',
        label: 'Branch Address',
        fields: [
          { key: 'bankState', label: 'State / Region / Province', type: 'text' },
          { key: 'bankCity', label: 'City', type: 'text' },
          { key: 'bankPostalCode', label: 'Postal Code', type: 'text' },
        ],
      },
    ],
  },
  {
    key: 'tax',
    label: 'Tax Details',
    groups: [
      {
        key: 'indirect',
        label: 'Indirect Tax (GST)',
        fields: [
          { key: 'hasGst', label: 'Do you hold a GST number?', type: 'radio', options: YES_NO, required: INDIA, showIf: INDIA },
          { key: 'gstin', label: 'GSTIN', type: 'text', validator: 'gstin', required: { field: 'tax.hasGst', op: 'eq', value: 'Yes' }, showIf: { field: 'tax.hasGst', op: 'eq', value: 'Yes' }, placeholder: '27AAPFU0939F1ZV' },
          { key: 'gstClassification', label: 'GST Classification', type: 'select', options: ['Regular', 'Composition', 'SEZ Unit', 'SEZ Developer', 'Input Service Distributor'], required: { field: 'tax.hasGst', op: 'eq', value: 'Yes' }, showIf: { field: 'tax.hasGst', op: 'eq', value: 'Yes' } },
          { key: 'vatNumber', label: 'VAT Registration Number', type: 'text', showIf: NOT_INDIA },
        ],
      },
      {
        key: 'direct',
        label: 'Direct Tax',
        fields: [
          { key: 'pan', label: 'PAN', type: 'text', validator: 'pan', required: INDIA, showIf: INDIA, placeholder: 'AAPFU0939F' },
          { key: 'tan', label: 'TAN', type: 'text', validator: 'tan', showIf: INDIA, placeholder: 'MUMA12345B' },
          { key: 'cin', label: 'CIN / LLPIN', type: 'text', validator: 'cin', showIf: { field: 'basic.entityType', op: 'in', value: ['Company (Pvt / Public Ltd)', 'Limited Liability Partnership'] }, required: { field: 'basic.entityType', op: 'eq', value: 'Company (Pvt / Public Ltd)' } },
          { key: 'concessionalTds', label: 'Do you hold a lower / nil TDS certificate (Sec. 197)?', type: 'radio', options: YES_NO, showIf: INDIA },
          { key: 'tdsCertNumber', label: 'Certificate Number', type: 'text', required: { field: 'tax.concessionalTds', op: 'eq', value: 'Yes' }, showIf: { field: 'tax.concessionalTds', op: 'eq', value: 'Yes' } },
          { key: 'tdsRate', label: 'Concessional Rate (%)', type: 'number', required: { field: 'tax.concessionalTds', op: 'eq', value: 'Yes' }, showIf: { field: 'tax.concessionalTds', op: 'eq', value: 'Yes' } },
          { key: 'tdsValidTill', label: 'Valid Till', type: 'date', required: { field: 'tax.concessionalTds', op: 'eq', value: 'Yes' }, showIf: { field: 'tax.concessionalTds', op: 'eq', value: 'Yes' } },
        ],
      },
      {
        key: 'foreign',
        label: 'Foreign Vendor (Form 15CA / DTAA)',
        fields: [
          { key: 'foreignTin', label: 'Tax Identification Number (TIN) of home country', type: 'text', required: NOT_INDIA, showIf: NOT_INDIA },
          { key: 'hasTrc', label: 'Do you hold a Tax Residency Certificate for the current year?', type: 'radio', options: YES_NO, required: NOT_INDIA, showIf: NOT_INDIA },
          { key: 'holdsNoPe', label: 'Do you hold a No Permanent Establishment (No-PE) declaration?', type: 'radio', options: YES_NO, required: NOT_INDIA, showIf: NOT_INDIA },
          { key: 'form10f', label: 'Form 10F filed?', type: 'radio', options: YES_NO, showIf: NOT_INDIA },
        ],
      },
    ],
  },
  {
    key: 'risk',
    label: 'Financial Risk Evaluation',
    groups: [
      {
        key: 'financials',
        label: 'Financial Data',
        fields: [
          { key: 'fiscalYearEnd', label: 'Fiscal Year Ending', type: 'select', required: true, options: ['March', 'June', 'September', 'December'] },
          { key: 'currency', label: 'Reporting Currency', type: 'select', required: true, options: ['INR', 'USD', 'EUR', 'GBP', 'AED', 'KWD', 'SGD'] },
          { key: 'turnoverYear', label: 'Financial Year of Figures', type: 'select', required: true, options: ['FY 2025-26', 'FY 2024-25', 'FY 2023-24'] },
          { key: 'annualTurnover', label: 'Annual Turnover', type: 'number', required: true },
          { key: 'netWorth', label: 'Net Worth', type: 'number' },
          { key: 'sourceOfInfo', label: 'Source of Financial Information', type: 'select', required: true, options: ['Audited financial statements', 'Provisional / management accounts', 'Income tax return', 'Self-declared'] },
        ],
      },
      {
        key: 'rating',
        label: 'Credit Rating & Declarations',
        fields: [
          { key: 'hasRating', label: 'Do you have an external credit rating?', type: 'radio', options: YES_NO, required: true },
          { key: 'ratingAgency', label: 'Rating Agency', type: 'select', options: ['CRISIL', 'ICRA', 'CARE', 'India Ratings', 'Acuité', "Moody's", 'S&P', 'Fitch', 'Other'], required: { field: 'risk.hasRating', op: 'eq', value: 'Yes' }, showIf: { field: 'risk.hasRating', op: 'eq', value: 'Yes' } },
          { key: 'rating', label: 'Rating', type: 'text', required: { field: 'risk.hasRating', op: 'eq', value: 'Yes' }, showIf: { field: 'risk.hasRating', op: 'eq', value: 'Yes' } },
          { key: 'bankruptcy5y', label: 'Has your organisation declared bankruptcy / insolvency in the last 5 years?', type: 'radio', options: YES_NO, required: true },
          { key: 'bankruptcyDetails', label: 'Please give details', type: 'textarea', required: { field: 'risk.bankruptcy5y', op: 'eq', value: 'Yes' }, showIf: { field: 'risk.bankruptcy5y', op: 'eq', value: 'Yes' } },
          { key: 'litigation', label: 'Any material litigation pending against the organisation?', type: 'radio', options: YES_NO, required: true },
          { key: 'litigationDetails', label: 'Litigation details', type: 'textarea', required: { field: 'risk.litigation', op: 'eq', value: 'Yes' }, showIf: { field: 'risk.litigation', op: 'eq', value: 'Yes' } },
        ],
      },
    ],
  },
];

const documents: DocumentRequirement[] = [
  { type: 'PAN_CARD', label: 'PAN Card', required: INDIA, showIf: INDIA },
  { type: 'GST_CERT', label: 'GST Registration Certificate', required: { field: 'tax.hasGst', op: 'eq', value: 'Yes' }, showIf: { field: 'tax.hasGst', op: 'eq', value: 'Yes' } },
  { type: 'CANCELLED_CHEQUE', label: 'Cancelled Cheque / Bank Letter', required: true },
  { type: 'INCORPORATION_CERT', label: 'Certificate of Incorporation', required: { field: 'basic.entityType', op: 'in', value: ['Company (Pvt / Public Ltd)', 'Limited Liability Partnership'] }, showIf: { field: 'basic.entityType', op: 'in', value: ['Company (Pvt / Public Ltd)', 'Limited Liability Partnership'] } },
  { type: 'MSME_CERT', label: 'Udyam (MSME) Certificate', required: { field: 'basic.msmeRegistered', op: 'eq', value: 'Yes' }, showIf: { field: 'basic.msmeRegistered', op: 'eq', value: 'Yes' } },
  { type: 'LOWER_TDS_CERT', label: 'Lower / Nil TDS Certificate', required: { field: 'tax.concessionalTds', op: 'eq', value: 'Yes' }, showIf: { field: 'tax.concessionalTds', op: 'eq', value: 'Yes' } },
  { type: 'TRC', label: 'Tax Residency Certificate', required: { field: 'tax.hasTrc', op: 'eq', value: 'Yes' }, showIf: NOT_INDIA },
  { type: 'NO_PE_CERT', label: 'No-PE Declaration', required: { field: 'tax.holdsNoPe', op: 'eq', value: 'Yes' }, showIf: NOT_INDIA },
  { type: 'FORM_10F', label: 'Form 10F', showIf: NOT_INDIA },
  { type: 'FINANCIALS', label: 'Latest Audited Financial Statements', help: 'Recommended for turnover above ₹5 crore' },
  { type: 'OTHER', label: 'Other Supporting Document' },
];

const guide = [
  { title: 'Step 1: Initial email', body: 'You receive an email from us with a secure link to the vendor onboarding portal. Open it and sign in with the one-time code sent to your registered email.' },
  { title: 'Step 2: Enter vendor details', body: 'Complete each tab — Basic Information, Bank Details, Tax Details and Financial Risk Evaluation. You can save and come back at any time.' },
  { title: 'Step 3: Upload documents', body: 'Upload the documents listed in the Documents tab. Required documents change with your answers (e.g. GST certificate only if you hold a GSTIN).' },
  { title: 'Step 4: Submit for review', body: 'The Required Fields checklist must be fully green before you can submit. Our Tax, Finance and Master Data teams review in turn.' },
  { title: 'Step 5: Corrections or approval', body: 'If a reviewer needs changes the form is sent back to you with remarks. Once all levels approve, you are activated as a vendor.' },
];

export const defaultConfig: OnboardingConfig = {
  sections,
  documents,
  workflow: {
    levels: [
      { id: 'tax', label: 'Tax Review', roleKey: 'TAX_MANAGER', slaHours: 48 },
      { id: 'finance', label: 'Finance & Risk Review', roleKey: 'FINANCE_MANAGER', slaHours: 48 },
      { id: 'mdm', label: 'Master Data Approval', roleKey: 'MDM_MANAGER', slaHours: 24 },
    ],
  },
  guide,
};
