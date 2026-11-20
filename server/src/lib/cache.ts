/**
 * A tiny in-process cache for answers that are expensive and fine to be a few seconds old (dashboard figures,
 * "needs attention" counts). Concurrent callers share one computation. Off in unit tests so they see every change.
 * With several API instances each keeps its own copy; entries are short-lived, so they agree within the TTL.
 */
import { env } from './env.js';

const store = new Map<string, { at: number; ttl: number; value: Promise<unknown> }>();

export function cached<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const ttl = env.isTest ? 0 : ttlMs;
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value as Promise<T>;
  const value = compute();
  store.set(key, { at: Date.now(), ttl, value });
  value.catch(() => store.delete(key));
  if (store.size > 5000) for (const [k, v] of store) if (Date.now() - v.at >= v.ttl) store.delete(k);
  return value;
}

/** Drop every entry whose key starts with `prefix` (e.g. everything for one workspace). */
export function forget(prefix: string) { for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k); }
