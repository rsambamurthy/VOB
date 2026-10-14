import { expect, test } from '@playwright/test';
import { call, staffLogin } from './helpers';

test('purchase orders: buyer loads orders, supplier signs in by email and accepts lines, buyer sees it', async ({ browser }) => {
  const admin = await staffLogin(browser, 'admin@acme.test');
  // Manual acceptance for the groups the sample orders use, so nothing auto-accepts mid-test.
  await admin.goto('/staff/orders');
  await expect(admin.getByRole('heading', { name: 'Purchase orders' })).toBeVisible();
  await admin.getByRole('button', { name: 'Load sample orders' }).click();
  await expect(admin.locator('.alert-success, .alert-info').first()).toContainText(/Sample purchase orders/);
  await expect(admin.locator('table.table tbody tr').first()).toBeVisible();

  // Purchasing setup shows the groups created from the orders
  await admin.getByRole('link', { name: 'Purchasing setup' }).click();
  await expect(admin.getByRole('heading', { name: 'Purchasing setup' })).toBeVisible();
  await expect(admin.locator('table tbody tr').first()).toBeVisible();

  // Vendor page: supplier portal card with the sign-in link
  const { vendors } = await call(admin, 'GET', '/api/staff/vendors?status=APPROVED');
  const precision = vendors.find((v: { contactEmail?: string; name: string }) => /precision/i.test(v.name));
  await admin.goto(`/staff/vendors/${precision.id}`);
  await expect(admin.locator('.card', { hasText: 'Supplier portal' })).toContainText('/s/acme');

  // Supplier signs in with email + code
  const sup = await (await browser.newContext()).newPage();
  await sup.goto('/s/acme');
  await sup.getByLabel('Work email').fill('accounts@precision.in');
  await sup.getByRole('button', { name: 'Send code' }).click();
  const code = (await sup.locator('.alert-info strong.mono').textContent())!.trim();
  await sup.locator('#s-otp').fill(code);
  await sup.getByRole('button', { name: 'Sign in' }).click();
  await sup.waitForURL('**/vendor');
  const consent = sup.getByRole('dialog', { name: 'Privacy notice' });
  await expect(sup.locator('.page-head h1')).toBeVisible();
  if (await consent.waitFor({ timeout: 3000 }).then(() => true, () => false)) { await consent.getByRole('checkbox').check(); await consent.getByRole('button', { name: 'Accept and continue' }).click(); await expect(consent).toBeHidden(); }
  await sup.locator('.topnav').getByRole('link', { name: /Purchase orders/ }).click();
  await expect(sup.getByRole('heading', { name: 'Purchase orders' })).toBeVisible();
  await sup.locator('table.table tbody tr a').first().click();
  await expect(sup.locator('.action-bar')).toBeVisible();

  // Accept one line first (if there are several), then the rest
  const boxes = sup.locator('tbody .chk input[type=checkbox]');
  const n = await boxes.count();
  if (n > 1) {
    await sup.getByLabel('Select all lines waiting for acceptance').uncheck();
    await boxes.first().check();
    await sup.getByRole('button', { name: 'Accept 1 selected line' }).click();
    await sup.getByRole('dialog').getByRole('button', { name: 'Accept' }).click();
    await expect(sup.locator('.alert-success')).toContainText('1 line accepted');
    await expect(sup.locator('h1 .badge')).toHaveText('Partly accepted');
  }
  await sup.getByRole('button', { name: 'Accept order' }).click();
  await sup.getByLabel('Note for the buyer (optional)').fill('Dispatch next week');
  await sup.getByRole('dialog').getByRole('button', { name: 'Accept' }).click();
  await expect(sup.locator('h1 .badge')).toHaveText('Accepted');
  const poNumber = (await sup.locator('h1 .mono-num').textContent())!.replace('PO ', '').trim();

  // Buyer sees the acceptance, who did it and the ERP message
  await admin.goto('/staff/orders?f=ACCEPTED');
  await admin.locator('tbody tr', { hasText: poNumber }).click();
  await expect(admin.locator('h1 .badge')).toHaveText('Accepted');
  await expect(admin.locator('.card', { hasText: 'History' })).toContainText('Dispatch next week');
  await expect(admin.locator('.card', { hasText: 'Messages to the ERP' })).toContainText('Acceptance');

  // Supplier: a shipment notice, then an invoice for that shipment
  await sup.getByRole('button', { name: 'Create shipment notice' }).click();
  const shipDlg = sup.getByRole('dialog', { name: 'Shipment notice' });
  await shipDlg.getByLabel('Carrier').fill('Blue Dart');
  await shipDlg.getByRole('button', { name: 'Send shipment notice' }).click();
  await expect(sup.locator('.alert-success')).toContainText('Shipment notice ASN-');
  await expect(sup.locator('.card', { hasText: 'Shipment notices' })).toContainText('In transit');
  await sup.getByRole('button', { name: 'Raise invoice' }).click();
  const inv = sup.getByRole('dialog', { name: 'Raise an invoice' });
  const invNo = `E2E-${Date.now() % 1_000_000}`;
  await inv.getByLabel('Invoice number').fill(invNo);
  await inv.getByLabel('For shipment').selectOption({ index: 1 });
  await inv.getByRole('button', { name: 'Check' }).click();
  await expect(inv.locator('.checks-list')).toContainText('received');
  await inv.getByRole('button', { name: 'Submit invoice' }).click();
  await expect(sup.locator('.alert-success')).toContainText('Invoice submitted');
  await sup.locator('.topnav').getByRole('link', { name: 'Invoices' }).click();
  await expect(sup.locator('tbody tr', { hasText: invNo })).toContainText('Exception');

  // Buyer: the invoice is in the review queue; approving an exception needs a note
  await admin.goto('/staff/invoices');
  await admin.locator('tbody tr', { hasText: invNo }).click();
  await expect(admin.locator('.card', { hasText: 'Matching' })).toContainText('received');
  await admin.getByRole('button', { name: /^Approve/ }).click();
  const dec = admin.getByRole('dialog', { name: 'Approve invoice' });
  await expect(dec.getByRole('button', { name: 'Approve' })).toBeDisabled();
  await dec.locator('textarea').fill('Goods arrive this week');
  await dec.getByRole('button', { name: 'Approve' }).click();
  await expect(admin.locator('h1 .badge')).toHaveText('Approved');
  await sup.goBack();

  // Help knows the screen
  await sup.keyboard.press('F1');
  await expect(sup.getByRole('dialog', { name: 'Help' })).toContainText('Accepting purchase orders');
});
