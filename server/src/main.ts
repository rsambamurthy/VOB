import { createApp } from './app.js';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { runMigrations } from './db/migrate.js';
import { startQueue, stopQueue } from './jobs/queue.js';
import { sweepOverdue } from './services/workflowEngine.js';
import { runExpiryReminders, runPeriodicReviews, sweepOverdueChanges } from './services/lifecycle.js';

if (process.env.CREATE_DATABASE_IF_MISSING === 'true') await (await import('./db/ensureDatabase.js')).ensureDatabase();
if (process.env.MIGRATE_ON_START === 'true') {
  await runMigrations();
  const dm = await import('./db/dataMigrations.js');
  await dm.sealExistingData();
  await dm.grantNewAdminPermissions();
}
// First deploy: create the first workspace and invite its administrator (only when the database has none).
if (process.env.BOOTSTRAP_ADMIN_EMAIL) {
  const { db, schema } = await import('./lib/db.js');
  if (!(await db.select({ id: schema.tenants.id }).from(schema.tenants).limit(1)).length) {
    const { createTenant } = await import('./services/tenants.js');
    const r = await createTenant({ slug: process.env.BOOTSTRAP_WORKSPACE ?? 'main', name: process.env.BOOTSTRAP_COMPANY ?? 'My Company', adminName: process.env.BOOTSTRAP_ADMIN_NAME ?? 'Administrator', adminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL, plan: 'enterprise', source: 'bootstrap' });
    logger.warn(`[bootstrap] Workspace "${r.tenant.slug}" created. Invitation for ${r.admin.email} (also emailed): ${r.inviteLink}`);
    console.log(`[bootstrap] Workspace "${r.tenant.slug}" created. Invitation for ${r.admin.email}: ${r.inviteLink}`);
  }
}
// First platform admin (the SaaS operator's console at /platform). Only acts while there are no platform admins.
if (process.env.PLATFORM_ADMIN_EMAIL) {
  const { ensureFirstPlatformAdmin } = await import('./platform/bootstrap.js');
  const link = await ensureFirstPlatformAdmin(process.env.PLATFORM_ADMIN_EMAIL, process.env.PLATFORM_ADMIN_NAME ?? 'Platform Admin');
  if (link) { logger.warn(`[platform] First platform admin invited: ${process.env.PLATFORM_ADMIN_EMAIL} (also emailed): ${link}`); console.log(`[platform] Platform admin invitation for ${process.env.PLATFORM_ADMIN_EMAIL}: ${link}`); }
}
const server = createApp().listen(env.port, () => {
  logger.info(`API listening on http://localhost:${env.port}`);
  console.log(`[startup] API listening on http://localhost:${env.port}`);
});
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.error(`Port ${env.port} is already in use — an older copy of the API is probably still running. Close other "npm run dev" windows (Windows: taskkill /F /IM node.exe) and start again.`);
  } else logger.error({ err }, 'API failed to start');
  process.exit(1);
});

try {
  // Background jobs: email/SMS delivery with retries, AI document reading, SLA sweep every 5 minutes.
  const schedules = [{ name: 'sla.sweep', cron: '*/5 * * * *' }, { name: 'lifecycle.daily', cron: '15 9 * * *' }, { name: 'po.hourly', cron: '7 * * * *' }, { name: 'billing.daily', cron: '35 9 * * *' }, { name: 'shipments.daily', cron: '45 3 * * *' }];
  if (env.int.PO_SYNC_SCHEDULE && env.int.PO_SYNC_SCHEDULE !== 'off') schedules.push({ name: 'po.sync', cron: env.int.PO_SYNC_SCHEDULE });
  await import('./services/orders/pull.js'); await import('./services/orders/acceptance.js'); await import('./services/billing.js');
  if (env.int.BACKUP_SCHEDULE) { await import('./services/backups.js'); schedules.push({ name: 'db.backup', cron: env.int.BACKUP_SCHEDULE }); }
  await startQueue(schedules);
  if (env.jobsEnabled) console.log('[startup] job queue started');
} catch (err) {
  logger.error({ err }, 'job queue failed to start — falling back to in-process jobs');
  setInterval(() => { sweepOverdue().catch((e) => logger.error({ err: e }, 'SLA sweep failed')); }, 5 * 60_000).unref();
}
if (!env.jobsEnabled) {
  setInterval(() => { sweepOverdue().then(() => sweepOverdueChanges()).catch((e) => logger.error({ err: e }, 'SLA sweep failed')); }, 5 * 60_000).unref();
  setInterval(() => { runExpiryReminders().then(() => runPeriodicReviews()).catch((e) => logger.error({ err: e }, 'daily lifecycle failed')); }, 6 * 3600_000).unref();
  const { runAutoAccept, runAcceptanceReminders } = await import('./services/orders/acceptance.js');
  const { runBillingDaily } = await import('./services/billing.js');
  setInterval(() => { runBillingDaily().catch((e) => logger.error({ err: e }, 'billing run failed')); }, 6 * 3600_000).unref();
  setInterval(() => { runAutoAccept().then(() => runAcceptanceReminders()).catch((e) => logger.error({ err: e }, 'purchase order sweep failed')); }, 3600_000).unref();
}

const shutdown = async () => { logger.info('shutting down'); server.close(); await stopQueue().catch(() => {}); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
