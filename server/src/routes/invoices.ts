/**
 * Invoices add-on (accounts payable): Administration → Invoices, and the AP screens under /api/staff/invoices.
 * Routes only check permissions and shape responses; rules live in services/invoices.
 */
import { Router, type Request, type Response } from 'express';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { requireAnyStaff, requireStaff, staffCtx } from '../auth/session.js';
import type { Permission } from '../lib/permissions.js';
import { bulkContractUpload, excelUpload, upload } from '../lib/upload.js';
import { sendStoredFile } from '../integrations/storage/index.js';
import { approvalSetupFor, saveFlowLevels } from './approvalAdmin.js';
import { decideFlow, flowView } from '../services/approvalFlow.js';
import { effectiveLimits } from '../lib/plans.js';
import { onboardingOn } from '../lib/modules.js';
import {
  accountFormat, assertInvoicesOn, checkInvoicesSettings, DEFAULT_ACCOUNT_FORMAT, erpSchema, INVOICE_ASSIGNEES, invoiceApprovalCatalog, invoiceApprovalLevels,
  invoiceRules, invoicesConfig, invoicesSummary,
} from '../services/invoices/config.js';
import { cancelInvoice, decideInvoice, getInvoice, linkInvoicesToParties, saveDraft, submitDraft } from '../services/invoices/record.js';
import { invoiceableLines, KIND_LABEL } from '../services/invoices/checks.js';
import { invoiceCounts, invoiceDetail, invoiceMessages, listInvoices, TABS } from '../services/invoices/views.js';
import { pushToErp } from '../services/invoices/erp.js';
import { debitNotePdf, debitNoteRecipient, emailDebitNote } from '../services/invoices/notify.js';
import { attachFile, bulkUpload, importInvoices, invoicesTemplate, workspaceCurrency } from '../services/invoices/capture.js';
import { addCode, codeOptions, codesTemplate, importCodes, listCodes, pullErpResults, refreshFromErp, updateCode } from '../services/invoices/codes.js';
import { invoiceReport, invoiceReportXlsx } from '../services/invoices/reports.js';
import { listPayments } from '../services/collab/invoices.js';

const { supplierInvoices, purchaseOrders, contracts, parties, users } = schema;
const by = (req: Request) => { const s = staffCtx(req); return { id: s.user.id, name: s.user.name, email: s.user.email, ip: req.ip }; };
const sendXlsx = (res: Response, name: string, buf: ArrayBuffer | Buffer) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(Buffer.from(buf as ArrayBuffer));
};
const has = (req: Request, p: string) => staffCtx(req).permissions.has(p as Permission);

/* ---------------- Administration → Invoices ---------------- */

async function adminView(t: Parameters<typeof invoicesConfig>[0]) {
  return { ...invoicesConfig(t), plan: effectiveLimits(t).label, onboarding: onboardingOn(t), accountFormat: accountFormat(t), defaultAccountFormat: DEFAULT_ACCOUNT_FORMAT,
    approval: await approvalSetupFor(t.id, invoiceApprovalLevels(t), invoiceApprovalCatalog(), undefined, INVOICE_ASSIGNEES) };
}

export const invoicesAdminRouter = Router();
invoicesAdminRouter.get('/', requireStaff('tenant.settings'), ah(async (req, res) => { res.json(await adminView(staffCtx(req).tenant)); }));
invoicesAdminRouter.put('/', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { settings, changes } = checkInvoicesSettings(s.tenant, req.body ?? {});
  const tenant = { ...s.tenant, settings: { ...s.tenant.settings, invoices: settings } };
  await db.update(schema.tenants).set({ settings: tenant.settings }).where(eq(schema.tenants.id, s.tenant.id));
  if (changes.length) await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'INVOICES_SETTINGS_CHANGED', detail: { changes }, ip: req.ip });
  // Switched on: today's supplier-portal invoices join the AP list under their supplier's party.
  if (settings.enabled && !(s.tenant.settings.invoices as { enabled?: boolean } | undefined)?.enabled) await linkInvoicesToParties(tenant as typeof s.tenant);
  res.json({ ...(await adminView(tenant)), changes });
}));
/** The approval matrix (the levels editor shared with contracts and sourcing; levels can go to the cost-centre owner). */
invoicesAdminRouter.put('/approval', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { tenant } = await saveFlowLevels(s.tenant, req.body?.levels, { catalog: invoiceApprovalCatalog(), settingsKey: 'invoices', field: 'approval', auditAction: 'INVOICES_APPROVAL_MATRIX_CHANGED', actor: s.user.name, ip: req.ip, assignees: INVOICE_ASSIGNEES });
  res.json({ approval: await approvalSetupFor(tenant.id, invoiceApprovalLevels(tenant), invoiceApprovalCatalog(), undefined, INVOICE_ASSIGNEES) });
}));
/** How a line's coding becomes Oracle's concatenated account. */
invoicesAdminRouter.put('/erp', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const erp = erpSchema.parse(req.body ?? {});
  const settings = { ...s.tenant.settings, invoices: { ...(s.tenant.settings.invoices ?? {}), erp } };
  await db.update(schema.tenants).set({ settings }).where(eq(schema.tenants.id, s.tenant.id));
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'INVOICES_ERP_FORMAT_CHANGED', detail: erp, ip: req.ip });
  res.json(await adminView({ ...s.tenant, settings }));
}));

/* ---------------- AP screens ---------------- */

export const invoicesRouter = Router();
invoicesRouter.use(requireStaff(), (req, _res, next) => { try { assertInvoicesOn(staffCtx(req).tenant); next(); } catch (e) { next(e); } });
const VIEW = requireAnyStaff('invoices.view', 'invoices.manage');
const CAPTURE = requireStaff('invoices.capture');
const MANAGE = requireStaff('invoices.manage');

const listQuery = z.object({ status: z.enum(TABS).optional(), kind: z.enum(['INVOICE', 'CREDIT', 'DEBIT']).optional(), basis: z.enum(['po', 'contract', 'nonPo']).optional(),
  partyId: z.string().max(40).optional(), contractId: z.string().max(40).optional(), poId: z.string().max(40).optional(), q: z.string().max(100).optional(), page: z.coerce.number().int().min(1).optional() });
invoicesRouter.get('/', VIEW, ah(async (req, res) => {
  const s = staffCtx(req);
  const q = listQuery.parse(req.query);
  res.json({ ...(await listInvoices({ tenantId: s.tenant.id, ...q })), counts: await invoiceCounts(s.tenant.id),
    can: { capture: has(req, 'invoices.capture'), manage: has(req, 'invoices.manage') }, settings: invoicesSummary(s.tenant) });
}));

/** What the entry screens need: code lists, settings, currency, the people who can own cost centres. */
invoicesRouter.get('/setup', VIEW, ah(async (req, res) => {
  const t = staffCtx(req).tenant;
  res.json({ codes: await codeOptions(t), settings: invoicesSummary(t), currency: workspaceCurrency(t), costCentreRequired: invoiceRules(t).costCentre !== 'optional', kinds: KIND_LABEL });
}));

/** Open purchase orders of a supplier (the party's onboarded supplier). */
invoicesRouter.get('/orders', CAPTURE, ah(async (req, res) => {
  const t = staffCtx(req).tenant;
  const party = await db.query.parties.findFirst({ where: and(eq(parties.tenantId, t.id), eq(parties.id, String(req.query.partyId ?? ''))) });
  if (!party?.vendorId) return res.json({ orders: [] });
  const rows = await db.select({ id: purchaseOrders.id, poNumber: purchaseOrders.poNumber, poDate: purchaseOrders.poDate, currency: purchaseOrders.currency, total: purchaseOrders.total }).from(purchaseOrders)
    .where(and(eq(purchaseOrders.tenantId, t.id), eq(purchaseOrders.vendorId, party.vendorId), sql`${purchaseOrders.status} <> 'CANCELLED'`)).orderBy(sql`${purchaseOrders.poDate} desc nulls last`).limit(200);
  res.json({ orders: rows.map((r) => ({ ...r, total: Number(r.total) })) });
}));
invoicesRouter.get('/orders/:poId/lines', CAPTURE, ah(async (req, res) => {
  const t = staffCtx(req).tenant;
  const po = await db.query.purchaseOrders.findFirst({ where: and(eq(purchaseOrders.tenantId, t.id), eq(purchaseOrders.id, req.params.poId)) });
  if (!po) throw new HttpError(404, 'Purchase order not found');
  res.json({ po: { id: po.id, poNumber: po.poNumber, currency: po.currency, paymentTerms: po.paymentTerms }, lines: await invoiceableLines(po.id, typeof req.query.exclude === 'string' ? req.query.exclude : undefined) });
}));
/** Signed supplier contracts with a party (for contract invoices). */
invoicesRouter.get('/contracts', CAPTURE, ah(async (req, res) => {
  const t = staffCtx(req).tenant;
  const rows = await db.select({ id: contracts.id, number: contracts.number, title: contracts.title, currency: contracts.currency, value: contracts.value, status: contracts.status, startDate: contracts.startDate, endDate: contracts.endDate }).from(contracts)
    .where(and(eq(contracts.tenantId, t.id), eq(contracts.partyId, String(req.query.partyId ?? '')), eq(contracts.direction, 'BUY'), inArray(contracts.status, ['ACTIVE', 'EXPIRED']))).orderBy(asc(contracts.number)).limit(200);
  res.json({ contracts: rows.map((r) => ({ ...r, value: r.value === null ? null : Number(r.value) })) });
}));
/** A supplier's invoices a credit or debit note can be raised against. */
invoicesRouter.get('/for-notes', CAPTURE, ah(async (req, res) => {
  const t = staffCtx(req).tenant;
  const rows = await db.select({ id: supplierInvoices.id, invoiceNumber: supplierInvoices.invoiceNumber, invoiceDate: supplierInvoices.invoiceDate, total: supplierInvoices.total, currency: supplierInvoices.currency, status: supplierInvoices.status, poId: supplierInvoices.poId, contractId: supplierInvoices.contractId }).from(supplierInvoices)
    .where(and(eq(supplierInvoices.tenantId, t.id), eq(supplierInvoices.partyId, String(req.query.partyId ?? '')), eq(supplierInvoices.kind, 'INVOICE'), inArray(supplierInvoices.status, ['SUBMITTED', 'EXCEPTION', 'IN_APPROVAL', 'APPROVED', 'PARTLY_PAID', 'PAID'])))
    .orderBy(sql`${supplierInvoices.invoiceDate} desc`).limit(200);
  res.json({ invoices: rows.map((r) => ({ ...r, total: Number(r.total) })) });
}));

invoicesRouter.get('/import-template.xlsx', CAPTURE, ah(async (_req, res) => { sendXlsx(res, 'invoices-import.xlsx', await invoicesTemplate()); }));
invoicesRouter.post('/import', CAPTURE, excelUpload.single('file'), ah(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'No file uploaded');
  res.json(await importInvoices(staffCtx(req).tenant, req.file.buffer, by(req), req.query.commit === '1'));
}));
invoicesRouter.post('/bulk', CAPTURE, bulkContractUpload.array('files', 25), ah(async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw new HttpError(400, 'Choose the invoice files');
  res.json(await bulkUpload(staffCtx(req).tenant, files, by(req), req.query.commit === '1'));
}));

invoicesRouter.get('/reports', VIEW, ah(async (req, res) => { res.json(await invoiceReport(staffCtx(req).tenant)); }));
invoicesRouter.get('/reports.xlsx', VIEW, ah(async (req, res) => { sendXlsx(res, 'invoice-reports.xlsx', await invoiceReportXlsx(staffCtx(req).tenant)); }));
invoicesRouter.get('/payments', VIEW, ah(async (req, res) => {
  const q = z.object({ partyId: z.string().max(40).optional(), page: z.coerce.number().int().min(1).optional() }).parse(req.query);
  res.json(await listPayments(staffCtx(req).tenant.id, undefined, q.page, q.partyId));
}));

/* ---- code lists (Administration → Invoices → Code lists, and pickers) ---- */
const CODES_ADMIN = requireAnyStaff('tenant.settings', 'invoices.manage');
invoicesRouter.get('/codes', VIEW, ah(async (req, res) => { res.json(await listCodes(staffCtx(req).tenant, req.query as Record<string, string>)); }));
invoicesRouter.get('/codes/template.xlsx', CODES_ADMIN, ah(async (_req, res) => { sendXlsx(res, 'invoice-codes.xlsx', await codesTemplate()); }));
invoicesRouter.post('/codes/import', CODES_ADMIN, excelUpload.single('file'), ah(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'No file uploaded');
  res.json(await importCodes(staffCtx(req).tenant, req.file.buffer, by(req), req.query.commit === '1'));
}));
invoicesRouter.post('/codes', CODES_ADMIN, ah(async (req, res) => { res.status(201).json(await addCode(staffCtx(req).tenant, req.body, by(req))); }));
invoicesRouter.patch('/codes/:id', CODES_ADMIN, ah(async (req, res) => { res.json(await updateCode(staffCtx(req).tenant, req.params.id, req.body, by(req))); }));
invoicesRouter.post('/codes/refresh', CODES_ADMIN, ah(async (req, res) => { res.json(await refreshFromErp(staffCtx(req).tenant, by(req))); }));
invoicesRouter.get('/owners', CODES_ADMIN, ah(async (req, res) => {
  res.json({ users: await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(and(eq(users.tenantId, staffCtx(req).tenant.id), eq(users.status, 'ACTIVE'))).orderBy(asc(users.name)) });
}));

/* ---- ERP ---- */
/** Manual push: send approved invoices (Ready for ERP, or Import failed after a fix in the ERP) now. */
invoicesRouter.post('/push', requireAnyStaff('invoices.capture', 'invoices.manage'), ah(async (req, res) => {
  const { ids } = z.object({ ids: z.array(z.string().max(40)).min(1).max(200) }).parse(req.body);
  const rows = await pushToErp(staffCtx(req).tenant, ids, by(req));
  res.json({ sent: rows.filter((r) => r.erpStatus === 'SENT').length, waiting: rows.filter((r) => r.erpStatus === 'READY').map((r) => ({ id: r.id, invoiceNumber: r.invoiceNumber, error: r.erpError })) });
}));
invoicesRouter.post('/erp-results', MANAGE, ah(async (req, res) => { res.json(await pullErpResults(staffCtx(req).tenant)); }));

/* ---- one invoice ---- */

/** Approvers without invoices.view may open an invoice they are asked to approve (the email links to it). */
async function canOpen(req: Request, id: string) {
  if (has(req, 'invoices.view') || has(req, 'invoices.manage')) return;
  const v = await flowView(staffCtx(req).tenant.id, 'invoice', id, staffCtx(req).user.id);
  if (!v.canAct) throw new HttpError(403, 'You don’t have permission to open invoices.');
}

invoicesRouter.post('/', CAPTURE, ah(async (req, res) => {
  const t = staffCtx(req).tenant;
  const inv = await saveDraft(t, null, req.body, { ...by(req), source: 'AP' });
  res.status(201).json(await detailFor(req, inv.id));
}));
invoicesRouter.get('/:id', ah(async (req, res) => { await canOpen(req, req.params.id); res.json(await detailFor(req, req.params.id)); }));
invoicesRouter.put('/:id', CAPTURE, ah(async (req, res) => {
  await saveDraft(staffCtx(req).tenant, req.params.id, req.body, by(req));
  res.json(await detailFor(req, req.params.id));
}));
invoicesRouter.post('/:id/file', CAPTURE, upload.single('file'), ah(async (req, res) => {
  await attachFile(staffCtx(req).tenant, req.params.id, req.file, by(req));
  res.json(await detailFor(req, req.params.id));
}));
invoicesRouter.get('/:id/file', ah(async (req, res) => {
  await canOpen(req, req.params.id);
  const inv = await getInvoice(staffCtx(req).tenant, req.params.id);
  if (inv.file) return sendStoredFile(res, inv.file);
  if (inv.documentId) {
    const d = await db.query.documents.findFirst({ where: and(eq(schema.documents.tenantId, inv.tenantId), eq(schema.documents.id, inv.documentId)) });
    if (d) return sendStoredFile(res, d);
  }
  if (inv.kind === 'DEBIT') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${inv.invoiceNumber.replace(/[^A-Za-z0-9-]/g, '_')}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(await debitNotePdf(inv.id));
  }
  throw new HttpError(404, 'No file');
}));
invoicesRouter.post('/:id/submit', CAPTURE, ah(async (req, res) => {
  await submitDraft(staffCtx(req).tenant, req.params.id, by(req));
  res.json(await detailFor(req, req.params.id));
}));
/** One decision (no matrix level applies). */
invoicesRouter.post('/:id/decide', MANAGE, ah(async (req, res) => {
  const { decision, note } = z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().trim().max(1000).optional() }).parse(req.body);
  const t = staffCtx(req).tenant;
  await decideInvoice(t, await getInvoice(t, req.params.id), decision, note || null, by(req));
  res.json(await detailFor(req, req.params.id));
}));
/** A step of the approval matrix. */
invoicesRouter.post('/:id/approval', ah(async (req, res) => {
  const { action, remarks } = z.object({ action: z.enum(['APPROVE', 'SEND_BACK', 'REJECT']), remarks: z.string().trim().max(1000).default('') }).parse(req.body);
  const s = staffCtx(req);
  const inv = await getInvoice(s.tenant, req.params.id);
  if (action === 'APPROVE' && inv.status === 'IN_APPROVAL' && inv.checks.some((c) => c.level === 'warning') && !remarks) throw new HttpError(400, 'This invoice has exceptions — add a remark on why it can be approved');
  await decideFlow(s.tenant.id, 'invoice', inv.id, { id: s.user.id, name: s.user.name }, action, remarks, req.ip);
  res.json(await detailFor(req, req.params.id));
}));
invoicesRouter.post('/:id/cancel', CAPTURE, ah(async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().max(500).default('Cancelled by AP') }).parse(req.body ?? {});
  const t = staffCtx(req).tenant;
  await cancelInvoice(t, await getInvoice(t, req.params.id), by(req), reason || 'Cancelled by AP');
  res.json(await detailFor(req, req.params.id));
}));
/** Email an approved debit note to the supplier (when the workspace's setting lets AP choose). */
invoicesRouter.post('/:id/email', MANAGE, ah(async (req, res) => {
  const t = staffCtx(req).tenant;
  await emailDebitNote(t, await getInvoice(t, req.params.id), by(req));
  res.json(await detailFor(req, req.params.id));
}));

async function detailFor(req: Request, id: string) {
  const s = staffCtx(req);
  const d = await invoiceDetail(s.tenant.id, id);
  const [flow, messages] = await Promise.all([flowView(s.tenant.id, 'invoice', id, s.user.id), invoiceMessages(s.tenant.id, id)]);
  const inv = d.invoice;
  const capture = has(req, 'invoices.capture'), manage = has(req, 'invoices.manage');
  const rules = invoiceRules(s.tenant);
  const priceCheck = d.vendor?.id ? await (await import('../services/contracts/manage.js')).priceCheck(s.tenant, d.vendor.id, inv.currency, d.lines.map((l) => ({ key: l.id, itemCode: l.itemCode, unitPrice: l.unitPrice }))).catch(() => null) : null;
  return {
    ...d, flow, messages, priceCheck, file: (await db.query.supplierInvoices.findFirst({ where: eq(supplierInvoices.id, id), columns: { file: true } }))?.file?.fileName ?? null,
    debitNoteTo: inv.kind === 'DEBIT' ? await debitNoteRecipient(s.tenant, await getInvoice(s.tenant, id)) : null,
    can: {
      edit: capture && inv.status === 'DRAFT' && inv.source !== 'PORTAL',
      submit: capture && inv.status === 'DRAFT',
      decide: manage && (inv.status === 'SUBMITTED' || inv.status === 'EXCEPTION') && inv.createdById !== s.user.id,
      cancel: capture && ['DRAFT', 'SUBMITTED', 'EXCEPTION', 'IN_APPROVAL'].includes(inv.status) && inv.source !== 'PORTAL',
      push: (capture || manage) && ['APPROVED', 'PARTLY_PAID', 'PAID'].includes(inv.status) && (inv.erpStatus === 'READY' || inv.erpStatus === 'FAILED'),
      email: manage && inv.kind === 'DEBIT' && rules.debitNoteEmail !== 'never' && ['APPROVED', 'PARTLY_PAID', 'PAID'].includes(inv.status),
      creditNote: capture && inv.kind === 'INVOICE' && inv.status !== 'DRAFT',
      debitNote: capture && inv.kind === 'INVOICE' && ['APPROVED', 'PARTLY_PAID', 'PAID'].includes(inv.status),
    },
  };
}
