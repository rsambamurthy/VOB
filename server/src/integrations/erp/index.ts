/** ERP connection settings, push queue and delivery log. */
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../lib/db.js';
import type { Vendor } from '../../db/schema.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { HttpError } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../lib/audit.js';
import { sendMail } from '../../lib/mailer.js';
import { env } from '../../lib/env.js';
import { defineJob, enqueue, queueRunning } from '../../jobs/queue.js';
import { usersWithPermission } from '../../services/approvers.js';
import { ErpError, SECRET_FIELDS, send, testConnection, type Connection, type ErpEvent, type ErpKind } from './drivers.js';

export { ErpError, type ErpEvent, type ErpKind } from './drivers.js';
const { erpConnections, erpSyncs, vendors, tenants } = schema;
const RETRIES = 4;

export async function getConnection(tenantId: string): Promise<Connection> {
  const row = await db.query.erpConnections.findFirst({ where: eq(erpConnections.tenantId, tenantId) });
  if (!row) return { kind: 'none', testMode: true, autoPush: true, config: {}, secrets: {} };
  let secrets: Record<string, string> = {};
  if (row.secretsEnc) { try { secrets = JSON.parse(decrypt(row.secretsEnc)); } catch { logger.warn({ tenantId }, 'ERP secrets could not be decrypted (ENCRYPTION_KEY changed?)'); } }
  return { kind: row.kind as ErpKind, testMode: row.testMode, autoPush: row.autoPush, config: row.config, secrets };
}

/** What the settings page may see: config plus which secrets are set — never their values. */
export function publicConnection(c: Connection) {
  return { kind: c.kind, testMode: c.testMode, autoPush: c.autoPush, config: c.config, secretsSet: Object.fromEntries(SECRET_FIELDS[c.kind].map((k) => [k, !!c.secrets[k]])) };
}

const CONFIG_FIELDS: Record<ErpKind, string[]> = {
  none: [], oracle: ['url', 'username', 'orgId'], webhook: ['url'], csv: ['delivery', 'host', 'port', 'username', 'remoteDir'],
};

export const connectionInput = z.object({
  kind: z.enum(['none', 'oracle', 'webhook', 'csv']),
  testMode: z.boolean(),
  autoPush: z.boolean(),
  config: z.record(z.string().max(500)).default({}),
  /** Omitted or "" = keep the stored value; null = clear it. */
  secrets: z.record(z.string().max(500).nullable()).default({}),
});

export async function saveConnection(tenantId: string, input: z.infer<typeof connectionInput>, actor: { id: string; name: string }, ip?: string) {
  const current = await getConnection(tenantId);
  const config = Object.fromEntries(CONFIG_FIELDS[input.kind].map((k) => [k, (input.config[k] ?? '').trim()]).filter(([, v]) => v !== ''));
  if (input.kind === 'csv' && !config.delivery) config.delivery = 'download';
  if ((input.kind === 'oracle' || input.kind === 'webhook') && config.url) {
    try { const u = new URL(config.url); if (!['http:', 'https:'].includes(u.protocol)) throw new Error(); } catch { throw new HttpError(400, 'Enter a full URL starting with https://'); }
    if (env.isProd && !config.url.startsWith('https://')) throw new HttpError(400, 'Use an https:// URL');
  }
  if (input.kind === 'csv' && config.port && !/^\d{1,5}$/.test(config.port)) throw new HttpError(400, 'Port must be a number');
  const secrets: Record<string, string> = {};
  for (const k of SECRET_FIELDS[input.kind]) {
    const v = input.secrets[k];
    if (v === null) continue;
    if (v) secrets[k] = v; else if (current.secrets[k] && current.kind === input.kind) secrets[k] = current.secrets[k];
  }
  if (!input.testMode) {
    if ((input.kind === 'oracle' || input.kind === 'webhook') && !config.url) throw new HttpError(400, 'Enter the URL before turning test mode off');
    if (input.kind === 'webhook' && !secrets.signingSecret) throw new HttpError(400, 'Set a signing secret before turning test mode off');
    if (input.kind === 'csv' && config.delivery === 'sftp' && (!config.host || !config.username)) throw new HttpError(400, 'Enter the SFTP host and user name before turning test mode off');
  }
  const values = { kind: input.kind, testMode: input.testMode, autoPush: input.autoPush, config, secretsEnc: Object.keys(secrets).length ? encrypt(JSON.stringify(secrets)) : null, updatedById: actor.id, updatedAt: new Date() };
  await db.insert(erpConnections).values({ tenantId, ...values }).onConflictDoUpdate({ target: erpConnections.tenantId, set: values });
  await audit({ tenantId, vendorId: null, actor: actor.name, action: 'ERP_SETTINGS_CHANGED', detail: { kind: input.kind, testMode: input.testMode ? 'on' : 'off', autoPush: input.autoPush ? 'on' : 'off', secretsChanged: Object.entries(input.secrets).filter(([, v]) => v !== '' && v !== undefined).map(([k]) => k).join(', ') }, ip });
  return publicConnection(await getConnection(tenantId));
}

export async function checkConnection(tenantId: string) {
  const conn = await getConnection(tenantId);
  const t = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  try { return await testConnection(conn, t?.slug ?? ''); }
  catch (e: any) { return { ok: false, message: e instanceof ErpError ? e.message : String(e?.message ?? e) }; }
}

/**
 * Record a push and hand it to the queue. Automatic events only fire when auto-push is on;
 * MANUAL always does (if a connector is set). Returns the sync row or null when nothing is set up.
 */
export async function queueErpPush(tenantId: string, vendorId: string, event: ErpEvent, requestedBy = 'system') {
  const conn = await getConnection(tenantId);
  if (conn.kind === 'none') { if (event === 'MANUAL') throw new HttpError(409, 'No ERP connection is set up. An administrator can add one under ERP integration.'); return null; }
  if (event !== 'MANUAL' && !conn.autoPush) return null;
  const [sync] = await db.insert(erpSyncs).values({ tenantId, vendorId, event, kind: conn.kind, status: 'PENDING', requestedBy }).returning();
  await db.update(vendors).set({ erpSyncStatus: 'PENDING' }).where(eq(vendors.id, vendorId));
  await enqueue('erp.push', { syncId: sync.id });
  return (await db.query.erpSyncs.findFirst({ where: eq(erpSyncs.id, sync.id) }))!;
}

/** Fire-and-forget wrapper for workflow hooks: an ERP problem must never block an approval. */
export function pushLater(tenantId: string, vendorId: string, event: ErpEvent, requestedBy = 'system') {
  return queueErpPush(tenantId, vendorId, event, requestedBy).catch((err) => { logger.error({ err, vendorId, event }, 'could not queue ERP push'); return null; });
}

export async function retrySync(tenantId: string, syncId: string, actor: string) {
  const s = await db.query.erpSyncs.findFirst({ where: and(eq(erpSyncs.tenantId, tenantId), eq(erpSyncs.id, syncId)) });
  if (!s) throw new HttpError(404, 'Delivery not found');
  if (s.status !== 'FAILED') throw new HttpError(409, 'Only failed deliveries can be retried');
  await db.update(erpSyncs).set({ status: 'PENDING', error: null, requestedBy: actor }).where(eq(erpSyncs.id, s.id));
  await db.update(vendors).set({ erpSyncStatus: 'PENDING' }).where(eq(vendors.id, s.vendorId));
  await enqueue('erp.push', { syncId: s.id });
  return (await db.query.erpSyncs.findFirst({ where: eq(erpSyncs.id, s.id) }))!;
}

async function deliver(syncId: string) {
  const s = await db.query.erpSyncs.findFirst({ where: eq(erpSyncs.id, syncId) });
  if (!s || s.status === 'SENT' || s.status === 'TEST') return;
  const [v, conn, t] = await Promise.all([
    db.query.vendors.findFirst({ where: eq(vendors.id, s.vendorId) }),
    getConnection(s.tenantId),
    db.query.tenants.findFirst({ where: eq(tenants.id, s.tenantId) }),
  ]);
  if (!v) return;
  const attempts = s.attempts + 1;
  try {
    if (conn.kind === 'none') throw new ErpError('The ERP connection was removed');
    // Always send the vendor as it is now, so a retried or late push never carries stale data.
    const r = await send({ ...conn, kind: conn.kind }, v as Vendor, s.event as ErpEvent, { syncId: s.id, tenantSlug: t?.slug ?? '' });
    const status = conn.testMode ? 'TEST' : 'SENT';
    await db.update(erpSyncs).set({ status, attempts, kind: conn.kind, target: r.target, request: r.request, httpStatus: r.httpStatus ?? null, response: r.response ?? null, error: null, erpVendorId: r.erpVendorId ?? null, sentAt: new Date() }).where(eq(erpSyncs.id, s.id));
    // Test-mode pushes never store an ERP id on the vendor, so going live later starts clean.
    await db.update(vendors).set({ erpSyncStatus: conn.testMode ? 'TEST' : 'SYNCED', erpSyncedAt: new Date(), ...(!conn.testMode && r.erpVendorId && !v.erpVendorId ? { erpVendorId: r.erpVendorId } : {}) }).where(eq(vendors.id, v.id));
    await audit({ tenantId: s.tenantId, vendorId: v.id, actor: 'system', action: conn.testMode ? 'ERP_PUSH_TEST' : 'ERP_PUSHED', detail: { event: s.event, connector: conn.kind, ...(r.erpVendorId && !conn.testMode ? { erpVendorId: r.erpVendorId } : {}) } });
  } catch (err: any) {
    const e = err instanceof ErpError ? err : new ErpError(String(err?.message ?? err));
    await db.update(erpSyncs).set({ status: 'FAILED', attempts, error: e.message.slice(0, 1000), httpStatus: e.httpStatus ?? null, response: e.response ?? null, kind: conn.kind === 'none' ? s.kind : conn.kind }).where(eq(erpSyncs.id, s.id));
    await db.update(vendors).set({ erpSyncStatus: 'FAILED' }).where(eq(vendors.id, v.id));
    const final = !queueRunning() || attempts > RETRIES;
    if (final) {
      await audit({ tenantId: s.tenantId, vendorId: v.id, actor: 'system', action: 'ERP_PUSH_FAILED', detail: { event: s.event, error: e.message.slice(0, 200) } });
      for (const u of await usersWithPermission(s.tenantId, 'vendors.export')) {
        await sendMail({ tenantId: s.tenantId, to: u.email, subject: `ERP push failed: ${v.name}`, body: `Hello ${u.name},\n\nSending ${v.name} (${v.code}) to the ERP failed${attempts > 1 ? ` after ${attempts} attempts` : ''}:\n\n${e.message}\n\nOpen the vendor to see the details and retry.`, link: `${env.appBaseUrl}/staff/vendors/${v.id}` });
      }
    }
    throw e; // let the queue retry with backoff
  }
}

defineJob<{ syncId: string }>('erp.push', async ({ syncId }) => { await deliver(syncId); }, { retryLimit: RETRIES, retryDelay: 60, expireInSeconds: 300 });

export async function syncsForVendor(vendorId: string, limit = 20) {
  return db.query.erpSyncs.findMany({ where: eq(erpSyncs.vendorId, vendorId), orderBy: desc(erpSyncs.createdAt), limit });
}

export async function recentSyncs(tenantId: string, status?: string, limit = 100) {
  return db.query.erpSyncs.findMany({
    where: and(eq(erpSyncs.tenantId, tenantId), ...(status ? [eq(erpSyncs.status, status)] : [])),
    orderBy: desc(erpSyncs.createdAt), limit, with: { vendor: { columns: { id: true, name: true, code: true } } },
  });
}

/** Strip bulky / sensitive bits for list views. */
export const syncSummary = (s: typeof erpSyncs.$inferSelect) => ({ id: s.id, event: s.event, kind: s.kind, status: s.status, attempts: s.attempts, target: s.target, httpStatus: s.httpStatus, error: s.error, erpVendorId: s.erpVendorId, requestedBy: s.requestedBy, sentAt: s.sentAt, createdAt: s.createdAt, fileName: s.request?.fileName ?? null });
