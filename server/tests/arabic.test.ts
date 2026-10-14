import { beforeAll, describe, expect, test } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { db, schema } from '../src/lib/db.js';
import { client, lastLinkTo, login, tokenOf } from './helpers.js';
import { createTenant } from '../src/services/tenants.js';
import { templateFor } from '../src/services/config.js';
import { localizeConfig, translateMessage, vendorLanguage } from '../src/i18n/index.js';
import { emailText } from '../src/i18n/emails.js';
import { hijriToGregorian, latinDigits, normaliseExtracted } from '../src/i18n/digits.js';
import { collect, parseCsv, problem, toCsv } from '../scripts/i18n.js';

const PASSWORD = 'Demo@12345';
const WS = 'najd-ar-test';
const ADMIN = 'admin@najdar.test';

beforeAll(async () => {
  await createTenant({ slug: WS, name: 'Najd Arabic Co', adminName: 'Sara', adminEmail: ADMIN, adminPassword: PASSWORD, country: 'SA' });
});

const lastMail = (to: string) => db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, to), orderBy: desc(schema.emailOutbox.createdAt) });

describe('Arabic text', () => {
  test('server messages: exact, with {values}, and several sentences', () => {
    expect(translateMessage('Enter a valid email address', 'ar')).toBe('أدخلوا بريداً إلكترونياً صحيحاً');
    expect(translateMessage('Enter a valid email address', 'en')).toBe('Enter a valid email address');
    expect(translateMessage('VAT Registration Number is required', 'ar')).toMatch(/مطلوب$/);
    expect(translateMessage('Enter a valid email address. Enter a valid year', 'ar')).toBe('أدخلوا بريداً إلكترونياً صحيحاً. أدخلوا سنة صحيحة');
    expect(translateMessage('Something nobody translated', 'ar')).toBe('Something nobody translated');
    expect(translateMessage('1 document expired', 'ar')).toBe('انتهت صلاحية مستند واحد');
    expect(translateMessage('3 documents expired', 'ar')).toBe('انتهت صلاحية 3 مستندات');
  });

  test('the Saudi form in Arabic keeps English values and adds option labels', () => {
    const cfg = templateFor('SA');
    const ar = localizeConfig(cfg, 'ar');
    const field = (c: typeof cfg, key: string) => c.sections.flatMap((s) => s.groups.flatMap((g) => g.fields)).find((f) => f.key === key)!;
    expect(field(ar, 'vatRegistered').label).toBe('هل المنشأة مسجلة في ضريبة القيمة المضافة؟');
    expect(field(ar, 'vatRegistered').options).toEqual(field(cfg, 'vatRegistered').options); // stored values stay English
    expect((field(ar, 'vatRegistered') as any).optionLabels.every((l: string) => /[؀-ۿ]/.test(l))).toBe(true);
    // A workspace's own Arabic wins over the built-in wording.
    const own = structuredClone(cfg);
    field(own, 'vatRegistered').tr = { ar: { label: 'مسجل في الضريبة؟' } };
    expect(field(localizeConfig(own, 'ar'), 'vatRegistered').label).toBe('مسجل في الضريبة؟');
    expect(localizeConfig(cfg, 'en')).toBe(cfg);
  });

  test('emails come in both languages with the same {values}', () => {
    const ar = emailText('ar', 'otp', { code: '123456', buyer: 'Najd' });
    expect(ar.body).toContain('123456');
    expect(ar.subject).toContain('Najd');
    expect(emailText('en', 'otp', { code: '1', buyer: 'B' }).subject).toBe('Your B supplier portal sign-in code');
  });

  test('every supplier-facing text has Arabic with matching {placeholders}', () => {
    const bad = collect().filter((r) => problem(r)).map((r) => `${r.area} ${r.key}: ${problem(r)}`);
    expect(bad).toEqual([]);
  });

  test('the translation spreadsheet survives a CSV round trip (quotes, commas, new lines, Arabic)', () => {
    const rows = [{ area: 'email', key: 'x.body', en: 'Dear {first},\n\n"Hi", there', ar: 'مرحباً {first}،\n\n«أهلاً»، "هنا"' }];
    const parsed = parseCsv(toCsv(rows));
    expect(parsed[0]).toEqual(['Area', 'Key', 'English', 'Arabic', 'Status']);
    expect(parsed[1].slice(0, 4)).toEqual([rows[0].area, rows[0].key, rows[0].en.replace(/\n/g, '\n'), rows[0].ar]);
  });

  test('reading Arabic documents: Arabic-Indic digits and Hijri dates', () => {
    expect(latinDigits('٣٠٠٠٠٠٠٠٠٠٠٠٠٠٣')).toBe('300000000000003');
    expect(latinDigits('۱۲۳')).toBe('123');
    expect(hijriToGregorian(1445, 9, 1)).toBe('2024-03-11'); // 1 Ramadan 1445
    expect(normaliseExtracted('H:1445-09-01')).toBe('2024-03-11');
    expect(normaliseExtracted('H:1445-13-01')).toBe('H:1445-13-01'); // not a date — left for a person to read
    expect(normaliseExtracted(' 2026-01-31 ')).toBe('2026-01-31');
  });
});

describe('Arabic supplier portal', () => {
  test('a supplier invited in Arabic gets Arabic emails, form, notice and errors; can switch to English', async () => {
    const admin = await login(ADMIN, WS, PASSWORD);
    const email = 'arabic@alnoor.test';
    const created = await admin.post('/api/staff/vendors', { name: 'Al Noor Arabic', vendorType: 'DOMESTIC', contactFirstName: 'Fahad', contactLastName: 'Al-Harbi', contactEmail: email, contactMobile: '966501234567', language: 'ar' });
    expect(created.status).toBe(201);
    expect((await lastMail(email))!.subject).toMatch(/دعوة/);

    const token = tokenOf((await lastLinkTo(email))!);
    const v = client();
    const inv = (await v.get(`/api/vendor-auth/invite/${token}`)).body;
    expect(inv).toMatchObject({ language: 'ar', buyer: { languages: ['en', 'ar'] } });
    const { devOtp } = (await v.post('/api/vendor-auth/request-otp', { token })).body;
    expect((await lastMail(email))!.subject).toMatch(/رمز/);
    await v.post('/api/vendor-auth/verify-otp', { token, code: devOtp });

    const me = (await v.get('/api/vendor')).body;
    expect(me.language).toBe('ar');
    expect(me.privacy.text).toMatch(/[؀-ۿ]/);
    const labels = me.config.sections.flatMap((s: any) => s.groups.flatMap((g: any) => g.fields.map((f: any) => f.label)));
    expect(labels).toContain('هل المنشأة مسجلة في ضريبة القيمة المضافة؟');

    await v.post('/api/vendor/consent', { version: me.privacy.version });
    // The checklist and errors come back in Arabic.
    const saved = await v.put('/api/vendor/profile/tax', { crNumber: '12' });
    expect(saved.body.checklist.find((c: any) => c.id === 'basic.entityType').message).toBe('الشكل القانوني مطلوب');
    const sub = await v.agent.post('/api/vendor/submit').set({ 'X-Requested-With': 'fetch', 'X-Lang': 'ar' }).send({});
    expect(sub.status).toBe(422);
    expect(sub.body.error).toBe('يرجى إكمال جميع الحقول المطلوبة قبل الإرسال');

    expect((await v.put('/api/vendor/language', { language: 'en' })).body).toEqual({ language: 'en' });
    const en = (await v.get('/api/vendor')).body;
    expect(en.language).toBe('en');
    expect(en.config.sections.flatMap((s: any) => s.groups.flatMap((g: any) => g.fields.map((f: any) => f.label)))).toContain('Registered for VAT?');
    const row = await db.query.vendors.findFirst({ where: eq(schema.vendors.contactEmail, email) });
    expect(row!.language).toBe('en');
  });

  test('Arabic is only offered where the country has it', async () => {
    expect(vendorLanguage({ country: 'IN', settings: {} } as any, { language: 'ar' })).toBe('en');
    expect(vendorLanguage({ country: 'SA', settings: { supplierLanguage: 'ar' } } as any, { language: null })).toBe('ar');
    expect(vendorLanguage({ country: 'SA', settings: {} } as any, { language: null })).toBe('en');
  });
});
