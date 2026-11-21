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

test('Invoices step 2: duplicate rules configured on screen, a possible duplicate cleared, forwarded to Procurement', async ({ browser }) => {
  const settings = sql(`select settings::text from tenants where slug = 'acme'`);
  const run = Date.now() % 100000;
  try {
    const admin = await staffLogin(browser, 'admin@acme.test');
    await call(admin, 'PUT', '/api/admin/invoices', { enabled: true, bases: { po: true, contract: true, nonPo: true }, features: { touchless: false, creditNotes: true, debitNotes: true, bulkUpload: true, excelImport: true, emailInbox: true }, rules: { pushMode: 'manual' } });
    await call(admin, 'PUT', '/api/admin/invoices/approval', { levels: [] });
    const party = (await call(admin, 'POST', '/api/staff/parties', { kind: 'SUPPLIER', name: `Sparkle Services ${run}`, country: 'IN' })).party;
    await call(admin, 'POST', '/api/staff/invoices/codes', { kind: 'ACCOUNT', code: '5230', name: 'Housekeeping' }).catch(() => {});
    await call(admin, 'POST', '/api/staff/invoices/codes', { kind: 'COST_CENTRE', code: '130', name: 'Admin' }).catch(() => {});

    // The algorithm on the Administration page: how it works, and a rule changed and saved.
    await admin.goto('/staff/admin/invoices');
    const card = admin.getByRole('region', { name: 'Invoice duplicate check' });
    await card.getByRole('button', { name: 'How it works' }).click();
    await expect(card.getByText('Normalise the new invoice')).toBeVisible();
    await expect(card.getByText(/fixed: an IRN is unique by law/)).toBeVisible();
    await card.getByLabel('P6 Same note again action').selectOption('off');
    await card.getByRole('button', { name: 'Save invoice duplicate check' }).click();
    await expect(card.getByText(/Saved: P6 Same note again: Warn → Off/)).toBeVisible();
    await expect(admin.getByRole('region', { name: 'Email inbox' }).getByText(/invoices-acme-[a-f0-9]{10}@|isn’t available/)).toBeVisible();

    const make = async (number: string, date: string) => {
      const d = (await call(admin, 'POST', '/api/staff/invoices', { kind: 'INVOICE', partyId: party.id, invoiceNumber: number, invoiceDate: date, total: 21240, lines: [{ description: 'Housekeeping', quantity: 1, unitPrice: 18000, taxRate: 18, glAccount: '5230', costCentre: '130' }] })).invoice;
      await admin.request.post(`/api/staff/invoices/${d.id}/file`, { headers: { 'X-Requested-With': 'fetch' }, multipart: { file: { ...PDF, name: `${number.replace(/\W/g, '')}.pdf`, buffer: Buffer.concat([PDF.buffer, Buffer.from(number)]) } } });
      return call(admin, 'POST', `/api/staff/invoices/${d.id}/submit`, {});
    };
    await make(`SFS/${run}/1187`, '2026-11-02');
    const second = await make(`SFS/${run}/1201`, '2026-11-05');
    expect(second.invoice.status).toBe('EXCEPTION');

    // The invoice shows what it matched; AP clears it with a note.
    await admin.goto(`/staff/ap/invoices/${second.invoice.id}`);
    const dups = admin.getByRole('region', { name: 'Possible duplicates' });
    await expect(dups.getByText('P3')).toBeVisible();
    await expect(dups.getByRole('link', { name: `SFS/${run}/1187` })).toBeVisible();
    await dups.getByRole('button', { name: 'Not a duplicate…' }).click();
    await admin.getByLabel('Why it isn’t a duplicate').fill('Two separate months of service');
    await admin.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
    await expect(admin.getByText(/Not a duplicate of/)).toBeVisible();
    await expect(admin.locator('h1')).toContainText('Submitted');

    // Forward to Procurement (the buyer), who approves; it comes back for the AP decision.
    await admin.getByRole('button', { name: 'Forward for approval…' }).click();
    await admin.getByLabel('Person', { exact: true }).selectOption({ label: 'Rahul Verma (buyer@acme.test)' });
    await admin.getByLabel('What they should look at').fill('Was the deep cleaning ordered by your team?');
    await admin.getByRole('dialog').getByRole('button', { name: 'Forward' }).click();
    await expect(admin.locator('h1')).toContainText('In approval');
    await expect(admin.getByText(/Forwarded by Anita Rao: “Was the deep cleaning ordered by your team\?”/)).toBeVisible();
    const buyer = await staffLogin(browser, 'buyer@acme.test');
    await buyer.goto(`/staff/ap/invoices/${second.invoice.id}`);
    await buyer.getByRole('button', { name: 'Approve — Forwarded to Rahul Verma' }).click();
    await buyer.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
    // Anita entered the invoice, so the decision goes to the invoice approvers, not back to her.
    await expect(buyer.getByText('AP decision', { exact: true })).toBeVisible();
    await expect(buyer.getByText('Forwarded by Anita Rao: “Was the deep cleaning ordered by your team?”')).toBeVisible();
  } finally {
    execFileSync('psql', [DB, '-v', `s=${settings}`], { input: `update tenants set settings = :'s'::jsonb where slug = 'acme';` });
  }
});
