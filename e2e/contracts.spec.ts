import { expect, test } from '@playwright/test';
import { PDF, staffLogin } from './helpers';

test('contracts: the administrator switches it on; a party and a contract are created, the signed copy uploaded and the contract marked signed', async ({ browser }) => {
  const admin = await staffLogin(browser, 'admin@acme.test');
  // Off by default: no Contracts menu group.
  await expect(admin.getByRole('link', { name: 'All contracts' })).toHaveCount(0);
  await admin.goto('/staff/admin/contracts');
  await expect(admin.getByRole('heading', { name: 'Contracts', exact: true })).toBeVisible();
  // Later options are shown but can't be chosen.
  await expect(admin.getByRole('checkbox', { name: /E-signature/ })).toBeDisabled();
  await admin.getByRole('checkbox', { name: /Switch Contracts on/ }).check();
  await admin.getByRole('checkbox', { name: /Non-disclosure agreement/ }).check();
  await admin.getByRole('checkbox', { name: /Service \/ maintenance contract/ }).check();
  await admin.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(admin.locator('.alert-success')).toContainText('Contracts on');

  // A new supplier party.
  await admin.goto('/staff/parties');
  await expect(admin.getByRole('heading', { name: 'Parties' })).toBeVisible();
  await admin.getByRole('button', { name: '+ New party' }).click();
  await admin.getByRole('radio', { name: 'Supplier' }).check();
  await admin.fill('#pf-name', 'Coolair Services');
  await admin.fill('#pf-tax', 'E2E-TAX-001');
  await admin.getByRole('button', { name: '+ Add contact' }).click();
  await admin.fill('#pc-name-0', 'Ravi Kulkarni');
  await admin.fill('#pc-email-0', 'ravi@coolair.test');
  await admin.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(admin.getByRole('heading', { name: 'Coolair Services' })).toBeVisible();
  await expect(admin.getByText(/SUP-\d{5}/).first()).toBeVisible();

  // A draft service contract with that party.
  await admin.goto('/staff/contracts');
  await expect(admin.getByText('No contracts yet.')).toBeVisible();
  await admin.getByRole('button', { name: '+ New contract' }).click();
  const dlg = admin.getByRole('dialog');
  await dlg.getByLabel('Title').fill('Annual maintenance — HVAC, Pune plant');
  await dlg.getByLabel('Contract type').selectOption('service');
  const party = dlg.locator('#cf-party');
  await expect(party.locator('option', { hasText: 'Coolair Services' })).toHaveCount(1);
  await party.selectOption({ value: await party.locator('option', { hasText: 'Coolair Services' }).getAttribute('value') ?? '' });
  await dlg.getByLabel('Value').fill('480000');
  await dlg.getByLabel('Start date').fill('2026-04-01');
  await dlg.getByLabel('End date').fill('2027-03-31');
  await dlg.getByRole('button', { name: 'Create draft' }).click();
  await expect(admin.getByRole('heading', { name: 'Annual maintenance — HVAC, Pune plant' })).toBeVisible();
  await expect(admin.getByText(/SVC-\d{4}-\d{4}/).first()).toBeVisible();
  await expect(admin.getByRole('button', { name: 'Mark as signed' })).toBeDisabled();

  // Upload the signed copy, then mark it signed.
  await admin.getByLabel('Add a file').selectOption('SIGNED');
  await admin.getByLabel('Contract file').setInputFiles({ ...PDF, name: 'hvac-amc-signed.pdf' });
  await expect(admin.getByText('hvac-amc-signed.pdf').first()).toBeVisible();
  await admin.getByRole('button', { name: 'Mark as signed' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Mark as signed' }).click();
  await expect(admin.locator('.badge', { hasText: 'Active' }).first()).toBeVisible();

  await admin.goto('/staff/contracts');
  await expect(admin.getByRole('cell', { name: /Annual maintenance/ })).toBeVisible();

  // Switch it off again so other tests see the default.
  await admin.goto('/staff/admin/contracts');
  await admin.getByRole('checkbox', { name: /Switch Contracts on/ }).uncheck();
  await admin.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(admin.locator('.alert-success')).toContainText('Contracts off');
  await expect(admin.getByRole('link', { name: 'All contracts' })).toHaveCount(0);
});
