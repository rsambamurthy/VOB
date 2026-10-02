import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import { env } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { defineJob, enqueue } from '../../jobs/queue.js';
import { msg91Driver, normaliseMobile, testSmsDriver, twilioDriver, type SmsDriver } from './drivers.js';

const i = env.int;
let driver: SmsDriver =
  i.SMS_PROVIDER === 'msg91' ? msg91Driver({ authKey: i.MSG91_AUTH_KEY!, templates: { otp: i.MSG91_OTP_TEMPLATE_ID! } })
  : i.SMS_PROVIDER === 'twilio' ? twilioDriver({ sid: i.TWILIO_ACCOUNT_SID!, token: i.TWILIO_AUTH_TOKEN!, from: i.TWILIO_FROM! })
  : testSmsDriver;

export function setSmsDriver(d: SmsDriver) { driver = d; }
export const smsStatus = () => ({ provider: driver.name, live: driver.live });
export const smsAvailable = () => driver.live || !env.isProd;

/** Sends (or, in test mode, records) a text. `vars` feed DLT template variables. */
export async function sendSms(m: { tenantId: string | null; to: string; body: string; purpose: 'otp' | 'test'; vars?: Record<string, string> }) {
  const to = normaliseMobile(m.to, i.SMS_DEFAULT_COUNTRY_CODE);
  if (!/^\d{8,15}$/.test(to)) throw new Error('Invalid mobile number');
  const [row] = await db.insert(schema.smsLog).values({ tenantId: m.tenantId, to, body: m.body, purpose: m.purpose, status: driver.live ? 'QUEUED' : 'TEST', provider: driver.name }).returning({ id: schema.smsLog.id });
  if (!driver.live) { logger.info({ to: `${to.slice(0, 4)}••••${to.slice(-2)}`, purpose: m.purpose }, 'sms recorded (test mode)'); return; }
  await enqueue('sms.send', { id: row.id, vars: m.vars ?? {} });
}

defineJob<{ id: string; vars: Record<string, string> }>('sms.send', async ({ id, vars }) => {
  const row = await db.query.smsLog.findFirst({ where: eq(schema.smsLog.id, id) });
  if (!row || row.status === 'SENT') return;
  // OTPs older than 10 minutes are useless — don't keep retrying them.
  if (row.purpose === 'otp' && Date.now() - row.createdAt.getTime() > 10 * 60_000) return;
  try {
    const r = await driver.send({ to: row.to, body: row.body, vars, purpose: row.purpose });
    await db.update(schema.smsLog).set({ status: 'SENT', sentAt: new Date(), providerMessageId: r.id ?? null, error: null, attempts: sql`${schema.smsLog.attempts} + 1` }).where(eq(schema.smsLog.id, id));
  } catch (err: any) {
    await db.update(schema.smsLog).set({ status: 'FAILED', error: String(err?.message ?? err).slice(0, 500), attempts: sql`${schema.smsLog.attempts} + 1` }).where(eq(schema.smsLog.id, id));
    throw err;
  }
}, { retryLimit: 2, retryDelay: 10, expireInSeconds: 60 });
