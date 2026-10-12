import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests. Run: npm run test:e2e   (first time: npx playwright install chromium)
 * They start their own server on port 4100 against a separate database (vendor_onboarding_e2e).
 */
const PORT = 4100;
const DB = process.env.E2E_DATABASE_URL ?? 'postgresql://vendor:vendor@localhost:5433/vendor_onboarding_e2e';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure', ...devices['Desktop Chrome'], viewport: { width: 1400, height: 900 } },
  webServer: {
    command: 'npm run -w server e2e:start',
    url: `http://localhost:${PORT}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'development', PORT: String(PORT), DATABASE_URL: DB, APP_BASE_URL: `http://localhost:${PORT}`,
      DEV_SHOW_OTP: 'true', JOBS_ENABLED: 'false', UPLOAD_DIR: './uploads-e2e', LOG_LEVEL: 'warn',
    },
  },
});
