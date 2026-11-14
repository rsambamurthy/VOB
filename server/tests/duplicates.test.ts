/** Possible duplicate suppliers: same PAN / GSTIN / bank account / IBAN / CR / VAT as another supplier. */
import { describe, expect, test } from 'vitest';
import ExcelJS from 'exceljs';
import { eq } from 'drizzle-orm';
import { approvedVendor, login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import { gstinCheckChar } from '../src/lib/validators.js';
import { identifiers, identityKeys } from '../src/services/duplicates.js';

const PDF = '%PDF-1.4\n%%EOF';
const profileOf = async (id: string) => (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) }))!.profile as any;
const gstin = (state: string, pan: string) => { const g = `${state}${pan}1Z`; return g + gstinCheckChar(g); };

describe('identifiers', () => {
  test('normalised, PAN taken from a GSTIN, bank account paired with the bank, numbers scoped by country', () => {
    const ids = identifiers({ tax: { gstin: ' 27aafcd1234q1z5 ' }, bank: { accountNumber: '5010-0012 3456', ifsc: 'hdfc0000001' } });
    expect(ids).toEqual(expect.arrayContaining([['gstin', '27AAFCD1234Q1Z5'], ['pan', 'AAFCD1234Q'], ['bank', '501000123456|HDFC']]));
    // Same PAN given directly, or via a GSTIN from another state, gives the same key.
    expect(identityKeys({ tax: { pan: 'AAFCD1234Q' } })[0]).toBe(identityKeys({ tax: { gstin: '29AAFCD1234Q1Z5' } }).find((k) => k.startsWith('pan:')));
    // Same account number at another bank is a different account.
    expect(identityKeys({ bank: { accountNumber: '50100012345', ifsc: 'ICIC0000001' } })).not.toEqual(identityKeys({ bank: { accountNumber: '50100012345', ifsc: 'HDFC0000001' } }));
    // A CR number is only unique within its country.
    expect(identityKeys({ basic: { supplierCountry: 'Saudi Arabia' }, tax: { crNumber: '7001234567' } })).not.toEqual(identityKeys({ basic: { supplierCountry: 'Oman' }, tax: { crNumber: '7001234567' } }));
    expect(identityKeys({ tax: { pan: '', gstin: 'x' }, bank: { accountNumber: '000000' } })).toEqual([]);
    expect(identityKeys({ tax: { pan: 'AAFCD1234Q' } })[0]).not.toContain('AAFCD1234Q'); // hashed, not stored in clear
  });
});

describe('duplicate suppliers', () => {
  test('flagged on the page and list, approval needs a check, "not a duplicate" clears it', async () => {
    const { id: aId } = await approvedVendor('Original Pumps Ltd', 'orig@dup.test');
    const a = await profileOf(aId);
    const admin = await login('admin@acme.test');
    const bId = (await admin.post('/api/staff/vendors', { name: 'Copycat Pumps Ltd', vendorType: 'DOMESTIC', contactFirstName: 'C', contactLastName: 'P', contactEmail: 'copy@dup.test', contactMobile: '9800055511', notify: false })).body.vendor.id;
    const pan = `AAFCZ${String(Math.floor(Math.random() * 9000) + 1000)}Q`;
    await admin.put(`/api/staff/vendors/${bId}/assist/profile/basic`, { entityType: 'Company (Pvt / Public Ltd)', address: '2 Main Rd', region: 'Maharashtra', district: 'Pune', postalCode: '411001', msmeRegistered: 'No', supplyCategory: 'Goods' });
    // Different company numbers, but the original supplier's bank account.
    await admin.put(`/api/staff/vendors/${bId}/assist/profile/bank`, { bankName: 'HDFC Bank', accountHolderName: 'Copycat Pumps Ltd', accountNumber: a.bank.accountNumber, bankBranch: 'Pune', ifsc: a.bank.ifsc });
    await admin.put(`/api/staff/vendors/${bId}/assist/profile/tax`, { hasGst: 'Yes', gstin: gstin('27', pan), gstClassification: 'Regular', pan, cin: 'U74999MH2016PTC765432' });
    await admin.put(`/api/staff/vendors/${bId}/assist/profile/risk`, { fiscalYearEnd: 'March', currency: 'INR', turnoverYear: 'FY 2024-25', annualTurnover: '9000000', sourceOfInfo: 'Audited financial statements', hasRating: 'No', bankruptcy5y: 'No', litigation: 'No' });

    const page = (await admin.get(`/api/staff/vendors/${bId}`)).body;
    expect(page.duplicates).toEqual([expect.objectContaining({ id: aId, matches: ['bank account'] })]);
    expect(page.flags.map((f: any) => f.code)).toContain('POSSIBLE_DUPLICATE');
    // …and on the original supplier too.
    expect((await admin.get(`/api/staff/vendors/${aId}`)).body.duplicates.map((x: any) => x.id)).toContain(bId);
    const list = (await admin.get('/api/staff/vendors?q=Copycat')).body.vendors;
    expect(list[0].flags.map((f: any) => f.code)).toContain('POSSIBLE_DUPLICATE');

    for (const t of ['PAN_CARD', 'GST_CERT', 'CANCELLED_CHEQUE', 'INCORPORATION_CERT']) {
      await admin.agent.post(`/api/staff/vendors/${bId}/assist/documents`).set('X-Requested-With', 'fetch').field('docType', t).attach('file', Buffer.from(PDF), { filename: 'd.pdf', contentType: 'application/pdf' });
    }
    expect((await admin.post(`/api/staff/vendors/${bId}/assist/submit`, { confirm: true })).status).toBe(200);
    const audit = async (id: string) => (await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.vendorId, id))).map((x) => x.action);
    expect(await audit(bId)).toContain('POSSIBLE_DUPLICATE');

    const tax = await login('tax@acme.test');
    const blocked = await tax.post(`/api/staff/vendors/${bId}/decision`, { action: 'APPROVE' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('POSSIBLE_DUPLICATE');
    expect(blocked.body.error).toMatch(/Original Pumps Ltd \(same bank account\)/);
    expect((await tax.post(`/api/staff/vendors/${bId}/decision`, { action: 'SEND_BACK', remarks: 'Check bank' })).status).toBe(200); // other decisions aren't held up

    // Someone with Edit vendors records that they are different suppliers.
    expect((await admin.post(`/api/staff/vendors/${bId}/duplicates/${aId}/dismiss`, { note: '' })).status).toBe(400);
    expect((await admin.post(`/api/staff/vendors/${bId}/duplicates/${aId}/dismiss`, { note: 'Sister company, shared treasury account — confirmed by CFO' })).status).toBe(200);
    expect((await admin.get(`/api/staff/vendors/${bId}`)).body.duplicates).toEqual([]);
    expect((await admin.get(`/api/staff/vendors/${bId}`)).body.flags.map((f: any) => f.code)).not.toContain('POSSIBLE_DUPLICATE');
    expect(await audit(aId)).toContain('DUPLICATE_DISMISSED');
  });

  test('approve with the check ticked; it is recorded', async () => {
    const { id: aId } = await approvedVendor('Twin Source Ltd', 'twin1@dup.test');
    const a = await profileOf(aId);
    const admin = await login('admin@acme.test');
    const bId = (await admin.post('/api/staff/vendors', { name: 'Twin Source (Karnataka) Ltd', vendorType: 'DOMESTIC', contactFirstName: 'T', contactLastName: 'S', contactEmail: 'twin2@dup.test', contactMobile: '9800055522', notify: false })).body.vendor.id;
    await admin.put(`/api/staff/vendors/${bId}/assist/profile/basic`, { entityType: 'Company (Pvt / Public Ltd)', address: '9 Hosur Rd', region: 'Karnataka', district: 'Bengaluru', postalCode: '560068', msmeRegistered: 'No', supplyCategory: 'Goods' });
    await admin.put(`/api/staff/vendors/${bId}/assist/profile/bank`, { bankName: 'ICICI Bank', accountHolderName: 'Twin Source Ltd', accountNumber: '000405123987', bankBranch: 'Koramangala', ifsc: 'ICIC0000004' });
    // Same company (PAN), registered for GST in another state.
    await admin.put(`/api/staff/vendors/${bId}/assist/profile/tax`, { hasGst: 'Yes', gstin: gstin('29', a.tax.pan), gstClassification: 'Regular', pan: a.tax.pan, cin: a.tax.cin });
    await admin.put(`/api/staff/vendors/${bId}/assist/profile/risk`, { fiscalYearEnd: 'March', currency: 'INR', turnoverYear: 'FY 2024-25', annualTurnover: '9000000', sourceOfInfo: 'Audited financial statements', hasRating: 'No', bankruptcy5y: 'No', litigation: 'No' });
    for (const t of ['PAN_CARD', 'GST_CERT', 'CANCELLED_CHEQUE', 'INCORPORATION_CERT']) {
      await admin.agent.post(`/api/staff/vendors/${bId}/assist/documents`).set('X-Requested-With', 'fetch').field('docType', t).attach('file', Buffer.from(PDF), { filename: 'd.pdf', contentType: 'application/pdf' });
    }
    expect((await admin.post(`/api/staff/vendors/${bId}/assist/submit`, { confirm: true })).status).toBe(200);
    expect((await admin.get(`/api/staff/vendors/${bId}`)).body.duplicates[0].matches.sort()).toEqual(['CIN', 'PAN']);
    for (const u of ['tax@acme.test', 'finance@acme.test', 'mdm@acme.test']) {
      expect((await (await login(u)).post(`/api/staff/vendors/${bId}/decision`, { action: 'APPROVE', duplicatesChecked: true })).status).toBe(200);
    }
    const logs = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.vendorId, bId));
    expect(logs.filter((l) => l.action === 'DUPLICATE_CHECKED')).toHaveLength(3);
    expect((await profileOf(bId)) && (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, bId) }))!.status).toBe('APPROVED');
  });

  test('a bank change to another supplier’s account needs an explicit check', async () => {
    const { id: aId } = await approvedVendor('Honest Castings Ltd', 'honest@dup.test');
    const a = await profileOf(aId);
    const { v, id: cId, admin } = await approvedVendor('Shifty Castings Ltd', 'shifty@dup.test');
    expect((await v.post('/api/vendor/change-requests', { changes: { bank: { accountNumber: a.bank.accountNumber, ifsc: a.bank.ifsc } }, note: 'New account' })).status).toBe(201);
    const cr = (await admin.get(`/api/staff/vendors/${cId}`)).body.changeRequests.find((x: any) => x.status === 'PENDING');
    expect(cr.duplicates).toEqual([expect.objectContaining({ id: aId, matches: ['bank account'] })]);
    // The vendor itself isn't a duplicate until the change is applied.
    expect((await admin.get(`/api/staff/vendors/${cId}`)).body.duplicates).toEqual([]);
    // Nothing about the other supplier reaches the supplier.
    expect(JSON.stringify((await v.get('/api/vendor')).body)).not.toContain('Honest Castings');
    const fin = await login('finance@acme.test');
    const r = await fin.post(`/api/staff/change-requests/${cr.id}/decision`, { action: 'APPROVE' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Honest Castings Ltd \(same bank account\)/);
    expect((await fin.post(`/api/staff/change-requests/${cr.id}/decision`, { action: 'APPROVE', duplicatesChecked: true })).body.nextLevel).toBeTruthy();
  });

  test('Excel import: same GSTIN or bank stops the row; a shared PAN only warns', async () => {
    const { id: aId } = await approvedVendor('Master Copy Ltd', 'mc@dup.test');
    const a = await profileOf(aId);
    const code = (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, aId) }))!.code;
    const admin = await login('admin@acme.test');
    const r = await admin.agent.get('/api/staff/vendor-import/template.xlsx?mode=approved').set('X-Requested-With', 'fetch').buffer(true)
      .parse((res: any, cb: any) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); });
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(r.body);
    const ws = wb.getWorksheet('Suppliers')!;
    const h: string[] = []; ws.getRow(1).eachCell((c, i) => { h[i] = String(c.text); });
    const put = (n: number, vals: Record<string, string>) => h.forEach((name, i) => { const k = Object.keys(vals).find((x) => name === x || name?.endsWith(`[${x}]`)); if (k) ws.getRow(n).getCell(i).value = vals[k]; });
    const base = { 'Vendor type': 'Domestic', 'Contact first name': 'X', 'Contact last name': 'Y', 'Contact mobile': '9800066611', 'basic.entityType': 'Company (Pvt / Public Ltd)' };
    put(3, { ...base, 'Supplier name': 'Same GST Ltd', 'Contact email': 'g@imp.test', 'tax.hasGst': 'Yes', 'tax.gstin': a.tax.gstin });
    put(4, { ...base, 'Supplier name': 'Same PAN Other State Ltd', 'Contact email': 'p@imp.test', 'tax.hasGst': 'Yes', 'tax.gstin': gstin('29', a.tax.pan) });
    put(5, { ...base, 'Supplier name': 'Bank Twin A', 'Contact email': 'b1@imp.test', 'bank.accountNumber': '000409999111', 'bank.ifsc': 'ICIC0000004' });
    put(6, { ...base, 'Supplier name': 'Bank Twin B', 'Contact email': 'b2@imp.test', 'bank.accountNumber': '000409999111', 'bank.ifsc': 'ICIC0000004' });
    const res = (await admin.agent.post('/api/staff/vendor-import?mode=approved').set('X-Requested-With', 'fetch').attach('file', Buffer.from(await wb.xlsx.writeBuffer()), 'x.xlsx')).body;
    const row = (n: number) => res.rows.find((x: any) => x.row === n);
    expect(res.ok).toBe(false);
    expect(row(3).errors).toContain(`Same GSTIN as ${code} Master Copy Ltd`);
    expect(row(4).errors.join()).not.toMatch(/Same/);
    expect(row(4).warnings).toContain(`Same PAN as ${code} Master Copy Ltd`);
    expect(row(6).errors).toContain('Same bank account as row 5');
  });
});
