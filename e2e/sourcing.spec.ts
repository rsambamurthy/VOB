import { expect, test } from '@playwright/test';
import { staffLogin } from './helpers';

test('sourcing: the administrator switches it on, chooses formats and locks a rule; buyers then see Sourcing', async ({ browser }) => {
  const admin = await staffLogin(browser, 'admin@acme.test');
  // Off by default: no Sourcing menu.
  await expect(admin.getByRole('button', { name: 'Sourcing' })).toHaveCount(0);
  await admin.goto('/staff/admin/sourcing');
  await expect(admin.getByRole('heading', { name: 'Sourcing', exact: true })).toBeVisible();
  // Later formats are shown but can't be chosen.
  await expect(admin.getByRole('checkbox', { name: /Dutch auction/ })).toBeDisabled();
  await admin.getByRole('checkbox', { name: /Switch Sourcing on/ }).check();
  await admin.getByRole('button', { name: 'Save' }).click();
  await expect(admin.locator('.alert-error')).toContainText('Choose at least one format');
  await admin.getByRole('checkbox', { name: /Sealed bid \/ RFQ/ }).check();
  await admin.getByRole('checkbox', { name: /Reverse auction/ }).check();
  await admin.getByLabel('Minimum bid step', { exact: true }).fill('1');
  await admin.getByRole('checkbox', { name: 'Lock Minimum bid step' }).check();
  await admin.getByRole('button', { name: 'Save' }).click();
  await expect(admin.locator('.alert-success')).toContainText('Sourcing on');
  await expect(admin.locator('.alert-success')).toContainText('Minimum bid step locked');

  await admin.getByRole('button', { name: 'Sourcing' }).click();
  await admin.getByRole('link', { name: 'Events' }).click();
  await expect(admin.getByRole('heading', { name: 'Sourcing events' })).toBeVisible();
  await expect(admin.getByText('switched on: Sealed bid / RFQ, Reverse auction')).toBeVisible();
  await expect(admin.getByText('No sourcing events yet.')).toBeVisible();

  // Switch it off again so other tests see the default.
  await admin.goto('/staff/admin/sourcing');
  await admin.getByRole('checkbox', { name: /Switch Sourcing on/ }).uncheck();
  await admin.getByRole('button', { name: 'Save' }).click();
  await expect(admin.locator('.alert-success')).toContainText('Sourcing off');
  await expect(admin.getByRole('button', { name: 'Sourcing' })).toHaveCount(0);
});
