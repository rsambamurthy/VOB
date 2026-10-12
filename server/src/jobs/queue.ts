/**
 * Background jobs on Postgres (pg-boss): retries with backoff, survives restarts, no Redis.
 * When the queue isn't running (tests, CLI scripts, JOBS_ENABLED=false) jobs run in-process
 * immediately so behaviour stays the same — just synchronous.
 */
import { PgBoss } from 'pg-boss';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

type Handler<T> = (data: T) => Promise<void>;
interface JobDef { handler: Handler<any>; retryLimit: number; retryDelay: number; expireInSeconds: number }

const defs = new Map<string, JobDef>();
let boss: PgBoss | null = null;

export function defineJob<T extends object>(name: string, handler: Handler<T>, opts: Partial<Omit<JobDef, 'handler'>> = {}) {
  defs.set(name, { handler, retryLimit: 4, retryDelay: 30, expireInSeconds: 300, ...opts });
}

export async function enqueue<T extends object>(name: string, data: T, opts: { singletonKey?: string; startAfter?: Date } = {}) {
  const def = defs.get(name);
  if (!def) throw new Error(`Unknown job ${name}`);
  if (!boss) {
    try { await def.handler(data); } catch (err) { logger.error({ err, job: name }, 'inline job failed'); }
    return;
  }
  await boss.send(name, data, { retryLimit: def.retryLimit, retryDelay: def.retryDelay, retryBackoff: true, expireInSeconds: def.expireInSeconds, ...opts });
}

/** Start workers + cron schedules. Called from index.ts only. */
export async function startQueue(schedules: { name: string; cron: string }[] = []) {
  if (!env.jobsEnabled) { logger.info('job queue disabled — jobs run inline'); return; }
  const b = new PgBoss({ connectionString: env.databaseUrl, schema: 'pgboss' });
  b.on('error', (err) => logger.error({ err }, 'job queue error'));
  await b.start();
  for (const [name, def] of defs) {
    await b.createQueue(name).catch(() => {});
    await b.work<object>(name, { batchSize: 1 }, async ([job]) => {
      try { await def.handler(job.data); }
      catch (err) { logger.warn({ err, job: name, id: job.id }, 'job failed — will retry'); throw err; }
    });
  }
  for (const s of schedules) await b.schedule(s.name, s.cron, {}, { tz: 'Asia/Kolkata' });
  boss = b;
  logger.info({ queues: [...defs.keys()] }, 'job queue started');
}

export async function stopQueue() { await boss?.stop({ graceful: true }); boss = null; }
export const queueRunning = () => !!boss;
