/** Scheduled, encrypted database backups to the configured storage (local volume, S3 or Azure). */
import { asc, desc, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { encryptBuffer } from '../lib/crypto.js';
import { defineJob } from '../jobs/queue.js';
import { primaryStorage } from '../integrations/storage/index.js';
import { dumpDatabase } from '../db/backupLib.js';

export async function runBackup() {
  const started = Date.now();
  const dump = await dumpDatabase();
  const body = encryptBuffer(dump);
  const store = primaryStorage();
  const key = `_backups/db-${new Date().toISOString().replace(/[:.]/g, '-')}.dump.enc`;
  await store.put(key, body, 'application/octet-stream');
  await db.insert(schema.systemBackups).values({ storageKey: key, storageDriver: store.name, size: body.length });
  // Keep the newest BACKUP_KEEP backups.
  const all = await db.select().from(schema.systemBackups).orderBy(desc(schema.systemBackups.createdAt));
  for (const old of all.slice(env.int.BACKUP_KEEP)) {
    await store.remove(old.storageKey).catch((err) => logger.warn({ err, key: old.storageKey }, 'could not delete old backup'));
    await db.delete(schema.systemBackups).where(eq(schema.systemBackups.id, old.id));
  }
  logger.info({ key, bytes: body.length, ms: Date.now() - started, kept: Math.min(all.length, env.int.BACKUP_KEEP) }, 'database backup stored');
  return { key, size: body.length };
}

export async function lastBackup() {
  return (await db.select().from(schema.systemBackups).orderBy(desc(schema.systemBackups.createdAt)).limit(1))[0] ?? null;
}
void asc;

defineJob('db.backup', async () => { await runBackup(); }, { retryLimit: 2, retryDelay: 600, expireInSeconds: 1800 });
