/** Buyer fills in for the supplier; suppliers invited from Excel; existing suppliers imported as approved. */
import { describe, expect, test } from 'vitest';
import ExcelJS from 'exceljs';
import { and, desc, eq } from 'drizzle-orm';
import { lastLinkTo, login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import { gstinCheckChar } from '../src/lib/validators.js';

const PDF = '%PDF-1.4\n%%EOF';
const binary = (res: any, cb: (e: Error | null, b: Buffer) => void) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); };
type Admin = Awaited<ReturnType<typeof login>>;
async function template(admin: Admin, mode: 'invite' | 'approved') {
  const r = await admin.agent.get(`/api/staff/vendor-import/template.xlsx?mode=${mode}`).set('X-Requested-With', 'fetch').buffer(true).parse(binary);
  expect(r.status).toBe(200);
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.body); return wb;
}
const headers = (ws: ExcelJS.Worksheet) => { const h: string[] = []; ws.getRow(1).eachCell((c, i) => { h[i] = String(c.text); }); return h; };
/** Types a supplier into the next empty row (like a person would; the template's drop-downs cover 1,000 rows). */
const put = (ws: ExcelJS.Worksheet, values: Record<string, string>) => {
  const h = headers(ws); let n = 3; while (ws.getRow(n).getCell(1).text) n++;
  h.forEach((name, i) => { const k = Object.keys(values).find((x) => name === x || name?.endsWith(`[${x}]`)); if (k) ws.getRow(n).getCell(i).value = values[k]; });
};
/** Clears a row (like selecting it and pressing Delete). */
const clear = (ws: ExcelJS.Worksheet, n: number) => { ws.getRow(n).eachCell((c) => { c.value = null; }); };
async function send(admin: Admin, wb: ExcelJS.Workbook, mode: string, extra = '') {
  return (await admin.agent.post(`/api/staff/vendor-import?mode=${mode}${extra}`).set('X-Requested-With', 'fetch').attach('file', Buffer.from(await wb.xlsx.writeBuffer()), 'suppliers.xlsx')).body;
}
const gstin = (pan: string) => { const g = `27${pan}1Z`; return g + gstinCheckChar(g); };

describe('buyer fills in the form for the supplier', () => {
  test('saves tabs and documents, keeps masked numbers, and submits with the buyer’s confirmation', async () => {
    const admin = await login('admin@acme.test');
    const id = (await admin.post('/api/staff/vendors', { name: 'Assisted Agro Ltd', vendorType: 'DOMESTIC', contactFirstName: 'Ravi', contactLastName: 'K', contactEmail: 'ravi@assisted.test', contactMobile: '9800044455', notify: false })).body.vendor.id;
    const pan = 'AAFCA1234Q';
    await admin.put(`/api/staff/vendors/${id}/assist/profile/basic`, { entityType: 'Company (Pvt / Public Ltd)', address: '1 Main Rd', region: 'Maharashtra', district: 'Pune', postalCode: '411001', msmeRegistered: 'No', supplyCategory: 'Goods' });
    const bank = (await admin.put(`/api/staff/vendors/${id}/assist/profile/bank`, { bankName: 'HDFC Bank', accountHolderName: 'Assisted Agro Ltd', accountNumber: '501000123456', bankBranch: 'Pune', ifsc: 'HDFC0000001' })).body;
    expect(bank.profile.bank.accountNumber).not.toBe('501000123456'); // shown masked to staff
    // Saving the tab again with the masked number keeps the real one.
    await admin.put(`/api/staff/vendors/${id}/assist/profile/bank`, { ...bank.profile.bank, bankBranch: 'Pune Camp' });
    await admin.put(`/api/staff/vendors/${id}/assist/profile/tax`, { hasGst: 'Yes', gstin: gstin(pan), gstClassification: 'Regular', pan, cin: 'U74999MH2015PTC123457' });
    await admin.put(`/api/staff/vendors/${id}/assist/profile/risk`, { fiscalYearEnd: 'March', currency: 'INR', turnoverYear: 'FY 2024-25', annualTurnover: '9000000', sourceOfInfo: 'Audited financial statements', hasRating: 'No', bankruptcy5y: 'No', litigation: 'No' });
    const early = await admin.post(`/api/staff/vendors/${id}/assist/submit`, { confirm: true });
    expect(early.status).toBe(422); // documents missing
    for (const t of ['PAN_CARD', 'GST_CERT', 'CANCELLED_CHEQUE', 'INCORPORATION_CERT']) {
      expect((await admin.agent.post(`/api/staff/vendors/${id}/assist/documents`).set('X-Requested-With', 'fetch').field('docType', t).attach('file', Buffer.from(PDF), { filename: 'd.pdf', contentType: 'application/pdf' })).status).toBe(201);
    }
    expect((await admin.post(`/api/staff/vendors/${id}/assist/submit`, {})).status).toBe(400); // confirmation needed
    expect((await admin.post(`/api/staff/vendors/${id}/assist/submit`, { confirm: true })).status).toBe(200);
    const v = (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) }))!;
    expect(v.status).toBe('UNDER_REVIEW');
    expect((v.profile as any).bank).toMatchObject({ accountNumber: '501000123456', bankBranch: 'Pune Camp' });
    expect(v.consentIp).toBe('buyer: Anita Rao');
    const actions = (await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.vendorId, id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['CONSENT_RECORDED_BY_BUYER', 'SUBMITTED', 'DOCUMENT_UPLOADED']));
    // Once submitted, the buyer can't keep editing through this route.
    expect((await admin.put(`/api/staff/vendors/${id}/assist/profile/basic`, { address: 'x' })).status).toBe(409);
  });
});

describe('suppliers from Excel', () => {
  test('invite: every row checked first; then created, invited or not per row', async () => {
    const admin = await login('admin@acme.test');
    const wb = await template(admin, 'invite');
    const ws = wb.getWorksheet('Suppliers')!;
    expect(headers(ws)).toEqual(expect.arrayContaining(['Supplier name', 'Vendor type', 'Contact mobile', 'Send invitation']));
    put(ws, { 'Supplier name': 'Bulk One Pvt Ltd', 'Vendor type': 'Domestic', 'Contact first name': 'A', 'Contact last name': 'One', 'Contact email': 'one@bulk.test', 'Contact mobile': '9800011111', 'Send invitation': 'Yes' });
    put(ws, { 'Supplier name': 'Bulk Two Pvt Ltd', 'Vendor type': 'Import', 'Contact first name': 'B', 'Contact last name': 'Two', 'Contact email': 'two@bulk.test', 'Contact mobile': '+44 20 7946 0000', 'Send invitation': 'No' });
    put(ws, { 'Supplier name': 'Bulk One Pvt Ltd', 'Vendor type': 'Local', 'Contact first name': 'C', 'Contact last name': 'Three', 'Contact email': 'not-an-email', 'Contact mobile': '12' });
    const bad = await send(admin, wb, 'invite');
    expect(bad.ok).toBe(false);
    const errs = bad.rows.find((r: any) => r.row === 5).errors.join(' | ');
    expect(errs).toMatch(/Vendor type must be/); expect(errs).toMatch(/valid email/); expect(errs).toMatch(/Same supplier name as row 3/);
    expect(await db.query.vendors.findFirst({ where: eq(schema.vendors.name, 'Bulk One Pvt Ltd') })).toBeUndefined();

    clear(ws, 5);
    const preview = await send(admin, wb, 'invite');
    expect(preview).toMatchObject({ ok: true, applied: false, summary: { rows: 2, withErrors: 0, invitations: 1 } });
    const done = await send(admin, wb, 'invite', '&apply=1');
    expect(done.created.map((c: any) => c.name)).toEqual(['Bulk One Pvt Ltd', 'Bulk Two Pvt Ltd']);
    expect(await lastLinkTo('one@bulk.test')).toMatch(/\/onboard\//);
    expect(await lastLinkTo('two@bulk.test')).toBeUndefined();
    expect((await db.query.vendors.findFirst({ where: eq(schema.vendors.name, 'Bulk Two Pvt Ltd') }))!.status).toBe('INVITED');
    // The same file again: names now exist.
    expect((await send(admin, wb, 'invite')).rows[0].errors).toContain('A supplier with this name already exists');
  });

  test('import approved: form columns from the live form, values checked, created approved with ERP code', async () => {
    const admin = await login('admin@acme.test');
    const wb = await template(admin, 'approved');
    const ws = wb.getWorksheet('Suppliers')!;
    const h = headers(ws);
    expect(h).toEqual(expect.arrayContaining(['ERP supplier code', 'Tax Details › GSTIN [tax.gstin]', 'Bank Details › Account Number [bank.accountNumber]']));
    expect(h.some((x) => x?.includes('[basic.vendorName]'))).toBe(false); // already a basic column
    const pan = 'AAFCM5678R';
    const row = { 'Supplier name': 'Master Metals Ltd', 'Vendor type': 'Domestic', 'Contact first name': 'Meena', 'Contact last name': 'S', 'Contact email': 'meena@master.test', 'Contact mobile': '9800099999', 'ERP supplier code': 'S-20001',
      'basic.entityType': 'Company (Pvt / Public Ltd)', 'basic.address': '5 Industrial Area', 'tax.hasGst': 'Yes', 'tax.gstin': '27AAFCM5678R1ZX', 'tax.pan': pan, 'bank.accountNumber': '601000555444', 'bank.ifsc': 'ICIC0001234', 'basic.msmeRegistered': 'Maybe' };
    put(ws, row);
    const bad = await send(admin, wb, 'approved');
    expect(bad.ok).toBe(false);
    const errs = bad.rows[0].errors.join(' | ');
    expect(errs).toMatch(/GSTIN/); expect(errs).toMatch(/Maybe” isn’t one of the choices/);

    clear(ws, 3);
    put(ws, { ...row, 'tax.gstin': gstin(pan), 'basic.msmeRegistered': 'No' });
    const preview = await send(admin, wb, 'approved');
    expect(preview.ok).toBe(true);
    expect(preview.rows[0].warnings.join(' | ')).toMatch(/Not filled: .*Postal Code/);
    expect(preview.rows[0].warnings.join(' | ')).toMatch(/required documents? to be uploaded/);
    const done = await send(admin, wb, 'approved', '&apply=1&notify=1');
    expect(done.applied).toBe(true);
    const v = (await db.query.vendors.findFirst({ where: and(eq(schema.vendors.name, 'Master Metals Ltd')) }))!;
    expect(v).toMatchObject({ status: 'APPROVED', erpVendorId: 'S-20001' });
    expect(v.lastReviewAt).toBeTruthy(); // asked to confirm in the portal
    expect((v.profile as any).tax).toMatchObject({ gstin: gstin(pan), pan });
    expect((v.profile as any).bank.accountNumber).toBe('601000555444');
    expect((await db.select().from(schema.supplierCodes).where(eq(schema.supplierCodes.vendorId, v.id)))[0].code).toBe('S-20001');
    const mail = (await db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, 'meena@master.test')).orderBy(desc(schema.emailOutbox.createdAt)))[0];
    expect(mail.subject).toMatch(/please check your supplier details/);
    expect((await db.select().from(schema.approvalSteps).where(eq(schema.approvalSteps.vendorId, v.id)))).toHaveLength(0);
  });
});
