import { expect, test, type Browser, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { call, staffLogin } from './helpers';

const iso = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://vendor:vendor@localhost:5433/vendor_onboarding_e2e';
const sql = (q: string) => execSync(`psql ${DB} -c "${q}"`);

/** An outside bidder signs in to the portal, registers briefly and accepts the event. */
async function bidderFor(browser: Browser, admin: Page, vendorId: string, eventId: string) {
  await admin.goto(`/staff/vendors/${vendorId}`);
  const token = (await admin.locator('a.break').getAttribute('href'))!.split('/').pop();
  const p = await (await browser.newContext()).newPage();
  await p.goto('/');
  const { devOtp } = await call(p, 'POST', '/api/vendor-auth/request-otp', { token });
  await call(p, 'POST', '/api/vendor-auth/verify-otp', { token, code: devOtp });
  await call(p, 'POST', '/api/vendor/consent', { version: (await call(p, 'GET', '/api/vendor')).privacy.version });
  await call(p, 'POST', '/api/vendor/bidder-registration', { supplies: 'Cement' });
  await call(p, 'POST', `/api/vendor/events/${eventId}/response`, { accept: true, noConflict: true });
  return p;
}

test('award: the buyer splits a lot with a reason, senior management approves, the bidder sees the result', async ({ browser }) => {
  const admin = await staffLogin(browser, 'admin@acme.test');
  await call(admin, 'PUT', '/api/admin/sourcing', { enabled: true, formats: { rfq: true, reverse: true } });
  const levels = (await call(admin, 'GET', '/api/admin/sourcing')).approval.levels;
  await call(admin, 'PUT', '/api/admin/sourcing/approval', { levels: [] });
  const buyer = await staffLogin(browser, 'buyer@acme.test');
  const e = (await call(buyer, 'POST', '/api/staff/sourcing/events', { title: 'Award cement', format: 'reverse', estimatedValue: 500000, liveStartsAt: iso(2), liveEndsAt: iso(3) })).event;
  await call(buyer, 'PUT', `/api/staff/sourcing/events/${e.id}/items`, { lots: [{ title: 'Cement', bidMode: 'lot', startPrice: 500000, lines: [{ description: 'OPC 53', quantity: 1000, unit: 'Bags' }] }] });
  await call(buyer, 'POST', `/api/staff/sourcing/events/${e.id}/submit`);
  const stamp = Date.now();
  const add = (name: string, first: string) => call(buyer, 'POST', `/api/staff/sourcing/events/${e.id}/outside-bidders`, { name: `${name} ${stamp}`, vendorType: 'IMPORT', contactFirstName: first, contactLastName: 'V', contactEmail: `${first.toLowerCase()}+${stamp}@e2e.test`, contactMobile: '+44 7700 900123' });
  await add('North Cement', 'Nia');
  const r = await add('South Cement', 'Sol');
  await call(buyer, 'POST', `/api/staff/sourcing/events/${e.id}/invitations`);
  const north = await bidderFor(browser, admin, r.bidders[0].vendor.id, e.id);
  const south = await bidderFor(browser, admin, r.bidders[1].vendor.id, e.id);
  sql(`update sourcing_events set live_starts_at = now() - interval '1 minute', live_ends_at = now() + interval '30 minutes' where id = '${e.id}'`);
  const lotId = (await call(north, 'GET', `/api/vendor/events/${e.id}/live`)).lots[0].id;
  await call(north, 'POST', `/api/vendor/events/${e.id}/bids`, { lotId, amount: 470000 });
  await call(south, 'POST', `/api/vendor/events/${e.id}/bids`, { lotId, amount: 460000 });
  sql(`update sourcing_events set live_ends_at = now() - interval '1 second' where id = '${e.id}'`);

  // Propose: split 60 / 40 (not all to the best price → reason, senior approval).
  await buyer.goto(`/staff/sourcing/events/${e.id}`);
  await expect(buyer.getByText('Propose the award in the Award section.')).toBeVisible();
  await buyer.getByLabel('Share for Bidder 2 in lot 1').fill('60');
  await buyer.getByLabel('Share for Bidder 1 in lot 1').fill('40');
  await buyer.getByLabel(/Reason for not awarding/).fill('Two sources for the monsoon season');
  await expect(buyer.getByText(/Award total: .*4,64,000/)).toBeVisible();
  await buyer.getByRole('button', { name: 'Propose award' }).click();
  await expect(buyer.locator('.alert-success', { hasText: 'Award proposed. Approval: Senior management approval' })).toBeVisible();

  // Senior management (admin) approves.
  await admin.goto(`/staff/sourcing/events/${e.id}`);
  await admin.getByRole('button', { name: /Approve — Senior management/ }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(admin.locator('.alert-success', { hasText: 'Award approved' })).toBeVisible();
  await expect(admin.getByText('Saving vs start price')).toBeVisible();
  await expect(admin.getByText(/New supplier — onboarding started/).first()).toBeVisible();
  await admin.addStyleTag({ content: '.af-header{position:static !important}' });
  await admin.locator('#award').screenshot({ path: 'test-results/award.png' });

  // Each bidder sees only their own result.
  await north.goto(`/vendor/events/${e.id}`);
  await expect(north.getByText('You have been awarded:')).toBeVisible();
  await expect(north.getByText(/40% · .*1,88,000/)).toBeVisible();
  await expect(north.getByText('4,60,000')).toHaveCount(0);

  await call(admin, 'PUT', '/api/admin/sourcing/approval', { levels });
  await call(admin, 'PUT', '/api/admin/sourcing', { enabled: false, formats: { rfq: true, reverse: true } });
});
