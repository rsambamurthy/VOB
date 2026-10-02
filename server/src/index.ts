import { createApp } from './app.js';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { runMigrations } from './db/migrate.js';
import { startQueue, stopQueue } from './jobs/queue.js';
import { sweepOverdue } from './services/workflowEngine.js';

if (process.env.MIGRATE_ON_START === 'true') await runMigrations();
const server = createApp().listen(env.port, () => logger.info(`API listening on http://localhost:${env.port}`));

try {
  // Background jobs: email/SMS delivery with retries, AI document reading, SLA sweep every 5 minutes.
  await startQueue([{ name: 'sla.sweep', cron: '*/5 * * * *' }]);
} catch (err) {
  logger.error({ err }, 'job queue failed to start — falling back to in-process jobs');
  setInterval(() => { sweepOverdue().catch((e) => logger.error({ err: e }, 'SLA sweep failed')); }, 5 * 60_000).unref();
}
if (!env.jobsEnabled) setInterval(() => { sweepOverdue().catch((e) => logger.error({ err: e }, 'SLA sweep failed')); }, 5 * 60_000).unref();

const shutdown = async () => { logger.info('shutting down'); server.close(); await stopQueue().catch(() => {}); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
