import { expect, test } from '@playwright/test';
import { call, PDF, staffLogin } from './helpers';

const CASES = [
  {
    ws: 'dunes', country: 'United Arab Emirates', mobile: '0501234567', law: 'Federal Decree-Law No. 45 of 2021', weekend: '(Saturday and Sunday)',
    tabs: ['Emiratisation & In-Country Value'], taxTab: 'Tax', verifyButtons: 1,
    profile: {
      basic: { entityType: 'Limited Liability Company (LLC)', address: 'Office 1204, Bay Square 7', region: 'Dubai', district: 'Dubai', supplyCategory: 'Services', freeZone: 'No' },
      bank: { bankName: 'Emirates NBD', iban: 'AE070331234567890123456' },
      tax: { licenceNumber: '784512', licenceAuthority: 'Dubai Economy and Tourism', vatRegistered: 'Yes', vatNumber: '100123456700003' },
      localContent: { employees: '40' },
      risk: { currency: 'AED' },
    },
    docs: ['Trade licence', 'VAT registration certificate (FTA)', 'Emirates ID or passport', 'Bank letter showing the IBAN', 'Ownership (beneficial owner) declaration'],
  },
  {
    ws: 'pearl', country: 'Bahrain', mobile: '33123456', law: 'Law No. 30 of 2018', weekend: '(Friday and Saturday)',
    tabs: ['Bahrainisation'], taxTab: 'Tax', verifyButtons: 2,
    profile: {
      basic: { entityType: 'With Limited Liability Company (W.L.L.)', address: 'Building 1234, Road 2810', postalCode: '428', region: 'Seef', district: 'Manama', supplyCategory: 'Goods' },
      bank: { bankName: 'National Bank of Bahrain', iban: 'BH67BMAG00001299123456' },
      tax: { crNumber: '12345-1', vatRegistered: 'Yes', vatNumber: '200000445300002' },
      localContent: { employees: '25' },
      risk: { currency: 'BHD' },
    },
    docs: ['Commercial Registration (CR) certificate', 'VAT registration certificate (NBR)', 'CPR or passport', 'Bank letter showing the IBAN', 'Ownership (beneficial owner) declaration'],
  },
];

for (const c of CASES) {
  test(`${c.country} workspace: local form, checks, PDPL notice, screening on submit, local working week`, async ({ browser }) => {
    const admin = await staffLogin(browser, `admin@${c.ws}.test`, c.ws);
    const name = `${c.ws} Supplier ${Date.now()}`;
    await admin.goto('/staff/vendors');
    await admin.getByRole('button', { name: '+ New vendor' }).click();
    await admin.fill('#cv-name', name);
    await admin.fill('#cv-fn', 'Sam'); await admin.fill('#cv-ln', 'Lee');
    await admin.fill('#cv-em', `sam+${Date.now()}@${c.ws}.test`); await admin.fill('#cv-mo', c.mobile);
    await admin.getByRole('button', { name: /Create & notify/ }).click();
    await expect(admin.getByRole('heading', { name })).toBeVisible();
    const link = await admin.locator('a.break').getAttribute('href');

    const v = await (await browser.newContext()).newPage();
    await v.goto(link!);
    await v.getByRole('button', { name: 'Send code' }).click();
    await v.fill('#otp', (await v.locator('.alert-info strong').textContent())!.trim());
    await v.getByRole('button', { name: /Verify & continue/ }).click();
    const consent = v.getByRole('dialog', { name: 'Privacy notice' });
    await expect(consent).toContainText(c.law);
    await consent.getByRole('checkbox').check();
    await consent.getByRole('button', { name: 'Accept and continue' }).click();
    for (const t of c.tabs) await expect(v.getByRole('tab', { name: t })).toBeVisible();

    const p = c.profile;
    await call(v, 'PUT', '/api/vendor/profile/basic', p.basic);
    await call(v, 'PUT', '/api/vendor/profile/bank', { ...p.bank, accountHolderName: name });
    await call(v, 'PUT', '/api/vendor/profile/tax', p.tax);
    await call(v, 'PUT', '/api/vendor/profile/ownership', { owner1Name: 'Sam Lee', owner1Nationality: 'British', owner1Share: '100', moreOwners: 'No', pep: 'No', relatedToBuyer: 'No' });
    await call(v, 'PUT', '/api/vendor/profile/localContent', p.localContent);
    await call(v, 'PUT', '/api/vendor/profile/risk', { fiscalYearEnd: 'December', ...p.risk, turnoverYear: 'FY 2025', annualTurnover: '5000000', sourceOfInfo: 'Audited financial statements', hasRating: 'No', bankruptcy5y: 'No', litigation: 'No' });
    await v.reload();

    await v.getByRole('tab', { name: c.taxTab, exact: true }).click();
    await expect(v.getByRole('button', { name: 'Verify' })).toHaveCount(c.verifyButtons);
    await v.getByRole('button', { name: 'Verify' }).first().click();
    await expect(v.locator('.verify .vbadge').first()).toHaveText('✓ Verified');

    await v.getByRole('tab', { name: 'Documents' }).click();
    const nextYear = `${new Date().getFullYear() + 1}-06-30`;
    for (const label of c.docs) {
      const row = v.locator('.doc-row', { hasText: label }).first();
      const date = row.locator('input[type=date]');
      if (await date.count()) await date.fill(nextYear);
      await row.locator('input[type=file]').setInputFiles(PDF);
      await expect(row.locator('.doc-file')).toHaveCount(1);
    }
    await v.getByRole('button', { name: 'Submit for review' }).first().click();
    await v.getByRole('dialog').getByRole('button', { name: 'Submit' }).click();
    await expect(v.getByText(/being reviewed/)).toBeVisible();

    await admin.reload();
    await expect(admin.locator('.card', { hasText: 'Verifications' }).locator('.verif li', { hasText: 'Sanctions screening' })).toContainText('Clear');
    await admin.goto('/staff/admin/workspace');
    await expect(admin.getByRole('checkbox', { name: /Count deadlines in working days/ })).toBeChecked();
    await expect(admin.getByText(c.weekend, { exact: false })).toBeVisible();
  });
}
