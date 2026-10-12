/** Cloud drivers live in their own module so their SDKs are only loaded when selected. */
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BlobServiceClient, BlobSASPermissions } from '@azure/storage-blob';
import { safeKey, type StorageDriver } from './drivers.js';

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

