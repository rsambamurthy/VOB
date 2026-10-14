/**
 * sendMail(): records the message in email_outbox, then delivers it via the configured provider
 * on the job queue (retries with backoff). In test mode it is only recorded (status TEST).
 */
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import { env } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { defineJob, enqueue } from '../../jobs/queue.js';
import { renderEmail } from './template.js';
import { emailLimitReason } from '../../services/limits.js';
import type { Tenant } from '../../db/schema.js';
import { resendDriver, sendgridDriver, smtpDriver, testDriver, type EmailDriver } from './drivers.js';

const i = env.int;
let driver: EmailDriver =
  i.EMAIL_PROVIDER === 'smtp' ? smtpDriver({ host: i.SMTP_HOST!, port: i.SMTP_PORT, secure: i.SMTP_SECURE === 'true', user: i.SMTP_USER, pass: i.SMTP_PASS })
  : i.EMAIL_PROVIDER === 'sendgrid' ? sendgridDriver({ apiKey: i.SENDGRID_API_KEY! })
  : i.EMAIL_PROVIDER === 'resend' ? resendDriver({ apiKey: i.RESEND_API_KEY! })
  : testDriver;

/** For tests. */
export function setEmailDriver(d: EmailDriver) { driver = d; }
export const emailStatus = () => ({ provider: driver.name, live: driver.live, from: i.EMAIL_FROM, domains: i.EMAIL_PROVIDER === 'resend', bounceTracking: i.EMAIL_PROVIDER === 'resend' && !!i.RESEND_WEBHOOK_SECRET });

/** Sender for a workspace: its own name / reply-to, and its own domain once verified. */
export function senderFor(tenant?: Pick<Tenant, 'name' | 'branding' | 'settings'>) {
  if (!tenant) return { from: i.EMAIL_FROM, replyTo: i.EMAIL_REPLY_TO };
  const e = tenant.settings.email ?? {};
  const name = (e.fromName?.trim() || `${tenant.name} via ${tenant.branding.productName ?? 'VendorGate'}`).replace(/["<>]/g, '');
  const defaultAddress = (i.EMAIL_FROM.match(/<([^>]+)>/)?.[1] ?? i.EMAIL_FROM).trim();
  const address = e.domain?.status === 'verified' ? `${e.domain.fromLocal || 'no-reply'}@${e.domain.name}` : defaultAddress;
  return { from: `"${name}" <${address}>`, replyTo: e.replyTo || i.EMAIL_REPLY_TO };
}

export async function isSuppressed(address: string) {
  return !!(await db.query.emailSuppressions.findFirst({ where: eq(schema.emailSuppressions.address, address.trim().toLowerCase()) }));
}

export async function sendMail(m: { tenantId: string | null; to: string; subject: string; body: string; link?: string }) {
  if (await isSuppressed(m.to)) {
    await db.insert(schema.emailOutbox).values({ tenantId: m.tenantId, to: m.to, subject: m.subject, body: m.body, link: m.link, status: 'FAILED', provider: driver.name, error: 'Not sent: this address bounced or reported our email as spam earlier' });
    logger.warn({ tenantId: m.tenantId, subject: m.subject }, 'email not sent: address suppressed');
    return;
  }
  const over = m.tenantId ? await emailLimitReason(m.tenantId) : null;
  if (over) {
    await db.insert(schema.emailOutbox).values({ tenantId: m.tenantId, to: m.to, subject: m.subject, body: m.body, link: m.link, status: 'FAILED', provider: driver.name, error: over });
    logger.warn({ tenantId: m.tenantId, subject: m.subject }, 'email not sent: daily limit reached');
    return;
  }
  const [row] = await db.insert(schema.emailOutbox).values({
    tenantId: m.tenantId, to: m.to, subject: m.subject, body: m.body, link: m.link,
    status: driver.live ? 'QUEUED' : 'TEST', provider: driver.name,
  }).returning({ id: schema.emailOutbox.id });
  if (!driver.live) { logger.info({ to: m.to, subject: m.subject }, 'email recorded (test mode)'); return; }
  await enqueue('email.send', { id: row.id });
}

defineJob<{ id: string }>('email.send', async ({ id }) => {
  const row = await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.id, id) });
  if (!row || row.status === 'SENT') return;
  const tenant = row.tenantId ? await db.query.tenants.findFirst({ where: eq(schema.tenants.id, row.tenantId) }) : undefined;
  const { html, text } = renderEmail({ subject: row.subject, body: row.body, link: row.link, tenantName: tenant?.name, branding: tenant?.branding });
  const { from, replyTo } = senderFor(tenant);
  try {
    const r = await driver.send({ to: row.to, from, replyTo, subject: row.subject, html, text });
    await db.update(schema.emailOutbox).set({ status: 'SENT', sentAt: new Date(), providerMessageId: r.id ?? null, error: null, attempts: sql`${schema.emailOutbox.attempts} + 1` }).where(eq(schema.emailOutbox.id, id));
    logger.info({ provider: driver.name, messageId: r.id, to: row.to.replace(/^(.).*(@.*)$/, '$1***$2'), subject: row.subject }, 'email sent');
  } catch (err: any) {
    logger.warn({ provider: driver.name, to: row.to.replace(/^(.).*(@.*)$/, '$1***$2'), subject: row.subject, err: String(err?.message ?? err) }, 'email failed');
    await db.update(schema.emailOutbox).set({ status: 'FAILED', error: String(err?.message ?? err).slice(0, 500), attempts: sql`${schema.emailOutbox.attempts} + 1` }).where(eq(schema.emailOutbox.id, id));
    throw err; // let the queue retry
  }
});

export { renderEmail };
