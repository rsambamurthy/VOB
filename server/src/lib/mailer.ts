/**
 * Mail sending. Every email is recorded in email_outbox (shown in the dev Mailbox).
 * Phase 3 adds real delivery providers (SMTP / SES / SendGrid) behind this function.
 */
import { db, schema } from './db.js';
import { logger } from './logger.js';

export async function sendMail(m: { tenantId: string | null; to: string; subject: string; body: string; link?: string }) {
  await db.insert(schema.emailOutbox).values({ tenantId: m.tenantId, to: m.to, subject: m.subject, body: m.body, link: m.link });
  logger.info({ to: m.to, subject: m.subject }, 'mail queued');
}
