import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/lib/db.js';
import { client, login } from './helpers.js';
import { createTenant } from '../src/services/tenants.js';
import { checksForVendor, packFor, toInternational, checkProvider } from '../src/countries/registry.js';
import { validators, crossFieldChecks } from '../src/lib/validators.js';
import { toOracleSupplier } from '../src/lib/erpMapper.js';
import { addWorkingDays, calendarFor } from '../src/lib/calendar.js';
import { templateFor } from '../src/services/config.js';
import type { Vendor } from '../src/db/schema.js';

const vendor = (profile: Record<string, Record<string, unknown>>) => ({ id: 'x', code: 'VND-00001', name: 'T', status: 'APPROVED', erpVendorId: null, blockedAt: null, blockedReason: null, decidedAt: new Date(), profile }) as unknown as Vendor;
const oracle = (home: string, profile: Record<string, Record<string, unknown>>) => toOracleSupplier(vendor(profile), { homeCountry: home }).ERPVendorsData.VENDOR.VENDOR_DATA as any;
const ids = (t: ReturnType<typeof templateFor>) => t.sections.flatMap((s) => s.groups.flatMap((g) => g.fields.map((f) => `${s.key}.${f.key}`)));

describe('Qatar, Kuwait and Oman packs', () => {
  test('each can host a Gulf workspace with its own currency, time zone and checks', () => {
    expect(packFor('QA')).toMatchObject({ currency: 'QAR', timeZone: 'Asia/Qatar', weekend: [5, 6], skipWeekendsByDefault: true });
    expect(packFor('KW')).toMatchObject({ currency: 'KWD', timeZone: 'Asia/Kuwait', weekend: [5, 6] });
    expect(packFor('OM')).toMatchObject({ currency: 'OMR', timeZone: 'Asia/Muscat', timeZoneLabel: 'GST', weekend: [5, 6] });
    const kinds = (home: string, country: string) => checksForVendor(home, { basic: { supplierCountry: country } }).map((c) => c.def.kind);
    expect(kinds('QA', 'Qatar')).toEqual(['sanctions', 'qa_cr', 'qa_tin']);
    expect(kinds('KW', 'Kuwait')).toEqual(['sanctions', 'kw_cr']);
    expect(kinds('OM', 'Oman')).toEqual(['sanctions', 'om_cr', 'om_vat']);
    expect(kinds('SA', 'Oman')).toEqual(['sanctions', 'sa_cr', 'sa_vat', 'om_cr', 'om_vat']); // an Omani supplier of a Saudi buyer
  });

  test('formats: Qatar TIN/CR/zone, Kuwait CR/postal, Oman CR/VAT/postal, IBANs by country', () => {
    expect(validators.qaTin('5012345671')).toBeNull();
    expect(validators.qaTin('4012345671')).toMatch(/starting with 5/);
    expect(validators.qaCr('123456/1')).toBeNull();
    expect(validators.qaCr('AB-12')).toMatch(/123456/);
    expect(validators.postalCode('63', { country: 'Qatar' })).toBeNull();
    expect(validators.postalCode('12345', { country: 'Qatar' })).toMatch(/zone/i);
    expect(validators.kwCr('123451')).toBeNull();
    expect(validators.kwCr('12')).toMatch(/registration number/);
    expect(validators.postalCode('15300', { country: 'Kuwait' })).toBeNull();
    expect(validators.postalCode('153', { country: 'Kuwait' })).toMatch(/5 digits/);
    expect(validators.omCr('1234567')).toBeNull();
    expect(validators.omCr('12345')).toMatch(/6 to 8/);
    expect(validators.vatNumber('OM1100012379', { country: 'Oman' })).toBeNull();
    expect(validators.vatNumber('1100012379', { country: 'Oman' })).toMatch(/OM followed/);
    expect(validators.postalCode('133', { country: 'Oman' })).toBeNull();
    for (const iban of ['QA58DOHB00001234567890ABCDEFG', 'KW81CBKU0000000000001234560101', 'OM260180000000129912345']) expect(validators.iban(iban)).toBeNull();
    expect(crossFieldChecks({ bank: { bankCountry: 'Qatar', iban: 'OM260180000000129912345' } })[0]?.message).toMatch(/QA and has 29/);
    expect(crossFieldChecks({ bank: { bankCountry: 'Kuwait', iban: 'KW81CBKU0000000000001234560101' } })).toEqual([]);
    expect(crossFieldChecks({ bank: { bankCountry: 'Oman', iban: 'OM260180000000129912345' } })).toEqual([]);
  });

  test('mobiles: +974, +965 and +968, 8 digits each', () => {
    expect(validators.phone('55123456', { country: 'Qatar' })).toBeNull();
    expect(validators.phone('25123456', { country: 'Qatar' })).not.toBeNull();
    expect(validators.phone('55123456', { country: 'Kuwait' })).toBeNull();
    expect(validators.phone('91234567', { country: 'Oman' })).toBeNull();
    expect(validators.phone('51234567', { country: 'Oman' })).not.toBeNull();
    expect(toInternational('5512 3456', 'QA')).toBe('97455123456');
    expect(toInternational('5512 3456', 'KW')).toBe('96555123456');
    expect(toInternational('9123 4567', 'OM')).toBe('96891234567');
  });

  test('working days: Friday–Saturday weekend in all three', () => {
    const thu = new Date('2026-10-15T09:00:00+03:00');
    for (const country of ['QA', 'KW', 'OM']) {
      expect(addWorkingDays(thu, 1, calendarFor({ country, settings: { skipWeekends: true } } as any)).getUTCDay()).toBe(0); // → Sunday
    }
  });

  test('templates: lapsed CR / licence holds the vendor; local fields; privacy laws', () => {
    const qa = templateFor('QA'), kw = templateFor('KW'), om = templateFor('OM');
    expect(qa.documents.filter((d) => d.holdOnExpiry).map((d) => d.type)).toEqual(['QA_CR_CERT', 'QA_LICENCE']);
    expect(kw.documents.filter((d) => d.holdOnExpiry).map((d) => d.type)).toEqual(['KW_LICENCE']);
    expect(om.documents.filter((d) => d.holdOnExpiry).map((d) => d.type)).toEqual(['OM_CR_CERT']);
    expect(ids(qa)).toEqual(expect.arrayContaining(['tax.crNumber', 'tax.licenceNumber', 'tax.establishmentId', 'tax.tinNumber', 'localContent.tawteenRegistered']));
    expect(ids(kw)).toEqual(expect.arrayContaining(['tax.crNumber', 'tax.licenceNumber', 'tax.signatoryName', 'basic.paciNumber', 'localContent.kuwaitizationPct']));
    expect(ids(om)).toEqual(expect.arrayContaining(['tax.crNumber', 'tax.vatNumber', 'localContent.icvScore', 'localContent.omanisationPct']));
    expect(ids(qa)).not.toContain('tax.vatRegistered'); // no VAT in Qatar
    expect(ids(kw)).not.toContain('tax.vatRegistered'); // nor in Kuwait
    expect(packFor('QA').privacy!.defaultNotice('X')).toContain('Law No. 13 of 2016');
    expect(packFor('OM').privacy!.defaultNotice('X')).toContain('Royal Decree 6/2022');
    expect(packFor('KW').privacy!.defaultNotice('X')).toContain('Kuwaiti law');
  });

  test('test-mode registry checks: numbers ending in 0 are not found', async () => {
    const p = checkProvider('QA')!;
    expect((await p.check('qa_cr', { cr: '123456' }, { legalName: 'West Bay' })).status).toBe('VERIFIED');
    expect((await p.check('qa_cr', { cr: '123450' }, { legalName: 'West Bay' })).status).toBe('NOT_FOUND');
    expect((await checkProvider('OM')!.check('om_vat', { vat: 'OM1100012379' }, { legalName: 'X' })).status).toBe('VERIFIED');
  });

  test('ERP records: QATAR / KUWAIT / OMAN_LOCALIZATION and foreign-tax blocks', () => {
    const qa = oracle('QA', { basic: { supplierCountry: 'Qatar', postalCode: '63' }, tax: { crNumber: '123456', licenceNumber: '45871', establishmentId: '23-1234-56', tinNumber: '5012345671' }, bank: { bankCountry: 'Qatar' } });
    expect(qa.QATAR_LOCALIZATION).toMatchObject({ CR_NUMBER: '123456', TIN: '5012345671', ZONE: '63' });
    expect(qa.INVOICE_CURRENCY_CODE).toBe('QAR');
    expect(oracle('QA', { basic: { supplierCountry: 'Germany' }, tax: { foreignTin: 'DE123', hasTrc: 'Yes' }, risk: { currency: 'EUR' } }).FOREIGN_TAX).toMatchObject({ TIN: 'DE123', TRC_HELD: 'Yes' });
    const kw = oracle('KW', { basic: { supplierCountry: 'Kuwait', paciNumber: '12345678' }, tax: { crNumber: '123451', licenceNumber: '2019/4567' }, bank: { bankCountry: 'Kuwait' } });
    expect(kw.KUWAIT_LOCALIZATION).toMatchObject({ CR_NUMBER: '123451', COMMERCIAL_LICENCE_NO: '2019/4567', PACI_NO: '12345678' });
    expect(kw.INVOICE_CURRENCY_CODE).toBe('KWD');
    const om = oracle('OM', { basic: { supplierCountry: 'Oman' }, tax: { crNumber: '1234567', vatNumber: 'OM1100012379' }, localContent: { icvScore: '28' }, bank: { bankCountry: 'Oman' } });
    expect(om.OMAN_LOCALIZATION).toMatchObject({ CR_NUMBER: '1234567', VAT_NUMBER: 'OM1100012379', ICV_SCORE: '28' });
    expect(om.INVOICE_CURRENCY_CODE).toBe('OMR');
  });

  test('Qatar, Kuwait and Oman workspaces end to end: locale, mobile format, checks, screening', async () => {
    const cases = [
      { slug: 'qa-co', country: 'QA', mobile: '55123456', bad: '0501234567', law: 'PDPPL', checks: ['sanctions', 'qa_cr', 'qa_tin'] },
      { slug: 'kw-co', country: 'KW', mobile: '55123456', bad: '0501234567', law: null, checks: ['sanctions', 'kw_cr'] },
      { slug: 'om-co', country: 'OM', mobile: '91234567', bad: '55123456', law: 'PDPL', checks: ['sanctions', 'om_cr', 'om_vat'] },
    ];
    for (const c of cases) {
      const email = `admin@${c.slug}.test`;
      await createTenant({ slug: c.slug, name: `${c.country} Co`, adminName: 'Test Admin', adminEmail: email, adminPassword: 'Demo@12345', country: c.country });
      const admin = await login(email, c.slug, 'Demo@12345');
      const me = (await admin.get('/api/auth/me')).body;
      expect(me.tenant).toMatchObject({ country: c.country, currency: packFor(c.country).currency, privacyLaw: c.law });
      const t = await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, c.slug) });
      expect(t!.settings).toMatchObject({ skipWeekends: true });
      expect((await admin.post('/api/staff/vendors', { name: `${c.country} Bad Mobile`, vendorType: 'DOMESTIC', contactFirstName: 'A', contactLastName: 'B', contactEmail: `bad@${c.slug}.test`, contactMobile: c.bad })).status).toBe(400);
      const ok = await admin.post('/api/staff/vendors', { name: `${c.country} Good Supplier`, vendorType: 'DOMESTIC', contactFirstName: 'A', contactLastName: 'B', contactEmail: `ok@${c.slug}.test`, contactMobile: c.mobile });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      const cfg = (await admin.get('/api/config')).body;
      expect(cfg.checks.filter((x: any) => x.home).map((x: any) => x.kind)).toEqual(c.checks);
      expect(cfg.issues ?? []).toEqual([]);
      expect((await admin.post(`/api/staff/vendors/${ok.body.vendor.id}/verify/sanctions`)).body.status).toBe('VERIFIED');
    }
    const signup = (await client().get('/api/signup/config')).body;
    expect(signup.countries.map((x: any) => x.name)).toEqual(expect.arrayContaining(['Qatar', 'Kuwait', 'Oman']));
  });
});
