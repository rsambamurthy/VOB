import crypto from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../src/lib/db.js';
import { env } from '../src/lib/env.js';
import { decrypt, encrypt } from '../src/lib/crypto.js';
import { maskField, maskProfile } from '../src/lib/fieldCrypto.js';
import { sealExistingData } from '../src/db/dataMigrations.js';

const raw = async (id: string) => ((await db.execute(sql`select profile from vendors where id = ${id}`)) as any).rows[0].profile;

describe('encryption at rest', () => {
  test('PAN and bank account are encrypted in the database, plain in the app', async () => {
    const v = await db.query.vendors.findFirst({ where: eq(schema.vendors.name, 'Precision Valves Pvt Ltd') });
    expect(v!.profile.tax.pan).toMatch(/^[A-Z]{5}\d{4}[A-Z]$/);
    const stored = await raw(v!.id);
    expect(stored.tax.pan).toMatch(/^enc:v1:/);
    expect(stored.bank.accountNumber).toMatch(/^enc:v1:/);
    expect(stored.bank.ifsc).toBe(v!.profile.bank.ifsc); // non-sensitive values stay searchable
    expect(JSON.stringify(stored)).not.toContain(v!.profile.bank.accountNumber as string);
  });

  test('legacy plain values are encrypted by the data migration', async () => {
    const v = await db.query.vendors.findFirst({ where: eq(schema.vendors.name, 'Kaveri Steel Traders Pvt Ltd') });
    const plain = await db.query.vendors.findFirst({ where: eq(schema.vendors.id, v!.id) });
    await db.execute(sql`update vendors set profile = jsonb_set(profile, '{tax,pan}', '"ABCDE1234F"') where id = ${v!.id}`);
    expect((await raw(v!.id)).tax.pan).toBe('ABCDE1234F');
    expect(await sealExistingData()).toBeGreaterThan(0);
    expect((await raw(v!.id)).tax.pan).toMatch(/^enc:v1:/);
    expect((await db.query.vendors.findFirst({ where: eq(schema.vendors.id, v!.id) }))!.profile.tax.pan).toBe('ABCDE1234F');
    await db.update(schema.vendors).set({ profile: plain!.profile }).where(eq(schema.vendors.id, v!.id));
  });

  test('key rotation: old data stays readable with ENCRYPTION_KEY_PREVIOUS', () => {
    const before = env.encryptionKey;
    const sealed = encrypt('501000123456');
    try {
      (env as any).encryptionKey = crypto.randomBytes(32);
      env.previousEncryptionKeys.push(before);
      expect(decrypt(sealed)).toBe('501000123456');
      env.previousEncryptionKeys.pop();
      expect(() => decrypt(sealed)).toThrow();
    } finally { (env as any).encryptionKey = before; }
  });

  test('masks', () => {
    expect(maskField('tax.pan', 'AAFCL1234Q')).toBe('AAF••••••Q');
    expect(maskField('bank.accountNumber', '501000123456')).toBe('••••••3456');
    expect(maskProfile({ tax: { pan: 'AAFCL1234Q', gstin: 'X' }, bank: { ifsc: 'HDFC0000001' } })).toEqual({ tax: { pan: 'AAF••••••Q', gstin: 'X' }, bank: { ifsc: 'HDFC0000001' } });
  });
});

describe('masking and reveal', () => {
  test('staff see masked PAN / account; reveal returns the value and is audited', async () => {
    const { login } = await import('./helpers.js');
    const fin = await login('finance@acme.test');
    const v = await db.query.vendors.findFirst({ where: eq(schema.vendors.name, 'Precision Valves Pvt Ltd') });
    const d = (await fin.get(`/api/staff/vendors/${v!.id}`)).body;
    expect(d.vendor.profile.tax.pan).toMatch(/•/);
    expect(d.vendor.profile.bank.accountNumber).toMatch(/^•+\d{4}$/);
    expect(d.vendor.profile.bank.ifsc).toBe(v!.profile.bank.ifsc);
    const r = await fin.post(`/api/staff/vendors/${v!.id}/reveal`, { fieldId: 'bank.accountNumber' });
    expect(r.body.value).toBe(v!.profile.bank.accountNumber);
    expect((await fin.post(`/api/staff/vendors/${v!.id}/reveal`, { fieldId: 'bank.ifsc' })).status).toBe(400);
    const log = await db.query.auditLogs.findFirst({ where: eq(schema.auditLogs.action, 'SENSITIVE_REVEALED') });
    expect(log).toMatchObject({ actor: 'Meera Nair', vendorId: v!.id });
  });
});

const hasPgDump = (await import('node:child_process')).spawnSync('pg_dump', ['--version']).status === 0;
describe('backups', () => {
  test.skipIf(!hasPgDump)('scheduled backup is encrypted, stored and pruned to BACKUP_KEEP', async () => {
    const { runBackup } = await import('../src/services/backups.js');
    const { decryptBuffer } = await import('../src/lib/crypto.js');
    const fs = await import('node:fs');
    const path = await import('node:path');
    (env.int as any).BACKUP_KEEP = 2;
    const keys = [];
    for (let i = 0; i < 3; i++) keys.push((await runBackup()).key);
    const rows = await db.select().from(schema.systemBackups);
    expect(rows.map((r) => r.storageKey).sort()).toEqual(keys.slice(1).sort());
    const file = path.join(path.resolve(env.uploadDir), keys[2]);
    const buf = fs.readFileSync(file);
    expect(buf.subarray(0, 4).toString()).toBe('VGB1');
    expect(decryptBuffer(buf).subarray(0, 5).toString()).toBe('PGDMP'); // pg_dump custom format
    expect(fs.existsSync(path.join(path.resolve(env.uploadDir), keys[0]))).toBe(false);
  });
});
