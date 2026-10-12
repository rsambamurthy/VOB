import { expect, test } from '@playwright/test';
import { staffLogin } from './helpers';

test('F1 opens help for the current screen; search tolerates typos; topics are filtered by role', async ({ browser }) => {
  const fin = await staffLogin(browser, 'finance@acme.test');
  await fin.goto('/staff/vendors');
  await expect(fin.locator('.help-fab')).toBeVisible();
  await fin.keyboard.press('F1');
  const panel = fin.getByRole('dialog', { name: 'Help' });
  await expect(panel).toBeVisible();
  await expect(panel.locator('.help-list').first()).toContainText('Finding vendors');
  // Finance can't manage users, so admin topics are hidden
  await expect(panel).not.toContainText('Users: invite, change roles, disable');

  await panel.getByRole('searchbox', { name: 'Search help' }).fill('bnak chnage');
  await expect(panel.locator('.help-item').first()).toContainText('Change requests');
  await panel.locator('.help-item').first().click();
  await expect(panel.getByRole('heading', { name: 'Change requests' })).toBeVisible();
  await expect(panel.locator('.help-shot img').first()).toBeVisible();
  await fin.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  // Context: the Approval flow tab of Configuration
  const admin = await staffLogin(browser, 'admin@acme.test');
  await admin.goto('/staff/admin/config');
  await admin.getByRole('tab', { name: 'Approval flow' }).click();
  await admin.locator('.help-fab').click();
  await expect(admin.getByRole('dialog', { name: 'Help' }).locator('.help-list').first().locator('.help-item').first()).toContainText('Approval flow');
});
