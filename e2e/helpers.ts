import { expect, type Browser, type Page } from '@playwright/test';

export const PASSWORD = 'Demo@12345';
export const PDF = { name: 'doc.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF') };

export async function staffLogin(browser: Browser, email: string, workspace = 'acme') {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/login');
  await page.fill('#ws', workspace);
  await page.fill('#em', email);
  await page.fill('#pw', PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/staff/**');
  return page;
}

/** JSON call from inside the page (shares its sign-in cookies; sends the CSRF header). */
export async function call(page: Page, method: string, path: string, data?: unknown) {
  const r = await page.request.fetch(path, { method, data, headers: { 'X-Requested-With': 'fetch' } });
  expect(r.ok(), `${method} ${path} → ${r.status()} ${await r.text()}`).toBeTruthy();
  return r.json();
}

export function gstin(pan: string, state = '27') {
  // Same check-character algorithm as the server (mod-36 weighted).
  const base = `${state}${pan}1Z`, chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let i = 0; i < base.length; i++) { const p = chars.indexOf(base[i]) * (i % 2 ? 2 : 1); sum += Math.floor(p / 36) + (p % 36); }
  return base + chars[(36 - (sum % 36)) % 36];
}
