/**
 * Live updates to browsers (server-sent events). Screens subscribe to a key (e.g. "event:<id>"); anything that
 * changes what they show calls publishLive(key). Postgres LISTEN/NOTIFY carries the signal to every server process,
 * so it works with more than one instance and on-premises without extra services. The message only says
 * "something changed" — each screen fetches its own view again (all permission rules stay in the normal routes).
 */
import type { Response } from 'express';
import { pool } from './db.js';
import { logger } from './logger.js';

const CHANNEL = 'vg_live';
const subscribers = new Map<string, Set<Response>>();
let listening: Promise<void> | null = null;
let ready = false;

function deliver(key: string, payload: string) {
  for (const res of subscribers.get(key) ?? []) res.write(`event: update\ndata: ${payload}\n\n`);
}

function listen() {
  listening ??= (async () => {
    try {
      const client = await pool.connect();
      client.on('notification', (m) => { if (m.channel === CHANNEL && m.payload) { const [key, ...rest] = m.payload.split('|'); deliver(key, rest.join('|') || '{}'); } });
      client.on('error', (err) => { logger.warn({ err }, 'live updates: listener lost'); listening = null; ready = false; });
      await client.query(`LISTEN ${CHANNEL}`);
      ready = true;
    } catch (err) { logger.warn({ err }, 'live updates: LISTEN failed, delivering in this process only'); listening = null; ready = false; }
  })();
  return listening;
}

/** Tell every screen watching `key` that it should refresh. */
export function publishLive(key: string, data: Record<string, unknown> = {}) {
  const payload = JSON.stringify({ at: Date.now(), ...data });
  // Until this process is listening, deliver to its own screens directly (other servers still get the notification).
  if (!ready) deliver(key, payload);
  pool.query('select pg_notify($1, $2)', [CHANNEL, `${key}|${payload}`]).catch(() => { if (ready) deliver(key, payload); });
}

/** Keep an HTTP response open as an event stream for `key`. */
export function subscribeLive(key: string, res: Response) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(`event: hello\ndata: ${JSON.stringify({ serverTime: Date.now() })}\n\n`);
  void listen();
  const set = subscribers.get(key) ?? new Set<Response>();
  set.add(res); subscribers.set(key, set);
  const beat = setInterval(() => res.write(`: ${Date.now()}\n\n`), 20_000);
  res.on('close', () => { clearInterval(beat); set.delete(res); if (!set.size) subscribers.delete(key); });
}
