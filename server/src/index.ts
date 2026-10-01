import { createApp } from './app.js';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { runMigrations } from './db/migrate.js';
import { sweepOverdue } from './services/workflowEngine.js';

if (process.env.MIGRATE_ON_START === 'true') await runMigrations();
createApp().listen(env.port, () => logger.info(`API listening on http://localhost:${env.port}`));

// SLA reminders / escalations. (Phase 3 moves scheduled work onto a Postgres-backed job queue.)
const SWEEP_MS = 5 * 60_000;
setInterval(() => { sweepOverdue().catch((e) => logger.error({ err: e }, 'SLA sweep failed')); }, SWEEP_MS).unref();
