import { expect, test } from '@playwright/test';
import { call, gstin, PDF, staffLogin } from './helpers';

test('invite → vendor accepts privacy notice, fills in, submits → three approvals → approved', async ({ browser }) => {
  const admin = await staffLogin(browser, 'admin@acme.test');
  const name = `E2E Supplies ${Date.now()}`;
  await admin.goto('/staff/vendors');
  await admin.getByRole('button', { name: '+ New vendor' }).click();
  await admin.fill('#cv-name', name);
  await admin.fill('#cv-fn', 'Esha'); await admin.fill('#cv-ln', 'Test');
  await admin.fill('#cv-em', `esha+${Date.now()}@e2e.test`); await admin.fill('#cv-mo', '9840012345');
  await admin.getByRole('button', { name: /Create & notify/ }).click();
  await expect(admin.getByRole('heading', { name })).toBeVisible();
  const link = await admin.locator('a.break').getAttribute('href');

  // ---- vendor ----
  const vendor = await (await browser.newContext()).newPage();
  await vendor.goto(link!);
  await vendor.getByRole('button', { name: 'Send code' }).click();
  const otp = (await vendor.locator('.alert-info strong').textContent())!.trim();
  await vendor.fill('#otp', otp);
  await vendor.getByRole('button', { name: /Verify & continue/ }).click();
  // DPDP consent comes first and can't be skipped
  await expect(vendor.getByRole('dialog', { name: 'Privacy notice' })).toBeVisible();
  await expect(vendor.getByRole('button', { name: 'Accept and continue' })).toBeDisabled();
  await vendor.getByRole('checkbox').check();
  await vendor.getByRole('button', { name: 'Accept and continue' }).click();
  await expect(vendor.getByRole('dialog', { name: 'Privacy notice' })).toBeHidden();

  // Fill the form (sections through the API, documents through the UI), then submit in the UI.
  const pan = 'AAFCE1234Q';
  await call(vendor, 'PUT', '/api/vendor/profile/basic', { entityType: 'Company (Pvt / Public Ltd)', address: '1 Test Road', region: 'Maharashtra', district: 'Pune', postalCode: '411001', msmeRegistered: 'No', supplyCategory: 'Goods' });
  await call(vendor, 'PUT', '/api/vendor/profile/bank', { bankName: 'HDFC Bank', accountHolderName: name, accountNumber: '501000999888', bankBranch: 'Pune', ifsc: 'HDFC0000001' });
  await call(vendor, 'PUT', '/api/vendor/profile/tax', { hasGst: 'Yes', gstin: gstin(pan), gstClassification: 'Regular', pan, cin: 'U74999MH2015PTC123456' });
  await call(vendor, 'PUT', '/api/vendor/profile/risk', { fiscalYearEnd: 'March', currency: 'INR', turnoverYear: 'FY 2024-25', annualTurnover: '9000000', sourceOfInfo: 'Audited financial statements', hasRating: 'No', bankruptcy5y: 'No', litigation: 'No' });
  await vendor.reload();
  // Online checks come from the India country pack: Verify next to GSTIN, Verify account next to IFSC.
  await vendor.getByRole('tab', { name: 'Tax Details' }).click();
  await vendor.locator('.verify', { has: vendor.getByRole('button', { name: 'Verify' }) }).first().getByRole('button').click();
  await expect(vendor.locator('.verify .vbadge').first()).toHaveText('✓ Verified');
  await vendor.getByRole('tab', { name: 'Bank Details' }).click();
  await vendor.getByRole('button', { name: 'Verify account' }).click();
  await expect(vendor.locator('.verify .vbadge').first()).toHaveText('✓ Verified');
  await vendor.getByRole('tab', { name: 'Documents' }).click();
  for (const label of ['PAN Card', 'GST Registration Certificate', 'Cancelled Cheque', 'Certificate of Incorporation']) {
    await vendor.locator('.doc-row', { hasText: label }).first().locator('input[type=file]').setInputFiles(PDF);
    await expect(vendor.locator('.doc-row', { hasText: label }).first().locator('.doc-file')).toHaveCount(1);
  }
  await vendor.getByRole('button', { name: 'Submit for review' }).first().click();
  await vendor.getByRole('dialog').getByRole('button', { name: 'Submit' }).click();
  await expect(vendor.getByText(/being reviewed/)).toBeVisible();

  // ---- approvals: Tax → Finance → Master Data ----
  for (const email of ['tax@acme.test', 'finance@acme.test', 'mdm@acme.test']) {
    const p = await staffLogin(browser, email);
    await p.goto('/staff/queue');
    await p.getByText(name).click();
    await p.getByRole('button', { name: 'Approve' }).first().click();
    await p.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
    await expect(p.locator('.alert-success')).toBeVisible();
    await p.context().close();
  }
  await admin.reload();
  await expect(admin.locator('h1 .badge-approved')).toBeVisible();
  await expect(admin.locator('.card', { hasText: 'Verifications' })).toContainText('GSTIN');
  await expect(admin.locator('.card', { hasText: 'Verifications' }).locator('.verif li', { hasText: 'Bank account' })).toContainText('Verified');
  await vendor.reload();
  await expect(vendor.getByRole('heading', { name: 'Registered details' })).toBeVisible();
});
