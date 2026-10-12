/** Applies SQL migrations from server/drizzle. Run: npm run db:migrate */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from '../lib/db.js';
import { logger } from '../lib/logger.js';

const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function runMigrations() {
  await migrate(db, { migrationsFolder: folder });
  logger.info('migrations applied');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMigrations().then(() => pool.end()).catch((e) => { logger.error(e); process.exit(1); });
}
