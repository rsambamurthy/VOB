import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

export interface StorageDriver {
  name: 'local' | 's3' | 'azure';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Either a stream to pipe, or a short-lived URL to redirect the browser to. */
  get(key: string, opts: { fileName: string; contentType: string }): Promise<{ stream: NodeJS.ReadableStream } | { url: string }>;
  remove(key: string): Promise<void>;
  check(): Promise<string>;
}

/** Keys look like tenantId/vendorId/uuid.pdf — reject anything that could escape the folder. */
export function safeKey(key: string) {
  if (!/^[A-Za-z0-9._\-/]+$/.test(key) || key.includes('..') || key.startsWith('/')) throw new Error('Invalid storage key');
  return key;
}

export function localDriver(dir: string): StorageDriver {
  const full = (k: string) => path.join(path.resolve(dir), safeKey(k));
  return {
    name: 'local',
    async put(key, body) { await fs.mkdir(path.dirname(full(key)), { recursive: true }); await fs.writeFile(full(key), body, { mode: 0o640 }); },
    async get(key) { const { createReadStream } = await import('node:fs'); await fs.access(full(key)); return { stream: createReadStream(full(key)) }; },
    async remove(key) { await fs.rm(full(key), { force: true }); },
    async check() { await fs.mkdir(path.resolve(dir), { recursive: true }); return `writing to ${path.resolve(dir)}`; },
  };
}

export type { Readable };
