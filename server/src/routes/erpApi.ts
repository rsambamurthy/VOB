/**
 * Public API for ERPs and middleware (/api/v1). Authenticate with a workspace API key:
 *   Authorization: Bearer vg_…
 *
 *   POST /api/v1/purchase-orders           create or update POs — canonical JSON, or Oracle EBS shape with ?format=oracle
 *   GET  /api/v1/purchase-orders/:poNumber acceptance status of a PO and its lines
 *   GET  /api/v1/acknowledgements?since=   lines accepted since a time (for ERPs that poll instead of receiving webhooks)
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { sha256 } from '../lib/crypto.js';
import { hasFeature } from '../services/limits.js';
import { importPurchaseOrders } from '../services/orders/importer.js';
import { oracleList, oracleToCanonical } from '../services/orders/oracle.js';
import type { Tenant } from '../db/schema.js';

const { apiKeys, tenants, purchaseOrders, poLines } = schema;
export const erpApiRouter = Router();

declare global { namespace Express { interface Request { apiTenant?: Tenant; apiKeyName?: string } } }

erpApiRouter.use(ah(async (req: Request, _res: Response, next: NextFunction) => {
  const m = /^Bearer\s+(vg_[A-Za-z0-9_-]+)$/.exec(req.get('authorization') ?? '');
  if (!m) throw new HttpError(401, 'Send your API key as: Authorization: Bearer vg_…');
  const key = await db.query.apiKeys.findFirst({ where: and(eq(apiKeys.keyHash, sha256(m[1])), isNull(apiKeys.revokedAt)) });
  if (!key) throw new HttpError(401, 'This API key is not valid or has been revoked');
  const t = await db.query.tenants.findFirst({ where: eq(tenants.id, key.tenantId) });
  if (!t || t.status !== 'ACTIVE') throw new HttpError(403, 'This workspace is not active');
  if (!hasFeature(t, 'collab')) throw new HttpError(403, 'Supplier collaboration isn’t included in this workspace’s plan', undefined, 'PLAN_LIMIT');
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > 60_000) await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id));
  req.apiTenant = t; req.apiKeyName = key.name;
  next();
}));

erpApiRouter.post('/purchase-orders', ah(async (req, res) => {
  const t = req.apiTenant!;
  const body = req.body as unknown;
  const oracle = req.query.format === 'oracle' || (body && typeof body === 'object' && (body as any).format === 'oracle');
  let items: unknown[];
  if (oracle) items = oracleList((body as any)?.purchaseOrders ?? body).map((r) => { try { return oracleToCanonical(r); } catch { return r; } });
  else items = Array.isArray(body) ? body : Array.isArray((body as any)?.purchaseOrders) ? (body as any).purchaseOrders : body && typeof body === 'object' ? [body] : [];
  if (!items.length) throw new HttpError(400, 'Send one purchase order, an array, or { "purchaseOrders": [ … ] }');
  if (items.length > 500) throw new HttpError(413, 'Send at most 500 purchase orders per request');
  const r = await importPurchaseOrders(t, items, oracle ? 'oracle' : 'api', `API (${req.apiKeyName})`);
  res.status(r.failed && !(r.created + r.updated + r.unchanged) ? 422 : 200).json({ importId: r.importId, created: r.created, updated: r.updated, unchanged: r.unchanged, failed: r.failed, unmappedSuppliers: r.unmapped, errors: r.errors });
}));

erpApiRouter.get('/purchase-orders/:poNumber', ah(async (req, res) => {
  const t = req.apiTenant!;
  const po = await db.query.purchaseOrders.findFirst({ where: and(eq(purchaseOrders.tenantId, t.id), eq(purchaseOrders.poNumber, req.params.poNumber)), orderBy: desc(purchaseOrders.revision) });
  if (!po) throw new HttpError(404, 'No purchase order with that number');
  const lines = await db.select().from(poLines).where(eq(poLines.poId, po.id)).orderBy(asc(poLines.lineNo));
  res.json({ erpId: po.erpId, poNumber: po.poNumber, revision: po.revision, status: po.status, acceptance: po.acceptance, acceptedAt: po.acceptedAt, acceptDueAt: po.acceptDueAt,
    lines: lines.map((l) => ({ erpId: l.erpId, lineNo: l.lineNo, acceptance: l.acceptance, acceptedAt: l.acceptedAt, acceptedBy: l.acceptedBy, note: l.acceptNote })) });
}));

erpApiRouter.get('/acknowledgements', ah(async (req, res) => {
  const t = req.apiTenant!;
  const { since } = z.object({ since: z.string().datetime({ offset: true }) }).parse(req.query);
  const lines = await db.select({ l: poLines, po: purchaseOrders }).from(poLines).innerJoin(purchaseOrders, eq(purchaseOrders.id, poLines.poId))
    .where(and(eq(poLines.tenantId, t.id), inArray(poLines.acceptance, ['ACCEPTED', 'AUTO_ACCEPTED']), gt(poLines.acceptedAt, new Date(since)))).orderBy(asc(poLines.acceptedAt)).limit(2000);
  res.json(lines.map(({ l, po }) => ({ poErpId: po.erpId, poNumber: po.poNumber, revision: po.revision, lineErpId: l.erpId, lineNo: l.lineNo, acceptance: l.acceptance, acceptedAt: l.acceptedAt, acceptedBy: l.acceptedBy, note: l.acceptNote })));
}));
