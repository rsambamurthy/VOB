/**
 * Order messages back to the ERP (acknowledgements now; shipment notices in Phase 2), through the
 * workspace's ERP connector, with retries. Test mode records exactly what would be sent.
 *
 *  oracle  — POST the acknowledgement JSON to the connector's "acknowledgement URL" (Basic auth)
 *  webhook — POST a signed `purchase_order.accepted` event to the webhook URL
 *  csv     — one CSV file per acknowledgement, kept for download or uploaded over SFTP
 */
import crypto from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../lib/audit.js';
import { defineJob, enqueue, queueRunning } from '../../jobs/queue.js';
import { getConnection } from '../../integrations/erp/index.js';
import { ErpError, joinDir, post, sftpPut, sign } from '../../integrations/erp/drivers.js';
import { hasFeature } from '../limits.js';
import { toCsv } from '../../lib/erpMapper.js';
import type { PoLine, PurchaseOrder } from '../../db/schema.js';
import { oracleAcknowledgement } from './oracle.js';

const { poMessages, purchaseOrders, poLines, tenants, legalEntities } = schema;
const RETRIES = 4;

export interface AckInfo { lineIds: string[]; by: string; auto: boolean; note?: string | null }

export async function queueAcknowledgement(po: PurchaseOrder, info: AckInfo) {
  const [conn, tenant] = await Promise.all([getConnection(po.tenantId), db.query.tenants.findFirst({ where: eq(tenants.id, po.tenantId) })]);
  const usable = conn.kind !== 'none' && !!tenant && hasFeature(tenant, 'erp');
  const [m] = await db.insert(poMessages).values({
    tenantId: po.tenantId, poId: po.id, kind: 'ACCEPTANCE', connector: conn.kind, status: usable ? 'PENDING' : 'NO_CONNECTOR',
    payload: { info }, requestedBy: info.by, ...(usable ? {} : { error: 'No ERP connection is set up; nothing was sent.' }),
  }).returning();
  if (usable) await enqueue('po.message', { id: m.id });
  return m;
}

async function deliver(id: string) {
  const m = await db.query.poMessages.findFirst({ where: eq(poMessages.id, id) });
  if (!m || m.status === 'SENT' || m.status === 'TEST' || m.status === 'NO_CONNECTOR') return;
  const info = (m.payload as { info: AckInfo }).info;
  const [po, conn, tenant] = await Promise.all([
    db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, m.poId) }),
    getConnection(m.tenantId),
    db.query.tenants.findFirst({ where: eq(tenants.id, m.tenantId) }),
  ]);
  if (!po || !tenant) return;
  const lines = (await db.select().from(poLines).where(eq(poLines.poId, po.id))).filter((l) => info.lineIds.includes(l.id));
  const entity = po.entityId ? await db.query.legalEntities.findFirst({ where: eq(legalEntities.id, po.entityId) }) : undefined;
  const attempts = m.attempts + 1;
  try {
    const r = await build(conn, po, lines, info, tenant.slug, entity?.code ?? null);
    if (!conn.testMode) await r.send();
    await db.update(poMessages).set({ status: conn.testMode ? 'TEST' : 'SENT', connector: conn.kind, attempts, target: r.target, payload: { info, request: r.request }, error: null, httpStatus: r.httpStatus ?? null, sentAt: new Date() }).where(eq(poMessages.id, id));
  } catch (err: any) {
    const e = err instanceof ErpError ? err : new ErpError(String(err?.message ?? err));
    await db.update(poMessages).set({ status: 'FAILED', attempts, error: e.message.slice(0, 1000), httpStatus: e.httpStatus ?? null, response: e.response ?? null }).where(eq(poMessages.id, id));
    if (!queueRunning() || attempts > RETRIES) await audit({ tenantId: m.tenantId, vendorId: po.vendorId, actor: 'system', action: 'PO_ACK_FAILED', detail: { po: po.poNumber, error: e.message.slice(0, 200) } });
    throw e;
  }
}

async function build(conn: Awaited<ReturnType<typeof getConnection>>, po: PurchaseOrder, lines: PoLine[], info: AckInfo, slug: string, entityCode: string | null) {
  if (conn.kind === 'oracle') {
    const body = oracleAcknowledgement(po, lines, { by: info.by, auto: info.auto, note: info.note, entityCode });
    const url = conn.config.ackUrl;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Idempotency-Key': `${po.id}:${lines.map((l) => l.id).join(',')}` };
    const shown = { ...headers, ...(conn.config.username ? { Authorization: 'Basic •••' } : {}) };
    let httpStatus: number | undefined;
    return {
      target: url ?? '(acknowledgement URL not set)', request: { body, headers: shown }, get httpStatus() { return httpStatus; },
      send: async () => {
        if (!url) throw new ErpError('Set the acknowledgement URL under ERP integration');
        if (conn.config.username) headers.Authorization = `Basic ${Buffer.from(`${conn.config.username}:${conn.secrets.password ?? ''}`).toString('base64')}`;
        httpStatus = (await post(url, JSON.stringify(body), headers)).status;
      },
    };
  }
  if (conn.kind === 'webhook') {
    const event = { id: crypto.randomUUID(), event: 'purchase_order.accepted', occurredAt: new Date().toISOString(), workspace: slug,
      purchaseOrder: { erpId: po.erpId, poNumber: po.poNumber, revision: po.revision, supplierCode: po.supplierCode, acceptedBy: info.by, auto: info.auto, note: info.note ?? null,
        lines: lines.map((l) => ({ erpId: l.erpId, lineNo: l.lineNo, acceptance: l.acceptance, promisedDate: l.promisedDate ?? l.needByDate })) } };
    const json = JSON.stringify(event);
    const ts = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'VendorGate-Webhook/1', 'X-VendorGate-Event': event.event, 'X-VendorGate-Delivery': event.id, 'X-VendorGate-Timestamp': ts };
    let httpStatus: number | undefined;
    return {
      target: conn.config.url ?? '', request: { body: event, headers: { ...headers, 'X-VendorGate-Signature': 'sha256=•••' } }, get httpStatus() { return httpStatus; },
      send: async () => {
        if (!conn.config.url || !conn.secrets.signingSecret) throw new ErpError('Set the webhook URL and signing secret first');
        httpStatus = (await post(conn.config.url, json, { ...headers, 'X-VendorGate-Signature': `sha256=${sign(conn.secrets.signingSecret, ts, json)}` })).status;
      },
    };
  }
  if (conn.kind === 'csv') {
    const at = new Date().toISOString();
    const csv = toCsv([['PO_NUMBER', 'REVISION', 'ERP_PO_ID', 'LINE_NUM', 'ERP_LINE_ID', 'ACCEPTANCE', 'ACCEPTED_BY', 'ACTION_DATE', 'NOTE'],
      ...lines.map((l) => [po.poNumber, String(po.revision), po.erpId, String(l.lineNo), l.erpId, info.auto ? 'AUTO_ACCEPTED' : 'ACCEPTED', info.by, at, info.note ?? ''])]);
    const fileName = `po_${po.poNumber}_acceptance_${at.replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}.csv`;
    const sftp = conn.config.delivery === 'sftp';
    return {
      target: sftp ? `sftp://${conn.config.host}${joinDir(conn.config.remoteDir, fileName)}` : 'Kept for download', request: { csv, fileName }, httpStatus: undefined as number | undefined,
      send: async () => { if (sftp) await sftpPut(conn, joinDir(conn.config.remoteDir, fileName), Buffer.from(csv, 'utf8')); },
    };
  }
  throw new ErpError('No ERP connection is set up');
}

defineJob<{ id: string }>('po.message', async ({ id }) => { await deliver(id); }, { retryLimit: RETRIES, retryDelay: 60, expireInSeconds: 300 });

export async function retryMessage(tenantId: string, id: string) {
  const m = await db.query.poMessages.findFirst({ where: and(eq(poMessages.tenantId, tenantId), eq(poMessages.id, id)) });
  if (!m) throw new ErpError('Message not found');
  if (m.status !== 'FAILED') throw new ErpError('Only failed messages can be retried');
  await db.update(poMessages).set({ status: 'PENDING', error: null }).where(eq(poMessages.id, id));
  await enqueue('po.message', { id });
}

export const messagesFor = (poId: string) => db.select().from(poMessages).where(eq(poMessages.poId, poId)).orderBy(desc(poMessages.createdAt)).limit(30);
export const messageView = (m: typeof poMessages.$inferSelect) => ({ id: m.id, kind: m.kind, connector: m.connector, status: m.status, attempts: m.attempts, target: m.target, error: m.error, httpStatus: m.httpStatus, requestedBy: m.requestedBy, sentAt: m.sentAt, createdAt: m.createdAt, request: (m.payload as any)?.request ?? null });

