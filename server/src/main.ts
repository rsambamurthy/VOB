import { createApp } from './app.js';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { runMigrations } from './db/migrate.js';
import { startQueue, stopQueue } from './jobs/queue.js';
import { sweepOverdue } from './services/workflowEngine.js';
import { runExpiryReminders, runPeriodicReviews, sweepOverdueChanges } from './services/lifecycle.js';

if (process.env.MIGRATE_ON_START === 'true') await runMigrations();
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
  await startQueue([{ name: 'sla.sweep', cron: '*/5 * * * *' }, { name: 'lifecycle.daily', cron: '15 9 * * *' }]);
  if (env.jobsEnabled) console.log('[startup] job queue started');
} catch (err) {
  logger.error({ err }, 'job queue failed to start — falling back to in-process jobs');
  setInterval(() => { sweepOverdue().catch((e) => logger.error({ err: e }, 'SLA sweep failed')); }, 5 * 60_000).unref();
}
if (!env.jobsEnabled) {
  setInterval(() => { sweepOverdue().then(() => sweepOverdueChanges()).catch((e) => logger.error({ err: e }, 'SLA sweep failed')); }, 5 * 60_000).unref();
  setInterval(() => { runExpiryReminders().then(() => runPeriodicReviews()).catch((e) => logger.error({ err: e }, 'daily lifecycle failed')); }, 6 * 3600_000).unref();
}

const shutdown = async () => { logger.info('shutting down'); server.close(); await stopQueue().catch(() => {}); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
