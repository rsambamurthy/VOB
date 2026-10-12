/**
 * India pack. As a HOME country: INR, en-IN formatting, the GST/PAN/TDS onboarding template,
 * DPDP privacy notice and Oracle's India localisation fields. As a SUPPLIER country (for a buyer
 * anywhere): GSTIN/PAN/TAN/CIN/IFSC/Udyam formats, GST portal / PAN / penny-drop / MCA checks,
 * and reading Indian KYC documents.
 */
import type { CountryPack, Profile } from '../types.js';
import { indiaValidators, indiaFormats, indiaCrossChecks } from './validators.js';
import { indiaChecks, indiaCheckProvider } from './checks.js';
import { indiaDocuments, indiaDerive } from './documents.js';
import { indiaTemplate } from './template.js';
import { indiaNotice } from './privacy.js';

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));

export const indiaPack: CountryPack = {
  code: 'IN',
  name: 'India',
  homeCountry: true,
  currency: 'INR',
  locale: 'en-IN',
  weekend: [0],
  // Indian workspaces have always counted deadlines on every day; switch on per workspace if wanted.
  skipWeekendsByDefault: false,
  // Lenient on purpose: Indian workspaces have always accepted any 8–15 digit number here.
  mobile: { dialCode: '91', nationalDigits: 10, example: '98765 43210' },
  timeZone: 'Asia/Kolkata',
  timeZoneLabel: 'IST',
  coreFields: [
    'basic.faxNumber', 'basic.telexNumber', 'basic.msmeRegistered', 'basic.udyamNumber', 'basic.msmeCategory', 'bank.ifsc', 'bank.routingNumber',
    'tax.hasGst', 'tax.gstin', 'tax.gstClassification', 'tax.pan', 'tax.tan', 'tax.cin',
    'tax.concessionalTds', 'tax.tdsCertNumber', 'tax.tdsRate', 'tax.tdsValidTill', 'tax.hasTrc', 'tax.holdsNoPe', 'tax.form10f',
  ],

  validators: indiaValidators,
  formats: indiaFormats,
  crossChecks: indiaCrossChecks,

  checks: indiaChecks,
  checkProvider: indiaCheckProvider,
  checksTitle: 'GSTIN / PAN / bank / MCA checks',

  documents: indiaDocuments,
  deriveExtracted: indiaDerive,

  template: indiaTemplate,
  privacy: { law: 'Digital Personal Data Protection Act, 2023', lawShort: 'DPDP', defaultNotice: indiaNotice },
  erp: {
    domesticTaxId: (p: Profile) => s(p.tax?.gstin),
    domesticBlock: (p: Profile) => {
      const b = p.basic ?? {}, tax = p.tax ?? {};
      return {
        key: 'INDIA_LOCALIZATION',
        value: {
          PAN_NO: s(tax.pan), TAN_NO: s(tax.tan), GSTIN: s(tax.gstin), GST_REGISTRATION_TYPE: s(tax.gstClassification),
          CIN: s(tax.cin), MSME_UDYAM_NO: s(b.udyamNumber), MSME_CATEGORY: s(b.msmeCategory),
          LOWER_TDS_CERT_NO: s(tax.tdsCertNumber), LOWER_TDS_RATE: s(tax.tdsRate), LOWER_TDS_VALID_TILL: s(tax.tdsValidTill),
        },
      };
    },
    // Indian buyers paying foreign suppliers: withholding under DTAA needs TRC, No-PE and Form 10F.
    foreignBlock: (p: Profile) => {
      const tax = p.tax ?? {};
      return { key: 'FOREIGN_TAX', value: { TIN: s(tax.foreignTin), TRC_HELD: s(tax.hasTrc), NO_PE_DECLARATION: s(tax.holdsNoPe), FORM_10F: s(tax.form10f) } };
    },
    bankBranchField: 'bank.ifsc',
  },
};
