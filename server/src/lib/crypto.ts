import crypto from 'node:crypto';
import { env } from './env.js';

/** Random URL-safe token (for sessions, invites, resets). */
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

/** Tokens are stored hashed so a DB leak doesn't leak live sessions/links. */
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** AES-256-GCM. Output: base64(iv).base64(tag).base64(ciphertext) */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', env.encryptionKey, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}

/** Decrypts with the current key, falling back to ENCRYPTION_KEY_PREVIOUS (key rotation). */
export function decrypt(payload: string): string {
  const [iv, tag, ct] = payload.split('.').map((s) => Buffer.from(s, 'base64'));
  let lastErr: unknown;
  for (const key of [env.encryptionKey, ...env.previousEncryptionKeys]) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/** Constant-time string compare. */
export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Binary AES-256-GCM for files (backups). Layout: "VGB1" | iv(12) | tag(16) | ciphertext. */
export function encryptBuffer(plain: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', env.encryptionKey, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([Buffer.from('VGB1'), iv, c.getAuthTag(), ct]);
}
export function decryptBuffer(data: Buffer): Buffer {
  if (data.subarray(0, 4).toString() !== 'VGB1') throw new Error('Not an encrypted VendorGate backup');
  const iv = data.subarray(4, 16), tag = data.subarray(16, 32), ct = data.subarray(32);
  let lastErr: unknown;
  for (const key of [env.encryptionKey, ...env.previousEncryptionKeys]) {
    try { const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag); return Buffer.concat([d.update(ct), d.final()]); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}
