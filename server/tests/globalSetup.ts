/** Rebuilds the test database once per run: drop schema, migrate, seed demo data. */
export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgresql://vendor:vendor@localhost:5433/vendor_onboarding_test';

export default async function setup() {
  const { execSync } = await import('node:child_process');
  execSync('npx tsx src/db/reset.ts', { stdio: 'pipe', env: { ...process.env, NODE_ENV: 'test', RESET_CONFIRM: '1', DATABASE_URL: TEST_DB, APP_BASE_URL: 'http://app.test' } });
}
