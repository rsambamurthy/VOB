/**
 * Staff side of supplier collaboration: purchase orders, ERP import, purchasing setup
 * (legal entities, sites, buying groups), supplier portal access, and API keys.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { hasFeature } from '../services/limits.js';
import { importPurchaseOrders, mapSupplierCode } from '../services/orders/importer.js';
import { acceptPurchaseOrder, retimeGroup } from '../services/orders/acceptance.js';
import { loadSamplePurchaseOrders, pullFromOracle } from '../services/orders/pull.js';
import { CSV_TEMPLATE_COLUMNS, CSV_TEMPLATE_SAMPLE, csvToPurchaseOrders } from '../services/orders/csv.js';
import { listOrders, orderCounts, orderDetail } from '../services/orders/queries.js';
import { messagesFor, messageView, retryMessage } from '../services/orders/outbound.js';
import { toCsv } from '../lib/erpMapper.js';
import { asnRequiredFor, shipmentsFor } from '../services/collab/shipments.js';
import { listInvoices } from '../services/collab/invoices.js';

const { purchaseOrders, legalEntities, sites, buyingGroups, supplierCodes, supplierContacts, vendors, poImports, apiKeys } = schema;
export const ordersRouter = Router();

/** Every route here needs the collaboration feature on the workspace's plan. */
ordersRouter.use(['/orders', '/purchasing'], (req: Request, _res: Response, next: NextFunction) => {
  const s = req.staff;
  if (s && !hasFeature(s.tenant, 'collab')) return next(new HttpError(403, 'Supplier collaboration isn’t included in your plan. Contact us to add it.', undefined, 'PLAN_LIMIT'));
  next();
});

/* ---------- Purchase orders ---------- */

ordersRouter.get('/orders', requireStaff('orders.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  const q = z.object({ q: z.string().max(100).optional(), acceptance: z.enum(['PENDING', 'PARTIAL', 'ACCEPTED', 'AUTO_ACCEPTED', 'WAITING']).optional(), status: z.enum(['OPEN', 'CLOSED', 'CANCELLED']).optional(),
    vendorId: z.string().optional(), entityId: z.string().optional(), groupId: z.string().optional(), siteId: z.string().optional(), unmapped: z.literal('1').optional(), dueSoon: z.literal('1').optional(), page: z.coerce.number().int().min(1).optional() }).parse(req.query);
  res.json({ ...(await listOrders({ tenantId: s.tenant.id, ...q, unmapped: !!q.unmapped, dueSoon: !!q.dueSoon })), counts: await orderCounts(s.tenant.id) });
}));

ordersRouter.get('/orders/import-template.csv', requireStaff('orders.manage'), (_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="purchase-orders-template.csv"');
  res.send(toCsv([CSV_TEMPLATE_COLUMNS, ...CSV_TEMPLATE_SAMPLE]));
});

ordersRouter.get('/orders/imports', requireStaff('orders.view'), ah(async (req, res) => {
  res.json(await db.select().from(poImports).where(eq(poImports.tenantId, staffCtx(req).tenant.id)).orderBy(desc(poImports.createdAt)).limit(30));
}));

ordersRouter.get('/orders/unmapped', requireStaff('orders.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  res.json(await db.select({ supplierCode: purchaseOrders.supplierCode, orders: count(), latest: sql<string>`max(${purchaseOrders.poDate})` }).from(purchaseOrders)
    .where(and(eq(purchaseOrders.tenantId, s.tenant.id), isNull(purchaseOrders.vendorId))).groupBy(purchaseOrders.supplierCode).orderBy(desc(count())));
}));

ordersRouter.post('/orders/pull', requireStaff('orders.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const f = z.object({ poNumber: z.string().trim().max(60).optional(), supplierNumber: z.string().trim().max(60).optional() }).parse(req.body);
  res.json(await pullFromOracle(s.tenant, s.user.name, { poNumber: f.poNumber || undefined, supplierNumber: f.supplierNumber || undefined }));
}));

ordersRouter.post('/orders/import-csv', requireStaff('orders.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { csv } = z.object({ csv: z.string().min(1, 'The file is empty').max(5_000_000, 'The file is too large (5 MB maximum)') }).parse(req.body);
  const { pos, errors } = csvToPurchaseOrders(csv);
  if (errors.length) throw new HttpError(400, errors[0]);
  res.json(await importPurchaseOrders(s.tenant, pos, 'csv', s.user.name));
}));

ordersRouter.post('/orders/samples', requireStaff('orders.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  res.json(await loadSamplePurchaseOrders(s.tenant, s.user.name));
}));

ordersRouter.post('/orders/map-supplier', requireStaff('orders.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { code, vendorId } = z.object({ code: z.string().trim().min(1).max(100), vendorId: z.string() }).parse(req.body);
  try { res.json({ attached: await mapSupplierCode(s.tenant, vendorId, code, s.user.name) }); }
  catch (e: any) { throw new HttpError(e.status ?? 400, e.message); }
}));

ordersRouter.get('/orders/:id', requireStaff('orders.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  const d = await orderDetail(s.tenant.id, req.params.id);
  const [ships, invoices, asnRequired] = await Promise.all([shipmentsFor(d.po.id), listInvoices({ tenantId: s.tenant.id, poId: d.po.id }), asnRequiredFor(d.po)]);
  res.json({ ...d, messages: (await messagesFor(d.po.id)).map(messageView), shipments: ships, invoices: invoices.rows, asnRequired });
}));

/** A buyer records the supplier's acceptance (e.g. confirmed by phone or email). */
ordersRouter.post('/orders/:id/accept', requireStaff('orders.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { lineIds, note } = z.object({ lineIds: z.array(z.string()).min(1).optional(), note: z.string().trim().min(3, 'Say how the supplier confirmed (kept in the history)').max(500) }).parse(req.body);
  const po = await db.query.purchaseOrders.findFirst({ where: and(eq(purchaseOrders.tenantId, s.tenant.id), eq(purchaseOrders.id, req.params.id)) });
  if (!po) throw new HttpError(404, 'Purchase order not found');
  const row = await acceptPurchaseOrder(s.tenant, po, lineIds ?? 'all', { name: s.user.name, email: s.user.email, kind: 'BUYER' }, note, req.ip);
  res.json({ acceptance: row.acceptance });
}));

ordersRouter.post('/orders/messages/:id/retry', requireStaff('orders.manage'), ah(async (req, res) => {
  try { await retryMessage(staffCtx(req).tenant.id, req.params.id); } catch (e: any) { throw new HttpError(409, e.message); }
  res.json({ ok: true });
}));

/* ---------- Purchasing setup ---------- */

ordersRouter.get('/purchasing/setup', requireStaff('orders.view'), ah(async (req, res) => {
  const tenant = staffCtx(req).tenant, t = tenant.id;
  const [entities, siteRows, groups] = await Promise.all([
    db.select().from(legalEntities).where(eq(legalEntities.tenantId, t)).orderBy(asc(legalEntities.code)),
    db.select().from(sites).where(eq(sites.tenantId, t)).orderBy(asc(sites.code)),
    db.select({ g: buyingGroups, orders: sql<number>`(select count(*) from purchase_orders p where p.buying_group_id = "buying_groups"."id")` }).from(buyingGroups).where(eq(buyingGroups.tenantId, t)).orderBy(asc(buyingGroups.code)),
  ]);
  res.json({ entities, sites: siteRows, groups: groups.map(({ g, orders }) => ({ ...g, orders: Number(orders) })),
    invoicing: { priceTolerancePct: tenant.settings.priceTolerancePct ?? 2, einvoiceRequired: !!tenant.settings.einvoiceRequired, india: tenant.country === 'IN' } });
}));

const codeName = z.object({ code: z.string().trim().min(1).max(40), name: z.string().trim().min(1).max(200) });
async function uniqueCode(table: typeof legalEntities | typeof sites | typeof buyingGroups, tenantId: string, code: string, exceptId?: string) {
  const t = table as any;
  const hit = (await db.select({ id: t.id }).from(t).where(and(eq(t.tenantId, tenantId), eq(t.code, code))).limit(1))[0];
  if (hit && hit.id !== exceptId) throw new HttpError(409, `The code ${code} is already used`);
}

ordersRouter.post('/purchasing/entities', requireStaff('orders.manage'), ah(async (req, res) => {
  const s = staffCtx(req); const v = codeName.parse(req.body);
  await uniqueCode(legalEntities, s.tenant.id, v.code);
  const [row] = await db.insert(legalEntities).values({ tenantId: s.tenant.id, ...v }).returning();
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'ENTITY_ADDED', detail: v, ip: req.ip });
  res.status(201).json(row);
}));
ordersRouter.patch('/purchasing/entities/:id', requireStaff('orders.manage'), ah(async (req, res) => {
  const s = staffCtx(req); const v = z.object({ name: z.string().trim().min(1).max(200).optional(), active: z.boolean().optional() }).parse(req.body);
  const [row] = await db.update(legalEntities).set(v).where(and(eq(legalEntities.tenantId, s.tenant.id), eq(legalEntities.id, req.params.id))).returning();
  if (!row) throw new HttpError(404, 'Not found');
  res.json(row);
}));

ordersRouter.post('/purchasing/sites', requireStaff('orders.manage'), ah(async (req, res) => {
  const s = staffCtx(req); const v = codeName.extend({ entityId: z.string().nullable().optional() }).parse(req.body);
  await uniqueCode(sites, s.tenant.id, v.code);
  const [row] = await db.insert(sites).values({ tenantId: s.tenant.id, ...v, entityId: v.entityId ?? null }).returning();
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'SITE_ADDED', detail: { code: v.code, name: v.name }, ip: req.ip });
  res.status(201).json(row);
}));
ordersRouter.patch('/purchasing/sites/:id', requireStaff('orders.manage'), ah(async (req, res) => {
  const s = staffCtx(req); const v = z.object({ name: z.string().trim().min(1).max(200).optional(), active: z.boolean().optional(), entityId: z.string().nullable().optional() }).parse(req.body);
  const [row] = await db.update(sites).set(v).where(and(eq(sites.tenantId, s.tenant.id), eq(sites.id, req.params.id))).returning();
  if (!row) throw new HttpError(404, 'Not found');
  res.json(row);
}));

const groupInput = z.object({ name: z.string().trim().min(1).max(200), autoAcceptDays: z.number().int().min(1).max(90).nullable(), asnRequired: z.boolean(), active: z.boolean().optional() });
ordersRouter.post('/purchasing/groups', requireStaff('orders.manage'), ah(async (req, res) => {
  const s = staffCtx(req); const v = groupInput.extend({ code: z.string().trim().min(1).max(40) }).parse(req.body);
  await uniqueCode(buyingGroups, s.tenant.id, v.code);
  const [row] = await db.insert(buyingGroups).values({ tenantId: s.tenant.id, ...v }).returning();
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'BUYING_GROUP_ADDED', detail: { code: v.code, autoAcceptDays: v.autoAcceptDays ?? 'manual' }, ip: req.ip });
  res.status(201).json(row);
}));
ordersRouter.patch('/purchasing/groups/:id', requireStaff('orders.manage'), ah(async (req, res) => {
  const s = staffCtx(req); const v = groupInput.partial().parse(req.body);
  const old = await db.query.buyingGroups.findFirst({ where: and(eq(buyingGroups.tenantId, s.tenant.id), eq(buyingGroups.id, req.params.id)) });
  if (!old) throw new HttpError(404, 'Not found');
  const [row] = await db.update(buyingGroups).set(v).where(eq(buyingGroups.id, old.id)).returning();
  let retimed = 0;
  if (v.autoAcceptDays !== undefined && v.autoAcceptDays !== old.autoAcceptDays) retimed = await retimeGroup(s.tenant.id, old.id, v.autoAcceptDays);
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'BUYING_GROUP_UPDATED', detail: { code: old.code, ...v, retimedOrders: retimed }, ip: req.ip });
  res.json({ ...row, retimed });
}));

/* ---------- Supplier portal access (per vendor) ---------- */

async function vendorOf(tenantId: string, id: string) {
  const v = await db.query.vendors.findFirst({ where: and(eq(vendors.tenantId, tenantId), eq(vendors.id, id)) });
  if (!v) throw new HttpError(404, 'Vendor not found');
  return v;
}

ordersRouter.get('/purchasing/vendors/:id/access', requireStaff('vendors.view'), ah(async (req, res) => {
  const s = staffCtx(req); const v = await vendorOf(s.tenant.id, req.params.id);
  const [codes, contacts, [orders]] = await Promise.all([
    db.select().from(supplierCodes).where(eq(supplierCodes.vendorId, v.id)).orderBy(asc(supplierCodes.code)),
    db.select().from(supplierContacts).where(eq(supplierContacts.vendorId, v.id)).orderBy(asc(supplierContacts.email)),
    db.select({ n: count() }).from(purchaseOrders).where(eq(purchaseOrders.vendorId, v.id)),
  ]);
  res.json({ mainContact: { name: `${v.contactFirstName} ${v.contactLastName}`.trim(), email: v.contactEmail }, codes, contacts, orders: Number(orders.n), signInUrl: `/s/${s.tenant.slug}` });
}));

ordersRouter.post('/purchasing/vendors/:id/codes', requireStaff('orders.manage'), ah(async (req, res) => {
  const s = staffCtx(req); const v = await vendorOf(s.tenant.id, req.params.id);
  const { code } = z.object({ code: z.string().trim().min(1).max(100) }).parse(req.body);
  try { res.status(201).json({ attached: await mapSupplierCode(s.tenant, v.id, code, s.user.name) }); }
  catch (e: any) { throw new HttpError(e.status ?? 400, e.message); }
}));
ordersRouter.delete('/purchasing/vendors/:id/codes/:codeId', requireStaff('orders.manage'), ah(async (req, res) => {
  const s = staffCtx(req); const v = await vendorOf(s.tenant.id, req.params.id);
  const [row] = await db.delete(supplierCodes).where(and(eq(supplierCodes.vendorId, v.id), eq(supplierCodes.id, req.params.codeId))).returning();
  if (!row) throw new HttpError(404, 'Not found');
  await audit({ tenantId: s.tenant.id, vendorId: v.id, actor: s.user.name, action: 'SUPPLIER_CODE_REMOVED', detail: { code: row.code }, ip: req.ip });
  res.json({ ok: true });
}));

ordersRouter.post('/purchasing/vendors/:id/contacts', requireStaff('orders.manage'), ah(async (req, res) => {
  const s = staffCtx(req); const v = await vendorOf(s.tenant.id, req.params.id);
  const input = z.object({ name: z.string().trim().min(2).max(100), email: z.string().trim().toLowerCase().email() }).parse(req.body);
  if (input.email === v.contactEmail.toLowerCase()) throw new HttpError(409, 'That is already the vendor’s main contact');
  const [row] = await db.insert(supplierContacts).values({ tenantId: s.tenant.id, vendorId: v.id, ...input }).onConflictDoNothing().returning();
  if (!row) throw new HttpError(409, 'This person already has access');
  await audit({ tenantId: s.tenant.id, vendorId: v.id, actor: s.user.name, action: 'SUPPLIER_CONTACT_ADDED', detail: { email: input.email }, ip: req.ip });
  res.status(201).json(row);
}));
ordersRouter.patch('/purchasing/vendors/:id/contacts/:contactId', requireStaff('orders.manage'), ah(async (req, res) => {
  const s = staffCtx(req); const v = await vendorOf(s.tenant.id, req.params.id);
  const { active } = z.object({ active: z.boolean() }).parse(req.body);
  const [row] = await db.update(supplierContacts).set({ active }).where(and(eq(supplierContacts.vendorId, v.id), eq(supplierContacts.id, req.params.contactId))).returning();
  if (!row) throw new HttpError(404, 'Not found');
  if (!active) await db.delete(schema.sessions).where(and(eq(schema.sessions.vendorId, v.id), eq(schema.sessions.contactEmail, row.email)));
  await audit({ tenantId: s.tenant.id, vendorId: v.id, actor: s.user.name, action: active ? 'SUPPLIER_CONTACT_ENABLED' : 'SUPPLIER_CONTACT_DISABLED', detail: { email: row.email }, ip: req.ip });
  res.json(row);
}));

/* ---------- API keys (for ERPs and middleware) ---------- */

ordersRouter.get('/purchasing/api-keys', requireStaff('tenant.settings'), ah(async (req, res) => {
  const rows = await db.select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt, createdAt: apiKeys.createdAt })
    .from(apiKeys).where(eq(apiKeys.tenantId, staffCtx(req).tenant.id)).orderBy(desc(apiKeys.createdAt));
  res.json(rows);
}));
ordersRouter.post('/purchasing/api-keys', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { name } = z.object({ name: z.string().trim().min(2).max(80) }).parse(req.body);
  const key = `vg_${randomToken(30)}`;
  await db.insert(apiKeys).values({ tenantId: s.tenant.id, name, prefix: key.slice(0, 10), keyHash: sha256(key), createdById: s.user.id });
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'API_KEY_CREATED', detail: { name, prefix: key.slice(0, 10) }, ip: req.ip });
  res.status(201).json({ key, name }); // shown once
}));
ordersRouter.delete('/purchasing/api-keys/:id', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const [row] = await db.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.tenantId, s.tenant.id), eq(apiKeys.id, req.params.id), isNull(apiKeys.revokedAt))).returning();
  if (!row) throw new HttpError(404, 'Key not found or already revoked');
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'API_KEY_REVOKED', detail: { name: row.name, prefix: row.prefix }, ip: req.ip });
  res.json({ ok: true });
}));
