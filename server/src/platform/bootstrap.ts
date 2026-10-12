import { count } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { sendMail } from '../lib/mailer.js';
import { issuePlatformToken, platformLog } from './session.js';

/** Invites the first platform admin when none exist yet. Returns the invitation link, or null if there already is one. */
export async function ensureFirstPlatformAdmin(email: string, name: string) {
  const [n] = await db.select({ n: count() }).from(schema.platformAdmins);
  if (Number(n.n) > 0) return null;
  const [a] = await db.insert(schema.platformAdmins).values({ email: email.trim().toLowerCase(), name }).returning();
  const link = await issuePlatformToken(a.id, 'INVITE');
  await sendMail({ tenantId: null, to: a.email, subject: 'Set up your VendorGate platform console', body: `Hello ${name},\n\nYou are the first administrator of the VendorGate platform console, where you create and manage customer workspaces. Open the link to set your password, then set up two-factor authentication. The link is valid for 7 days.`, link });
  await platformLog({ actor: 'system', action: 'ADMIN_INVITED', detail: { email: a.email, via: 'PLATFORM_ADMIN_EMAIL' } });
  return link;
}
