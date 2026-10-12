/** DEV ONLY: drops everything, re-applies migrations and loads demo data. Run: npm run db:reset -- --yes */
import { sql } from 'drizzle-orm';
import { db, pool } from '../lib/db.js';
import { env } from '../lib/env.js';
import { runMigrations } from './migrate.js';
import { seed } from './seed.js';

if (env.isProd) throw new Error('db:reset is disabled in production');
// Deleting everything needs an explicit "--yes" (the test suite passes RESET_CONFIRM=1 for its own database).
if (!process.argv.includes('--yes') && process.env.RESET_CONFIRM !== '1') {
  console.error('\n  db:reset DELETES every workspace, vendor, user and document in this database and reloads the demo data.\n'
    + '  To keep your data and just apply updates, run:   npm run db:setup\n'
    + '  If you really want to wipe it, run:              npm run db:reset -- --yes\n');
  process.exit(1);
}
await db.execute(sql`drop schema if exists public cascade`);
await db.execute(sql`drop schema if exists drizzle cascade`);
await db.execute(sql`create schema public`);
await runMigrations();
await seed();
await pool.end();
