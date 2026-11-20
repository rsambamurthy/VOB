import { expect, test } from '@playwright/test';
import { call, staffLogin } from './helpers';

const iso = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

test('sealed offer: a bidder submits and gets a receipt; the buyer sees it only as sealed', async ({ browser }) => {
  const admin = await staffLogin(browser, 'admin@acme.test');
  await call(admin, 'PUT', '/api/admin/sourcing', { enabled: true, formats: { rfq: true, reverse: true } });
  const levels = (await call(admin, 'GET', '/api/admin/sourcing')).approval.levels;
  await call(admin, 'PUT', '/api/admin/sourcing/approval', { levels: [] });

  const buyer = await staffLogin(browser, 'buyer@acme.test');
  const e = (await call(buyer, 'POST', '/api/staff/sourcing/events', { title: 'Sealed pumps', format: 'rfq', estimatedValue: 400000, bidDeadline: iso(48) })).event;
  await call(buyer, 'PUT', `/api/staff/sourcing/events/${e.id}/items`, { lots: [{ title: 'Pumps', bidMode: 'lot', lines: [{ description: 'Centrifugal pump 5 HP', quantity: 4, unit: 'Nos' }] }] });
  await call(buyer, 'POST', `/api/staff/sourcing/events/${e.id}/submit`);
  const r = await call(buyer, 'POST', `/api/staff/sourcing/events/${e.id}/outside-bidders`, { name: `Pump Co ${Date.now()}`, vendorType: 'IMPORT', contactFirstName: 'Pia', contactLastName: 'Lund', contactEmail: `pia+${Date.now()}@e2e.test`, contactMobile: '+44 7700 900123' });
  await call(buyer, 'POST', `/api/staff/sourcing/events/${e.id}/invitations`);
  await admin.goto(`/staff/vendors/${r.bidders[0].vendor.id}`);
  const link = await admin.locator('a.break').getAttribute('href');

  const bidder = await (await browser.newContext()).newPage();
  await bidder.goto(link!);
  await bidder.getByRole('button', { name: 'Send code' }).click();
  await bidder.fill('#otp', (await bidder.locator('.alert-info strong').textContent())!.trim());
  await bidder.getByRole('button', { name: /Verify & continue/ }).click();
  await bidder.getByRole('checkbox').check();
  await bidder.getByRole('button', { name: 'Accept and continue' }).click();
  await bidder.getByLabel('What you supply').fill('Pumps');
  await bidder.getByRole('button', { name: 'Save and continue' }).click();
  await bidder.getByRole('link', { name: 'Sealed pumps' }).click();
  await bidder.getByRole('radio', { name: /no conflict of interest/ }).check();
  await bidder.getByRole('button', { name: 'Accept the invitation' }).click();

  await bidder.getByLabel(/Price for the lot/).fill('152000');
  await bidder.getByLabel('Delivery (days)').fill('30');
  await bidder.getByLabel('Payment terms').fill('Net 30');
  await bidder.getByRole('button', { name: 'Submit sealed offer' }).click();
  await expect(bidder.getByText(/Received: version 1/)).toBeVisible();
  await expect(bidder.getByText(/Receipt reference [0-9A-F]{16}/)).toBeVisible();

  await buyer.goto(`/staff/sourcing/events/${e.id}`);
  await expect(buyer.getByRole('row', { name: /Bidder 1/ }).filter({ hasText: 'Sealed' })).toBeVisible();
  await expect(buyer.getByText('152')).toHaveCount(0);

  await call(admin, 'PUT', '/api/admin/sourcing/approval', { levels });
  await call(admin, 'PUT', '/api/admin/sourcing', { enabled: false, formats: { rfq: true, reverse: true } });
});
