import { expect, test } from '@playwright/test';
import { call, staffLogin } from './helpers';

test('contracts: obligations with reminders, and an amendment that extends a signed contract', async ({ browser }) => {
  const admin = await staffLogin(browser, 'admin@acme.test');
  await call(admin, 'PUT', '/api/admin/contracts', { enabled: true, types: { service: true }, features: { internalApproval: false, obligations: true, renewalAlerts: true } });
  const party = (await call(admin, 'POST', '/api/staff/parties', { kind: 'SUPPLIER', name: 'Chiller Care', country: 'IN' })).party;
  const c = await call(admin, 'POST', '/api/staff/contracts', { title: 'AMC — chillers 2026', direction: 'BUY', type: 'service', partyId: party.id, value: 600000, currency: 'INR', startDate: '2026-01-01', endDate: '2027-06-30', signedDate: '2025-12-20', signed: true });

  await admin.goto(`/staff/contracts/${c.contract.id}`);
  await admin.getByRole('button', { name: '+ Add obligation' }).click();
  const dlg = admin.getByRole('dialog');
  await dlg.getByLabel('What has to be done').fill('Quarterly maintenance report');
  await dlg.getByLabel('Kind').selectOption('REPORT');
  await dlg.getByLabel('Due date').fill('2027-01-15');
  await dlg.getByLabel('Repeats').selectOption('QUARTERLY');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(admin.locator('.alert-success').first()).toContainText('Obligation added');
  await admin.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(admin.locator('.alert-success').first()).toContainText('the next one is added');

  await admin.goto('/staff/contract-obligations');
  await expect(admin.getByRole('heading', { name: 'Obligations' })).toBeVisible();
  await expect(admin.getByText('Quarterly maintenance report').first()).toBeVisible();

  await admin.goto(`/staff/contracts/${c.contract.id}`);
  await admin.getByRole('button', { name: '+ New amendment' }).click();
  await admin.getByRole('dialog').getByLabel('End date').fill('2028-06-30');
  await admin.getByRole('dialog').getByRole('button', { name: 'Create the amendment' }).click();
  await expect(admin.getByRole('heading', { name: 'What this amendment changes' })).toBeVisible();
  await expect(admin.getByText(/The end date is changed from 30 June 2027 to 30 June 2028/).first()).toBeVisible();
  await admin.getByLabel('Add a file').selectOption('SIGNED');
  await admin.getByLabel('Contract file').setInputFiles({ name: 'amendment.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF') });
  await admin.getByRole('button', { name: 'Mark as signed' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Mark as signed' }).click();
  await expect(admin.getByText('Applied to the contract when it was signed.')).toBeVisible();
  await admin.getByRole('link', { name: c.contract.number }).first().click();
  await expect(admin.getByText(/30 Jun 2028/).first()).toBeVisible();

  await call(admin, 'PUT', '/api/admin/contracts', { enabled: false, types: { service: true } });
});
