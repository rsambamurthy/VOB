/**
 * End-to-end API smoke test: runs the whole onboarding flow against a running server.
 *   npm run dev   (in another terminal)   then   npm run smoke
 */
import assert from 'node:assert/strict';
import { gstinCheckChar } from '../src/lib/validators.js';

const BASE = process.env.API_URL ?? 'http://localhost:4000/api';

async function call(method: string, path: string, token?: string, body?: unknown) {
  const isForm = body instanceof FormData;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
const ok = async (method: string, path: string, token?: string, body?: unknown) => {
  const r = await call(method, path, token, body);
  assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};
const staffLogin = async (email: string) => (await ok('POST', '/auth/staff-login', undefined, { email })).token as string;
const step = (m: string) => console.log(`✔ ${m}`);

const suffix = Date.now().toString().slice(-6);
const name = `Smoke Test Engineering ${suffix}`;
const pan = 'AAFCS1234Q';
const gst = `27${pan}1Z`; const gstin = gst + gstinCheckChar(gst);

const admin = await staffLogin('admin@buyer.test');
const created = await ok('POST', '/staff/vendors', admin, { name, vendorType: 'DOMESTIC', contactFirstName: 'Asha', contactLastName: 'K', contactEmail: `asha${suffix}@smoke.test`, contactMobile: '9812345678', notify: true });
const inviteToken = new URL(created.inviteLink).pathname.split('/').pop()!;
step(`Admin created ${created.vendor.code} and sent invite`);

const dup = await call('POST', '/staff/vendors', admin, { name, vendorType: 'DOMESTIC', contactFirstName: 'A', contactLastName: 'B', contactEmail: 'x@y.test', contactMobile: '9812345678' });
assert.equal(dup.status, 409); step('Duplicate vendor name rejected');

const otp = await ok('POST', '/auth/request-otp', undefined, { token: inviteToken });
assert.equal((await call('POST', '/auth/verify-otp', undefined, { token: inviteToken, code: '000000' === otp.devOtp ? '111111' : '000000' })).status, 401);
const vendor = (await ok('POST', '/auth/verify-otp', undefined, { token: inviteToken, code: otp.devOtp })).token as string;
step('Vendor signed in with OTP (wrong code refused)');

const early = await call('POST', '/vendor/submit', vendor);
assert.equal(early.status, 422); step(`Submit blocked with ${early.json.details.length} checklist gaps`);

const badGst = await ok('PUT', '/vendor/profile/tax', vendor, { hasGst: 'Yes', gstin: '27AAFCS1234Q1ZA', pan: 'AAFCS1234Q' });
assert.ok(badGst.checklist.some((c: any) => c.id === 'tax.gstin' && !c.ok)); step('Bad GSTIN checksum flagged');

await ok('PUT', '/vendor/profile/basic', vendor, { entityType: 'Company (Pvt / Public Ltd)', address: '12 Link Road', region: 'Maharashtra', district: 'Mumbai', postalCode: '400001', msmeRegistered: 'No', supplyCategory: 'Services' });
await ok('PUT', '/vendor/profile/bank', vendor, { bankName: 'ICICI Bank', accountHolderName: name, accountNumber: '000401234567', bankBranch: 'Fort', ifsc: 'icic0000004' });
await ok('PUT', '/vendor/profile/tax', vendor, { hasGst: 'Yes', gstin, gstClassification: 'Regular', pan, cin: 'U74999MH2015PTC123456' });
const afterRisk = await ok('PUT', '/vendor/profile/risk', vendor, { fiscalYearEnd: 'March', currency: 'INR', turnoverYear: 'FY 2024-25', annualTurnover: '25000000', sourceOfInfo: 'Audited financial statements', hasRating: 'No', bankruptcy5y: 'No', litigation: 'No' });
const missing = afterRisk.checklist.filter((c: any) => !c.ok).map((c: any) => c.id);
assert.deepEqual(missing.sort(), ['doc.CANCELLED_CHEQUE', 'doc.GST_CERT', 'doc.INCORPORATION_CERT', 'doc.PAN_CARD']);
step('All fields valid; only documents missing');

const v = await ok('POST', '/vendor/verify/gstin', vendor, { gstin });
assert.equal(v.status, 'VERIFIED'); step('GSTIN verification (mock) passed');

const pdf = new Blob(['%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'], { type: 'application/pdf' });
for (const docType of ['PAN_CARD', 'GST_CERT', 'CANCELLED_CHEQUE', 'INCORPORATION_CERT']) {
  const fd = new FormData(); fd.append('docType', docType); fd.append('file', pdf, `${docType.toLowerCase()}.pdf`);
  await ok('POST', '/vendor/documents', vendor, fd);
}
const exe = new FormData(); exe.append('docType', 'OTHER'); exe.append('file', new Blob(['MZ'], { type: 'application/x-msdownload' }), 'x.exe');
assert.equal((await call('POST', '/vendor/documents', vendor, exe)).status, 400);
step('4 documents uploaded; .exe refused');

await ok('POST', '/vendor/submit', vendor);
assert.equal((await call('PUT', '/vendor/profile/basic', vendor, { district: 'Thane' })).status, 409);
step('Submitted; profile locked');

const tax = await staffLogin('tax@buyer.test');
const fin = await staffLogin('finance@buyer.test');
const mdm = await staffLogin('mdm@buyer.test');
const id = created.vendor.id;
assert.equal((await call('POST', `/staff/vendors/${id}/decision`, fin, { action: 'APPROVE' })).status, 403); step('Finance cannot jump the Tax level');
await ok('POST', `/staff/vendors/${id}/decision`, tax, { action: 'APPROVE', remarks: 'Tax OK' });
assert.equal((await call('POST', `/staff/vendors/${id}/decision`, fin, { action: 'SEND_BACK' })).status, 400); step('Send-back without remarks refused');
await ok('POST', `/staff/vendors/${id}/decision`, fin, { action: 'SEND_BACK', remarks: 'Please upload audited financials' });
const me = await ok('GET', '/vendor', vendor);
assert.equal(me.vendor.status, 'SENT_BACK'); assert.equal(me.sendBackRemarks, 'Please upload audited financials');
step('Finance sent back; vendor sees remarks');

const fd = new FormData(); fd.append('docType', 'FINANCIALS'); fd.append('file', pdf, 'fy25.pdf');
await ok('POST', '/vendor/documents', vendor, fd);
await ok('POST', '/vendor/submit', vendor);
for (const t of [tax, fin, mdm]) await ok('POST', `/staff/vendors/${id}/decision`, t, { action: 'APPROVE', remarks: '' });
const detail = await ok('GET', `/staff/vendors/${id}`, admin);
assert.equal(detail.vendor.status, 'APPROVED'); assert.equal(detail.vendor.reviewCycle, 2);
step('Resubmitted and approved through 3 levels (cycle 2)');

const erp = await ok('GET', `/staff/vendors/${id}/erp-export?orgId=85`, admin);
const vd = erp.ERPVendorsData.VENDOR.VENDOR_DATA;
assert.equal(vd.VENDOR_NAME, name); assert.equal(vd.INDIA_LOCALIZATION.GSTIN, gstin);
assert.ok(Array.isArray(vd.VENDOR_SITES.SITE_DATA) && Array.isArray(vd.VENDOR_SITES.SITE_DATA[0].VENDOR_BANKS.BANK_DATA));
assert.equal(vd.VENDOR_SITES.SITE_DATA[0].VENDOR_BANKS.BANK_DATA[0].BRANCH_NUMBER, 'ICIC0000004');
step('ERP export matches Oracle supplier shape');

console.log('\nAll smoke checks passed.');
