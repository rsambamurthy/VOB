import { describe, expect, test } from 'vitest';
import { checkInputs, checkList, homeCountries, localeFor, packFor, packForCountryName, readableDocuments, validatorNames } from '../src/countries/registry.js';
import { validators, crossFieldChecks, UPPERCASE_VALIDATORS } from '../src/lib/validators.js';
import { toOracleSupplier } from '../src/lib/erpMapper.js';
import { templateFor } from '../src/services/config.js';
import { defaultNotice } from '../src/services/privacy.js';
import { client, login } from './helpers.js';
import type { Vendor } from '../src/db/schema.js';

const vendor = (profile: Record<string, Record<string, unknown>>) => ({ id: 'v1', code: 'VND-00099', name: 'Test', status: 'APPROVED', profile, erpVendorId: null, blockedAt: null, blockedReason: null, decidedAt: new Date('2026-01-01') }) as unknown as Vendor;

describe('country packs', () => {
  test('India is a home country; unknown codes fall back to the shared base', () => {
    expect(homeCountries().map((c) => c.code)).toContain('IN');
    expect(packFor('IN')).toMatchObject({ name: 'India', currency: 'INR', locale: 'en-IN' });
    expect(packFor('ZZ').code).toBe('BASE');
    expect(packForCountryName('India').code).toBe('IN');
    expect(packForCountryName('Germany').code).toBe('BASE');
    expect(localeFor('IN')).toMatchObject({ currency: 'INR', locale: 'en-IN', privacyLaw: 'DPDP' });
  });

  test('India inherits the shared formats and adds its own; every format the old app had still exists', () => {
    const before = ['gstin', 'pan', 'tan', 'cin', 'ifsc', 'swift', 'iban', 'upi', 'udyam', 'email', 'phone', 'url', 'postalCode', 'bankAccount', 'year'];
    expect(validatorNames().sort()).toEqual(expect.arrayContaining(before));
    expect(Object.keys(packFor('IN').validators!)).toEqual(expect.arrayContaining(['iban', 'swift', 'gstin']));
    expect([...UPPERCASE_VALIDATORS].sort()).toEqual(['aeLicence', 'cin', 'gstin', 'iban', 'ifsc', 'pan', 'swift', 'tan', 'udyam']);
  });

  test('postal code and bank account follow the supplier country', () => {
    expect(validators.postalCode('411019', { country: 'India' })).toBeNull();
    expect(validators.postalCode('D-10115', { country: 'India' })).toMatch(/PIN/);
    expect(validators.postalCode('D-10115', { country: 'Germany' })).toBeNull();
    expect(validators.bankAccount('GB12AB', { country: 'India' })).toMatch(/9–18 digits/);
    expect(validators.bankAccount('GB12AB', { country: 'United Kingdom' })).toBeNull();
  });

  test('cross-checks: PAN inside the GSTIN', () => {
    expect(crossFieldChecks({ tax: { gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939G' } })[0].field).toBe('tax.gstin');
    expect(crossFieldChecks({ tax: { gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939F' } })).toEqual([]);
  });

  test('online checks are declared by the pack, with the field that gets the button', () => {
    expect(checkList('IN').filter((c) => c.home).map((c) => [c.kind, c.anchor])).toEqual([['gstin', 'tax.gstin'], ['pan', 'tax.pan'], ['bank', 'bank.ifsc'], ['cin', 'tax.cin']]);
    const bank = checkList().find((c) => c.kind === 'bank')!;
    expect(checkInputs(bank as any, { bank: { accountNumber: '50100123456789', ifsc: 'HDFC0001234' } })).toEqual({ accountNumber: '50100123456789', ifsc: 'HDFC0001234' });
    expect(Object.keys(readableDocuments())).toEqual(expect.arrayContaining(['GST_CERT', 'PAN_CARD', 'CANCELLED_CHEQUE', 'INCORPORATION_CERT', 'MSME_CERT']));
  });

  test('ERP export: the home country decides "domestic"; the bank country decides the branch code', () => {
    const indian = vendor({ basic: { supplierCountry: 'India', msmeRegistered: 'Yes', udyamNumber: 'UDYAM-MH-01-0000001' }, tax: { gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939F' }, bank: { bankCountry: 'India', ifsc: 'HDFC0001234', routingNumber: 'X' } });
    const inIndia = toOracleSupplier(indian, { homeCountry: 'IN' }).ERPVendorsData.VENDOR.VENDOR_DATA as any;
    expect(inIndia.INDIA_LOCALIZATION).toMatchObject({ GSTIN: '27AAPFU0939F1ZV', PAN_NO: 'AAPFU0939F', MSME_UDYAM_NO: 'UDYAM-MH-01-0000001' });
    expect(inIndia.FOREIGN_TAX).toBeUndefined();
    expect(inIndia.INVOICE_CURRENCY_CODE).toBe('INR');
    expect(inIndia.TCA_SYNC_VAT_REG_NUM).toBe('27AAPFU0939F1ZV');
    const bankRow = inIndia.VENDOR_SITES.SITE_DATA[0].VENDOR_BANKS.BANK_DATA[0];
    expect(bankRow).toMatchObject({ BRANCH_NUMBER: 'HDFC0001234', PAYMENT_METHOD: 'EFT', BANK_COUNTRY: 'IN' });

    // The same Indian supplier for a workspace elsewhere is foreign — but its Indian bank still uses IFSC.
    const abroad = toOracleSupplier(indian, { homeCountry: 'ZZ' }).ERPVendorsData.VENDOR.VENDOR_DATA as any;
    expect(abroad.INDIA_LOCALIZATION).toBeUndefined();
    expect(abroad.VENDOR_SITES.SITE_DATA[0].VENDOR_BANKS.BANK_DATA[0]).toMatchObject({ BRANCH_NUMBER: 'HDFC0001234', PAYMENT_METHOD: 'WIRE' });

    // A foreign supplier for an Indian workspace carries India's withholding-tax block.
    const german = vendor({ basic: { supplierCountry: 'Germany' }, tax: { vatNumber: 'DE123', foreignTin: 'T1', hasTrc: 'Yes' }, bank: { bankCountry: 'Germany', routingNumber: '1000' }, risk: { currency: 'EUR' } });
    const g = toOracleSupplier(german, { homeCountry: 'IN' }).ERPVendorsData.VENDOR.VENDOR_DATA as any;
    expect(g.FOREIGN_TAX).toMatchObject({ TIN: 'T1', TRC_HELD: 'Yes' });
    expect(g.TCA_SYNC_VAT_REG_NUM).toBe('DE123');
    expect(g.VENDOR_SITES.SITE_DATA[0].VENDOR_BANKS.BANK_DATA[0].BRANCH_NUMBER).toBe('1000');
  });

  test('home pack supplies the template and the privacy notice', () => {
    const t = templateFor('IN');
    expect(t.sections.map((s) => s.key)).toEqual(['basic', 'bank', 'tax', 'risk']);
    expect(t.documents.some((d) => d.type === 'GST_CERT')).toBe(true);
    t.sections.pop();
    expect(templateFor('IN').sections).toHaveLength(4); // a fresh copy every time
    expect(defaultNotice('Acme', undefined, 'IN')).toContain('GSTIN');
  });

  test('workspaces get India by default; other home countries are refused until their pack exists', async () => {
    const me = (await (await login('admin@acme.test')).get('/api/auth/me')).body;
    expect(me.tenant).toMatchObject({ country: 'IN', currency: 'INR', locale: 'en-IN' });
    const { createTenant } = await import('../src/services/tenants.js');
    await expect(createTenant({ slug: 'amman-co', name: 'Amman Co', adminName: 'A B', adminEmail: 'a@amman.test', country: 'JO' })).rejects.toThrow(/can’t be set up in JO/);
    expect(client).toBeDefined();
  });
});
