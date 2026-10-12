import { expect, test } from '@playwright/test';
import { call, PDF, staffLogin } from './helpers';

test('Saudi workspace: Saudi form with Arabic name, CR/VAT checks, sanctions screening on submit, SAR and working days', async ({ browser }) => {
  const admin = await staffLogin(browser, 'admin@najd.test', 'najd');
  const name = `Riyadh Supplies ${Date.now()}`;
  await admin.goto('/staff/vendors');
  await admin.getByRole('button', { name: '+ New vendor' }).click();
  await admin.fill('#cv-name', name);
  await admin.fill('#cv-fn', 'Noura'); await admin.fill('#cv-ln', 'Al-Saud');
  await admin.fill('#cv-em', `noura+${Date.now()}@riyadh.test`); await admin.fill('#cv-mo', '966501234567');
  await admin.getByRole('button', { name: /Create & notify/ }).click();
  await expect(admin.getByRole('heading', { name })).toBeVisible();
  const link = await admin.locator('a.break').getAttribute('href');

  const vendor = await (await browser.newContext()).newPage();
  await vendor.goto(link!);
  await vendor.getByRole('button', { name: 'Send code' }).click();
  await vendor.fill('#otp', (await vendor.locator('.alert-info strong').textContent())!.trim());
  await vendor.getByRole('button', { name: /Verify & continue/ }).click();
  const consent = vendor.getByRole('dialog', { name: 'Privacy notice' });
  await expect(consent).toContainText('Personal Data Protection Law');
  await consent.getByRole('checkbox').check();
  await consent.getByRole('button', { name: 'Accept and continue' }).click();

  // Saudi template: Arabic legal name is typed right-to-left
  await expect(vendor.getByRole('tab', { name: 'Ownership' })).toBeVisible();
  await expect(vendor.getByRole('tab', { name: 'Saudization & Local Content' })).toBeVisible();
  await expect(vendor.locator('#basic\\.nameArabic')).toHaveAttribute('dir', 'rtl');

  await call(vendor, 'PUT', '/api/vendor/profile/basic', { nameArabic: 'شركة الرياض للتوريدات', entityType: 'Limited Liability Company (LLC)', address: '8228 King Fahd Road', region: 'Riyadh Region', district: 'Riyadh', postalCode: '12271', supplyCategory: 'Goods' });
  await call(vendor, 'PUT', '/api/vendor/profile/bank', { bankName: 'Al Rajhi Bank', accountHolderName: name, iban: 'SA0380000000608010167519' });
  await call(vendor, 'PUT', '/api/vendor/profile/tax', { crNumber: '7001234567', vatRegistered: 'Yes', vatNumber: '300000000000003' });
  await call(vendor, 'PUT', '/api/vendor/profile/ownership', { owner1Name: 'Noura Al-Saud', owner1Nationality: 'Saudi', owner1Share: '100', moreOwners: 'No', pep: 'No', relatedToBuyer: 'No' });
  await call(vendor, 'PUT', '/api/vendor/profile/localContent', { nitaqatBand: 'Platinum' });
  await call(vendor, 'PUT', '/api/vendor/profile/risk', { fiscalYearEnd: 'December', currency: 'SAR', turnoverYear: 'FY 2025', annualTurnover: '12000000', sourceOfInfo: 'Audited financial statements', hasRating: 'No', bankruptcy5y: 'No', litigation: 'No' });
  await vendor.reload();

  // CR and VAT checks from the Saudi pack; no GSTIN button for a Saudi supplier
  await vendor.getByRole('tab', { name: 'Tax & Zakat' }).click();
  await expect(vendor.getByRole('button', { name: 'Verify' })).toHaveCount(2);
  await vendor.getByRole('button', { name: 'Verify' }).first().click();
  await expect(vendor.locator('.verify .vbadge').first()).toHaveText('✓ Verified');

  // Documents: the ones that lapse ask for a date
  await vendor.getByRole('tab', { name: 'Documents' }).click();
  const nextYear = `${new Date().getFullYear() + 1}-06-30`;
  for (const label of ['Commercial Registration (CR) certificate', 'Zakat certificate (ZATCA)', 'GOSI certificate', 'Saudization (Nitaqat) certificate', 'National Address certificate', 'VAT registration certificate', 'Bank letter showing the IBAN', 'Ownership (beneficial owner) declaration']) {
    const row = vendor.locator('.doc-row', { hasText: label }).first();
    const date = row.locator('input[type=date]');
    if (await date.count()) await date.fill(nextYear);
    await row.locator('input[type=file]').setInputFiles(PDF);
    await expect(row.locator('.doc-file')).toHaveCount(1);
  }
  await vendor.getByRole('button', { name: 'Submit for review' }).first().click();
  await vendor.getByRole('dialog').getByRole('button', { name: 'Submit' }).click();
  await expect(vendor.getByText(/being reviewed/)).toBeVisible();

  // Staff: sanctions screening ran on submit and shows "Clear"; Saudi checks listed, Indian ones not
  await admin.reload();
  const checks = admin.locator('.card', { hasText: 'Verifications' });
  await expect(checks.locator('.verif li', { hasText: 'Sanctions screening' })).toContainText('Clear');
  await expect(checks).toContainText('Commercial Registration (Wathq)');
  await expect(checks).not.toContainText('GSTIN');

  // Workspace setting: deadlines in working days, on by default
  await admin.goto('/staff/admin/workspace');
  await expect(admin.getByRole('checkbox', { name: /Count deadlines in working days/ })).toBeChecked();
  await expect(admin.getByText('(Friday and Saturday)', { exact: false })).toBeVisible();
});
