import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { staffLogin } from './helpers';

const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://vendor:vendor@localhost:5433/vendor_onboarding_e2e';
const sql = (q: string) => execFileSync('psql', [DB, '-At', '-c', q]).toString().trim();

test('Contracts-only plan: Administration shows no onboarding menus, roles, permissions or settings', async ({ browser }) => {
  const plan = sql(`select plan from tenants where slug = 'acme'`), limits = sql(`select limits::text from tenants where slug = 'acme'`);
  sql(`update tenants set plan = 'contracts', limits = '{}' where slug = 'acme'`);
  try {
    const admin = await staffLogin(browser, 'admin@acme.test');
    await admin.goto('/staff/admin/workspace');
    const nav = admin.getByRole('navigation');
    for (const item of ['Users', 'Roles', 'Contracts', 'Workspace', 'Integrations']) await expect(nav.getByRole('link', { name: item, exact: true })).toBeVisible();
    for (const item of ['Configuration', 'Agreements', 'Questionnaires', 'ERP integration', 'All vendors', 'Dashboard']) await expect(nav.getByRole('link', { name: item, exact: true })).toHaveCount(0);

    // Workspace: no supplier lifecycle or supplier privacy notice; working days stay (contract approvals use them).
    await expect(admin.getByRole('heading', { name: 'Deadlines' })).toBeVisible();
    await expect(admin.getByLabel('Re-verify every (months)')).toHaveCount(0);
    await expect(admin.getByText('Count deadlines in working days')).toBeVisible();
    await expect(admin.getByRole('heading', { name: /Privacy & data retention/ })).toHaveCount(0);

    // Integrations: email, storage and AI only.
    await admin.goto('/staff/admin/integrations');
    await expect(admin.getByRole('heading', { name: 'AI: contract reading and help answers' })).toBeVisible();
    await expect(admin.getByRole('heading', { name: 'SMS' })).toHaveCount(0);
    await expect(admin.getByText('How suppliers enter their details')).toHaveCount(0);

    // Roles: only contract roles, and no onboarding permission to tick.
    await admin.goto('/staff/admin/roles');
    await expect(admin.getByText('Contract Manager').first()).toBeVisible();
    await expect(admin.getByText('Vendor Admin')).toHaveCount(0);
    await expect(admin.getByText('Master Data Manager')).toHaveCount(0);
    await expect(admin.getByText('vendors.view')).toHaveCount(0);

    // The ERP screen is not reachable directly either.
    const erp = await admin.request.get('/api/admin/erp');
    expect(erp.status()).toBe(404);
  } finally {
    execFileSync('psql', [DB, '-v', `plan=${plan}`, '-v', `limits=${limits}`], { input: `update tenants set plan = :'plan', limits = :'limits'::jsonb where slug = 'acme';` });
  }
});
