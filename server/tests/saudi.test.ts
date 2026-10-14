import { beforeAll, describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../src/lib/db.js';
import { client, lastLinkTo, login, tokenOf } from './helpers.js';
import { createTenant } from '../src/services/tenants.js';
import { checksForVendor, packFor, toInternational, validatorNames } from '../src/countries/registry.js';
import { validators, crossFieldChecks } from '../src/lib/validators.js';
import { toOracleSupplier } from '../src/lib/erpMapper.js';
import { addWorkingDays, addWorkingHours, calendarFor } from '../src/lib/calendar.js';
import { runExpiryReminders } from '../src/services/lifecycle.js';
import type { Vendor } from '../src/db/schema.js';

const PDF = '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF';
const PASSWORD = 'Demo@12345';
const WS = 'najd-test';
const ADMIN = 'admin@najdtest.test';
let tenantId = '';

beforeAll(async () => {
  const r = await createTenant({ slug: WS, name: 'Najd Industrial Co', adminName: 'Sara Al-Qahtani', adminEmail: ADMIN, adminPassword: PASSWORD, country: 'SA' });
  tenantId = r.tenant.id;
  // One person holds every review role so the test can approve all levels.
  for (const key of ['TAX_MANAGER', 'FINANCE_MANAGER', 'MDM_MANAGER']) await db.insert(schema.userRoles).values({ userId: r.admin.id, roleId: r.roles.find((x) => x.key === key)!.id });
});

describe('Saudi Arabia pack', () => {
  test('formats: VAT 15 digits starting and ending with 3, CR 10 digits, 5-digit postal code, Saudi IBAN', () => {
    expect(validatorNames()).toEqual(expect.arrayContaining(['saVat', 'saCr', 'vatNumber']));
    expect(validators.saVat('300000000000003')).toBeNull();
    expect(validators.saVat('310000000000002')).toMatch(/start and end with 3/);
    expect(validators.saCr('7001234567')).toBeNull();
    expect(validators.saCr('70012')).toMatch(/10 digits/);
    expect(validators.postalCode('12271', { country: 'Saudi Arabia' })).toBeNull();
    expect(validators.postalCode('411001', { country: 'Saudi Arabia' })).toMatch(/5 digits/);
    expect(validators.vatNumber('300000000000003', { country: 'Saudi Arabia' })).toBeNull();
    expect(validators.vatNumber('DE123456789', { country: 'Germany' })).toBeNull();
    expect(validators.vatNumber('DE123456789', { country: 'Saudi Arabia' })).toMatch(/start and end with 3/);
    expect(crossFieldChecks({ bank: { bankCountry: 'Saudi Arabia', iban: 'AE070331234567890123456' } })[0]?.field).toBe('bank.iban');
  });

  test('mobile numbers follow the country: Saudi 05x format, +966 for SMS; India unchanged', async () => {
    expect(validators.phone('0501234567', { country: 'Saudi Arabia' })).toBeNull();
    expect(validators.phone('966501234567', { country: 'Saudi Arabia' })).toBeNull();
    expect(validators.phone('9876543210', { country: 'Saudi Arabia' })).toMatch(/05x xxx xxxx/);
    expect(validators.phone('+91 98765 43210', { country: 'Saudi Arabia' })).toBeNull();
    expect(validators.phone('9876543210', { country: 'India' })).toBeNull();
    expect(validators.phone('02012345678', { country: 'India' })).toBeNull();
    expect(toInternational('050 123 4567', 'SA')).toBe('966501234567');
    expect(toInternational('501234567', 'SA')).toBe('966501234567');
    expect(toInternational('98765 43210', 'IN')).toBe('919876543210');
    expect(toInternational('+44 7700 900123', 'SA')).toBe('447700900123');
    const admin = await login(ADMIN, WS, PASSWORD);
    const bad = await admin.post('/api/staff/vendors', { name: 'Wrong Number Co', vendorType: 'DOMESTIC', contactFirstName: 'A', contactLastName: 'B', contactEmail: 'a@wrong.test', contactMobile: '9876543210' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Saudi Arabia mobile numbers look like/);
    expect((await (await login(ADMIN, WS, PASSWORD)).get('/api/auth/me')).body.tenant.mobileExample).toBe('05x xxx xxxx');
  });

  test('a Saudi workspace gets the Saudi template, SAR, AST and working-day deadlines', async () => {
    const t = await db.query.tenants.findFirst({ where: eq(schema.tenants.id, tenantId) });
    expect(t).toMatchObject({ country: 'SA', settings: { skipWeekends: true } });
    const admin = await login(ADMIN, WS, PASSWORD);
    const me = (await admin.get('/api/auth/me')).body;
    expect(me.tenant).toMatchObject({ country: 'SA', currency: 'SAR', privacyLaw: 'PDPL' });
    const cfg = (await admin.get('/api/config')).body;
    const fields = cfg.config.sections.flatMap((s: any) => s.groups.flatMap((g: any) => g.fields.map((f: any) => `${s.key}.${f.key}`)));
    expect(fields).toEqual(expect.arrayContaining(['basic.nameArabic', 'tax.crNumber', 'tax.vatNumber', 'ownership.owner1Name', 'localContent.nitaqatBand']));
    expect(fields).not.toContain('tax.gstin');
    expect(cfg.config.documents.filter((d: any) => d.holdOnExpiry).map((d: any) => d.type)).toEqual(['CR_CERT', 'ZAKAT_CERT', 'GOSI_CERT', 'NITAQAT_CERT']);
    expect(cfg.checks.filter((c: any) => c.home).map((c: any) => c.kind)).toEqual(['sanctions', 'gcc_iban', 'sa_cr', 'sa_vat']);
    // The configuration editor accepts the template as is.
    expect((await admin.get('/api/admin/config')).body.meta.coreFields).toContain('tax.crNumber');
    const privacy = (await admin.get('/api/admin/privacy')).body;
    expect(privacy.template).toContain('Personal Data Protection Law');
  });

  test('Friday and Saturday are skipped when counting deadlines', () => {
    const cal = calendarFor({ country: 'SA', settings: { skipWeekends: true } } as any);
    const thu = new Date('2026-10-15T09:00:00+03:00'); // Thursday morning in Riyadh
    expect(addWorkingDays(thu, 1, cal).toISOString()).toBe(new Date('2026-10-18T09:00:00+03:00').toISOString()); // → Sunday
    expect(addWorkingHours(thu, 24, cal).toISOString()).toBe(new Date('2026-10-18T09:00:00+03:00').toISOString());
    const plain = calendarFor({ country: 'SA', settings: {} } as any);
    expect(addWorkingDays(thu, 1, plain).toISOString()).toBe(new Date('2026-10-16T09:00:00+03:00').toISOString());
    expect(calendarFor({ country: 'IN', settings: {} } as any).weekend).toEqual([]);
  });

  test('checks follow the workspace and the supplier: Gulf screening for all, GSTIN only for Indian suppliers', () => {
    const kinds = (home: string, country: string) => checksForVendor(home, { basic: { supplierCountry: country } }).map((c) => c.def.kind);
    expect(kinds('SA', 'Saudi Arabia')).toEqual(['sanctions', 'gcc_iban', 'sa_cr', 'sa_vat']);
    expect(kinds('SA', 'India')).toEqual(['gstin', 'pan', 'bank', 'cin', 'sanctions', 'gcc_iban', 'sa_cr', 'sa_vat']);
    expect(kinds('IN', 'India')).toEqual(['gstin', 'pan', 'bank', 'cin']);
    expect(kinds('IN', 'Saudi Arabia')).toEqual(['gstin', 'pan', 'bank', 'cin', 'sa_cr', 'sa_vat']);
    expect(kinds('IN', 'Germany')).toEqual(['gstin', 'pan', 'bank', 'cin']);
  });

  test('ERP record carries SAUDI_LOCALIZATION for Saudi suppliers of a Saudi workspace', () => {
    const v = { id: 'x', code: 'VND-00001', name: 'Al Noor', status: 'APPROVED', erpVendorId: null, blockedAt: null, blockedReason: null, decidedAt: new Date(),
      profile: { basic: { supplierCountry: 'Saudi Arabia', nameArabic: 'شركة النور', isSme: 'Yes' }, tax: { crNumber: '7001234567', vatNumber: '300000000000003' }, bank: { bankCountry: 'Saudi Arabia', iban: 'SA0380000000608010167519' }, localContent: { nitaqatBand: 'Platinum' } } } as unknown as Vendor;
    const d = toOracleSupplier(v, { homeCountry: 'SA' }).ERPVendorsData.VENDOR.VENDOR_DATA as any;
    expect(d.SAUDI_LOCALIZATION).toMatchObject({ CR_NUMBER: '7001234567', VENDOR_NAME_AR: 'شركة النور', NITAQAT_BAND: 'Platinum', SME_FLAG: 'Y' });
    expect(d.TCA_SYNC_VAT_REG_NUM).toBe('300000000000003');
    expect(d.INVOICE_CURRENCY_CODE).toBe('SAR');
    expect(d.VENDOR_SITES.SITE_DATA[0].VENDOR_BANKS.BANK_DATA[0]).toMatchObject({ IBAN: 'SA0380000000608010167519', PAYMENT_METHOD: 'EFT', BANK_COUNTRY: 'SA' });
    expect(packFor('SA').timeZoneLabel).toBe('AST');
  });

  test('Saudi supplier end to end: screened on submit, approved, held when Zakat lapses, released on renewal', async () => {
    const admin = await login(ADMIN, WS, PASSWORD);
    const email = 'procurement@alnoor.test';
    const created = await admin.post('/api/staff/vendors', { name: 'Al Noor Trading Co', vendorType: 'DOMESTIC', contactFirstName: 'Fahad', contactLastName: 'Al-Harbi', contactEmail: email, contactMobile: '966501234567' });
    expect(created.status).toBe(201);
    const id = created.body.vendor.id;
    const vendorRow = await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) });
    expect((vendorRow!.profile as any).basic.supplierCountry).toBe('Saudi Arabia'); // domestic = home country

    const token = tokenOf((await lastLinkTo(email))!);
    const v = client();
    const { devOtp } = (await v.post('/api/vendor-auth/request-otp', { token })).body;
    await v.post('/api/vendor-auth/verify-otp', { token, code: devOtp });
    const me = (await v.get('/api/vendor')).body;
    expect(me.privacy.text).toContain('PDPL');
    expect(me.buyer).toMatchObject({ currency: 'SAR', country: 'SA' });
    await v.post('/api/vendor/consent', { version: me.privacy.version });

    const put = async (sec: string, body: object) => { const r = await v.put(`/api/vendor/profile/${sec}`, body); expect(r.status, JSON.stringify(r.body)).toBe(200); };
    await put('basic', { nameArabic: 'شركة النور للتجارة', entityType: 'Limited Liability Company (LLC)', address: '8228 King Fahd Road', region: 'Riyadh Region', district: 'Riyadh', postalCode: '12271', supplyCategory: 'Goods' });
    await put('bank', { bankName: 'Al Rajhi Bank', accountHolderName: 'Al Noor Trading Co', iban: 'SA0380000000608010167519' });
    await put('tax', { crNumber: '7001234567', vatRegistered: 'Yes', vatNumber: '300000000000003' });
    await put('ownership', { owner1Name: 'Fahad Al-Harbi', owner1Nationality: 'Saudi', owner1Share: '100', moreOwners: 'No', pep: 'No', relatedToBuyer: 'No' });
    await put('localContent', { nitaqatBand: 'High Green' });
    await put('risk', { fiscalYearEnd: 'December', currency: 'SAR', turnoverYear: 'FY 2025', annualTurnover: '25000000', sourceOfInfo: 'Audited financial statements', hasRating: 'No', bankruptcy5y: 'No', litigation: 'No' });

    // CR and VAT checks (test mode) from the Verify buttons
    expect((await v.post('/api/vendor/verify/sa_cr', { cr: '7001234567' })).body.status).toBe('VERIFIED');
    expect((await v.post('/api/vendor/verify/sa_vat', { vat: '300000000000003' })).body.status).toBe('VERIFIED');
    expect((await v.post('/api/vendor/verify/gstin', { gstin: 'X' })).status).toBe(200); // India's check still exists (for Indian suppliers)

    const nextYear = `${new Date().getFullYear() + 1}-06-30`;
    const up = async (type: string, expiresOn?: string) => {
      const r = v.agent.post('/api/vendor/documents').set('X-Requested-With', 'fetch').field('docType', type);
      if (expiresOn) r.field('expiresOn', expiresOn);
      const res = await r.attach('file', Buffer.from(PDF), { filename: `${type}.pdf`, contentType: 'application/pdf' });
      expect(res.status, `${type}: ${JSON.stringify(res.body)}`).toBe(201);
      return res.body;
    };
    for (const t of ['CR_CERT', 'ZAKAT_CERT', 'GOSI_CERT', 'NITAQAT_CERT']) await up(t, nextYear);
    for (const t of ['NATIONAL_ADDRESS', 'VAT_CERT', 'BANK_LETTER', 'UBO_DECLARATION']) await up(t);
    const sub = await v.post('/api/vendor/submit');
    expect(sub.status, JSON.stringify(sub.body)).toBe(200);

    // Suppliers never see or run the buyer's sanctions screening
    expect((await v.post('/api/vendor/verify/sanctions', { name: 'x' })).status).toBe(404);
    expect((await v.get('/api/vendor')).body.verifiable.map((c: any) => c.kind)).not.toContain('sanctions');
    expect((await v.get('/api/vendor')).body.checks.map((c: any) => c.kind)).not.toContain('sanctions');
    // Sanctions screening ran automatically on submit
    const detail = (await admin.get(`/api/staff/vendors/${id}`)).body;
    expect(detail.checks.find((c: any) => c.kind === 'sanctions')).toMatchObject({ status: 'VERIFIED' });
    for (let i = 0; i < 3; i++) expect((await admin.post(`/api/staff/vendors/${id}/decision`, { action: 'APPROVE' })).status).toBe(200);
    expect((await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) }))!.status).toBe('APPROVED');

    // The Zakat certificate lapses → automatic hold
    const zakat = await db.query.documents.findFirst({ where: and(eq(schema.documents.vendorId, id), eq(schema.documents.docType, 'ZAKAT_CERT')) });
    await db.update(schema.documents).set({ expiresOn: '2020-01-01', expiryNotified: 0 }).where(eq(schema.documents.id, zakat!.id));
    await runExpiryReminders();
    let row = await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) });
    expect(row).toMatchObject({ blockSource: 'EXPIRY', blockedReason: 'Expired: Zakat certificate (ZATCA)' });
    expect(row!.blockedAt).not.toBeNull();
    const held = (await v.get('/api/vendor')).body.lifecycle;
    expect(held).toMatchObject({ blocked: true, hold: { reason: 'Expired: Zakat certificate (ZATCA)' } });

    // A manual block is never touched by the expiry logic; the supplier can still send the renewal while on an expiry hold
    const renewal = v.agent.post('/api/vendor/documents').set('X-Requested-With', 'fetch').field('docType', 'ZAKAT_CERT').field('expiresOn', nextYear);
    const doc = (await renewal.attach('file', Buffer.from(PDF), { filename: 'zakat-2027.pdf', contentType: 'application/pdf' })).body;
    const cr = await v.post('/api/vendor/change-requests', { changes: {}, note: 'Renewed Zakat certificate' });
    expect(cr.status, JSON.stringify(cr.body)).toBe(201);
    expect(doc.id).toBeDefined();
    // Approve the change request at every level it needs
    for (let i = 0; i < 3; i++) {
      const crs = (await admin.get(`/api/staff/vendors/${id}`)).body.changeRequests ?? [];
      const open = crs.find((c: any) => c.status === 'PENDING');
      if (!open) break;
      expect((await admin.post(`/api/staff/change-requests/${open.id}/decision`, { action: 'APPROVE' })).status).toBe(200);
    }
    row = await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) });
    expect(row).toMatchObject({ blockedAt: null, blockSource: null });
    const audit = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.vendorId, id), eq(schema.auditLogs.action, 'VENDOR_HOLD_RELEASED')));
    expect(audit).toHaveLength(1);
  });

  test('sanctions screening: a test-list name comes back as a possible match', async () => {
    const admin = await login(ADMIN, WS, PASSWORD);
    const created = await admin.post('/api/staff/vendors', { name: 'Embargo Test Shipping LLC', vendorType: 'DOMESTIC', contactFirstName: 'Test', contactLastName: 'Match', contactEmail: 'ops@embargo.test', contactMobile: '966501112223' });
    const r = await admin.post(`/api/staff/vendors/${created.body.vendor.id}/verify/sanctions`);
    expect(r.body).toMatchObject({ status: 'NOT_FOUND' });
    expect(r.body.message).toMatch(/Possible match/);
    // Indian workspaces don't offer Gulf screening
    expect((await (await login('admin@acme.test')).post(`/api/staff/vendors/${created.body.vendor.id}/verify/sanctions`)).status).toBe(404);
  });
});
