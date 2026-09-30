import { createApp } from './app.js';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { runMigrations } from './db/migrate.js';

if (process.env.MIGRATE_ON_START === 'true') await runMigrations();
createApp().listen(env.port, () => logger.info(`API listening on http://localhost:${env.port}`));
