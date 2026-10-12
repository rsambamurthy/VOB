import { expect, test } from '@playwright/test';
import { staffLogin } from './helpers';

test('bank account is masked for staff; Reveal shows it and is audited', async ({ browser }) => {
  const fin = await staffLogin(browser, 'finance@acme.test');
  await fin.goto('/staff/vendors');
  await fin.getByText('Precision Valves Pvt Ltd').first().click();
  await fin.getByRole('tab', { name: 'Bank Details' }).click();
  const account = fin.locator('.field', { hasText: 'Account Number' }).first();
  await expect(account.locator('.ro-value')).toContainText('•');
  await account.getByRole('button', { name: 'Reveal' }).click();
  await expect(account.locator('.ro-value')).not.toContainText('•');
  await expect(account.locator('.ro-value')).toContainText(/\d{6,}/);
  const admin = await staffLogin(browser, 'admin@acme.test');
  await admin.goto('/staff/admin/audit');
  await expect(admin.getByText(/Sensitive revealed/i).first()).toBeVisible();
});

test('dashboard and an Excel report', async ({ browser }) => {
  const admin = await staffLogin(browser, 'admin@acme.test');
  await admin.goto('/staff/dashboard');
  await expect(admin.getByText('Onboarding funnel')).toBeVisible();
  await expect(admin.locator('.tile')).toHaveCount(6);
  await admin.goto('/staff/reports?r=vendor-register');
  await expect(admin.locator('.report-table tbody tr').first()).toBeVisible();
  const [download] = await Promise.all([admin.waitForEvent('download'), admin.getByRole('link', { name: 'Download Excel' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^vendor-register_.*\.xlsx$/);
});

test('ERP settings: Oracle in test mode, preview payload', async ({ browser }) => {
  const admin = await staffLogin(browser, 'admin@acme.test');
  await admin.goto('/staff/admin/erp');
  await admin.getByText('Oracle E-Business Suite').click();
  await admin.fill('#erp-url', 'https://ebs.example.com/webservices/rest/supplier');
  await admin.getByRole('button', { name: 'Save settings' }).click();
  await expect(admin.locator('.alert-success')).toContainText('saved');
  await admin.getByRole('button', { name: 'Preview payload' }).click();
  await expect(admin.getByRole('dialog')).toContainText('ERPVendorsData');
});

test('privacy settings: a new notice version is created on save', async ({ browser }) => {
  const admin = await staffLogin(browser, 'admin@acme.test');
  await admin.goto('/staff/admin/workspace');
  const notice = admin.locator('#pv-text');
  await expect(notice).toHaveValue(/Your rights/);
  await notice.fill((await notice.inputValue()) + '\n\nE2E update.');
  await admin.fill('#pv-email', 'dpo@acme.test');
  await admin.getByRole('button', { name: 'Save as new version' }).click();
  await expect(admin.getByText(/Saved as version 2/)).toBeVisible();
});
