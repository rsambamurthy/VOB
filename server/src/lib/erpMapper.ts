/**
 * Maps an approved vendor to an Oracle E-Business Suite style supplier payload
 * (same shape as the ERPVendorsData sample: VENDOR_DATA -> VENDOR_SITES -> VENDOR_BANKS).
 *
 * Deliberate fixes vs. the sample data:
 *  - SITE_DATA and BANK_DATA are ALWAYS arrays (the sample mixes arrays, objects and "").
 *  - BIC_SWIFTCODE only ever holds a SWIFT/BIC; the IBAN goes in IBAN; Indian IFSC goes in BRANCH_NUMBER.
 *  - India tax identifiers (PAN/TAN/GSTIN/MSME) are carried in an INDIA_LOCALIZATION block
 *    (Oracle stores these in the JAI_* localization tables, not AP_SUPPLIERS).
 */
import type { Vendor } from '../db/schema.js';
import type { Profile } from './profileEngine.js';

const ORG_TYPE: Record<string, string> = {
  'Company (Pvt / Public Ltd)': 'CORPORATION',
  'Limited Liability Partnership': 'PARTNERSHIP',
  'Partnership Firm': 'PARTNERSHIP',
  'Individual / Proprietorship': 'INDIVIDUAL',
  'Hindu Undivided Family (HUF)': 'INDIVIDUAL',
  'Association of Persons': 'PARTNERSHIP',
  Trust: 'CORPORATION',
  'Government Organisation': 'GOVERNMENT',
};
const TERMS: Record<string, string> = { Advance: 'IMMEDIATE', 'Net 15': 'N15', 'Net 30': 'N30', 'Net 45': 'N45', 'Net 60': 'N60', 'Net 90': 'N90' };
const COUNTRY_ISO: Record<string, string> = { India: 'IN', 'United Arab Emirates': 'AE', 'United States': 'US', 'United Kingdom': 'GB', Germany: 'DE', Singapore: 'SG', Kuwait: 'KW', 'Saudi Arabia': 'SA', China: 'CN', Japan: 'JP' };

const s = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const ts = (d: Date | null | undefined) => (d ? d.toISOString().replace('T', ' ').slice(0, 19) : '');

export function toOracleSupplier(v: Vendor, opts: { orgId?: string; action?: 'CREATE' | 'UPDATE' } = {}) {
  const p = (v.profile ?? {}) as Profile;
  const b = p.basic ?? {}, bank = p.bank ?? {}, tax = p.tax ?? {}, risk = p.risk ?? {};
  const domestic = s(b.supplierCountry) === 'India';
  const bankIndia = s(bank.bankCountry) === 'India';
  const currency = domestic ? 'INR' : s(risk.currency) || 'USD';
  const payGroup = bankIndia ? 'EFT DOMESTIC' : 'EFT FOREIGN';

  return {
    ERPVendorsData: {
      VENDOR: {
        VENDOR_DATA: {
          SOURCE_SYSTEM_NAME: 'VENDOR_PORTAL',
          SYNC_ACTION: opts.action ?? (v.erpVendorId ? 'UPDATE' : 'CREATE'),
          VENDOR_ID: v.erpVendorId ?? '',  // assigned by the ERP on the first import; sent back on updates
          SEGMENT1: v.code,                // supplier number
          VENDOR_NAME: s(b.vendorName) || v.name,
          VENDOR_NAME_ALT: s(b.tradingName),
          ENABLED_FLAG: v.status === 'APPROVED' ? 'Y' : 'N',
          VENDOR_TYPE_LOOKUP_CODE: 'VENDOR',
          ORGANIZATION_TYPE_LOOKUP_CODE: ORG_TYPE[s(b.entityType)] ?? '',
          PAY_DATE_BASIS_LOOKUP_CODE: 'DUE',
          PAY_GROUP_LOOKUP_CODE: payGroup,
          PAYMENT_PRIORITY: '99',
          INVOICE_CURRENCY_CODE: currency,
          PAYMENT_CURRENCY_CODE: currency,
          HOLD_ALL_PAYMENTS_FLAG: v.blockedAt ? 'Y' : 'N',
          HOLD_FUTURE_PAYMENTS_FLAG: v.blockedAt ? 'Y' : 'N',
          HOLD_FLAG: v.blockedAt ? 'Y' : 'N',
          HOLD_REASON: v.blockedReason ?? '',
          TERMS_DATE_BASIS: 'Invoice',
          TERMS_NAME: TERMS[s(b.paymentTerms)] ?? 'N30',
          MATCH_OPTION: 'P',
          START_DATE_ACTIVE: ts(v.decidedAt),
          END_DATE_ACTIVE: '',
          TCA_SYNC_VAT_REG_NUM: domestic ? s(tax.gstin) : s(tax.vatNumber),
          NUM_1099: '',
          SMALL_BUSINESS_FLAG: s(b.msmeRegistered) === 'Yes' ? 'Y' : 'N',
          INDIA_LOCALIZATION: domestic ? {
            PAN_NO: s(tax.pan), TAN_NO: s(tax.tan), GSTIN: s(tax.gstin), GST_REGISTRATION_TYPE: s(tax.gstClassification),
            CIN: s(tax.cin), MSME_UDYAM_NO: s(b.udyamNumber), MSME_CATEGORY: s(b.msmeCategory),
            LOWER_TDS_CERT_NO: s(tax.tdsCertNumber), LOWER_TDS_RATE: s(tax.tdsRate), LOWER_TDS_VALID_TILL: s(tax.tdsValidTill),
          } : undefined,
          FOREIGN_TAX: !domestic ? { TIN: s(tax.foreignTin), TRC_HELD: s(tax.hasTrc), NO_PE_DECLARATION: s(tax.holdsNoPe), FORM_10F: s(tax.form10f) } : undefined,
          VENDOR_SITES: {
            SITE_DATA: [
              {
                VENDOR_SITE_CODE: `${v.code}-MAIN`.slice(0, 15),
                PURCHASING_SITE_FLAG: 'Y',
                PAY_SITE_FLAG: 'Y',
                PRIMARY_PAY_SITE_FLAG: 'Y',
                ADDRESS_LINE1: s(b.address).split('\n')[0] ?? '',
                ADDRESS_LINE2: s(b.address).split('\n').slice(1).join(', '),
                CITY: s(b.district),
                STATE: s(b.region),
                ZIP: s(b.postalCode),
                COUNTRY: COUNTRY_ISO[s(b.supplierCountry)] ?? s(b.supplierCountry),
                PHONE: s(b.contactMobile),
                FAX: s(b.faxNumber),
                TELEX: s(b.telexNumber),
                EMAIL_ADDRESS: s(b.contactEmail),
                REMITTANCE_EMAIL: s(b.accountsEmail) || s(b.contactEmail),
                PAY_GROUP_LOOKUP_CODE: payGroup,
                INVOICE_CURRENCY_CODE: currency,
                PAYMENT_CURRENCY_CODE: currency,
                ORG_ID: opts.orgId ?? '',     // operating unit — decided by Master Data at approval
                VAT_REGISTRATION_NUMBER: domestic ? s(tax.gstin) : s(tax.vatNumber),
                VENDOR_BANKS: {
                  BANK_DATA: [
                    {
                      ACCOUNT_NUMBER: s(bank.accountNumber),
                      BANK_ACCOUNT_NAME: s(bank.accountHolderName),
                      BANK_NAME: s(bank.bankName),
                      BRANCH_NAME: s(bank.bankBranch),
                      BRANCH_NUMBER: bankIndia ? s(bank.ifsc) : s(bank.routingNumber),
                      BIC_SWIFTCODE: s(bank.swift),
                      IBAN: s(bank.iban),
                      BANK_COUNTRY: COUNTRY_ISO[s(bank.bankCountry)] ?? s(bank.bankCountry),
                      START_DATE: ts(v.decidedAt),
                      END_DATE: '',
                      FOREIGN_PAYMENT_USE_FLAG: bankIndia ? 'N' : 'Y',
                      PAYMENT_METHOD: bankIndia ? 'EFT' : 'WIRE',
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  };
}

/** System-neutral vendor record used by the webhook and CSV connectors. */
export function toGenericVendor(v: Vendor) {
  const p = (v.profile ?? {}) as Profile;
  const b = p.basic ?? {}, bank = p.bank ?? {}, tax = p.tax ?? {};
  return {
    id: v.id, code: v.code, erpVendorId: v.erpVendorId ?? null, name: s(b.vendorName) || v.name, vendorType: v.vendorType,
    status: v.blockedAt ? 'BLOCKED' : v.status === 'APPROVED' ? 'ACTIVE' : v.status,
    blocked: !!v.blockedAt, blockedReason: v.blockedReason ?? null,
    approvedAt: v.decidedAt?.toISOString() ?? null,
    entityType: s(b.entityType), msme: s(b.msmeRegistered) === 'Yes', udyamNumber: s(b.udyamNumber),
    address: { line1: s(b.address).split('\n')[0] ?? '', line2: s(b.address).split('\n').slice(1).join(', '), city: s(b.district), state: s(b.region), postalCode: s(b.postalCode), country: COUNTRY_ISO[s(b.supplierCountry)] ?? s(b.supplierCountry) },
    contact: { name: s(b.contactName) || `${v.contactFirstName} ${v.contactLastName}`, email: s(b.contactEmail) || v.contactEmail, mobile: s(b.contactMobile) || v.contactMobile },
    tax: { pan: s(tax.pan), gstin: s(tax.gstin), tan: s(tax.tan), cin: s(tax.cin), gstClassification: s(tax.gstClassification), foreignTin: s(tax.foreignTin) },
    bank: { accountName: s(bank.accountHolderName), accountNumber: s(bank.accountNumber), bankName: s(bank.bankName), branch: s(bank.bankBranch), ifsc: s(bank.ifsc), swift: s(bank.swift), iban: s(bank.iban), country: COUNTRY_ISO[s(bank.bankCountry)] ?? s(bank.bankCountry) },
    paymentTerms: s(b.paymentTerms),
  };
}

export const CSV_COLUMNS = [
  'ACTION', 'VENDOR_CODE', 'ERP_VENDOR_ID', 'VENDOR_NAME', 'VENDOR_TYPE', 'STATUS', 'HOLD_FLAG', 'HOLD_REASON', 'APPROVED_AT',
  'ADDRESS_LINE1', 'ADDRESS_LINE2', 'CITY', 'STATE', 'POSTAL_CODE', 'COUNTRY', 'CONTACT_NAME', 'CONTACT_EMAIL', 'CONTACT_MOBILE',
  'PAN', 'GSTIN', 'TAN', 'CIN', 'MSME', 'UDYAM_NO', 'BANK_ACCOUNT_NAME', 'BANK_ACCOUNT_NUMBER', 'BANK_NAME', 'BANK_BRANCH', 'IFSC', 'SWIFT', 'IBAN', 'BANK_COUNTRY', 'PAYMENT_TERMS',
] as const;

export function toCsvRow(v: Vendor, action: string) {
  const g = toGenericVendor(v);
  return [action, g.code, g.erpVendorId ?? '', g.name, g.vendorType, g.status, g.blocked ? 'Y' : 'N', g.blockedReason ?? '', g.approvedAt ?? '',
    g.address.line1, g.address.line2, g.address.city, g.address.state, g.address.postalCode, g.address.country, g.contact.name, g.contact.email, g.contact.mobile,
    g.tax.pan, g.tax.gstin, g.tax.tan, g.tax.cin, g.msme ? 'Y' : 'N', g.udyamNumber, g.bank.accountName, g.bank.accountNumber, g.bank.bankName, g.bank.branch, g.bank.ifsc, g.bank.swift, g.bank.iban, g.bank.country, g.paymentTerms];
}

/** RFC 4180 CSV; cells starting with = + - @ are prefixed with ' so spreadsheets don't run them as formulas. */
export function toCsv(rows: (readonly string[])[]) {
  const cell = (x: string) => { let v = x ?? ''; if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`; return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
