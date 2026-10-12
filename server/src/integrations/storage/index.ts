import crypto from 'node:crypto';
import path from 'node:path';
import { env } from '../../lib/env.js';
import { HttpError } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { localDriver, type StorageDriver } from './drivers.js';
import { clamScan, pdfLooksActive, sniffType } from './scan.js';

const i = env.int;
const local = localDriver(env.uploadDir);
// Cloud SDKs are imported only when that driver is configured (keeps start-up fast and light).
const primary: StorageDriver = i.STORAGE_DRIVER === 'local' ? local : await (async () => {
  const cloud = await import('./cloud.js');
  return i.STORAGE_DRIVER === 's3'
    ? cloud.s3Driver({ bucket: i.S3_BUCKET!, region: i.S3_REGION, endpoint: i.S3_ENDPOINT, accessKeyId: i.S3_ACCESS_KEY_ID!, secretAccessKey: i.S3_SECRET_ACCESS_KEY!, forcePathStyle: i.S3_FORCE_PATH_STYLE === 'true' })
    : cloud.azureDriver({ connectionString: i.AZURE_STORAGE_CONNECTION_STRING!, container: i.AZURE_STORAGE_CONTAINER });
})();

/** Documents remember which driver stored them, so switching drivers doesn't break old files. */
export function driverFor(name: string): StorageDriver {
  if (name === primary.name) return primary;
  if (name === 'local') return local;
  throw new HttpError(500, `This file is stored with the "${name}" driver, which isn't configured on this server`);
}

export const storageStatus = () => ({ driver: primary.name, scan: i.SCAN_PROVIDER, bucket: i.STORAGE_DRIVER === 's3' ? i.S3_BUCKET : i.STORAGE_DRIVER === 'azure' ? i.AZURE_STORAGE_CONTAINER : undefined });
export const storageCheck = () => primary.check();
export const primaryStorage = () => primary;

const EXT: Record<string, string> = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' };

/** Validates, scans and stores an upload. Returns what to save on the document row. */
export async function storeUpload(tenantId: string, vendorId: string, file: { buffer: Buffer; originalname: string }) {
  const type = sniffType(file.buffer);
  if (!type) throw new HttpError(400, 'Only real PDF, PNG or JPG files are accepted (the file’s contents don’t match)');
  if (type === 'application/pdf' && pdfLooksActive(file.buffer)) throw new HttpError(400, 'This PDF contains scripts or auto-run actions. Please print it to a plain PDF and upload again.');
  let scanStatus = 'SKIPPED';
  if (i.SCAN_PROVIDER === 'clamav') {
    try {
      const r = await clamScan(file.buffer, i.CLAMAV_HOST, i.CLAMAV_PORT);
      if (!r.clean) { logger.warn({ tenantId, vendorId, signature: r.signature }, 'infected upload blocked'); throw new HttpError(400, 'This file failed the virus scan and was not saved.'); }
      scanStatus = 'CLEAN';
    } catch (e) {
      if (e instanceof HttpError) throw e;
      logger.error({ err: e }, 'virus scanner unavailable');
      throw new HttpError(503, 'Uploads are temporarily unavailable (virus scanner offline). Please try again shortly.');
    }
  }
  const key = `${tenantId}/${vendorId}/${crypto.randomUUID()}${EXT[type]}`;
  await primary.put(key, file.buffer, type);
  const base = path.basename(file.originalname).replace(/[^\w.\- ()]/g, '_').slice(0, 120) || `document${EXT[type]}`;
  return { storagePath: key, storageDriver: primary.name, mimeType: type, size: file.buffer.length, sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'), scanStatus, fileName: base };
}

export async function readForDownload(doc: { storagePath: string; storageDriver: string; fileName: string; mimeType: string }) {
  return driverFor(doc.storageDriver).get(doc.storagePath, { fileName: doc.fileName, contentType: doc.mimeType });
}

/** Full bytes (for AI extraction). */
export async function readBytes(doc: { storagePath: string; storageDriver: string; fileName: string; mimeType: string }): Promise<Buffer> {
  const r = await readForDownload(doc);
  if ('stream' in r) {
    const chunks: Buffer[] = [];
    for await (const c of r.stream as AsyncIterable<Buffer>) chunks.push(c);
    return Buffer.concat(chunks);
  }
  const res = await fetch(r.url);
  if (!res.ok) throw new Error(`storage fetch ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function removeStored(doc: { storagePath: string; storageDriver: string }) {
  await driverFor(doc.storageDriver).remove(doc.storagePath).catch((e) => logger.warn({ err: e }, 'failed to delete stored file'));
}
