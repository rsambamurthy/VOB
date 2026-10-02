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

  /* ---- Integrations (Phase 3). Every one defaults to a safe TEST mode. ---- */
  /** Run background jobs through the Postgres queue (pg-boss). false = run them in-process immediately. */
  JOBS_ENABLED: z.enum(['true', 'false']).default('true'),

  EMAIL_PROVIDER: z.enum(['test', 'smtp', 'sendgrid']).default('test'),
  EMAIL_FROM: z.string().default('VendorGate <no-reply@vendorgate.local>'),
  EMAIL_REPLY_TO: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  SENDGRID_API_KEY: z.string().optional(),

  SMS_PROVIDER: z.enum(['test', 'msg91', 'twilio']).default('test'),
  MSG91_AUTH_KEY: z.string().optional(),
  /** DLT-approved Flow template for the vendor OTP; variable ##otp## / VAR1 receives the code */
  MSG91_OTP_TEMPLATE_ID: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),
  /** Country code added to 10-digit mobile numbers */
  SMS_DEFAULT_COUNTRY_CODE: z.string().default('91'),

  STORAGE_DRIVER: z.enum(['local', 's3', 'azure']).default('local'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  /** For Cloudflare R2 / MinIO / Wasabi etc. Leave empty for AWS. */
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
  AZURE_STORAGE_CONNECTION_STRING: z.string().optional(),
  AZURE_STORAGE_CONTAINER: z.string().default('vendor-documents'),
  /** Virus scanning: 'none' or 'clamav' (clamd over TCP) */
  SCAN_PROVIDER: z.enum(['none', 'clamav']).default('none'),
  CLAMAV_HOST: z.string().default('127.0.0.1'),
  CLAMAV_PORT: z.coerce.number().default(3310),

  KYC_PROVIDER: z.enum(['mock', 'surepass']).default('mock'),
  SUREPASS_TOKEN: z.string().optional(),
  /** Production: https://kyc-api.surepass.io/api/v1 — Sandbox: https://sandbox.surepass.io/api/v1 */
  SUREPASS_BASE_URL: z.string().default('https://sandbox.surepass.io/api/v1'),
  SUREPASS_PATH_GSTIN: z.string().default('/corporate/gstin'),
  SUREPASS_PATH_PAN: z.string().default('/pan/pan-comprehensive'),
  SUREPASS_PATH_BANK: z.string().default('/bank-verification/'),
  SUREPASS_PATH_CIN: z.string().default('/corporate/company-details'),
  /** Re-use an identical successful check for this many hours (saves provider fees) */
  KYC_CACHE_HOURS: z.coerce.number().default(24),
  /** Max provider calls per vendor per check type per day */
  KYC_DAILY_LIMIT: z.coerce.number().default(10),

  AI_PROVIDER: z.enum(['mock', 'anthropic']).default('mock'),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-sonnet-5-5'),
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
  jobsEnabled: parsed.JOBS_ENABLED === 'true' && parsed.NODE_ENV !== 'test',
  int: parsed,
};

/** Fail fast when a live provider is selected without its credentials. */
const need = (cond: boolean, msg: string) => { if (cond) throw new Error(`Configuration error: ${msg}`); };
const i = parsed;
need(i.EMAIL_PROVIDER === 'smtp' && !i.SMTP_HOST, 'EMAIL_PROVIDER=smtp needs SMTP_HOST (and usually SMTP_USER / SMTP_PASS)');
need(i.EMAIL_PROVIDER === 'sendgrid' && !i.SENDGRID_API_KEY, 'EMAIL_PROVIDER=sendgrid needs SENDGRID_API_KEY');
need(i.SMS_PROVIDER === 'msg91' && (!i.MSG91_AUTH_KEY || !i.MSG91_OTP_TEMPLATE_ID), 'SMS_PROVIDER=msg91 needs MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID');
need(i.SMS_PROVIDER === 'twilio' && (!i.TWILIO_ACCOUNT_SID || !i.TWILIO_AUTH_TOKEN || !i.TWILIO_FROM), 'SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM');
need(i.STORAGE_DRIVER === 's3' && (!i.S3_BUCKET || !i.S3_ACCESS_KEY_ID || !i.S3_SECRET_ACCESS_KEY), 'STORAGE_DRIVER=s3 needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
need(i.STORAGE_DRIVER === 'azure' && !i.AZURE_STORAGE_CONNECTION_STRING, 'STORAGE_DRIVER=azure needs AZURE_STORAGE_CONNECTION_STRING');
need(i.KYC_PROVIDER === 'surepass' && !i.SUREPASS_TOKEN, 'KYC_PROVIDER=surepass needs SUREPASS_TOKEN');
need(i.AI_PROVIDER === 'anthropic' && !i.ANTHROPIC_API_KEY, 'AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY');

if (env.encryptionKey.length !== 32) throw new Error('ENCRYPTION_KEY must decode to 32 bytes');
