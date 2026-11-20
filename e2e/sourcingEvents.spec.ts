import { expect, test } from '@playwright/test';
import { call, staffLogin } from './helpers';

const local = (hours: number) => { const d = new Date(Date.now() + hours * 3_600_000); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

test('sourcing event: a buyer sets up an RFQ, finance approves it', async ({ browser }) => {
  const admin = await staffLogin(browser, 'admin@acme.test');
  await call(admin, 'PUT', '/api/admin/sourcing', { enabled: true, formats: { rfq: true, reverse: true } });

  const buyer = await staffLogin(browser, 'buyer@acme.test');
  await buyer.goto('/staff/sourcing');
  await buyer.getByRole('button', { name: '+ New event' }).click();
  await buyer.getByLabel('Title').fill('MS plates for Pune plant');
  await buyer.getByRole('button', { name: 'Create' }).click();
  await expect(buyer.getByRole('heading', { name: 'MS plates for Pune plant' })).toBeVisible();
  await expect(buyer.getByText(/RFQ-\d{4}-\d{4}/).first()).toBeVisible();
  await expect(buyer.locator('.alert-info')).toContainText('Enter the estimated value');
  await expect(buyer.getByRole('button', { name: 'Submit for approval' })).toBeDisabled();

  await buyer.getByLabel(/Estimated value/).fill('2500000');
  await buyer.getByLabel('Bid deadline').fill(local(72));
  await buyer.getByRole('button', { name: 'Save details' }).click();
  await expect(buyer.locator('.alert-success')).toContainText('Saved');

  await buyer.getByRole('button', { name: '+ Add lot' }).click();
  await buyer.getByLabel('Lot 1', { exact: true }).fill('Plates');
  await buyer.getByLabel('Lot 1 item 1 description').fill('MS plate 10 mm');
  await buyer.getByLabel('Lot 1 item 1 quantity').fill('20');
  await buyer.getByLabel('Lot 1 item 1 unit').fill('MT');
  await buyer.getByRole('button', { name: 'Save items' }).click();
  await expect(buyer.locator('.alert-success')).toContainText('Items saved');

  await buyer.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(buyer.locator('.alert-success')).toContainText('Approval: Finance approval');
  await expect(buyer.getByText('Waiting for approval').first()).toBeVisible();
  const url = buyer.url();

  const fin = await staffLogin(browser, 'finance@acme.test');
  await fin.goto('/staff/queue');
  await expect(fin.locator('.alert-info', { hasText: 'sourcing event' })).toBeVisible();
  await fin.goto(url);
  await fin.getByRole('button', { name: 'Approve — Finance approval' }).click();
  await fin.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(fin.locator('.alert-success', { hasText: 'The owner can now invite bidders' })).toBeVisible();
  await expect(fin.getByText('Approved', { exact: true }).first()).toBeVisible();

  await call(admin, 'PUT', '/api/admin/sourcing', { enabled: false, formats: { rfq: true, reverse: true } });
});
