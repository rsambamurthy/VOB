import { expect, test } from '@playwright/test';
import { PDF, staffLogin } from './helpers';

test('contracts: the administrator switches it on; a party and a contract are created, the signed copy uploaded and the contract marked signed', async ({ browser }) => {
  const admin = await staffLogin(browser, 'admin@acme.test');
  // Off by default: no Contracts menu group.
  await expect(admin.getByRole('link', { name: 'All contracts' })).toHaveCount(0);
  await admin.goto('/staff/admin/contracts');
  await expect(admin.getByRole('heading', { name: 'Contracts', exact: true })).toBeVisible();
  // Every option is released now; reading uploaded contracts needs the AI feature, which the plan has.
  await expect(admin.getByRole('checkbox', { name: /Read uploaded contracts/ })).toBeEnabled();
  await admin.getByRole('checkbox', { name: /Switch Contracts on/ }).check();
  await admin.getByRole('checkbox', { name: /Non-disclosure agreement/ }).check();
  await admin.getByRole('checkbox', { name: /Service \/ maintenance contract/ }).check();
  await admin.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(admin.locator('.alert-success')).toContainText('Contracts on');

  // A new supplier party.
  await admin.goto('/staff/parties');
  await expect(admin.getByRole('heading', { name: 'Parties' })).toBeVisible();
  await admin.getByRole('button', { name: '+ New party' }).click();
  await admin.getByRole('radio', { name: 'Supplier' }).check();
  await admin.fill('#pf-name', 'Coolair Services');
  await admin.fill('#pf-tax', 'E2E-TAX-001');
  await admin.getByRole('button', { name: '+ Add contact' }).click();
  await admin.fill('#pc-name-0', 'Ravi Kulkarni');
  await admin.fill('#pc-email-0', 'ravi@coolair.test');
  await admin.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(admin.getByRole('heading', { name: 'Coolair Services' })).toBeVisible();
  await expect(admin.getByText(/SUP-\d{5}/).first()).toBeVisible();

  // A draft service contract with that party.
  await admin.goto('/staff/contracts');
  await expect(admin.getByText('No contracts yet.')).toBeVisible();
  await admin.getByRole('button', { name: '+ New contract' }).click();
  const dlg = admin.getByRole('dialog');
  await dlg.getByLabel('Title').fill('Annual maintenance — HVAC, Pune plant');
  await dlg.getByLabel('Contract type').selectOption('service');
  const party = dlg.locator('#cf-party');
  await expect(party.locator('option', { hasText: 'Coolair Services' })).toHaveCount(1);
  await party.selectOption({ value: await party.locator('option', { hasText: 'Coolair Services' }).getAttribute('value') ?? '' });
  await dlg.getByLabel('Value').fill('480000');
  await dlg.getByLabel('Start date').fill('2026-04-01');
  // Ends in 45 days, so contract watch asks for a decision (notice 30 days → 15 days from now).
  await dlg.getByLabel('End date').fill(new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10));
  await dlg.getByRole('button', { name: 'Create draft' }).click();
  await expect(admin.getByRole('heading', { name: 'Annual maintenance — HVAC, Pune plant' })).toBeVisible();
  await expect(admin.getByText(/SVC-\d{4}-\d{4}/).first()).toBeVisible();
  await expect(admin.getByRole('button', { name: 'Mark as signed' })).toBeDisabled();

  // Upload the signed copy, then mark it signed.
  await admin.getByLabel('Add a file').selectOption('SIGNED');
  await admin.getByLabel('Contract file').setInputFiles({ ...PDF, name: 'hvac-amc-signed.pdf' });
  await expect(admin.getByText('hvac-amc-signed.pdf').first()).toBeVisible();
  await admin.getByRole('button', { name: 'Mark as signed' }).click();
  await admin.getByRole('dialog').getByRole('button', { name: 'Mark as signed' }).click();
  await expect(admin.locator('.badge', { hasText: 'Active' }).first()).toBeVisible();

  // Reading a file with no text (a scan) says so instead of guessing.
  await admin.getByRole('button', { name: 'Read hvac-amc-signed.pdf' }).click();
  await expect(admin.locator('.alert-error')).toContainText(/scan/);

  // Contract watch: a renew / renegotiate / end decision; record what was done.
  await admin.goto('/staff/contract-watch');
  await admin.getByRole('button', { name: 'Check now' }).click();
  await expect(admin.locator('.alert-success')).toContainText('Checked now');
  const decide = admin.getByTestId('watch-DECIDE').filter({ hasText: 'Annual maintenance' });
  await expect(decide).toContainText(/Decide before it ends: SVC-/);
  // The decision pack: VendorGate's recommendation with reasons, and a draft to the other party.
  await decide.getByRole('button', { name: 'Decision pack' }).click();
  const pack = decide.getByTestId('decision-pack');
  await expect(pack).toContainText('Summary written by VendorGate’s rules');
  await expect(pack).toContainText(/Notice by/);
  await pack.getByRole('button', { name: 'Draft: Notice that we will not renew' }).click();
  await expect(admin.getByRole('dialog').getByLabel('Subject')).toHaveValue(/^Notice of non-renewal — SVC-/);
  await expect(admin.getByRole('dialog').getByLabel('To')).toHaveValue('ravi@coolair.test');
  await admin.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).last().click();
  await decide.getByRole('button', { name: 'Renegotiate', exact: true }).click();
  await expect(admin.locator('.alert-success')).toContainText('Recorded');
  await admin.getByRole('tab', { name: 'Decided' }).click();
  await expect(admin.getByTestId('watch-DECIDE').first()).toContainText('Done: Renegotiate');

  // Bring contracts in: a signed copy named by the contract number is matched; an unknown file goes to the inbox.
  const number = (await admin.request.get('/api/staff/contracts?q=Annual').then((r) => r.json())).contracts[0].number as string;
  await admin.goto('/staff/contract-migration');
  await expect(admin.getByRole('heading', { name: 'Bring existing contracts in' })).toBeVisible();
  await admin.getByLabel('Files', { exact: true }).setInputFiles([{ ...PDF, buffer: Buffer.concat([PDF.buffer, Buffer.from('\n% annexure')]), name: `${number} annexure scan.pdf` }, { ...PDF, buffer: Buffer.concat([PDF.buffer, Buffer.from('\n% letter')]), name: 'old letter.pdf' }]);
  await admin.getByLabel('They are').selectOption('ANNEXURE');
  await admin.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(admin.getByText('1 to attach · 1 to the inbox', { exact: false })).toBeVisible();
  await admin.getByRole('button', { name: 'Upload 2 files' }).click();
  await expect(admin.locator('.alert-success')).toContainText('1 file attached, 1 to the inbox');
  const inbox = admin.getByRole('region', { name: 'Inbox' });
  await expect(inbox.getByRole('link', { name: 'old letter.pdf' })).toBeVisible();
  admin.once('dialog', (d) => d.accept());
  await inbox.getByRole('button', { name: 'Remove' }).click();
  await expect(inbox.getByText('Empty.')).toBeVisible();
  await expect(admin.getByRole('region', { name: 'Checklist' })).toContainText('Active contracts with no owner');

  // Contract reports show the active contract's value.
  await admin.goto('/staff/contract-reports');
  await expect(admin.getByRole('heading', { name: 'Contract reports' })).toBeVisible();
  await expect(admin.getByText('1 active supplier contract')).toBeVisible();
  await expect(admin.getByRole('link', { name: 'Download Excel' })).toBeVisible();

  await admin.goto('/staff/contracts');
  await expect(admin.getByRole('cell', { name: /Annual maintenance/ })).toBeVisible();

  // Switch it off again so other tests see the default.
  await admin.goto('/staff/admin/contracts');
  await admin.getByRole('checkbox', { name: /Switch Contracts on/ }).uncheck();
  await admin.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(admin.locator('.alert-success')).toContainText('Contracts off');
  await expect(admin.getByRole('link', { name: 'All contracts' })).toHaveCount(0);
});
