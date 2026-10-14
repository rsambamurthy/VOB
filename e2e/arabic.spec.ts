import { expect, test } from '@playwright/test';
import { staffLogin } from './helpers';

test('Arabic supplier portal: invited in Arabic, right-to-left form and notice, switches to English and back', async ({ browser }) => {
  const admin = await staffLogin(browser, 'admin@najd.test', 'najd');
  const name = `Dammam Trading ${Date.now()}`;
  await admin.goto('/staff/vendors');
  await admin.getByRole('button', { name: '+ New vendor' }).click();
  await admin.fill('#cv-name', name);
  await admin.fill('#cv-fn', 'Khalid'); await admin.fill('#cv-ln', 'Al-Otaibi');
  await admin.fill('#cv-em', `khalid+${Date.now()}@dammam.test`); await admin.fill('#cv-mo', '966501234567');
  await admin.selectOption('#cv-lang', 'ar');
  await admin.getByRole('button', { name: /Create & notify/ }).click();
  await expect(admin.getByRole('heading', { name })).toBeVisible();
  const link = await admin.locator('a.break').getAttribute('href');
  // Staff screens stay in English.
  await expect(admin.locator('html')).not.toHaveAttribute('dir', 'rtl');

  const vendor = await (await browser.newContext()).newPage();
  await vendor.goto(link!);
  await expect(vendor.locator('html')).toHaveAttribute('dir', 'rtl');
  await vendor.getByRole('button', { name: 'إرسال الرمز' }).click();
  await vendor.fill('#otp', (await vendor.locator('.alert-info strong').textContent())!.trim());
  await vendor.getByRole('button', { name: 'تحقق ومتابعة' }).click();

  const consent = vendor.getByRole('dialog', { name: 'إشعار الخصوصية' });
  await expect(consent).toContainText('نظام حماية البيانات الشخصية');
  await consent.getByRole('checkbox').check();
  await consent.getByRole('button', { name: 'موافقة ومتابعة' }).click();

  // The form comes from the server in Arabic; stored choices stay in English.
  await expect(vendor.getByRole('tab', { name: 'الضريبة والزكاة' })).toBeVisible();

  // Switch to English: the whole portal follows, and the choice is remembered on the server.
  await vendor.locator('.lang-switch').click();
  await expect(vendor.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(vendor.getByRole('tab', { name: 'Tax & Zakat' })).toBeVisible();
  await vendor.reload();
  await expect(vendor.getByRole('tab', { name: 'Tax & Zakat' })).toBeVisible();

  await vendor.locator('.lang-switch').click();
  await expect(vendor.getByRole('tab', { name: 'الضريبة والزكاة' })).toBeVisible();
});
