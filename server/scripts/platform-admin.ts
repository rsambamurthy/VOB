/**
 * Invite a platform admin (for when you can't use the console, e.g. everyone lost their 2FA device).
 *   npm run platform:admin -- --email you@company.com --name "Your Name"
 * Against production: set DATABASE_URL (public URL), ENCRYPTION_KEY and APP_BASE_URL first.
 */
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { db, pool, schema } from '../src/lib/db.js';
import { issuePlatformToken, platformLog } from '../src/platform/session.js';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' }, 'reset-2fa': { type: 'boolean' } } });
if (!values.email) { console.error('Usage: npm run platform:admin -- --email <email> [--name "<Name>"] [--reset-2fa]'); process.exit(1); }
try {
  const email = values.email.trim().toLowerCase();
  let a = await db.query.platformAdmins.findFirst({ where: eq(schema.platformAdmins.email, email) });
  if (a && values['reset-2fa']) {
    await db.update(schema.platformAdmins).set({ mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryHashes: [] }).where(eq(schema.platformAdmins.id, a.id));
    await db.delete(schema.platformSessions).where(eq(schema.platformSessions.adminId, a.id));
    await platformLog({ actor: 'cli', action: 'ADMIN_MFA_RESET', detail: { email } });
    console.log(`Two-factor authentication reset for ${email}. They will set it up again at the next sign-in.`);
  } else {
    if (!a) [a] = await db.insert(schema.platformAdmins).values({ email, name: values.name ?? email }).returning();
    else if (a.status !== 'INVITED') { console.log(`${email} is already a platform admin. Use --reset-2fa if they lost their authenticator, or "Forgot password" on the sign-in page.`); process.exit(0); }
    const link = await issuePlatformToken(a.id, 'INVITE');
    await platformLog({ actor: 'cli', action: 'ADMIN_INVITED', detail: { email } });
    console.log(`\nPlatform admin invitation for ${email} (valid 7 days):\n  ${link}\n`);
  }
} catch (e: any) { console.error(`Failed: ${e.message}`); process.exitCode = 1; } finally { await pool.end(); }
