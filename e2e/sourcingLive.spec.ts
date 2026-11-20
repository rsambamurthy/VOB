import { expect, test } from '@playwright/test';
import { execSync } from 'node:child_process';
import { call, staffLogin } from './helpers';

const iso = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://vendor:vendor@localhost:5433/vendor_onboarding_e2e';

test('live auction: a bidder bids, the buyer sees it live and messages the bidders', async ({ browser }) => {
  const admin = await staffLogin(browser, 'admin@acme.test');
  await call(admin, 'PUT', '/api/admin/sourcing', { enabled: true, formats: { rfq: true, reverse: true } });
  const levels = (await call(admin, 'GET', '/api/admin/sourcing')).approval.levels;
  await call(admin, 'PUT', '/api/admin/sourcing/approval', { levels: [] });
  const buyer = await staffLogin(browser, 'buyer@acme.test');
  const e = (await call(buyer, 'POST', '/api/staff/sourcing/events', { title: 'Live cement', format: 'reverse', estimatedValue: 500000, liveStartsAt: iso(2), liveEndsAt: iso(3) })).event;
  await call(buyer, 'PUT', `/api/staff/sourcing/events/${e.id}/items`, { lots: [{ title: 'Cement', bidMode: 'lot', startPrice: 500000, lines: [{ description: 'OPC 53', quantity: 1000, unit: 'Bags' }] }] });
  await call(buyer, 'POST', `/api/staff/sourcing/events/${e.id}/submit`);
  const r = await call(buyer, 'POST', `/api/staff/sourcing/events/${e.id}/outside-bidders`, { name: `Live Co ${Date.now()}`, vendorType: 'IMPORT', contactFirstName: 'Lia', contactLastName: 'V', contactEmail: `lia+${Date.now()}@e2e.test`, contactMobile: '+44 7700 900123' });
  await call(buyer, 'POST', `/api/staff/sourcing/events/${e.id}/invitations`);
  await admin.goto(`/staff/vendors/${r.bidders[0].vendor.id}`);
  const token = (await admin.locator('a.break').getAttribute('href'))!.split('/').pop();
  const bidder = await (await browser.newContext()).newPage();
  await bidder.goto('/');
  const { devOtp } = await call(bidder, 'POST', '/api/vendor-auth/request-otp', { token });
  await call(bidder, 'POST', '/api/vendor-auth/verify-otp', { token, code: devOtp });
  await call(bidder, 'POST', '/api/vendor/consent', { version: (await call(bidder, 'GET', '/api/vendor')).privacy.version });
  await call(bidder, 'POST', '/api/vendor/bidder-registration', { supplies: 'Cement' });
  await call(bidder, 'POST', `/api/vendor/events/${e.id}/response`, { accept: true, noConflict: true });
  execSync(`psql ${DB} -c "update sourcing_events set live_starts_at = now() - interval '1 minute', live_ends_at = now() + interval '30 minutes' where id = '${e.id}'"`);

  await buyer.goto(`/staff/sourcing/events/${e.id}`);
  await expect(buyer.getByText('Live — ends in')).toBeVisible();
  await bidder.goto(`/vendor/events/${e.id}`);
  await expect(bidder.getByText('Ends in')).toBeVisible();
  await bidder.getByLabel(/Your bid for the lot/).fill('600000');
  await bidder.getByRole('button', { name: 'Place bid' }).click();
  await expect(bidder.locator('.alert-error')).toContainText('must not be above the start price');
  await bidder.getByLabel(/Your bid for the lot/).fill('480000');
  await bidder.getByRole('button', { name: 'Place bid' }).click();
  await expect(bidder.locator('.alert-success', { hasText: 'You are L1' })).toBeVisible();
  await expect(bidder.getByText(/Your next bid: at most/)).toBeVisible();

  // The buyer's screen updates without reloading.
  await expect(buyer.getByRole('row', { name: /L1 Bidder 1/ })).toContainText('4,80,000');
  await expect(buyer.getByText(/saving 4%/)).toBeVisible();
  await buyer.getByRole('button', { name: 'Message all bidders' }).click();
  await buyer.getByRole('dialog').getByLabel('Message').fill('Delivery to the Chakan plant.');
  await buyer.getByRole('dialog').getByRole('button', { name: 'Send' }).click();
  await expect(bidder.getByText('Delivery to the Chakan plant.')).toBeVisible();

  await call(admin, 'PUT', '/api/admin/sourcing/approval', { levels });
  await call(admin, 'PUT', '/api/admin/sourcing', { enabled: false, formats: { rfq: true, reverse: true } });
});
