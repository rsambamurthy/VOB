/**
 * Start a throw-away server for the browser (Playwright) tests: creates the e2e database if needed,
 * resets it with demo data, then starts the API (which also serves the built web app).
 * Used by playwright.config.ts — not for normal use.
 */
import { spawnSync } from 'node:child_process';
import { ensureDatabase } from './ensureDatabase.js';

const url = new URL(process.env.DATABASE_URL!);
const dbName = url.pathname.slice(1);
if (!/_e2e$/.test(dbName)) throw new Error('e2eStart only runs against a database whose name ends in _e2e');
await ensureDatabase(url.toString());

const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/db/reset.ts', '--yes'], { stdio: 'inherit', env: process.env });
if (r.status !== 0) process.exit(r.status ?? 1);
await import('../index.js');
