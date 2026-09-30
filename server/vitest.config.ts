import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://vendor:vendor@localhost:5433/vendor_onboarding_test',
      DEV_SHOW_OTP: 'true',
      UPLOAD_DIR: './uploads-test',
      APP_BASE_URL: 'http://app.test',
    },
  },
});
