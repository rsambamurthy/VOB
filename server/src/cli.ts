/**
 * VendorGate administration commands — built into the image, so on-prem IT can run them without development tools:
 *
 *   docker compose exec app node server/dist/cli.js <command> [options]
 *
 *   version                                      version and deployment mode
 *   setup                                        apply database updates (also done on every start)
 *   create-workspace --slug acme --name "Acme Ltd" --admin-name "Anita Rao" --admin-email anita@acme.com [--country IN]
 *   backup [--encrypt]                           database + locally stored documents → BACKUP_DIR
 *   restore <folder or file> --yes [--production]
 *   reencrypt                                    after rotating ENCRYPTION_KEY (old key in ENCRYPTION_KEY_PREVIOUS)
 *   licence show | licence install <file>
 *   user reset-2fa <email> [--workspace acme]    turn off 2FA so the user can set it up again
 *   user unlock <email> [--workspace acme]       clear a sign-in lock-out
 *   user reset-password <email> [--workspace acme]   print a password reset link
 */
import { parseArgs } from 'node:util';
import fs from 'node:fs';

const [cmd, sub, ...rest] = process.argv.slice(2);
const die = (msg: string): never => { console.error(msg); process.exit(1); };
const run = async (script: string, args: string[]) => { process.argv = [process.argv[0], script, ...args]; await import(script); };

async function main() {
  const { env } = await import('./lib/env.js');
  switch (cmd) {
    case 'version': case '--version': case '-v':
      console.log(`VendorGate ${env.version} (${env.onPrem ? 'on-premises' : 'cloud'})`); return;
    case 'setup': {
      const { runMigrations } = await import('./db/migrate.js');
      await runMigrations();
      const dm = await import('./db/dataMigrations.js');
      const n = await dm.sealExistingData(); await dm.grantNewAdminPermissions();
      console.log(`Database is up to date.${n ? ` Encrypted sensitive values in ${n} record(s).` : ''}`);
      break;
    }
    case 'create-workspace': {
      const { values } = parseArgs({ args: [sub, ...rest].filter(Boolean), options: { slug: { type: 'string' }, name: { type: 'string' }, 'admin-name': { type: 'string' }, 'admin-email': { type: 'string' }, country: { type: 'string' }, force: { type: 'boolean' } } });
      if (!values.slug || !values.name || !values['admin-name'] || !values['admin-email']) die('Usage: create-workspace --slug <id> --name "<Company>" --admin-name "<Name>" --admin-email <email> [--country IN]');
      const { db, schema } = await import('./lib/db.js');
      if (env.onPrem && !values.force && (await db.select({ id: schema.tenants.id }).from(schema.tenants).limit(1)).length) die('This installation already has a workspace. (Use --force to add another.)');
      const { createTenant } = await import('./services/tenants.js');
      const r = await createTenant({ slug: values.slug!, name: values.name!, adminName: values['admin-name']!, adminEmail: values['admin-email']!, country: values.country ?? 'IN', plan: 'enterprise', source: 'cli' });
      console.log(`Workspace "${r.tenant.slug}" created. Invitation for ${r.admin.email} (also emailed):\n  ${r.inviteLink}`);
      break;
    }
    case 'backup': return run('./db/backup.js', [sub, ...rest].filter(Boolean));
    case 'restore': return run('./db/restore.js', [sub, ...rest].filter(Boolean));
    case 'reencrypt': return run('./db/reencrypt.js', []);
    case 'licence': {
      const { loadLicence, installLicence } = await import('./services/licence.js');
      if (sub === 'install') {
        const file = rest[0] ?? die('Usage: licence install <licence file>');
        if (!fs.existsSync(file)) die(`No file at ${file}`);
        const s = await installLicence(fs.readFileSync(file, 'utf8'), { name: 'command line' }).catch((e) => die(e.message));
        console.log(`Installed licence ${s.licence?.id} for ${s.licence?.customer}, valid ${s.licence?.validFrom} to ${s.licence?.validUntil} — ${s.state}.`);
      } else {
        const s = await loadLicence();
        console.log(s.licence ? `Licence ${s.licence.id} for ${s.licence.customer}\n  valid ${s.licence.validFrom} to ${s.licence.validUntil} (${s.state}${s.daysLeft !== null ? `, ${s.daysLeft} days left` : ''})\n  users ${s.licence.maxUsers ?? 'unlimited'}, suppliers ${s.licence.maxVendors ?? 'unlimited'}` : 'No licence installed.');
        if (s.message) console.log(`  ${s.message}`);
      }
      break;
    }
    case 'user': {
      const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { workspace: { type: 'string' } } });
      const email = positionals[0]?.toLowerCase() ?? die('Usage: user reset-2fa|unlock|reset-password <email> [--workspace <id>]');
      const { db, schema } = await import('./lib/db.js');
      const { and, eq } = await import('drizzle-orm');
      const rows = await db.select({ u: schema.users, t: schema.tenants }).from(schema.users).innerJoin(schema.tenants, eq(schema.tenants.id, schema.users.tenantId))
        .where(and(eq(schema.users.email, email), ...(values.workspace ? [eq(schema.tenants.slug, values.workspace)] : [])));
      if (!rows.length) die(`No user ${email}${values.workspace ? ` in ${values.workspace}` : ''}`);
      if (rows.length > 1) die(`${email} is in several workspaces — add --workspace <id>`);
      const { u, t } = rows[0];
      const { audit } = await import('./lib/audit.js');
      if (sub === 'reset-2fa') { await db.update(schema.users).set({ mfaEnabled: false, mfaSecretEnc: null, mfaRecoveryHashes: [] }).where(eq(schema.users.id, u.id)); console.log(`2FA turned off for ${email}; they set it up again at next sign-in.`); }
      else if (sub === 'unlock') { await db.update(schema.users).set({ failedLogins: 0, lockedUntil: null }).where(eq(schema.users.id, u.id)); console.log(`${email} can sign in again.`); }
      else if (sub === 'reset-password') { const { issueToken } = await import('./services/users.js'); const tok = await issueToken(t.id, u.id, 'PASSWORD_RESET'); console.log(`Password reset link for ${email}:\n  ${env.appBaseUrl}/reset-password/${tok}`); }
      else die('Usage: user reset-2fa|unlock|reset-password <email>');
      await audit({ tenantId: t.id, actor: 'command line', action: 'USER_ADMIN_CLI', detail: { user: email, action: sub } });
      break;
    }
    default:
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith(' *')).map((l) => l.slice(3)).join('\n'));
      return;
  }
  const { pool } = await import('./lib/db.js');
  await pool.end();
}
await main().catch((e) => { console.error(`Failed: ${e?.cause?.message ?? e?.message ?? e}`); process.exit(1); });
