import { expect, test } from '@playwright/test';
import { call, staffLogin } from './helpers';

test('contracts: the customer reviews by email link, proposes wording and accepts; both sides sign with test signing', async ({ browser }) => {
  const admin = await staffLogin(browser, 'admin@acme.test');
  await call(admin, 'PUT', '/api/admin/contracts', { enabled: true, types: { nda: true }, features: { esign: true, internalApproval: false } });
  await call(admin, 'PUT', '/api/admin/contracts/esign', { provider: 'test', sandbox: true, values: {} });
  const party = (await call(admin, 'POST', '/api/staff/parties', { kind: 'CUSTOMER', name: 'Harbour Retail', country: 'AE', contacts: [{ name: 'Omar Haddad', email: 'omar@harbour.example', signatory: true }] })).party;
  const c = await call(admin, 'POST', '/api/staff/contracts', { title: 'NDA — Harbour pilot', direction: 'SELL', type: 'nda', partyId: party.id, startDate: '2026-12-01', endDate: '2027-11-30', description: 'A retail pilot.' });
  const tpl = c.drafting.templates.find((t: any) => t.name === 'Mutual non-disclosure agreement');
  await call(admin, 'POST', `/api/staff/contracts/${c.contract.id}/draft`, { templateId: tpl.id, jurisdiction: 'AE' });
  await call(admin, 'POST', `/api/staff/contracts/${c.contract.id}/document`);

  await admin.goto(`/staff/contracts/${c.contract.id}`);
  await admin.getByRole('button', { name: 'Send to Harbour Retail for review' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Send' }).click();
  await expect(admin.locator('.alert-success').first()).toContainText('Sent to Omar Haddad');

  const linkTo = async () => ((await call(admin, 'GET', '/api/meta/outbox')) as any[]).find((m) => m.to === 'omar@harbour.example' && m.link?.includes('/review/')).link as string;
  const customer = await (await browser.newContext()).newPage();
  await customer.goto(new URL(await linkTo()).pathname);
  await customer.getByRole('button', { name: 'Send the code' }).click();
  await customer.getByRole('button', { name: 'Open the contract' }).click();
  await expect(customer.getByRole('heading', { name: 'NDA — Harbour pilot' })).toBeVisible();
  await expect(customer.getByText('Waiting for your review')).toBeVisible();
  // A comment with proposed wording on the governing law clause (UAE version).
  await expect(customer.getByText(/federal laws of the United Arab Emirates/)).toBeVisible();
  await customer.getByRole('button', { name: 'Comment: Governing law' }).click();
  await customer.locator('textarea').first().fill('We prefer DIFC.');
  await customer.getByRole('button', { name: 'Post comment' }).click();
  await expect(customer.getByText('We prefer DIFC.')).toBeVisible();
  await customer.getByRole('button', { name: 'Accept this version' }).click();
  await customer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(customer.getByText('Agreed — ready to sign')).toBeVisible();

  await admin.reload();
  await expect(admin.getByText('We prefer DIFC.')).toBeVisible();
  await admin.getByRole('button', { name: 'Send for signature' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Send' }).click();
  await expect(admin.locator('.badge', { hasText: 'Out for signature' }).first()).toBeVisible();

  await customer.goto(new URL(await linkTo()).pathname);
  await customer.getByRole('button', { name: 'Send the code' }).click();
  await customer.getByRole('button', { name: 'Open the contract' }).click();
  await expect(customer.getByText('It’s your turn to sign.')).toBeVisible();
  await customer.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(customer.getByText('Thank you — your signature has been added.')).toBeVisible();

  await admin.reload();
  await admin.getByRole('button', { name: 'Sign', exact: true }).click();
  await expect(admin.locator('.badge', { hasText: 'Active' }).first()).toBeVisible();
  await expect(admin.getByText(/signed\.pdf/).first()).toBeVisible();

  await call(admin, 'PUT', '/api/admin/contracts', { enabled: false, types: { nda: true } });
});
