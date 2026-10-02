import fs from 'node:fs/promises';
import path from 'node:path';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BlobServiceClient, BlobSASPermissions } from '@azure/storage-blob';
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

/** AWS S3 and S3-compatible stores (Cloudflare R2, MinIO, Wasabi, DigitalOcean Spaces). Files are private; downloads use 60-second signed URLs. */
export function s3Driver(cfg: { bucket: string; region: string; endpoint?: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean }): StorageDriver {
  const client = new S3Client({ region: cfg.region, endpoint: cfg.endpoint || undefined, forcePathStyle: cfg.forcePathStyle, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } });
  return {
    name: 's3',
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: safeKey(key), Body: body, ContentType: contentType, ServerSideEncryption: cfg.endpoint ? undefined : 'AES256' }));
    },
    async get(key, { fileName, contentType }) {
      const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: cfg.bucket, Key: safeKey(key), ResponseContentType: contentType, ResponseContentDisposition: `inline; filename="${encodeURIComponent(fileName)}"` }), { expiresIn: 60 });
      return { url };
    },
    async remove(key) { await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: safeKey(key) })); },
    async check() { await client.send(new HeadBucketCommand({ Bucket: cfg.bucket })); return `bucket ${cfg.bucket} reachable`; },
  };
}

/** Azure Blob Storage. Downloads use 60-second read-only SAS URLs. */
export function azureDriver(cfg: { connectionString: string; container: string }): StorageDriver {
  const container = BlobServiceClient.fromConnectionString(cfg.connectionString).getContainerClient(cfg.container);
  let ensured = false;
  const ensure = async () => { if (!ensured) { await container.createIfNotExists(); ensured = true; } };
  return {
    name: 'azure',
    async put(key, body, contentType) { await ensure(); await container.getBlockBlobClient(safeKey(key)).uploadData(body, { blobHTTPHeaders: { blobContentType: contentType } }); },
    async get(key, { fileName, contentType }) {
      const blob = container.getBlobClient(safeKey(key));
      const url = await blob.generateSasUrl({ permissions: BlobSASPermissions.parse('r'), expiresOn: new Date(Date.now() + 60_000), contentType, contentDisposition: `inline; filename="${encodeURIComponent(fileName)}"` });
      return { url };
    },
    async remove(key) { await container.deleteBlob(safeKey(key), { deleteSnapshots: 'include' }).catch(() => {}); },
    async check() { await ensure(); return `container ${cfg.container} reachable`; },
  };
}

export type { Readable };
