/**
 * Back up the database (and locally stored documents) to ./backups/<date-time>/.
 *   npm run db:backup                 plain dump (development)
 *   npm run db:backup -- --encrypt    encrypt with ENCRYPTION_KEY (keep that key safe — without it the backup is unreadable)
 */
import fs from 'node:fs';
import path from 'node:path';
import { encryptBuffer } from '../lib/crypto.js';
import { env } from '../lib/env.js';
import { backupMode, dumpDatabase } from './backupLib.js';

const encrypt = process.argv.includes('--encrypt');
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const root = path.resolve(process.env.BACKUP_DIR ?? path.join(process.cwd(), '..', 'backups'));
const dir = path.join(root, stamp);
fs.mkdirSync(dir, { recursive: true });

console.log(`Backing up the database (${backupMode() === 'docker' ? 'via the Docker "db" container' : 'with pg_dump'})…`);
let dump: Buffer;
try { dump = await dumpDatabase(); }
catch (e: any) {
  console.error(`\n  Backup failed: ${e.message}\n\n  Is Docker Desktop running and the database started (npm run db:up)?\n`);
  process.exit(1);
}
const file = path.join(dir, encrypt ? 'database.dump.enc' : 'database.dump');
fs.writeFileSync(file, encrypt ? encryptBuffer(dump) : dump);

const uploads = path.resolve(env.uploadDir);
let files = 0;
if (fs.existsSync(uploads)) {
  fs.cpSync(uploads, path.join(dir, 'uploads'), { recursive: true });
  const count = (d: string): number => fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(d, e.name)) : 1), 0);
  files = count(path.join(dir, 'uploads'));
}
console.log(`Saved ${path.relative(process.cwd(), file)} (${(dump.length / 1024).toFixed(0)} KB)${files ? ` and ${files} uploaded file(s)` : ''}.`);
console.log(`Restore with: npm run db:restore -- "${dir}" --yes`);
