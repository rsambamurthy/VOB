import { expect, test } from '@playwright/test';
import { call, staffLogin } from './helpers';

const iso = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const DEFAULT_APPROVAL = [
  { id: 'finance', label: 'Finance approval', roleKey: 'FINANCE_MANAGER', rule: { match: 'all', conditions: [{ field: 'event.estimatedValue', op: 'gt', value: 1000000 }] }, slaHours: 48 },
  { id: 'senior', label: 'Senior management approval', roleKey: 'ADMIN', rule: { match: 'all', conditions: [{ field: 'event.estimatedValue', op: 'gt', value: 10000000 }] }, slaHours: 48 },
];

test('bidders: buyer invites a supplier and an outside bidder; the bidder registers, accepts and asks; the buyer answers', async ({ browser }) => {
  const admin = await staffLogin(browser, 'admin@acme.test');
  await call(admin, 'PUT', '/api/admin/sourcing', { enabled: true, formats: { rfq: true, reverse: true } });
  await call(admin, 'PUT', '/api/admin/sourcing/approval', { levels: [] });

  const buyer = await staffLogin(browser, 'buyer@acme.test');
  const e = (await call(buyer, 'POST', '/api/staff/sourcing/events', { title: 'Ball valves for Chakan', format: 'rfq', estimatedValue: 600000, category: 'Goods', bidDeadline: iso(72) })).event;
  await call(buyer, 'PUT', `/api/staff/sourcing/events/${e.id}/items`, { lots: [{ title: 'Valves', lines: [{ description: 'Ball valve DN25', quantity: 100, unit: 'Nos' }] }] });
  await call(buyer, 'POST', `/api/staff/sourcing/events/${e.id}/submit`);

  await buyer.goto(`/staff/sourcing/events/${e.id}`);
  await buyer.getByRole('button', { name: '+ Add suppliers' }).click();
  await buyer.getByRole('checkbox', { name: 'Pick Precision Valves Pvt Ltd' }).check();
  await buyer.getByRole('button', { name: /Add 1 to bidders/ }).click();
  await expect(buyer.locator('.alert-success', { hasText: '1 supplier added' })).toBeVisible();

  await buyer.getByRole('button', { name: '+ Outside bidder' }).click();
  const company = `Delta Flow ${Date.now()}`;
  await buyer.fill('#cv-name', company);
  await buyer.selectOption('#cv-type', 'IMPORT');
  await buyer.fill('#cv-fn', 'Dana'); await buyer.fill('#cv-ln', 'Lee');
  await buyer.fill('#cv-em', `dana+${Date.now()}@e2e.test`); await buyer.fill('#cv-mo', '+44 7700 900123');
  await buyer.getByRole('button', { name: 'Add to bidders' }).click();
  await expect(buyer.locator('.alert-success', { hasText: 'Outside bidder added' })).toBeVisible();
  await buyer.getByRole('button', { name: 'Send invitations (2)' }).click();
  await expect(buyer.locator('.alert-success', { hasText: 'Invitations sent to 2 bidders' })).toBeVisible();
  await expect(buyer.getByText('Published').first()).toBeVisible();

  // The outside bidder signs in from the link on their supplier page.
  const vendorId = (await call(buyer, 'GET', `/api/staff/sourcing/events/${e.id}`)).bidders.find((b: any) => b.outside).vendor.id;
  await admin.goto(`/staff/vendors/${vendorId}`);
  const link = await admin.locator('a.break').getAttribute('href');
  const bidder = await (await browser.newContext()).newPage();
  await bidder.goto(link!);
  await bidder.getByRole('button', { name: 'Send code' }).click();
  await bidder.fill('#otp', (await bidder.locator('.alert-info strong').textContent())!.trim());
  await bidder.getByRole('button', { name: /Verify & continue/ }).click();
  await bidder.getByRole('checkbox').check();
  await bidder.getByRole('button', { name: 'Accept and continue' }).click();

  await expect(bidder.getByRole('heading', { name: 'Bidder registration' })).toBeVisible();
  await bidder.getByLabel('What you supply').fill('Industrial valves');
  await bidder.getByRole('button', { name: 'Save and continue' }).click();
  await bidder.getByRole('link', { name: 'Ball valves for Chakan' }).click();
  await expect(bidder.getByText(/Other bidders see you as “Bidder 2”/)).toBeVisible();
  await bidder.getByRole('radio', { name: /no conflict of interest/ }).check();
  await bidder.getByRole('button', { name: 'Accept the invitation' }).click();
  await expect(bidder.getByText(/You accepted on/)).toBeVisible();
  await bidder.getByLabel('Ask a question').fill('Is a 3.1 material certificate required?');
  await bidder.getByRole('button', { name: 'Send question' }).click();
  await expect(bidder.getByText('Waiting for an answer')).toBeVisible();

  await buyer.goto(`/staff/sourcing/events/${e.id}`);
  await expect(buyer.getByRole('row', { name: new RegExp(company) })).toContainText('Accepted');
  await buyer.getByLabel('Answer to: Is a 3.1 material certificate required?').fill('Yes, EN 10204 3.1 for every heat.');
  await buyer.getByRole('button', { name: 'Answer all bidders' }).click();
  await expect(buyer.locator('.alert-success', { hasText: 'Shared with 2 bidders' })).toBeVisible();

  await bidder.reload();
  await expect(bidder.getByText('Yes, EN 10204 3.1 for every heat.')).toBeVisible();

  await call(admin, 'PUT', '/api/admin/sourcing/approval', { levels: DEFAULT_APPROVAL });
  await call(admin, 'PUT', '/api/admin/sourcing', { enabled: false, formats: { rfq: true, reverse: true } });
});
