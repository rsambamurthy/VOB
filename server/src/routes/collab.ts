/**
 * Shipment notices, supplier invoices and payments.
 *   Supplier (/api/vendor/collab/…): create / cancel shipment notices, raise / withdraw invoices, see payments.
 *   Staff (/api/…): review queue for invoices (approve / reject), shipments and payments.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { requireStaff, requireVendor, staffCtx, vendorCtx } from '../auth/session.js';
import { hasFeature } from '../services/limits.js';
import { asnRequiredFor, cancelShipment, createShipment, shippableLines, shipmentsFor } from '../services/collab/shipments.js';
import { upload } from './vendorPortal.js';
import { storeUpload } from '../integrations/storage/index.js';
import { cancelInvoice, decideInvoice, invoiceCounts, invoiceDetail, invoiceableLines, listInvoices, listPayments, matchInvoice, submitInvoice } from '../services/collab/invoices.js';
import { translateMessage } from '../i18n/index.js';

const { purchaseOrders, vendors, shipments, supplierInvoices } = schema;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date');
const opt = (n: number) => z.string().trim().max(n).optional().nullable();

const shipmentInput = z.object({
  shipDate: date, expectedDate: date.optional().nullable(), supplierRef: opt(60), carrier: opt(100), trackingNo: opt(100), vehicleNo: opt(20), ewayBill: opt(20),
  packages: z.number().int().min(1).max(100000).optional().nullable(), notes: opt(1000),
  lines: z.array(z.object({ lineId: z.string(), quantity: z.number().min(0).max(1e12), batchNo: opt(60) })).min(1).max(500),
});
const invoiceInput = z.object({
  invoiceNumber: z.string().trim().min(1, 'Enter the invoice number').max(40), invoiceDate: date, shipmentId: z.string().optional().nullable(), currency: z.string().length(3).optional(),
  total: z.number().min(0).max(1e13), notes: opt(1000), documentId: z.string().optional().nullable(),
  lines: z.array(z.object({ lineId: z.string(), quantity: z.number().min(0).max(1e12), unitPrice: z.number().min(0).max(1e12), taxRate: z.number().min(0).max(100).optional().nullable(), taxAmount: z.number().min(0).max(1e13).optional().nullable() })).min(1).max(500),
  einvoice: z.object({ irn: opt(64), ackNo: opt(30), ackDate: opt(30), signedQr: z.string().trim().max(8000).optional().nullable() }).optional().nullable(),
});

/* ---------- Supplier ---------- */

/** Match results in the language the supplier is reading (X-Lang from the portal). */
const txChecks = (req: Request, checks: { code: string; level: string; message: string }[]) => {
  const lang = req.get('x-lang') === 'ar' ? 'ar' : 'en';
  return checks.map((c) => ({ ...c, message: translateMessage(c.message, lang) }));
};

export const supplierCollabRouter = Router();
supplierCollabRouter.use(requireVendor);
supplierCollabRouter.use((req, _res, next) => (hasFeature(vendorCtx(req).tenant, 'collab') ? next() : next(new HttpError(404, 'Not available'))));

async function supplierActor(req: Request) {
  const c = vendorCtx(req);
  const v = await db.query.vendors.findFirst({ where: eq(vendors.id, c.vendorId) });
  if (!v) throw new HttpError(404, 'Supplier not found');
  const email = c.contactEmail ?? v.contactEmail;
  const contact = email.toLowerCase() === v.contactEmail.toLowerCase() ? `${v.contactFirstName} ${v.contactLastName}`.trim()
    : (await db.query.supplierContacts.findFirst({ where: and(eq(schema.supplierContacts.vendorId, c.vendorId), eq(schema.supplierContacts.email, email.toLowerCase())) }))?.name;
  return { c, v, by: { name: `${contact || email}, ${v.name}`, email } };
}
async function supplierPo(req: Request, id: string) {
  const c = vendorCtx(req);
  const po = await db.query.purchaseOrders.findFirst({ where: and(eq(purchaseOrders.tenantId, c.tenant.id), eq(purchaseOrders.id, id), eq(purchaseOrders.vendorId, c.vendorId)) });
  if (!po) throw new HttpError(404, 'Purchase order not found');
  return po;
}

/** What the supplier can still ship and invoice on an order, plus its notices and invoices. */
supplierCollabRouter.get('/orders/:id', ah(async (req, res) => {
  const c = vendorCtx(req);
  const po = await supplierPo(req, req.params.id);
  const [ship, inv, list, asn] = await Promise.all([shippableLines(po.id), invoiceableLines(po.id), shipmentsFor(po.id), asnRequiredFor(po)]);
  res.json({ shippable: ship, invoiceable: inv, shipments: list.map(({ createdBy: _b, ...s }) => s), invoices: (await listInvoices({ tenantId: c.tenant.id, vendorId: c.vendorId, poId: po.id })).rows, asnRequired: asn,
    priceTolerancePct: c.tenant.settings.priceTolerancePct ?? 2, einvoice: c.tenant.country === 'IN' });
}));

supplierCollabRouter.post('/orders/:id/shipments', ah(async (req, res) => {
  const { c, v, by } = await supplierActor(req);
  if (v.blockedAt) throw new HttpError(409, 'Your vendor account is on hold. Contact the buyer.');
  const po = await supplierPo(req, req.params.id);
  res.status(201).json(await createShipment(c.tenant, po, shipmentInput.parse(req.body), by, req.ip));
}));

supplierCollabRouter.get('/shipments', ah(async (req, res) => {
  const c = vendorCtx(req);
  const rows = await db.select({ s: shipments, poNumber: purchaseOrders.poNumber }).from(shipments).innerJoin(purchaseOrders, eq(purchaseOrders.id, shipments.poId))
    .where(and(eq(shipments.tenantId, c.tenant.id), eq(shipments.vendorId, c.vendorId))).orderBy(schema.shipments.createdAt).limit(500);
  res.json(rows.reverse().map(({ s, poNumber }) => ({ id: s.id, number: s.number, supplierRef: s.supplierRef, status: s.status, shipDate: s.shipDate, expectedDate: s.expectedDate, carrier: s.carrier, trackingNo: s.trackingNo, poId: s.poId, poNumber })));
}));

supplierCollabRouter.post('/shipments/:id/cancel', ah(async (req, res) => {
  const { c, by } = await supplierActor(req);
  const { reason } = z.object({ reason: z.string().trim().min(3, 'Say why').max(500) }).parse(req.body);
  const s = await db.query.shipments.findFirst({ where: and(eq(shipments.tenantId, c.tenant.id), eq(shipments.id, req.params.id), eq(shipments.vendorId, c.vendorId)) });
  if (!s) throw new HttpError(404, 'Shipment notice not found');
  res.json(await cancelShipment(c.tenant, s, reason, { ...by, supplier: true }, req.ip));
}));

/** The invoice file (PDF or image), uploaded before the invoice is submitted. Kept apart from onboarding documents. */
supplierCollabRouter.post('/invoice-files', upload.single('file'), ah(async (req, res) => {
  const c = vendorCtx(req);
  if (!req.file) throw new HttpError(400, 'No file uploaded');
  const stored = await storeUpload(c.tenant.id, c.vendorId, req.file);
  const [doc] = await db.insert(schema.documents).values({ tenantId: c.tenant.id, vendorId: c.vendorId, docType: 'INVOICE', ...stored, status: 'ATTACHMENT' }).returning();
  res.status(201).json({ id: doc.id, fileName: doc.fileName });
}));

/** Dry run: the checks an invoice would get, without submitting it. */
supplierCollabRouter.post('/orders/:id/invoices/check', ah(async (req, res) => {
  const { c, v } = await supplierActor(req);
  const po = await supplierPo(req, req.params.id);
  const m = await matchInvoice(c.tenant, po, v, invoiceInput.parse(req.body));
  res.json({ checks: txChecks(req, m.checks), subtotal: m.subtotal, tax: m.tax, total: m.total });
}));

supplierCollabRouter.post('/orders/:id/invoices', ah(async (req, res) => {
  const { c, v, by } = await supplierActor(req);
  if (v.blockedAt) throw new HttpError(409, 'Your vendor account is on hold. Contact the buyer.');
  const po = await supplierPo(req, req.params.id);
  const input = invoiceInput.parse(req.body);
  if (input.documentId) {
    const d = await db.query.documents.findFirst({ where: and(eq(schema.documents.id, input.documentId), eq(schema.documents.vendorId, v.id), eq(schema.documents.status, 'ATTACHMENT')) });
    if (!d) throw new HttpError(400, 'Attach the invoice file again');
  }
  const inv = await submitInvoice(c.tenant, po, v, input, by, req.ip);
  res.status(201).json({ id: inv.id, status: inv.status, checks: txChecks(req, inv.checks) });
}));

supplierCollabRouter.get('/invoices', ah(async (req, res) => {
  const c = vendorCtx(req);
  const q = z.object({ status: z.enum(['REVIEW', 'UNPAID', 'SUBMITTED', 'EXCEPTION', 'APPROVED', 'REJECTED', 'CANCELLED', 'PARTLY_PAID', 'PAID']).optional(), q: z.string().max(100).optional(), page: z.coerce.number().int().min(1).optional() }).parse(req.query);
  const list = await listInvoices({ tenantId: c.tenant.id, vendorId: c.vendorId, ...q });
  res.json({ ...list, counts: await invoiceCounts(c.tenant.id, c.vendorId) });
}));

supplierCollabRouter.get('/invoices/:id', ah(async (req, res) => {
  const c = vendorCtx(req);
  const d = await invoiceDetail(c.tenant.id, req.params.id, c.vendorId);
  // The buyer's reviewer names stay internal.
  res.json({ ...d, invoice: { ...d.invoice, decidedBy: null, checks: txChecks(req, d.invoice.checks) } });
}));

supplierCollabRouter.post('/invoices/:id/cancel', ah(async (req, res) => {
  const { c, by } = await supplierActor(req);
  const inv = await db.query.supplierInvoices.findFirst({ where: and(eq(supplierInvoices.tenantId, c.tenant.id), eq(supplierInvoices.id, req.params.id), eq(supplierInvoices.vendorId, c.vendorId)) });
  if (!inv) throw new HttpError(404, 'Invoice not found');
  res.json(await cancelInvoice(c.tenant, inv, by, req.ip));
}));

supplierCollabRouter.get('/payments', ah(async (req, res) => {
  const c = vendorCtx(req);
  const page = z.coerce.number().int().min(1).optional().parse(req.query.page);
  res.json(await listPayments(c.tenant.id, c.vendorId, page));
}));

/* ---------- Staff ---------- */

export const staffCollabRouter = Router();
staffCollabRouter.use(['/invoices', '/payments', '/shipments'], (req, _res, next) => {
  const s = req.staff;
  if (s && !hasFeature(s.tenant, 'collab')) return next(new HttpError(403, 'Supplier collaboration isn’t included in your plan. Contact us to add it.', undefined, 'PLAN_LIMIT'));
  next();
});

staffCollabRouter.get('/invoices', requireStaff('orders.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  const q = z.object({ status: z.enum(['REVIEW', 'UNPAID', 'SUBMITTED', 'EXCEPTION', 'APPROVED', 'REJECTED', 'CANCELLED', 'PARTLY_PAID', 'PAID']).optional(), q: z.string().max(100).optional(), vendorId: z.string().optional(), poId: z.string().optional(), page: z.coerce.number().int().min(1).optional() }).parse(req.query);
  res.json({ ...(await listInvoices({ tenantId: s.tenant.id, ...q })), counts: await invoiceCounts(s.tenant.id, q.vendorId), canDecide: s.permissions.has('invoices.manage') });
}));

staffCollabRouter.get('/invoices/:id', requireStaff('orders.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  res.json({ ...(await invoiceDetail(s.tenant.id, req.params.id)), canDecide: s.permissions.has('invoices.manage') });
}));

staffCollabRouter.post('/invoices/:id/decide', requireStaff('invoices.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { decision, note } = z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().trim().max(1000).optional() }).parse(req.body);
  const inv = await db.query.supplierInvoices.findFirst({ where: and(eq(supplierInvoices.tenantId, s.tenant.id), eq(supplierInvoices.id, req.params.id)) });
  if (!inv) throw new HttpError(404, 'Invoice not found');
  const row = await decideInvoice(s.tenant, inv, decision, note || null, { name: s.user.name, email: s.user.email }, req.ip);
  res.json({ status: row.status });
}));

staffCollabRouter.get('/payments', requireStaff('invoices.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const q = z.object({ vendorId: z.string().optional(), page: z.coerce.number().int().min(1).optional() }).parse(req.query);
  res.json(await listPayments(s.tenant.id, q.vendorId, q.page));
}));

staffCollabRouter.post('/shipments/:id/cancel', requireStaff('orders.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { reason } = z.object({ reason: z.string().trim().min(3, 'Say why (the supplier is told)').max(500) }).parse(req.body);
  const row = await db.query.shipments.findFirst({ where: and(eq(shipments.tenantId, s.tenant.id), eq(shipments.id, req.params.id)) });
  if (!row) throw new HttpError(404, 'Shipment notice not found');
  res.json(await cancelShipment(s.tenant, row, reason, { name: s.user.name, email: s.user.email, supplier: false }, req.ip));
}));
