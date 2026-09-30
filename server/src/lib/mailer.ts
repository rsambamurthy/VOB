/**
 * Prototype mailer: writes every email to the email_outbox table (viewable in the
 * app under "Mailbox"). Replace sendMail() with SES / SendGrid / SMTP for production.
 */
import { db, schema } from './db.js';

export async function sendMail(to: string, subject: string, body: string, link?: string) {
  await db.insert(schema.emailOutbox).values({ to, subject, body, link });
  console.log(`[mail] to=${to} subject="${subject}"${link ? ` link=${link}` : ''}`);
}
