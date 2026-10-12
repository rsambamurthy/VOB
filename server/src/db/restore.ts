/**
 * Restore a backup made by db:backup (or the scheduled production backup).
 *   npm run db:restore -- <backup folder or .dump / .dump.enc file> --yes
 * REPLACES everything in the database named by DATABASE_URL.
 */
import fs from 'node:fs';
import path from 'node:path';
import { decryptBuffer } from '../lib/crypto.js';
import { env } from '../lib/env.js';
import { restoreDatabase } from './backupLib.js';

const target = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!target) { console.error('Usage: npm run db:restore -- <backup folder or file> --yes'); process.exit(1); }
const p = path.resolve(target);
const isDir = fs.existsSync(p) && fs.statSync(p).isDirectory();
const file = isDir ? ['database.dump.enc', 'database.dump'].map((f) => path.join(p, f)).find((f) => fs.existsSync(f)) : p;
if (!file || !fs.existsSync(file)) { console.error(`No backup found at ${p}`); process.exit(1); }
const host = new URL(env.databaseUrl).host;
if (!process.argv.includes('--yes')) {
  console.error(`\n  This REPLACES everything in the database at ${host} with ${path.basename(file)}.\n  Run again with --yes to continue. (Tip: take a fresh backup first: npm run db:backup)\n`);
  process.exit(1);
}
if (env.isProd && !process.argv.includes('--production')) { console.error('Refusing to restore into a production database without --production'); process.exit(1); }

let dump: Buffer = fs.readFileSync(file);
if (file.endsWith('.enc')) dump = decryptBuffer(dump);
console.log(`Restoring ${path.basename(file)} into ${host}…`);
try { await restoreDatabase(dump); }
catch (e: any) { console.error(`\n  Restore failed: ${e.message}\n`); process.exit(1); }
if (isDir && fs.existsSync(path.join(p, 'uploads'))) {
  fs.cpSync(path.join(p, 'uploads'), path.resolve(env.uploadDir), { recursive: true });
  console.log('Uploaded documents restored.');
}
console.log('Done. Restart the API so it picks up the restored data.');
