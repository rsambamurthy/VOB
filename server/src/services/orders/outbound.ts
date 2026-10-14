/**
 * Order messages back to the ERP — acknowledgements, shipment notices (ASN) and approved supplier
 * invoices — through the workspace's ERP connector, with retries. Test mode records exactly what would be sent.
 *
 *  oracle    — POST Oracle-shaped JSON to the connector's acknowledgement / ASN / invoice URLs (Basic auth):
 *              PO_ACCEPTANCES, RCV_HEADERS/TRANSACTIONS_INTERFACE, AP_INVOICES/INVOICE_LINES_INTERFACE
 *  webhook   — POST a signed event (purchase_order.accepted, shipment.created, shipment.cancelled, invoice.approved)
 *  sap, dynamics — the same JSON events to the "order message URL" (your Integration Suite / Logic App flow),
 *              with the connector's own sign-in
 *  csv       — one CSV file per message, kept for download or uploaded over SFTP
 */
import crypto from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import { audit } from '../../lib/audit.js';
import { defineJob, enqueue, queueRunning } from '../../jobs/queue.js';
import { getConnection } from '../../integrations/erp/index.js';
import { ErpError, joinDir, post, sftpPut, sign, type Connection } from '../../integrations/erp/drivers.js';
import { sapMessageAuth } from '../../integrations/erp/sap.js';
import { dynamicsMessageAuth } from '../../integrations/erp/dynamics.js';
import { hasFeature } from '../limits.js';
import { toCsv } from '../../lib/erpMapper.js';
import type { PoLine, PurchaseOrder, Shipment, SupplierInvoice } from '../../db/schema.js';
import { oracleAcknowledgement } from './oracle.js';

const { poMessages, purchaseOrders, poLines, tenants, legalEntities, shipments, shipmentLines, supplierInvoices, supplierInvoiceLines } = schema;
const RETRIES = 4;

export type MessageKind = 'ACCEPTANCE' | 'ASN' | 'ASN_CANCEL' | 'INVOICE';
export interface AckInfo { lineIds: string[]; by: string; auto: boolean; note?: string | null }
type Payload = { info?: AckInfo; shipmentId?: string; invoiceId?: string; by?: string };

export const EVENT: Record<MessageKind, string> = { ACCEPTANCE: 'purchase_order.accepted', ASN: 'shipment.created', ASN_CANCEL: 'shipment.cancelled', INVOICE: 'invoice.approved' };

export async function queueMessage(po: PurchaseOrder, kind: MessageKind, payload: Payload, requestedBy: string) {
  const [conn, tenant] = await Promise.all([getConnection(po.tenantId), db.query.tenants.findFirst({ where: eq(tenants.id, po.tenantId) })]);
  const usable = conn.kind !== 'none' && !!tenant && hasFeature(tenant, 'erp');
  const [m] = await db.insert(poMessages).values({
    tenantId: po.tenantId, poId: po.id, kind, connector: conn.kind, status: usable ? 'PENDING' : 'NO_CONNECTOR',
    payload, requestedBy, ...(usable ? {} : { error: 'No ERP connection is set up; nothing was sent.' }),
  }).returning();
  if (usable) await enqueue('po.message', { id: m.id });
  return m;
}

export const queueAcknowledgement = (po: PurchaseOrder, info: AckInfo) => queueMessage(po, 'ACCEPTANCE', { info }, info.by);

/** Everything a message needs, loaded fresh at send time. */
interface Data {
  kind: MessageKind; po: PurchaseOrder; slug: string; entityCode: string | null;
  info?: AckInfo; lines: PoLine[];
  shipment?: Shipment; shipLines?: { line: PoLine; quantity: string; batchNo: string | null }[];
  invoice?: SupplierInvoice; invLines?: { line: PoLine; quantity: string; unitPrice: string; amount: string; taxRate: string | null; taxAmount: string }[]; shipmentNumber?: string | null;
}

async function load(m: typeof poMessages.$inferSelect): Promise<Data | null> {
  const p = (m.payload ?? {}) as Payload;
  const [po, tenant] = await Promise.all([db.query.purchaseOrders.findFirst({ where: eq(purchaseOrders.id, m.poId) }), db.query.tenants.findFirst({ where: eq(tenants.id, m.tenantId) })]);
  if (!po || !tenant) return null;
  const entity = po.entityId ? await db.query.legalEntities.findFirst({ where: eq(legalEntities.id, po.entityId) }) : undefined;
  const all = await db.select().from(poLines).where(eq(poLines.poId, po.id));
  const byId = new Map(all.map((l) => [l.id, l]));
  const d: Data = { kind: m.kind as MessageKind, po, slug: tenant.slug, entityCode: entity?.code ?? null, lines: [] };
  if (d.kind === 'ACCEPTANCE') { d.info = p.info!; d.lines = all.filter((l) => d.info!.lineIds.includes(l.id)); }
  if ((d.kind === 'ASN' || d.kind === 'ASN_CANCEL') && p.shipmentId) {
    d.shipment = await db.query.shipments.findFirst({ where: eq(shipments.id, p.shipmentId) });
    if (!d.shipment) return null;
    d.shipLines = (await db.select().from(shipmentLines).where(eq(shipmentLines.shipmentId, p.shipmentId))).filter((s) => byId.has(s.lineId)).map((s) => ({ line: byId.get(s.lineId)!, quantity: s.quantity, batchNo: s.batchNo }));
  }
  if (d.kind === 'INVOICE' && p.invoiceId) {
    d.invoice = await db.query.supplierInvoices.findFirst({ where: eq(supplierInvoices.id, p.invoiceId) });
    if (!d.invoice) return null;
    d.invLines = (await db.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, p.invoiceId))).filter((s) => byId.has(s.lineId)).map((s) => ({ ...s, line: byId.get(s.lineId)! }));
    d.shipmentNumber = d.invoice.shipmentId ? (await db.query.shipments.findFirst({ where: eq(shipments.id, d.invoice.shipmentId) }))?.number ?? null : null;
  }
  return d;
}

const num = (s: string | null | undefined) => (s === null || s === undefined ? null : Number(s));

/** The connector-neutral JSON event (webhook, SAP / Dynamics middleware). */
export function genericEvent(d: Data) {
  const head = { id: crypto.randomUUID(), event: EVENT[d.kind], occurredAt: new Date().toISOString(), workspace: d.slug };
  const poRef = { poErpId: d.po.erpId, poNumber: d.po.poNumber, revision: d.po.revision, supplierCode: d.po.supplierCode, entity: d.entityCode };
  if (d.kind === 'ACCEPTANCE') {
    const i = d.info!;
    return { ...head, purchaseOrder: { erpId: d.po.erpId, poNumber: d.po.poNumber, revision: d.po.revision, supplierCode: d.po.supplierCode, acceptedBy: i.by, auto: i.auto, note: i.note ?? null,
      lines: d.lines.map((l) => ({ erpId: l.erpId, lineNo: l.lineNo, acceptance: l.acceptance, promisedDate: l.promisedDate ?? l.needByDate })) } };
  }
  if (d.kind === 'ASN' || d.kind === 'ASN_CANCEL') {
    const s = d.shipment!;
    return { ...head, shipment: { number: s.number, supplierRef: s.supplierRef, status: s.status, shipDate: s.shipDate, expectedDate: s.expectedDate, carrier: s.carrier, trackingNo: s.trackingNo, vehicleNo: s.vehicleNo,
      ewayBill: s.ewayBill, packages: s.packages, ...(d.kind === 'ASN_CANCEL' ? { cancelReason: s.cancelReason } : {}), ...poRef,
      lines: d.shipLines!.map((x) => ({ poLineErpId: x.line.erpId, lineNo: x.line.lineNo, itemCode: x.line.itemCode, description: x.line.description, uom: x.line.uom, quantity: num(x.quantity), batchNo: x.batchNo })) } };
  }
  const v = d.invoice!;
  return { ...head, invoice: { id: v.id, invoiceNumber: v.invoiceNumber, invoiceDate: v.invoiceDate, dueDate: v.dueDate, currency: v.currency, subtotal: num(v.subtotal), taxAmount: num(v.taxAmount), total: num(v.total),
    shipmentNumber: d.shipmentNumber ?? null, irn: v.einvoice?.irn ?? null, approvedBy: v.decidedBy, ...poRef,
    lines: d.invLines!.map((x) => ({ poLineErpId: x.line.erpId, lineNo: x.line.lineNo, itemCode: x.line.itemCode, quantity: num(x.quantity), unitPrice: num(x.unitPrice), amount: num(x.amount), taxRate: num(x.taxRate), taxAmount: num(x.taxAmount) })) } };
}

/** Oracle EBS shapes: PO acceptance, receiving open interface (ASN), payables open interface (invoice). */
export function oracleBody(d: Data) {
  if (d.kind === 'ACCEPTANCE') return oracleAcknowledgement(d.po, d.lines, { by: d.info!.by, auto: d.info!.auto, note: d.info!.note, entityCode: d.entityCode });
  if (d.kind === 'ASN' || d.kind === 'ASN_CANCEL') {
    const s = d.shipment!;
    return {
      HEADER: { TRANSACTION_TYPE: d.kind === 'ASN' ? 'NEW' : 'CANCEL', ASN_TYPE: 'ASN', SHIPMENT_NUM: s.number, PACKING_SLIP: s.supplierRef ?? undefined, SHIPPED_DATE: s.shipDate, EXPECTED_RECEIPT_DATE: s.expectedDate ?? undefined,
        VENDOR_NUM: d.po.supplierCode, VENDOR_SITE_CODE: d.po.supplierSiteCode ?? undefined, ORG_ID: d.entityCode ?? undefined, FREIGHT_CARRIER_CODE: s.carrier ?? undefined, WAYBILL_AIRBILL_NUM: s.trackingNo ?? undefined,
        NUM_OF_CONTAINERS: s.packages ?? undefined, COMMENTS: [s.vehicleNo && `Vehicle ${s.vehicleNo}`, s.ewayBill && `E-way bill ${s.ewayBill}`].filter(Boolean).join('; ') || undefined },
      LINES: d.shipLines!.map((x) => ({ TRANSACTION_TYPE: 'SHIP', PO_HEADER_ID: d.po.erpId, DOCUMENT_NUM: d.po.poNumber, PO_LINE_ID: x.line.erpId, DOCUMENT_LINE_NUM: x.line.lineNo, ITEM_NUM: x.line.itemCode ?? undefined,
        QUANTITY: num(x.quantity), UNIT_OF_MEASURE: x.line.uom ?? undefined, VENDOR_LOT_NUM: x.batchNo ?? undefined })),
    };
  }
  const v = d.invoice!;
  return {
    INVOICE_NUM: v.invoiceNumber, INVOICE_TYPE_LOOKUP_CODE: 'STANDARD', INVOICE_DATE: v.invoiceDate, VENDOR_NUM: d.po.supplierCode, VENDOR_SITE_CODE: d.po.supplierSiteCode ?? undefined,
    INVOICE_AMOUNT: num(v.total), INVOICE_CURRENCY_CODE: v.currency, PO_NUMBER: d.po.poNumber, ORG_ID: d.entityCode ?? undefined, SOURCE: 'VENDORGATE', DESCRIPTION: v.einvoice?.irn ? `IRN ${v.einvoice.irn}` : undefined,
    LINES: [
      ...d.invLines!.map((x, i) => ({ LINE_NUMBER: i + 1, LINE_TYPE_LOOKUP_CODE: 'ITEM', AMOUNT: num(x.amount), QUANTITY_INVOICED: num(x.quantity), UNIT_PRICE: num(x.unitPrice), PO_HEADER_ID: d.po.erpId, PO_LINE_ID: x.line.erpId, PO_NUMBER: d.po.poNumber, PO_LINE_NUMBER: x.line.lineNo })),
      ...(Number(v.taxAmount) ? [{ LINE_NUMBER: d.invLines!.length + 1, LINE_TYPE_LOOKUP_CODE: 'TAX', AMOUNT: num(v.taxAmount) }] : []),
    ],
  };
}

export function csvFor(d: Data) {
  const at = new Date().toISOString();
  const stamp = at.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  if (d.kind === 'ACCEPTANCE') {
    const i = d.info!;
    return { fileName: `po_${d.po.poNumber}_acceptance_${stamp}.csv`, csv: toCsv([['PO_NUMBER', 'REVISION', 'ERP_PO_ID', 'LINE_NUM', 'ERP_LINE_ID', 'ACCEPTANCE', 'ACCEPTED_BY', 'ACTION_DATE', 'NOTE'],
      ...d.lines.map((l) => [d.po.poNumber, String(d.po.revision), d.po.erpId, String(l.lineNo), l.erpId, i.auto ? 'AUTO_ACCEPTED' : 'ACCEPTED', i.by, at, i.note ?? ''])]) };
  }
  if (d.kind === 'ASN' || d.kind === 'ASN_CANCEL') {
    const s = d.shipment!;
    return { fileName: `asn_${s.number}_${d.kind === 'ASN' ? 'new' : 'cancel'}_${stamp}.csv`, csv: toCsv([['ACTION', 'ASN_NUMBER', 'SUPPLIER_REF', 'SUPPLIER_CODE', 'PO_NUMBER', 'ERP_PO_ID', 'LINE_NUM', 'ERP_LINE_ID', 'ITEM', 'QUANTITY', 'UOM', 'BATCH', 'SHIP_DATE', 'EXPECTED_DATE', 'CARRIER', 'TRACKING_NO', 'VEHICLE_NO', 'EWAY_BILL'],
      ...d.shipLines!.map((x) => [d.kind === 'ASN' ? 'NEW' : 'CANCEL', s.number, s.supplierRef ?? '', d.po.supplierCode, d.po.poNumber, d.po.erpId, String(x.line.lineNo), x.line.erpId, x.line.itemCode ?? '', x.quantity, x.line.uom ?? '', x.batchNo ?? '', s.shipDate, s.expectedDate ?? '', s.carrier ?? '', s.trackingNo ?? '', s.vehicleNo ?? '', s.ewayBill ?? ''])]) };
  }
  const v = d.invoice!;
  return { fileName: `invoice_${d.po.supplierCode}_${v.invoiceNumber.replace(/[^A-Za-z0-9-]/g, '_')}_${stamp}.csv`, csv: toCsv([['INVOICE_NUMBER', 'INVOICE_DATE', 'SUPPLIER_CODE', 'CURRENCY', 'INVOICE_TOTAL', 'TAX_TOTAL', 'PO_NUMBER', 'ERP_PO_ID', 'LINE_NUM', 'ERP_LINE_ID', 'QUANTITY', 'UNIT_PRICE', 'AMOUNT', 'TAX_RATE', 'TAX_AMOUNT', 'ASN_NUMBER', 'IRN'],
    ...d.invLines!.map((x) => [v.invoiceNumber, v.invoiceDate, d.po.supplierCode, v.currency, v.total, v.taxAmount, d.po.poNumber, d.po.erpId, String(x.line.lineNo), x.line.erpId, x.quantity, x.unitPrice, x.amount, x.taxRate ?? '', x.taxAmount, d.shipmentNumber ?? '', v.einvoice?.irn ?? ''])]) };
}

const ORACLE_URL: Record<MessageKind, string> = { ACCEPTANCE: 'ackUrl', ASN: 'asnUrl', ASN_CANCEL: 'asnUrl', INVOICE: 'invoiceUrl' };
const URL_LABEL: Record<string, string> = { ackUrl: 'acknowledgement URL', asnUrl: 'shipment notice URL', invoiceUrl: 'invoice URL' };

async function deliver(id: string) {
  const m = await db.query.poMessages.findFirst({ where: eq(poMessages.id, id) });
  if (!m || m.status === 'SENT' || m.status === 'TEST' || m.status === 'NO_CONNECTOR') return;
  const [d, conn] = await Promise.all([load(m), getConnection(m.tenantId)]);
  if (!d) return;
  const attempts = m.attempts + 1;
  try {
    const r = await build(conn, d, m.id);
    if (!conn.testMode) await r.send();
    await db.update(poMessages).set({ status: conn.testMode ? 'TEST' : 'SENT', connector: conn.kind, attempts, target: r.target, payload: { ...(m.payload as object), request: r.request }, error: null, httpStatus: r.httpStatus ?? null, sentAt: new Date() }).where(eq(poMessages.id, id));
  } catch (err: any) {
    const e = err instanceof ErpError ? err : new ErpError(String(err?.message ?? err));
    await db.update(poMessages).set({ status: 'FAILED', attempts, error: e.message.slice(0, 1000), httpStatus: e.httpStatus ?? null, response: e.response ?? null }).where(eq(poMessages.id, id));
    if (!queueRunning() || attempts > RETRIES) await audit({ tenantId: m.tenantId, vendorId: d.po.vendorId, actor: 'system', action: d.kind === 'ACCEPTANCE' ? 'PO_ACK_FAILED' : 'PO_MESSAGE_FAILED', detail: { po: d.po.poNumber, kind: d.kind, error: e.message.slice(0, 200) } });
    throw e;
  }
}

async function build(conn: Connection, d: Data, messageId: string) {
  let httpStatus: number | undefined;
  const out = (target: string, request: unknown, send: () => Promise<void>) => ({ target, request, send, get httpStatus() { return httpStatus; } });
  if (conn.kind === 'oracle') {
    const body = oracleBody(d);
    const key = ORACLE_URL[d.kind];
    const url = conn.config[key];
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Idempotency-Key': messageId };
    return out(url ?? `(${URL_LABEL[key]} not set)`, { body, headers: { ...headers, ...(conn.config.username ? { Authorization: 'Basic •••' } : {}) } }, async () => {
      if (!url) throw new ErpError(`Set the ${URL_LABEL[key]} under ERP integration`);
      if (conn.config.username) headers.Authorization = `Basic ${Buffer.from(`${conn.config.username}:${conn.secrets.password ?? ''}`).toString('base64')}`;
      httpStatus = (await post(url, JSON.stringify(body), headers)).status;
    });
  }
  if (conn.kind === 'webhook' || conn.kind === 'sap' || conn.kind === 'dynamics') {
    const event = genericEvent(d);
    const json = JSON.stringify(event);
    const ts = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'VendorGate-Webhook/1', 'X-VendorGate-Event': event.event, 'X-VendorGate-Delivery': event.id, 'X-VendorGate-Timestamp': ts, 'X-Idempotency-Key': messageId };
    const url = conn.kind === 'webhook' ? conn.config.url : conn.config.messageUrl;
    const shown = conn.kind === 'webhook' ? { 'X-VendorGate-Signature': 'sha256=•••' } : { Authorization: conn.kind === 'sap' ? 'Basic •••' : 'Bearer •••' };
    return out(url ?? '(order message URL not set)', { body: event, headers: { ...headers, ...shown } }, async () => {
      if (!url) throw new ErpError(conn.kind === 'webhook' ? 'Set the webhook URL first' : 'Set the order message URL under ERP integration (your middleware flow that posts to the ERP)');
      if (conn.kind === 'webhook') {
        if (!conn.secrets.signingSecret) throw new ErpError('Set the webhook URL and signing secret first');
        headers['X-VendorGate-Signature'] = `sha256=${sign(conn.secrets.signingSecret, ts, json)}`;
      } else Object.assign(headers, conn.kind === 'sap' ? sapMessageAuth(conn) : await dynamicsMessageAuth(conn));
      httpStatus = (await post(url, json, headers)).status;
    });
  }
  if (conn.kind === 'csv') {
    const { csv, fileName } = csvFor(d);
    const sftp = conn.config.delivery === 'sftp';
    return out(sftp ? `sftp://${conn.config.host}${joinDir(conn.config.remoteDir, fileName)}` : 'Kept for download', { csv, fileName }, async () => {
      if (sftp) await sftpPut(conn, joinDir(conn.config.remoteDir, fileName), Buffer.from(csv, 'utf8'));
    });
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
export const messagesForIds = (poId: string, kinds: MessageKind[]) => db.select().from(poMessages).where(and(eq(poMessages.poId, poId), inArray(poMessages.kind, kinds))).orderBy(desc(poMessages.createdAt));
export const messageView = (m: typeof poMessages.$inferSelect) => ({ id: m.id, kind: m.kind, connector: m.connector, status: m.status, attempts: m.attempts, target: m.target, error: m.error, httpStatus: m.httpStatus, requestedBy: m.requestedBy, sentAt: m.sentAt, createdAt: m.createdAt, request: (m.payload as any)?.request ?? null });
