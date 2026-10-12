/** Supplier side of purchase orders (/api/vendor/orders): the supplier's own POs only. */
import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { requireVendor, vendorCtx } from '../auth/session.js';
import { hasFeature } from '../services/limits.js';
import { listOrders, orderCounts, orderDetail } from '../services/orders/queries.js';
import { acceptPurchaseOrder } from '../services/orders/acceptance.js';

const { purchaseOrders, legalEntities, sites, poLines, vendors } = schema;
export const supplierOrdersRouter = Router();
supplierOrdersRouter.use(requireVendor);
supplierOrdersRouter.use((req, _res, next) => (hasFeature(vendorCtx(req).tenant, 'collab') ? next() : next(new HttpError(404, 'Purchase orders aren’t available'))));

supplierOrdersRouter.get('/', ah(async (req, res) => {
  const c = vendorCtx(req);
  const q = z.object({ q: z.string().max(100).optional(), acceptance: z.enum(['PENDING', 'PARTIAL', 'ACCEPTED', 'AUTO_ACCEPTED', 'WAITING']).optional(), status: z.enum(['OPEN', 'CLOSED', 'CANCELLED']).optional(),
    entityId: z.string().optional(), siteId: z.string().optional(), page: z.coerce.number().int().min(1).optional() }).parse(req.query);
  const list = await listOrders({ tenantId: c.tenant.id, vendorId: c.vendorId, ...q });
  // Filter choices: only the companies and sites this supplier actually has orders for.
  const mine = db.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.vendorId, c.vendorId));
  const [entities, siteRows] = await Promise.all([
    db.selectDistinct({ id: legalEntities.id, code: legalEntities.code, name: legalEntities.name }).from(legalEntities).innerJoin(purchaseOrders, eq(purchaseOrders.entityId, legalEntities.id)).where(eq(purchaseOrders.vendorId, c.vendorId)).orderBy(asc(legalEntities.name)),
    db.selectDistinct({ id: sites.id, code: sites.code, name: sites.name }).from(sites).innerJoin(poLines, eq(poLines.siteId, sites.id)).where(inArray(poLines.poId, mine)).orderBy(asc(sites.name)),
  ]);
  res.json({ ...list, rows: list.rows.map(({ supplierCode: _c, source: _s, ...r }) => r), counts: await orderCounts(c.tenant.id, c.vendorId), filters: { entities, sites: siteRows } });
}));

supplierOrdersRouter.get('/:id', ah(async (req, res) => {
  const c = vendorCtx(req);
  const d = await orderDetail(c.tenant.id, req.params.id, c.vendorId);
  // Internal history (who in the buyer's team did what) stays internal; the supplier sees acceptance events only.
  res.json({ ...d, history: d.history.filter((h) => h.action === 'PO_ACCEPTED' || h.action === 'PO_AUTO_ACCEPTED' || h.action === 'PO_REVISED' || h.action === 'PO_RECEIVED').map((h) => ({ ...h, actor: h.action === 'PO_ACCEPTED' ? h.actor : '' })) });
}));

supplierOrdersRouter.post('/:id/accept', ah(async (req, res) => {
  const c = vendorCtx(req);
  const { lineIds, note } = z.object({ lineIds: z.array(z.string()).min(1).optional(), note: z.string().trim().max(500).optional() }).parse(req.body);
  const po = await db.query.purchaseOrders.findFirst({ where: and(eq(purchaseOrders.tenantId, c.tenant.id), eq(purchaseOrders.id, req.params.id), eq(purchaseOrders.vendorId, c.vendorId)) });
  if (!po) throw new HttpError(404, 'Purchase order not found');
  const v = await db.query.vendors.findFirst({ where: eq(vendors.id, c.vendorId) });
  if (v?.blockedAt) throw new HttpError(409, 'Your vendor account is on hold. Contact the buyer.');
  const email = c.contactEmail ?? v?.contactEmail ?? '';
  const contact = email.toLowerCase() === v?.contactEmail.toLowerCase() ? `${v.contactFirstName} ${v.contactLastName}`.trim()
    : (await db.query.supplierContacts.findFirst({ where: and(eq(schema.supplierContacts.vendorId, c.vendorId), eq(schema.supplierContacts.email, email.toLowerCase())) }))?.name;
  const row = await acceptPurchaseOrder(c.tenant, po, lineIds ?? 'all', { name: `${contact || email}${v ? `, ${v.name}` : ''}`, email, kind: 'SUPPLIER' }, note, req.ip);
  res.json({ acceptance: row.acceptance });
}));
