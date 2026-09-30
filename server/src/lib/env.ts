import 'dotenv/config';
import crypto from 'node:crypto';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().default('postgresql://vendor:vendor@localhost:5433/vendor_onboarding'),
  PORT: z.coerce.number().default(4000),
  /** Public URL of the web app, used in email links */
  APP_BASE_URL: z.string().default('http://localhost:5173'),
  /** 32-byte key (base64) for encrypting secrets at rest (TOTP secrets now; PAN/bank in Phase 6) */
  ENCRYPTION_KEY: z.string().optional(),
  /** Show OTPs on screen and enable the Mailbox screen. Never enable in production. */
  DEV_SHOW_OTP: z.enum(['true', 'false']).default('true'),
  UPLOAD_DIR: z.string().default('./uploads'),
  LOG_LEVEL: z.string().default('info'),
  /** Set when running behind a proxy/load balancer (Railway, Render, nginx) so rate limits see real IPs */
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
});

const parsed = schema.parse(process.env);
const isProd = parsed.NODE_ENV === 'production';

if (isProd) {
  if (!parsed.ENCRYPTION_KEY) throw new Error('ENCRYPTION_KEY is required in production (openssl rand -base64 32)');
  if (parsed.DEV_SHOW_OTP === 'true') throw new Error('DEV_SHOW_OTP must be false in production');
}

export const env = {
  nodeEnv: parsed.NODE_ENV,
  isProd,
  isTest: parsed.NODE_ENV === 'test',
  databaseUrl: parsed.DATABASE_URL,
  port: parsed.PORT,
  appBaseUrl: parsed.APP_BASE_URL.replace(/\/$/, ''),
  // Dev fallback key is derived from a constant so local data stays decryptable across restarts.
  encryptionKey: parsed.ENCRYPTION_KEY
    ? Buffer.from(parsed.ENCRYPTION_KEY, 'base64')
    : crypto.createHash('sha256').update('vendorgate-dev-only-key').digest(),
  devShowOtp: parsed.DEV_SHOW_OTP === 'true',
  uploadDir: parsed.UPLOAD_DIR,
  logLevel: parsed.LOG_LEVEL,
  trustProxy: parsed.TRUST_PROXY === 'true',
};

if (env.encryptionKey.length !== 32) throw new Error('ENCRYPTION_KEY must decode to 32 bytes');
