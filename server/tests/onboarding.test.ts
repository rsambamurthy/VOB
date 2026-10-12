import { describe, expect, test } from 'vitest';
import { client, login, lastLinkTo, tokenOf } from './helpers.js';
import { gstinCheckChar } from '../src/lib/validators.js';

describe('end-to-end onboarding', () => {
  test('invite → OTP → fill → submit → send back → resubmit → 3 approvals → ERP export', async () => {
    const admin = await login('admin@acme.test');
    const name = 'Flow Test Engineering Pvt Ltd';
    const email = 'asha@flowtest.test';
    const created = await admin.post('/api/staff/vendors', { name, vendorType: 'DOMESTIC', contactFirstName: 'Asha', contactLastName: 'K', contactEmail: email, contactMobile: '9812345678' });
    expect(created.status).toBe(201);
    const id = created.body.vendor.id;
    expect((await admin.post('/api/staff/vendors', { name: name.toUpperCase(), vendorType: 'DOMESTIC', contactFirstName: 'A', contactLastName: 'B', contactEmail: 'x@y.test', contactMobile: '9812345678' })).status).toBe(409);

    // Vendor signs in
    const token = tokenOf((await lastLinkTo(email))!);
    const v = client();
    const info = await v.get(`/api/vendor-auth/invite/${token}`);
    expect(info.body.buyer.name).toBe('Acme Industries Ltd');
    const { devOtp } = (await v.post('/api/vendor-auth/request-otp', { token })).body;
    expect((await v.post('/api/vendor-auth/verify-otp', { token, code: devOtp === '000000' ? '111111' : '000000' })).status).toBe(401);
    expect((await v.post('/api/vendor-auth/verify-otp', { token, code: devOtp })).status).toBe(200);

    // DPDP: nothing can be entered before the privacy notice is accepted
    const blocked = await v.put('/api/vendor/profile/basic', { address: 'x' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('CONSENT_REQUIRED');
    const privacy = (await v.get('/api/vendor')).body.privacy;
    expect(privacy).toMatchObject({ version: 1, needsConsent: true });
    expect(privacy.text).toMatch(/Your rights/);
    expect((await v.post('/api/vendor/consent', { version: 99 })).status).toBe(409);
    expect((await v.post('/api/vendor/consent', { version: 1 })).status).toBe(200);
    expect((await v.get('/api/vendor')).body.privacy.needsConsent).toBe(false);

    const early = await v.post('/api/vendor/submit');
    expect(early.status).toBe(422);

    const pan = 'AAFCS1234Q';
    const g = `27${pan}1Z`; const gstin = g + gstinCheckChar(g);
    await v.put('/api/vendor/profile/basic', { entityType: 'Company (Pvt / Public Ltd)', address: '12 Link Road', region: 'Maharashtra', district: 'Mumbai', postalCode: '400001', msmeRegistered: 'No', supplyCategory: 'Services' });
    await v.put('/api/vendor/profile/bank', { bankName: 'ICICI Bank', accountHolderName: name, accountNumber: '000401234567', bankBranch: 'Fort', ifsc: 'icic0000004' });
    const bad = await v.put('/api/vendor/profile/tax', { hasGst: 'Yes', gstin: '27AAFCS1234Q1ZA', pan });
    expect(bad.body.checklist.some((c: any) => c.id === 'tax.gstin' && !c.ok)).toBe(true);
    await v.put('/api/vendor/profile/tax', { hasGst: 'Yes', gstin, gstClassification: 'Regular', pan, cin: 'U74999MH2015PTC123456' });
    const risk = await v.put('/api/vendor/profile/risk', { fiscalYearEnd: 'March', currency: 'INR', turnoverYear: 'FY 2024-25', annualTurnover: '25000000', sourceOfInfo: 'Audited financial statements', hasRating: 'No', bankruptcy5y: 'No', litigation: 'No' });
    expect(risk.body.checklist.filter((c: any) => !c.ok).map((c: any) => c.id).sort()).toEqual(['doc.CANCELLED_CHEQUE', 'doc.GST_CERT', 'doc.INCORPORATION_CERT', 'doc.PAN_CARD']);

    expect((await v.post('/api/vendor/verify/gstin', { gstin })).body.status).toBe('VERIFIED');
    for (const t of ['PAN_CARD', 'GST_CERT', 'CANCELLED_CHEQUE', 'INCORPORATION_CERT']) expect((await v.upload('/api/vendor/documents', t)).status).toBe(201);
    expect((await v.upload('/api/vendor/documents', 'OTHER', 'MZ', 'x.exe', 'application/x-msdownload')).status).toBe(400);

    expect((await v.post('/api/vendor/submit')).status).toBe(200);
    expect((await v.put('/api/vendor/profile/basic', { district: 'Thane' })).status).toBe(409);

    const tax = await login('tax@acme.test');
    const fin = await login('finance@acme.test');
    const mdm = await login('mdm@acme.test');
    expect((await fin.post(`/api/staff/vendors/${id}/decision`, { action: 'APPROVE' })).status).toBe(403);
    expect((await tax.post(`/api/staff/vendors/${id}/decision`, { action: 'APPROVE', remarks: 'Tax OK' })).body.nextLevel).toBe('Finance & Risk Review');
    expect((await fin.post(`/api/staff/vendors/${id}/decision`, { action: 'SEND_BACK' })).status).toBe(400);
    await fin.post(`/api/staff/vendors/${id}/decision`, { action: 'SEND_BACK', remarks: 'Please upload audited financials' });
    const me = (await v.get('/api/vendor')).body;
    expect(me.vendor.status).toBe('SENT_BACK');
    expect(me.sendBackRemarks).toBe('Please upload audited financials');

    await v.upload('/api/vendor/documents', 'FINANCIALS');
    expect((await v.post('/api/vendor/submit')).status).toBe(200);
    for (const s of [tax, fin, mdm]) expect((await s.post(`/api/staff/vendors/${id}/decision`, { action: 'APPROVE' })).status).toBe(200);

    const detail = (await admin.get(`/api/staff/vendors/${id}`)).body;
    expect(detail.vendor.status).toBe('APPROVED');
    expect(detail.vendor.reviewCycle).toBe(2);

    const erp = (await mdm.get(`/api/staff/vendors/${id}/erp-export?orgId=85`)).body;
    const vd = erp.ERPVendorsData.VENDOR.VENDOR_DATA;
    expect(vd.VENDOR_NAME).toBe(name);
    expect(vd.INDIA_LOCALIZATION.GSTIN).toBe(gstin);
    expect(vd.VENDOR_SITES.SITE_DATA[0].VENDOR_BANKS.BANK_DATA[0].BRANCH_NUMBER).toBe('ICIC0000004');
  });
});
