/**
 * Safe setup / update: applies any new migrations and loads the demo workspaces only when the
 * database is empty. Never deletes data — run this after every update. Run: npm run db:setup
 */
import { count } from 'drizzle-orm';
import { db, pool, schema } from '../lib/db.js';
import { runMigrations } from './migrate.js';
import { seed } from './seed.js';
import { sealExistingData } from './dataMigrations.js';

await runMigrations();
const sealed = await sealExistingData();
if (sealed) console.log(`Encrypted sensitive values in ${sealed} existing record(s).`);
const [{ n }] = await db.select({ n: count() }).from(schema.tenants);
if (n === 0) {
  await seed();
} else {
  console.log(`Database is up to date. Your existing data (${n} workspace${n === 1 ? '' : 's'}) was kept — nothing was deleted.`);
}
await pool.end();
