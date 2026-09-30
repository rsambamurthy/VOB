/** DEV ONLY: drops everything, re-applies migrations and loads demo data. Run: npm run db:reset */
import { sql } from 'drizzle-orm';
import { db, pool } from '../lib/db.js';
import { env } from '../lib/env.js';
import { runMigrations } from './migrate.js';
import { seed } from './seed.js';

if (env.isProd) throw new Error('db:reset is disabled in production');
await db.execute(sql`drop schema if exists public cascade`);
await db.execute(sql`drop schema if exists drizzle cascade`);
await db.execute(sql`create schema public`);
await runMigrations();
await seed();
await pool.end();
