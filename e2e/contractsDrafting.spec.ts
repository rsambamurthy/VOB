import { expect, test } from '@playwright/test';
import { call, staffLogin } from './helpers';

test('contracts: draft from a template with a fallback, make the document, Legal approves', async ({ browser }) => {
  const admin = await staffLogin(browser, 'admin@acme.test');
  await call(admin, 'PUT', '/api/admin/contracts', { enabled: true, types: { service: true, nda: true } });
  const party = (await call(admin, 'POST', '/api/staff/parties', { kind: 'SUPPLIER', name: 'Breeze HVAC Services', country: 'IN', contacts: [{ name: 'Sunil Rao', signatory: true }] })).party;
  const created = await call(admin, 'POST', '/api/staff/contracts', { title: 'AMC — chillers', direction: 'BUY', type: 'service', partyId: party.id, value: 480000, currency: 'INR', startDate: '2026-12-01', endDate: '2027-11-30', description: 'Quarterly maintenance of two chillers.' });

  // The clause library and templates are in the menu.
  await admin.goto('/staff/contract-clauses');
  await expect(admin.getByRole('heading', { name: 'Clause library' })).toBeVisible();
  await expect(admin.getByText('Disputes and arbitration').first()).toBeVisible();

  await admin.goto(`/staff/contracts/${created.contract.id}`);
  await expect(admin.getByRole('heading', { name: 'Draft from a template' })).toBeVisible();
  await admin.locator('#dr-tpl').selectOption({ label: 'Service / maintenance agreement (AMC)' });
  await admin.getByRole('button', { name: 'Start drafting' }).click();
  await expect(admin.locator('.alert-success')).toContainText('Draft started');
  await expect(admin.getByText('Standard wording', { exact: true })).toBeVisible();

  await admin.getByLabel('Wording for Price and payment').selectOption({ label: 'Fallback: Payment in 45 days' });
  await admin.getByRole('button', { name: 'Save wording' }).click();
  await expect(admin.getByText('Fallback used', { exact: true })).toBeVisible();
  await expect(admin.getByRole('button', { name: 'Submit for approval' })).toBeDisabled();
  await admin.getByRole('button', { name: /Make the document/ }).click();
  await expect(admin.locator('.alert-warning, .alert-success').first()).toContainText('made');
  await expect(admin.getByText(/SVC-\d{4}-\d{4} v\d+\.docx/).first()).toBeVisible();
  await admin.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(admin.locator('.alert-success').first()).toContainText('Sent for approval: Legal review');
  await expect(admin.locator('.badge', { hasText: 'In approval' }).first()).toBeVisible();

  const legal = await staffLogin(browser, 'legal@acme.test');
  await legal.goto(`/staff/contracts/${created.contract.id}`);
  await legal.getByRole('button', { name: /^Approve — Legal review/ }).click();
  await legal.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(legal.locator('.badge', { hasText: 'Approved' }).first()).toBeVisible();

  await call(admin, 'PUT', '/api/admin/contracts', { enabled: false, types: { service: true, nda: true } });
});
