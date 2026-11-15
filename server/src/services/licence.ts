/**
 * On-prem licence: storing, loading and reminding (the rules are in lib/licence.ts).
 *  - The licence lives in the database (table system_licence), installed from Administration → Licence, the CLI
 *    (`node server/dist/cli.js licence install <file>`) or LICENCE_FILE at start-up.
 *  - Every app instance reloads it each minute, so a new licence takes effect everywhere without a restart.
 *  - Daily: administrators are emailed 30, 14, 7 and 1 days before it ends, when it ends, and when VendorGate turns read-only.
 */
import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';
import { sendMail } from '../lib/mailer.js';
import { currentLicence, licenceStatus, setCurrentLicence, verifyLicence } from '../lib/licence.js';
import { defineJob } from '../jobs/queue.js';
import { usersWithPermission } from './approvers.js';

const { systemLicence } = schema;
const ROW = 'current';

/** Read the installed licence into the cache (and install LICENCE_FILE first if it is newer). */
export async function loadLicence() {
  if (env.int.LICENCE_FILE && fs.existsSync(env.int.LICENCE_FILE)) {
    const token = fs.readFileSync(env.int.LICENCE_FILE, 'utf8').trim();
    const v = verifyLicence(token);
    const row = await db.query.systemLicence.findFirst({ where: eq(systemLicence.id, ROW) });
    const stored = row ? verifyLicence(row.token) : null;
    if (!v.ok) logger.error(`[licence] ${env.int.LICENCE_FILE}: ${v.error}`);
    else if (!stored?.ok || stored.licence.issuedAt < v.licence.issuedAt) await saveLicence(token, `licence file ${env.int.LICENCE_FILE}`);
  }
  const row = await db.query.systemLicence.findFirst({ where: eq(systemLicence.id, ROW) });
  const v = row ? verifyLicence(row.token) : null;
  if (row && v && !v.ok) logger.error(`[licence] the installed licence is not valid: ${v.error}`);
  setCurrentLicence(row && v?.ok ? { licence: v.licence, token: row.token, installedAt: row.installedAt, installedBy: row.installedBy } : null);
  return licenceStatus();
}

async function saveLicence(token: string, by: string) {
  await db.insert(systemLicence).values({ id: ROW, token, installedBy: by, installedAt: new Date() })
    .onConflictDoUpdate({ target: systemLicence.id, set: { token, installedBy: by, installedAt: new Date() } });
}

/** Install a licence (Administration → Licence, or the CLI). */
export async function installLicence(token: string, by: { name: string; tenantId?: string; ip?: string }) {
  const v = verifyLicence(token);
  if (!v.ok) throw new HttpError(400, v.error, undefined, 'LICENCE_INVALID');
  await saveLicence(token.trim(), by.name);
  await loadLicence();
  if (by.tenantId) await audit({ tenantId: by.tenantId, actor: by.name, action: 'LICENCE_INSTALLED', detail: { licence: v.licence.id, customer: v.licence.customer, validUntil: v.licence.validUntil }, ip: by.ip });
  logger.info({ licence: v.licence.id, validUntil: v.licence.validUntil, by: by.name }, '[licence] installed');
  return licenceStatus();
}

let timer: NodeJS.Timeout | undefined;
/** On-prem: load at start-up and re-read every minute (another instance may have installed a new one). */
export async function startLicence() {
  if (!env.onPrem) return;
  const s = await loadLicence();
  logger[s.readOnly ? 'warn' : 'info'](`[licence] ${s.licence ? `${s.licence.id} for ${s.licence.customer}, valid until ${s.licence.validUntil}` : 'none installed'} — ${s.state}${s.readOnly ? ' (read-only)' : ''}`);
  timer = setInterval(() => { loadLicence().catch((err) => logger.warn({ err }, '[licence] reload failed')); }, 60_000);
  timer.unref();
}

/** Daily: tell the administrators ahead of the end date, at the end, and when VendorGate turns read-only. */
export async function runLicenceReminders(now = new Date()) {
  if (!env.onPrem) return { sent: 0 };
  await loadLicence();
  const s = licenceStatus(now);
  const lic = currentLicence()?.licence;
  const key = lic?.id ?? 'none';
  const milestone = s.state === 'readonly' || s.state === 'missing' ? 'readonly' : s.state === 'grace' ? 'expired'
    : s.state === 'expiring' && s.daysLeft !== null ? (['1', '7', '14', '30'].find((d) => s.daysLeft! <= Number(d)) ?? null) : null;
  if (!milestone) return { sent: 0 };
  const row = await db.query.systemLicence.findFirst({ where: eq(systemLicence.id, ROW) });
  const done = row?.notified?.[key] ?? [];
  if (done.includes(milestone)) return { sent: 0 };
  let sent = 0;
  for (const t of await db.select().from(schema.tenants)) {
    for (const a of await usersWithPermission(t.id, 'tenant.settings')) {
      await sendMail({ tenantId: t.id, to: a.email, subject: milestone === 'readonly' ? 'VendorGate is now read-only — licence expired' : milestone === 'expired' ? 'VendorGate licence has ended' : `VendorGate licence ends in ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'}`,
        body: `Hello ${a.name},\n\n${s.message}\n\n${lic ? `Licence ${lic.id} for ${lic.customer}, valid ${lic.validFrom} to ${lic.validUntil}.\n\n` : ''}Contact Integratatech (info@integratatech.ai) for a new licence, then install it under Administration → Licence.`,
        link: `${env.appBaseUrl}/staff/admin/licence` });
      sent++;
    }
  }
  if (row) await db.update(systemLicence).set({ notified: { ...row.notified, [key]: [...done, milestone] } }).where(eq(systemLicence.id, ROW));
  return { sent, milestone };
}

defineJob('licence.daily', async () => { logger.info(await runLicenceReminders(), 'licence reminders'); }, { retryLimit: 1, expireInSeconds: 600 });
