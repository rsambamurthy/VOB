import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/lib/db.js';
import { client, login } from './helpers.js';
import { createTenant } from '../src/services/tenants.js';
import { checksForVendor, homeCountries, packFor, toInternational } from '../src/countries/registry.js';
import { validators, crossFieldChecks } from '../src/lib/validators.js';
import { toOracleSupplier } from '../src/lib/erpMapper.js';
import { addWorkingDays, calendarFor } from '../src/lib/calendar.js';
import { templateFor } from '../src/services/config.js';
import type { Vendor } from '../src/db/schema.js';

const vendor = (profile: Record<string, Record<string, unknown>>) => ({ id: 'x', code: 'VND-00001', name: 'T', status: 'APPROVED', erpVendorId: null, blockedAt: null, blockedReason: null, decidedAt: new Date(), profile }) as unknown as Vendor;

describe('UAE and Bahrain packs', () => {
  test('both can host a workspace; both inherit Gulf sanctions screening', () => {
    expect(homeCountries().map((c) => c.code)).toEqual(['IN', 'SA', 'AE', 'BH', 'QA', 'KW', 'OM']);
    expect(packFor('AE')).toMatchObject({ currency: 'AED', timeZoneLabel: 'GST', weekend: [6, 0], skipWeekendsByDefault: true });
    expect(packFor('BH')).toMatchObject({ currency: 'BHD', timeZoneLabel: 'AST', weekend: [5, 6], skipWeekendsByDefault: true });
    const kinds = (home: string, country: string) => checksForVendor(home, { basic: { supplierCountry: country } }).map((c) => c.def.kind);
    expect(kinds('AE', 'United Arab Emirates')).toEqual(['sanctions', 'gcc_iban', 'ae_trn']);
    expect(kinds('BH', 'Bahrain')).toEqual(['sanctions', 'gcc_iban', 'bh_cr', 'bh_vat']);
    expect(kinds('AE', 'Saudi Arabia')).toEqual(['sanctions', 'gcc_iban', 'sa_cr', 'sa_vat', 'ae_trn']); // a Saudi supplier of a UAE buyer
  });

  test('formats: UAE TRN and licence, Bahrain CR and VAT, block numbers, P.O. Box, IBAN by country', () => {
    expect(validators.aeTrn('100123456700003')).toBeNull();
    expect(validators.aeTrn('300123456700003')).toMatch(/starting with 1/);
    expect(validators.vatNumber('100123456700003', { country: 'United Arab Emirates' })).toBeNull();
    expect(validators.vatNumber('300000000000003', { country: 'United Arab Emirates' })).toMatch(/UAE TRN/);
    expect(validators.aeLicence('CN-1234567')).toBeNull();
    expect(validators.bhCr('12345-1')).toBeNull();
    expect(validators.bhCr('12345')).toBeNull();
    expect(validators.bhCr('ABC-1')).toMatch(/12345-1/);
    expect(validators.vatNumber('200000445300002', { country: 'Bahrain' })).toBeNull();
    expect(validators.vatNumber('2000004453', { country: 'Bahrain' })).toMatch(/15 digits/);
    expect(validators.postalCode('428', { country: 'Bahrain' })).toBeNull();
    expect(validators.postalCode('12271', { country: 'Bahrain' })).toMatch(/block/i);
    expect(validators.postalCode('123456', { country: 'United Arab Emirates' })).toBeNull();
    expect(validators.iban('AE070331234567890123456')).toBeNull();
    expect(validators.iban('BH67BMAG00001299123456')).toBeNull();
    expect(crossFieldChecks({ bank: { bankCountry: 'United Arab Emirates', iban: 'BH67BMAG00001299123456' } })[0]?.message).toMatch(/AE and has 23/);
    expect(crossFieldChecks({ bank: { bankCountry: 'Bahrain', iban: 'BH67BMAG00001299123456' } })).toEqual([]);
  });

  test('mobiles: UAE 05x xxx xxxx → +971, Bahrain 3xxx xxxx → +973', () => {
    expect(validators.phone('0501234567', { country: 'United Arab Emirates' })).toBeNull();
    expect(validators.phone('33123456', { country: 'Bahrain' })).toBeNull();
    expect(validators.phone('0501234567', { country: 'Bahrain' })).toMatch(/3xxx xxxx/);
    expect(toInternational('050 123 4567', 'AE')).toBe('971501234567');
    expect(toInternational('3312 3456', 'BH')).toBe('97333123456');
  });

  test('working days: the UAE skips Saturday–Sunday, Bahrain Friday–Saturday', () => {
    const thu = new Date('2026-10-15T09:00:00+04:00');
    expect(addWorkingDays(thu, 1, calendarFor({ country: 'AE', settings: { skipWeekends: true } } as any)).toISOString()).toBe(new Date('2026-10-16T09:00:00+04:00').toISOString()); // Friday is a working day
    const fri = new Date('2026-10-16T09:00:00+04:00');
    expect(addWorkingDays(fri, 1, calendarFor({ country: 'AE', settings: { skipWeekends: true } } as any)).toISOString()).toBe(new Date('2026-10-19T09:00:00+04:00').toISOString()); // → Monday
    expect(addWorkingDays(thu, 1, calendarFor({ country: 'BH', settings: { skipWeekends: true } } as any)).toISOString()).toBe(new Date('2026-10-18T09:00:00+04:00').toISOString()); // → Sunday
  });

  test('templates: trade licence (UAE) and CR (Bahrain) hold the vendor when they lapse', () => {
    const ae = templateFor('AE'), bh = templateFor('BH');
    expect(ae.documents.filter((d) => d.holdOnExpiry).map((d) => d.type)).toEqual(['TRADE_LICENCE']);
    expect(bh.documents.filter((d) => d.holdOnExpiry).map((d) => d.type)).toEqual(['BH_CR_CERT']);
    const ids = (t: typeof ae) => t.sections.flatMap((s) => s.groups.flatMap((g) => g.fields.map((f) => `${s.key}.${f.key}`)));
    expect(ids(ae)).toEqual(expect.arrayContaining(['tax.licenceNumber', 'tax.licenceAuthority', 'tax.ctTrn', 'localContent.icvScore', 'ownership.owner1Name']));
    expect(ids(bh)).toEqual(expect.arrayContaining(['tax.crNumber', 'localContent.bahrainisationPct', 'ownership.owner1Name']));
    expect(packFor('AE').privacy!.defaultNotice('X')).toContain('Federal Decree-Law No. 45 of 2021');
    expect(packFor('BH').privacy!.defaultNotice('X')).toContain('Law No. 30 of 2018');
  });

  test('ERP records: UAE_LOCALIZATION / BAHRAIN_LOCALIZATION, AED / BHD, no foreign-tax block', () => {
    const ae = toOracleSupplier(vendor({ basic: { supplierCountry: 'United Arab Emirates', region: 'Dubai', freeZone: 'No' }, tax: { licenceNumber: '784512', licenceAuthority: 'Dubai Economy and Tourism', vatNumber: '100123456700003' }, bank: { bankCountry: 'United Arab Emirates', iban: 'AE070331234567890123456' } }), { homeCountry: 'AE' }).ERPVendorsData.VENDOR.VENDOR_DATA as any;
    expect(ae.UAE_LOCALIZATION).toMatchObject({ TRADE_LICENCE_NO: '784512', EMIRATE: 'Dubai', TRN: '100123456700003' });
    expect(ae.INVOICE_CURRENCY_CODE).toBe('AED');
    const de = toOracleSupplier(vendor({ basic: { supplierCountry: 'Germany' }, tax: { vatNumber: 'DE1' }, risk: { currency: 'EUR' } }), { homeCountry: 'AE' }).ERPVendorsData.VENDOR.VENDOR_DATA as any;
    expect(de.FOREIGN_TAX).toBeUndefined();
    const bh = toOracleSupplier(vendor({ basic: { supplierCountry: 'Bahrain', postalCode: '428' }, tax: { crNumber: '12345-1', vatNumber: '200000445300002' }, bank: { bankCountry: 'Bahrain' } }), { homeCountry: 'BH' }).ERPVendorsData.VENDOR.VENDOR_DATA as any;
    expect(bh.BAHRAIN_LOCALIZATION).toMatchObject({ CR_NUMBER: '12345-1', VAT_ACCOUNT_NO: '200000445300002', BLOCK: '428' });
    expect(bh.INVOICE_CURRENCY_CODE).toBe('BHD');
  });

  test('a UAE and a Bahrain workspace end to end: template, locale, checks, mobile format, sign-up list', async () => {
    for (const [slug, country, mobile, bad] of [['ae-co', 'AE', '0501234567', '33123456'], ['bh-co', 'BH', '33123456', '0501234567']] as const) {
      const email = `admin@${slug}.test`;
      await createTenant({ slug, name: `${country} Co`, adminName: 'Test Admin', adminEmail: email, adminPassword: 'Demo@12345', country });
      const admin = await login(email, slug, 'Demo@12345');
      const me = (await admin.get('/api/auth/me')).body;
      expect(me.tenant).toMatchObject({ country, currency: packFor(country).currency, privacyLaw: 'PDPL', mobileExample: packFor(country).mobile!.example });
      const t = await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, slug) });
      expect(t!.settings).toMatchObject({ skipWeekends: true });
      expect((await admin.post('/api/staff/vendors', { name: `${country} Bad Mobile`, vendorType: 'DOMESTIC', contactFirstName: 'A', contactLastName: 'B', contactEmail: `bad@${slug}.test`, contactMobile: bad })).status).toBe(400);
      const ok = await admin.post('/api/staff/vendors', { name: `${country} Good Supplier`, vendorType: 'DOMESTIC', contactFirstName: 'A', contactLastName: 'B', contactEmail: `ok@${slug}.test`, contactMobile: mobile });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      const cfg = (await admin.get('/api/config')).body;
      expect(cfg.checks.filter((c: any) => c.home).map((c: any) => c.kind)).toEqual(country === 'AE' ? ['sanctions', 'gcc_iban', 'ae_trn'] : ['sanctions', 'gcc_iban', 'bh_cr', 'bh_vat']);
      // Screening works for a workspace's own suppliers
      expect((await admin.post(`/api/staff/vendors/${ok.body.vendor.id}/verify/sanctions`)).body.status).toBe('VERIFIED');
    }
    const signup = (await client().get('/api/signup/config')).body;
    expect(signup.countries.map((c: any) => c.code)).toEqual(['IN', 'SA', 'AE', 'BH', 'QA', 'KW', 'OM']);
  });
});
