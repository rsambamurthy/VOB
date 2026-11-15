import { expect, test } from '@playwright/test';
import { staffLogin } from './helpers';

test('corrective actions: raise from the supplier page, see them in the overview', async ({ browser }) => {
  const fin = await staffLogin(browser, 'finance@acme.test');
  await fin.goto('/staff/vendors');
  await fin.getByText('Precision Valves Pvt Ltd').first().click();
  await fin.getByRole('tab', { name: /^Corrective actions/ }).click();
  await fin.getByRole('button', { name: /^Raise corrective actions/ }).click();
  const dialog = fin.getByRole('dialog');
  await dialog.getByRole('button', { name: '+ Add your own action' }).click();
  await dialog.getByLabel('Title').last().fill('Send a corrected delivery schedule');
  await dialog.getByRole('button', { name: /^Send \d+ to the supplier$/ }).click();
  await expect(fin.locator('.alert-success')).toContainText(/corrective action.* sent to Precision Valves/);
  await expect(fin.locator('.action-card', { hasText: 'Send a corrected delivery schedule' })).toContainText('Waiting for the supplier');
  await fin.goto('/staff/actions');
  await fin.getByRole('tab', { name: 'Raised by me' }).click();
  await expect(fin.getByRole('row', { name: /Send a corrected delivery schedule/ })).toBeVisible();
});
