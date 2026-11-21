import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { call, PDF, staffLogin } from './helpers';

const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://vendor:vendor@localhost:5433/vendor_onboarding_e2e';
const sql = (q: string) => execFileSync('psql', [DB, '-At', '-c', q]).toString().trim();

test('Invoices add-on: AP enters an invoice without a PO, the cost-centre owner approves it, it waits for the ERP push', async ({ browser }) => {
  const settings = sql(`select settings::text from tenants where slug = 'acme'`);
  const run = Date.now() % 100000;
  try {
    const admin = await staffLogin(browser, 'admin@acme.test');
    await call(admin, 'PUT', '/api/admin/invoices', { enabled: true, bases: { po: true, contract: true, nonPo: true }, features: { touchless: false, creditNotes: true, debitNotes: true, bulkUpload: true, excelImport: true }, rules: { pushMode: 'manual' } });
    const party = (await call(admin, 'POST', '/api/staff/parties', { kind: 'SUPPLIER', name: `Pune Estates ${run}`, country: 'IN', ap: { paymentTerms: 'Net 30', accountsEmail: 'accounts@pune-estates.test' } })).party;
    await call(admin, 'POST', '/api/staff/invoices/codes', { kind: 'ACCOUNT', code: '5100', name: 'Rent' });
    await call(admin, 'POST', '/api/staff/invoices/codes', { kind: 'COST_CENTRE', code: '120', name: 'Pune plant' });

    // Code lists: the cost centre's owner is the budget approver.
    await admin.goto('/staff/admin/invoice-codes');
    await admin.getByRole('tab', { name: /Cost centres/ }).click();
    await admin.getByLabel('Owner of 120').selectOption({ label: 'Meera Nair' });
    await expect(admin.getByLabel('Owner of 120')).toHaveValue(/.+/);

    // AP enters the invoice.
    await admin.goto('/staff/ap/invoices');
    await admin.getByRole('button', { name: '+ New invoice' }).click();
    await admin.locator('#if-party').selectOption(party.id);
    await admin.locator('#if-basis').selectOption('nonPo');
    await admin.locator('#if-num').fill(`PE/26-27/${run}`);
    await admin.locator('#if-total').fill('29500');
    await admin.locator('#if-desc').fill('Warehouse rent — November');
    await admin.getByLabel('Line 1 description').fill('Warehouse rent');
    await admin.getByLabel('Line 1 unit price').fill('25000');
    await admin.getByLabel('Line 1 tax rate').fill('18');
    await admin.getByLabel('Line 1 GL account').fill('5100');
    await admin.getByLabel('Line 1 cost centre').fill('120');
    await admin.getByRole('button', { name: 'Save draft' }).click();
    await admin.waitForURL(/\/staff\/ap\/invoices\/[0-9a-f-]{36}$/);
    const url = admin.url();
    await expect(admin.getByRole('heading', { name: /Draft — finish and submit/ })).toBeVisible();
    await admin.locator('#inv-file').setInputFiles(PDF);
    await expect(admin.getByText('File attached.')).toBeVisible();
    await admin.getByRole('button', { name: 'Save and submit' }).click();
    await expect(admin.locator('h1')).toContainText('In approval');
    await expect(admin.getByRole('heading', { name: 'Approval matrix' })).toBeVisible();
    // The person who entered it can't approve it.
    await expect(admin.getByRole('button', { name: /^Approve — / })).toHaveCount(0);

    // The cost-centre owner approves.
    const owner = await staffLogin(browser, 'finance@acme.test');
    await owner.goto(url.replace(/^https?:\/\/[^/]+/, ''));
    await owner.getByRole('button', { name: 'Approve — Budget owner' }).click();
    await owner.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
    await expect(owner.locator('h1')).toContainText('Approved');
    await expect(owner.locator('h1')).toContainText('Ready for ERP');

    // Manual push: it is in the Ready for ERP queue.
    await admin.goto('/staff/ap/ready');
    await expect(admin.getByText(`PE/26-27/${run}`)).toBeVisible();
    await admin.getByLabel(`Select PE/26-27/${run}`).check();
    await admin.getByRole('button', { name: /Send 1 to the ERP/ }).click();
    await expect(admin.getByRole('alert').or(admin.locator('.alert')).first()).toContainText(/sent/i);
  } finally {
    execFileSync('psql', [DB, '-v', `s=${settings}`], { input: `update tenants set settings = :'s'::jsonb where slug = 'acme';` });
  }
});
