/**
 * Pulling purchase orders from Oracle EBS (nightly and on demand), and sample POs for test mode.
 *
 * Pull request: GET <PO pull URL>?changedSince=<ISO time>[&poNumber=…][&supplierNumber=…]
 * with the connector's Basic auth; the answer is Oracle-shaped JSON (see oracle.ts).
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import { HttpError } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { defineJob } from '../../jobs/queue.js';
import { getConnection } from '../../integrations/erp/index.js';
import { ErpError, getJson } from '../../integrations/erp/drivers.js';
import { hasFeature } from '../limits.js';
import type { Tenant } from '../../db/schema.js';
import { importPurchaseOrders, type ImportResult } from './importer.js';
import { oracleList, oracleToCanonical } from './oracle.js';

const { poImports, tenants, vendors, supplierCodes } = schema;

export async function pullFromOracle(tenant: Tenant, by: string, filter: { poNumber?: string; supplierNumber?: string; changedSince?: Date } = {}): Promise<ImportResult> {
  const conn = await getConnection(tenant.id);
  if (conn.kind !== 'oracle') throw new HttpError(409, 'Pulling purchase orders needs the Oracle E-Business Suite connector. Other ERPs send orders through the API or a CSV import.');
  if (conn.testMode) throw new HttpError(409, 'Test mode is on, so nothing is pulled from Oracle. Use “Load sample purchase orders” to try the portal, or turn test mode off.');
  if (!conn.config.poPullUrl) throw new HttpError(409, 'Set the purchase order pull URL under ERP integration first.');
  const since = filter.changedSince ?? (filter.poNumber || filter.supplierNumber ? undefined : await lastPull(tenant.id));
  const url = new URL(conn.config.poPullUrl);
  if (since) url.searchParams.set('changedSince', since.toISOString());
  if (filter.poNumber) url.searchParams.set('poNumber', filter.poNumber);
  if (filter.supplierNumber) url.searchParams.set('supplierNumber', filter.supplierNumber);
  let body: unknown;
  try { body = await getJson(url.toString(), conn); }
  catch (e: any) {
    const msg = e instanceof ErpError ? e.message : String(e?.message ?? e);
    await db.insert(poImports).values({ tenantId: tenant.id, source: 'oracle', requestedBy: by, status: 'FAILED', failed: 0, errors: [msg], detail: { url: url.toString() } });
    throw new HttpError(502, `Couldn’t pull from Oracle: ${msg}`);
  }
  const rows = oracleList(body);
  const canon = rows.map((r) => { try { return oracleToCanonical(r); } catch { return r; } });
  return importPurchaseOrders(tenant, canon, 'oracle', by);
}

async function lastPull(tenantId: string) {
  const last = await db.query.poImports.findFirst({ where: and(eq(poImports.tenantId, tenantId), eq(poImports.source, 'oracle'), inArray(poImports.status, ['OK', 'PARTIAL'])), orderBy: desc(poImports.createdAt) });
  // Overlap by an hour so nothing changed during the last run is missed (re-imports are harmless).
  return last ? new Date(last.createdAt.getTime() - 3600_000) : undefined;
}

defineJob('po.sync', async () => {
  for (const t of await db.select().from(tenants).where(eq(tenants.status, 'ACTIVE'))) {
    if (!hasFeature(t, 'collab') || !hasFeature(t, 'erp')) continue;
    const c = await getConnection(t.id);
    if (c.kind !== 'oracle' || c.testMode || !c.config.poPullUrl) continue;
    try { const r = await pullFromOracle(t, 'system (nightly sync)'); logger.info({ tenant: t.slug, ...r, poIds: undefined }, 'purchase orders pulled'); }
    catch (err) { logger.warn({ err, tenant: t.slug }, 'nightly purchase order pull failed'); }
  }
}, { retryLimit: 1, expireInSeconds: 1800 });

/* ---------- sample purchase orders (test mode / demos) ---------- */

const ITEMS = [
  { item: 'RM-10021', desc: 'Microcrystalline cellulose PH-102', uom: 'KG', price: 182.5, hsn: '39129090', cat: 'RAW' },
  { item: 'RM-10388', desc: 'Magnesium stearate (vegetable grade)', uom: 'KG', price: 640, hsn: '29157020', cat: 'RAW' },
  { item: 'PK-20410', desc: 'HDPE bottle 100 cc with CR cap', uom: 'EA', price: 6.4, hsn: '39233090', cat: 'PACK' },
  { item: 'PK-20518', desc: 'Printed carton 120x60x40 mm', uom: 'EA', price: 3.15, hsn: '48191010', cat: 'PACK' },
  { item: 'MR-30077', desc: 'Nitrile gloves, powder-free (box of 100)', uom: 'BOX', price: 410, hsn: '40151900', cat: 'MRO' },
  { item: 'MR-30152', desc: 'HEPA filter 610x610x292 mm', uom: 'EA', price: 18500, hsn: '84213990', cat: 'MRO' },
  { item: null, desc: 'Annual maintenance of HVAC system — Q3', uom: 'LOT', price: 145000, hsn: '998719', cat: 'SERV' },
];

/** Builds Oracle-shaped POs for up to 5 approved vendors and imports them through the same path as a real pull. */
export async function loadSamplePurchaseOrders(tenant: Tenant, by: string, count = 6) {
  const conn = await getConnection(tenant.id);
  if (conn.kind !== 'none' && !conn.testMode) throw new HttpError(409, 'Sample purchase orders can only be loaded while the ERP connection is in test mode (or not set up).');
  const vs = await db.select().from(vendors).where(and(eq(vendors.tenantId, tenant.id), eq(vendors.status, 'APPROVED'))).limit(5);
  if (!vs.length) throw new HttpError(409, 'Approve at least one vendor first — sample orders are addressed to approved vendors.');
  const codes = await db.select().from(supplierCodes).where(eq(supplierCodes.tenantId, tenant.id));
  const base = Date.now() % 100000;
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const pos = Array.from({ length: count }, (_, i) => {
    const v = vs[i % vs.length];
    const vendorNum = codes.find((c) => c.vendorId === v.id)?.code ?? v.erpVendorId ?? v.code;
    const picks = ITEMS.filter((_, k) => (k + i) % 3 === 0).slice(0, 3);
    const lines = (picks.length ? picks : [ITEMS[i % ITEMS.length]]).map((it, k) => {
      const qty = it.item ? [500, 1200, 2500, 40, 12][(i + k) % 5] : 1;
      return { PO_LINE_ID: `${base + i * 10 + k + 1}`, LINE_NUM: k + 1, ITEM_NUMBER: it.item, ITEM_DESCRIPTION: it.desc, UNIT_MEAS_LOOKUP_CODE: it.uom, QUANTITY: qty, UNIT_PRICE: it.price,
        CATEGORY: `${it.cat}.GENERAL`, LINE_TYPE: it.item ? 'Goods' : 'Services', TAX_NAME: 'GST 18%', TAX_RATE: 18, HSN_CODE: it.hsn, CLOSED_CODE: 'OPEN', CANCEL_FLAG: 'N',
        SHIPMENTS: [{ LINE_LOCATION_ID: `${base + i * 10 + k + 1}01`, SHIP_TO_ORGANIZATION_CODE: k % 2 ? 'CHN1' : 'PUN1', SHIP_TO_ORGANIZATION_NAME: k % 2 ? 'Chennai Warehouse' : 'Pune Plant', NEED_BY_DATE: day(14 + i * 3 + k), QUANTITY: qty, QUANTITY_RECEIVED: 0, QUANTITY_BILLED: 0, QTY_RCV_TOLERANCE: 5 }] };
    });
    return { PO_HEADER_ID: `${900000 + base + i}`, SEGMENT1: `${4500 + (base % 1000)}${String(i + 1).padStart(3, '0')}`, REVISION_NUM: 0, TYPE_LOOKUP_CODE: 'STANDARD',
      VENDOR_NUM: vendorNum, VENDOR_SITE_CODE: 'MAIN', ORG_ID: '101', OPERATING_UNIT: `${tenant.name} India`, AGENT_NAME: by, CURRENCY_CODE: 'INR',
      APPROVED_DATE: day(-(i % 3)), TERMS: ['Net 30', 'Net 45', 'Net 60'][i % 3], FOB_LOOKUP_CODE: i % 2 ? 'DAP' : 'FCA', BUYING_GROUP: lines[0].CATEGORY.split('.')[0],
      AUTHORIZATION_STATUS: 'APPROVED', CLOSED_CODE: 'OPEN', CANCEL_FLAG: 'N', COMMENTS: 'Sample order created in test mode.', LINES: lines };
  });
  return importPurchaseOrders(tenant, pos.map(oracleToCanonical), 'demo', by);
}
