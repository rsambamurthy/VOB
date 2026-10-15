/**
 * "Ask VendorGate": the fixed, read-only searches the AI may choose from.
 *
 * The AI never writes SQL and never sees supplier data: it only picks one of these searches and its
 * parameters from the question. VendorGate runs the search here, within the user's workspace and
 * permissions, and shows the rows. Masked fields (bank accounts, IBAN, tax ids) are never returned.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, notExists, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import type { Tenant } from '../../db/schema.js';
import { getConfig } from '../config.js';
import { effectiveLimits } from '../../lib/plans.js';

const { vendors, documents, approvalSteps, changeRequests, purchaseOrders, shipments, supplierInvoices } = schema;

export type Cell = string | number | null;
export interface AskColumn { key: string; label: string; type?: 'date' | 'datetime' | 'money' | 'number' }
export interface AskResult { query: string; title: string; columns: AskColumn[]; rows: (Record<string, Cell> & { _link?: string })[]; total: number; truncated: boolean }
export interface AskUser { tenant: Tenant; can: (p: string) => boolean }

export const VENDOR_STATUSES = ['INVITED', 'IN_PROGRESS', 'UNDER_REVIEW', 'SENT_BACK', 'APPROVED', 'REJECTED'] as const;
const STATUS_LABEL: Record<string, string> = { INVITED: 'Invited', IN_PROGRESS: 'In progress', UNDER_REVIEW: 'Under review', SENT_BACK: 'Sent back', APPROVED: 'Approved', REJECTED: 'Rejected' };
export const INVOICE_STATUSES = ['SUBMITTED', 'EXCEPTION', 'APPROVED', 'REJECTED', 'CANCELLED', 'PARTLY_PAID', 'PAID'] as const;
const INVOICE_LABEL: Record<string, string> = { SUBMITTED: 'In review', EXCEPTION: 'Exception', APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Withdrawn', PARTLY_PAID: 'Partly paid', PAID: 'Paid' };
export const PO_ACCEPTANCE = ['PENDING', 'PARTIAL', 'ACCEPTED', 'REJECTED', 'AUTO_ACCEPTED'] as const;
const ACCEPT_LABEL: Record<string, string> = { PENDING: 'Awaiting acceptance', PARTIAL: 'Partly accepted', ACCEPTED: 'Accepted', REJECTED: 'Rejected', AUTO_ACCEPTED: 'Auto-accepted' };

const LIMIT = 500;
const day = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const like = (s: string) => `%${s.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** City, district, region, area, address or country — the location answers in the supplier's profile. */
const locationOf = sql<string>`concat_ws(' ', ${vendors.profile}->'basic'->>'city', ${vendors.profile}->'basic'->>'district', ${vendors.profile}->'basic'->>'region', ${vendors.profile}->'basic'->>'area', ${vendors.profile}->'basic'->>'address', ${vendors.profile}->'basic'->>'supplierCountry')`;
const cityOf = sql<string>`coalesce(nullif(${vendors.profile}->'basic'->>'city', ''), nullif(${vendors.profile}->'basic'->>'district', ''), nullif(${vendors.profile}->'basic'->>'region', ''))`;
const countryOf = sql<string>`${vendors.profile}->'basic'->>'supplierCountry'`;

function vendorFilters(t: Tenant, p: { status?: string[]; location?: string; country?: string; vendorType?: string; name?: string; onHold?: boolean }): SQL[] {
  const w: SQL[] = [eq(vendors.tenantId, t.id), isNull(vendors.erasedAt)];
  const st = (p.status ?? []).filter((s) => (VENDOR_STATUSES as readonly string[]).includes(s));
  if (st.length) w.push(inArray(vendors.status, st as never));
  if (p.location?.trim()) w.push(sql`${locationOf} ilike ${like(p.location.trim())}`);
  if (p.country?.trim()) w.push(sql`${countryOf} ilike ${like(p.country.trim())}`);
  if (p.vendorType) w.push(eq(vendors.vendorType, p.vendorType as never));
  if (p.name?.trim()) w.push(sql`(${vendors.name} ilike ${like(p.name.trim())} or ${vendors.code} ilike ${like(p.name.trim())})`);
  if (p.onHold === true) w.push(isNotNull(vendors.blockedAt));
  if (p.onHold === false) w.push(isNull(vendors.blockedAt));
  return w;
}

/* ---------- The searches ---------- */

export interface VendorsParams { status?: string[]; location?: string; country?: string; vendorType?: string; name?: string; onHold?: boolean; createdWithinDays?: number; approvedWithinDays?: number }
async function findVendors(u: AskUser, p: VendorsParams, title: string): Promise<AskResult> {
  const w = vendorFilters(u.tenant, p);
  if (p.createdWithinDays) w.push(gte(vendors.createdAt, new Date(Date.now() - p.createdWithinDays * day)));
  if (p.approvedWithinDays) w.push(eq(vendors.status, 'APPROVED'), gte(vendors.decidedAt, new Date(Date.now() - p.approvedWithinDays * day)));
  const rows = await db.select({ id: vendors.id, code: vendors.code, name: vendors.name, status: vendors.status, type: vendors.vendorType, blockedAt: vendors.blockedAt, city: cityOf, country: countryOf, created: vendors.createdAt, decided: vendors.decidedAt })
    .from(vendors).where(and(...w)).orderBy(asc(vendors.name)).limit(LIMIT + 1);
  return out('vendors', title, [
    { key: 'name', label: 'Supplier' }, { key: 'code', label: 'Code' }, { key: 'status', label: 'Status' }, { key: 'city', label: 'City / region' }, { key: 'country', label: 'Country' }, { key: 'created', label: 'Invited', type: 'date' },
  ], rows.map((r) => ({ name: r.name, code: r.code, status: r.blockedAt ? 'On hold' : STATUS_LABEL[r.status] ?? r.status, city: r.city, country: r.country, created: r.created?.toISOString() ?? null, _link: `/staff/vendors/${r.id}` })));
}

export interface ExpiringParams { withinDays?: number; includeExpired?: boolean; documentTypes?: string[]; location?: string; status?: string[] }
async function expiringDocuments(u: AskUser, p: ExpiringParams, title: string): Promise<AskResult> {
  const days = Math.min(Math.max(p.withinDays ?? 90, 1), 730);
  const cfg = await getConfig(u.tenant.id);
  const labelOf = new Map(cfg.documents.map((d) => [d.type, d.label]));
  const types = matchDocTypes(cfg.documents, p.documentTypes);
  const w = [...vendorFilters(u.tenant, { status: p.status ?? ['APPROVED'], location: p.location }), isNotNull(documents.expiresOn), isNull(documents.supersededAt), ne(documents.status, 'REJECTED'),
    lte(documents.expiresOn, isoDay(new Date(Date.now() + days * day)))];
  if (!p.includeExpired) w.push(gte(documents.expiresOn, isoDay(new Date())));
  if (types) w.push(inArray(documents.docType, types.length ? types : ['__none__']));
  const rows = await db.select({ vid: vendors.id, name: vendors.name, code: vendors.code, type: documents.docType, expires: documents.expiresOn, city: cityOf })
    .from(documents).innerJoin(vendors, eq(vendors.id, documents.vendorId)).where(and(...w)).orderBy(asc(documents.expiresOn)).limit(LIMIT + 1);
  const today = Date.parse(isoDay(new Date()));
  return out('expiring_documents', title, [
    { key: 'name', label: 'Supplier' }, { key: 'code', label: 'Code' }, { key: 'document', label: 'Document' }, { key: 'expires', label: 'Expires', type: 'date' }, { key: 'days', label: 'Days left', type: 'number' }, { key: 'city', label: 'City / region' },
  ], rows.map((r) => ({ name: r.name, code: r.code, document: labelOf.get(r.type) ?? r.type, expires: r.expires, days: r.expires ? Math.round((Date.parse(r.expires) - today) / day) : null, city: r.city, _link: `/staff/vendors/${r.vid}` })));
}

/** Document codes for the names the AI gave ("CR", "Zakat certificate"…). undefined = any type. */
function matchDocTypes(docs: { type: string; label: string }[], wanted?: string[]) {
  if (!wanted?.length) return undefined;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, ' ').trim();
  return docs.filter((d) => wanted.some((w) => {
    const x = norm(w); if (!x) return false;
    return d.type.toLowerCase() === x.replace(/ /g, '_') || norm(d.label).includes(x) || x.split(' ').every((part) => norm(d.label).split(' ').some((lw) => lw.startsWith(part)));
  })).map((d) => d.type);
}

export interface ApprovalsParams { level?: string; olderThanDays?: number; overdueOnly?: boolean }
async function pendingApprovals(u: AskUser, p: ApprovalsParams, title: string): Promise<AskResult> {
  const w = [eq(approvalSteps.tenantId, u.tenant.id), eq(approvalSteps.status, 'PENDING'), eq(vendors.status, 'UNDER_REVIEW'), isNull(vendors.erasedAt), sql`${approvalSteps.cycle} = ${vendors.reviewCycle}`];
  if (p.level?.trim()) w.push(sql`${approvalSteps.label} ilike ${like(p.level.trim())}`);
  if (p.olderThanDays) w.push(lte(approvalSteps.activatedAt, new Date(Date.now() - p.olderThanDays * day)));
  if (p.overdueOnly) w.push(lte(approvalSteps.dueAt, new Date()));
  const rows = await db.select({ vid: vendors.id, name: vendors.name, code: vendors.code, level: approvalSteps.label, since: approvalSteps.activatedAt, due: approvalSteps.dueAt })
    .from(approvalSteps).innerJoin(vendors, eq(vendors.id, approvalSteps.vendorId)).where(and(...w)).orderBy(asc(approvalSteps.activatedAt)).limit(LIMIT + 1);
  const now = Date.now();
  return out('pending_approvals', title, [
    { key: 'name', label: 'Supplier' }, { key: 'code', label: 'Code' }, { key: 'level', label: 'Waiting on' }, { key: 'since', label: 'Waiting since', type: 'datetime' }, { key: 'days', label: 'Days waiting', type: 'number' }, { key: 'due', label: 'Due', type: 'datetime' },
  ], rows.map((r) => ({ name: r.name, code: r.code, level: r.level, since: r.since?.toISOString() ?? null, days: r.since ? Math.floor((now - r.since.getTime()) / day) : null, due: r.due?.toISOString() ?? null, _link: `/staff/vendors/${r.vid}` })));
}

export interface ChangesParams { status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'ANY'; bankOnly?: boolean; withinDays?: number }
async function changeRequestsQ(u: AskUser, p: ChangesParams, title: string): Promise<AskResult> {
  const w = [eq(changeRequests.tenantId, u.tenant.id), isNull(vendors.erasedAt)];
  if (p.status && p.status !== 'ANY') w.push(eq(changeRequests.status, p.status));
  if (p.withinDays) w.push(gte(changeRequests.createdAt, new Date(Date.now() - p.withinDays * day)));
  if (p.bankOnly) w.push(sql`exists (select 1 from jsonb_array_elements(${changeRequests.changes}) c where c->>'fieldId' like 'bank.%')`);
  const rows = await db.select({ vid: vendors.id, name: vendors.name, code: vendors.code, status: changeRequests.status, changes: changeRequests.changes, created: changeRequests.createdAt, decided: changeRequests.decidedAt })
    .from(changeRequests).innerJoin(vendors, eq(vendors.id, changeRequests.vendorId)).where(and(...w)).orderBy(desc(changeRequests.createdAt)).limit(LIMIT + 1);
  // Field names only — never the old or new values.
  const fields = (cs: { fieldId: string; label?: string }[]) => [...new Set(cs.map((c) => c.label ?? c.fieldId))].slice(0, 6).join(', ');
  return out('change_requests', title, [
    { key: 'name', label: 'Supplier' }, { key: 'code', label: 'Code' }, { key: 'fields', label: 'What changed' }, { key: 'status', label: 'Status' }, { key: 'created', label: 'Requested', type: 'datetime' }, { key: 'decided', label: 'Decided', type: 'datetime' },
  ], rows.map((r) => ({ name: r.name, code: r.code, fields: fields(r.changes as never), status: r.status === 'PENDING' ? 'In review' : r.status[0] + r.status.slice(1).toLowerCase(), created: r.created.toISOString(), decided: r.decided?.toISOString() ?? null, _link: `/staff/vendors/${r.vid}` })));
}

export interface OrdersParams { acceptance?: string[]; open?: boolean; minValue?: number; noShipmentNotice?: boolean; withinDays?: number; supplier?: string; groupBySupplier?: boolean }
async function purchaseOrdersQ(u: AskUser, p: OrdersParams, title: string): Promise<AskResult> {
  const w: SQL[] = [eq(purchaseOrders.tenantId, u.tenant.id)];
  const acc = (p.acceptance ?? []).filter((a) => (PO_ACCEPTANCE as readonly string[]).includes(a));
  if (acc.length) w.push(inArray(purchaseOrders.acceptance, acc));
  if (p.open !== false) w.push(eq(purchaseOrders.status, 'OPEN'));
  if (p.minValue) w.push(gte(sql`${purchaseOrders.total}::numeric`, p.minValue));
  if (p.withinDays) w.push(gte(purchaseOrders.poDate, isoDay(new Date(Date.now() - p.withinDays * day))));
  if (p.supplier?.trim()) w.push(sql`(${vendors.name} ilike ${like(p.supplier.trim())} or ${vendors.code} ilike ${like(p.supplier.trim())})`);
  if (p.noShipmentNotice) w.push(notExists(db.select({ x: sql`1` }).from(shipments).where(and(eq(shipments.poId, purchaseOrders.id), isNull(shipments.cancelledAt)))));
  const rows = await db.select({ id: purchaseOrders.id, po: purchaseOrders.poNumber, vid: vendors.id, name: vendors.name, code: vendors.code, total: purchaseOrders.total, currency: purchaseOrders.currency, date: purchaseOrders.poDate, acceptance: purchaseOrders.acceptance })
    .from(purchaseOrders).leftJoin(vendors, eq(vendors.id, purchaseOrders.vendorId)).where(and(...w)).orderBy(desc(purchaseOrders.poDate)).limit(p.groupBySupplier ? 5000 : LIMIT + 1);
  if (p.groupBySupplier) return grouped('purchase_orders', title, 'Orders', rows.map((r) => ({ vid: r.vid, name: r.name, code: r.code, total: num(r.total), currency: r.currency })));
  return out('purchase_orders', title, [
    { key: 'po', label: 'PO number' }, { key: 'name', label: 'Supplier' }, { key: 'date', label: 'PO date', type: 'date' }, { key: 'value', label: 'Value', type: 'money' }, { key: 'currency', label: 'Currency' }, { key: 'acceptance', label: 'Acceptance' },
  ], rows.map((r) => ({ po: r.po, name: r.name ?? '(not linked)', date: r.date, value: num(r.total), currency: r.currency, acceptance: ACCEPT_LABEL[r.acceptance] ?? r.acceptance, _link: `/staff/orders/${r.id}` })));
}

export interface InvoicesParams { status?: string[]; withinDays?: number; overdue?: boolean; supplier?: string; groupBySupplier?: boolean }
async function invoicesQ(u: AskUser, p: InvoicesParams, title: string): Promise<AskResult> {
  const w: SQL[] = [eq(supplierInvoices.tenantId, u.tenant.id)];
  const st = (p.status ?? []).filter((s) => (INVOICE_STATUSES as readonly string[]).includes(s));
  if (st.length) w.push(inArray(supplierInvoices.status, st));
  if (p.withinDays) w.push(gte(supplierInvoices.invoiceDate, isoDay(new Date(Date.now() - p.withinDays * day))));
  if (p.overdue) w.push(lte(supplierInvoices.dueDate, isoDay(new Date())), inArray(supplierInvoices.status, ['APPROVED', 'PARTLY_PAID']));
  if (p.supplier?.trim()) w.push(sql`(${vendors.name} ilike ${like(p.supplier.trim())} or ${vendors.code} ilike ${like(p.supplier.trim())})`);
  const rows = await db.select({ id: supplierInvoices.id, no: supplierInvoices.invoiceNumber, vid: vendors.id, name: vendors.name, code: vendors.code, date: supplierInvoices.invoiceDate, due: supplierInvoices.dueDate, total: supplierInvoices.total, paid: supplierInvoices.paidAmount, currency: supplierInvoices.currency, status: supplierInvoices.status, po: purchaseOrders.poNumber })
    .from(supplierInvoices).innerJoin(vendors, eq(vendors.id, supplierInvoices.vendorId)).innerJoin(purchaseOrders, eq(purchaseOrders.id, supplierInvoices.poId))
    .where(and(...w)).orderBy(desc(supplierInvoices.invoiceDate)).limit(p.groupBySupplier ? 5000 : LIMIT + 1);
  if (p.groupBySupplier) return grouped('invoices', title, 'Invoices', rows.map((r) => ({ vid: r.vid, name: r.name, code: r.code, total: num(r.total), currency: r.currency })));
  return out('invoices', title, [
    { key: 'no', label: 'Invoice' }, { key: 'name', label: 'Supplier' }, { key: 'po', label: 'PO' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'value', label: 'Total', type: 'money' }, { key: 'currency', label: 'Currency' }, { key: 'status', label: 'Status' }, { key: 'due', label: 'Due', type: 'date' },
  ], rows.map((r) => ({ no: r.no, name: r.name, po: r.po, date: r.date, value: num(r.total), currency: r.currency, status: INVOICE_LABEL[r.status] ?? r.status, due: r.due, _link: `/staff/invoices/${r.id}` })));
}

function grouped(query: string, title: string, noun: string, rows: { vid: string | null; name: string | null; code: string | null; total: number | null; currency: string }[]): AskResult {
  const by = new Map<string, { name: string; code: string; vid: string | null; n: number; total: number; currency: string }>();
  for (const r of rows) {
    const k = `${r.vid ?? 'none'}|${r.currency}`;
    const g = by.get(k) ?? { name: r.name ?? '(not linked)', code: r.code ?? '', vid: r.vid, n: 0, total: 0, currency: r.currency };
    g.n++; g.total += r.total ?? 0; by.set(k, g);
  }
  const list = [...by.values()].sort((a, b) => b.total - a.total);
  return out(query, title, [{ key: 'name', label: 'Supplier' }, { key: 'code', label: 'Code' }, { key: 'n', label: noun, type: 'number' }, { key: 'value', label: 'Total value', type: 'money' }, { key: 'currency', label: 'Currency' }],
    list.map((g) => ({ name: g.name, code: g.code, n: g.n, value: Math.round(g.total * 100) / 100, currency: g.currency, ...(g.vid ? { _link: `/staff/vendors/${g.vid}` } : {}) })));
}

function out(query: string, title: string, columns: AskColumn[], rows: AskResult['rows']): AskResult {
  return { query, title, columns, rows: rows.slice(0, LIMIT), total: Math.min(rows.length, LIMIT), truncated: rows.length > LIMIT };
}

/* ---------- Catalogue (also given to the AI as tools) ---------- */

export interface AskQueryDef { name: string; description: string; needs: (u: AskUser) => boolean; params: Record<string, unknown>; run: (u: AskUser, p: any, title: string) => Promise<AskResult> }
const collab = (u: AskUser) => !!effectiveLimits(u.tenant).features.collab;

export const ASK_QUERIES: AskQueryDef[] = [
  {
    name: 'find_vendors', description: 'List suppliers (vendors) filtered by status, location, country, type or name. Use for "which suppliers…", "show vendors in …", "suppliers on hold", "suppliers invited this month".',
    needs: (u) => u.can('vendors.view'),
    params: {
      status: { type: 'array', items: { type: 'string', enum: [...VENDOR_STATUSES] }, description: 'Onboarding status. APPROVED = active suppliers.' },
      location: { type: 'string', description: 'City, district, region or area, as written (e.g. "Riyadh", "Pune").' },
      country: { type: 'string', description: 'Supplier country name in English (e.g. "Saudi Arabia", "India").' },
      vendorType: { type: 'string', enum: ['DOMESTIC', 'IMPORT', 'GOVERNMENT'] },
      name: { type: 'string', description: 'Part of the supplier name or code.' },
      onHold: { type: 'boolean', description: 'true = only suppliers on hold (blocked); false = exclude them.' },
      createdWithinDays: { type: 'integer', minimum: 1, maximum: 3650 },
      approvedWithinDays: { type: 'integer', minimum: 1, maximum: 3650 },
    },
    run: findVendors,
  },
  {
    name: 'expiring_documents', description: 'Supplier documents (licences, CR, VAT, Zakat, GOSI, GST and other certificates) that expire within a number of days, or have already expired.',
    needs: (u) => u.can('vendors.view'),
    params: {
      withinDays: { type: 'integer', minimum: 1, maximum: 730, description: 'Expiring within this many days from today (default 90; "this quarter" ≈ 90, "this month" ≈ 30).' },
      includeExpired: { type: 'boolean', description: 'Also include documents already expired.' },
      documentTypes: { type: 'array', items: { type: 'string' }, description: 'Document names or abbreviations as the user wrote them, e.g. ["CR"], ["trade licence"], ["Zakat"]. Omit for all documents.' },
      location: { type: 'string', description: 'Supplier city or region.' },
      status: { type: 'array', items: { type: 'string', enum: [...VENDOR_STATUSES] }, description: 'Supplier status (default APPROVED).' },
    },
    run: expiringDocuments,
  },
  {
    name: 'pending_approvals', description: 'Suppliers waiting for an approval decision (onboarding review), with the level they are waiting on and for how long. Use for "stuck", "waiting", "overdue approvals", "in Finance review".',
    needs: (u) => u.can('vendors.view'),
    params: {
      level: { type: 'string', description: 'Approval level name or part of it, e.g. "Finance", "Tax".' },
      olderThanDays: { type: 'integer', minimum: 1, maximum: 3650, description: 'Waiting at the current level for more than this many days.' },
      overdueOnly: { type: 'boolean', description: 'Only steps past their deadline.' },
    },
    run: pendingApprovals,
  },
  {
    name: 'change_requests', description: 'Changes to approved suppliers\' details (requested by the supplier or staff), e.g. bank detail changes.',
    needs: (u) => u.can('vendors.view'),
    params: {
      status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED', 'ANY'], description: 'PENDING = still in review. Default ANY.' },
      bankOnly: { type: 'boolean', description: 'Only changes to bank details.' },
      withinDays: { type: 'integer', minimum: 1, maximum: 3650, description: 'Requested within this many days.' },
    },
    run: changeRequestsQ,
  },
  {
    name: 'purchase_orders', description: 'Purchase orders sent to suppliers: acceptance status, value, missing shipment notices; can total by supplier.',
    needs: (u) => u.can('orders.view') && collab(u),
    params: {
      acceptance: { type: 'array', items: { type: 'string', enum: [...PO_ACCEPTANCE] } },
      open: { type: 'boolean', description: 'Only open orders (default true).' },
      minValue: { type: 'number', description: 'Order value at least this amount (in the order currency).' },
      noShipmentNotice: { type: 'boolean', description: 'Orders with no shipment notice yet.' },
      withinDays: { type: 'integer', minimum: 1, maximum: 3650, description: 'PO date within this many days.' },
      supplier: { type: 'string', description: 'Part of the supplier name or code.' },
      groupBySupplier: { type: 'boolean', description: 'Total the orders per supplier instead of listing them.' },
    },
    run: purchaseOrdersQ,
  },
  {
    name: 'invoices', description: 'Supplier invoices: status (in review, exception, approved, paid…), overdue for payment; can total by supplier.',
    needs: (u) => u.can('orders.view') && collab(u),
    params: {
      status: { type: 'array', items: { type: 'string', enum: [...INVOICE_STATUSES] }, description: 'SUBMITTED = in review; EXCEPTION = did not match the order.' },
      withinDays: { type: 'integer', minimum: 1, maximum: 3650, description: 'Invoice date within this many days ("this month" ≈ 30).' },
      overdue: { type: 'boolean', description: 'Approved but unpaid invoices past their due date.' },
      supplier: { type: 'string' },
      groupBySupplier: { type: 'boolean', description: 'Total per supplier ("by supplier").' },
    },
    run: invoicesQ,
  },
];

export async function runAskQuery(u: AskUser, name: string, params: Record<string, unknown>, title: string): Promise<AskResult> {
  const q = ASK_QUERIES.find((x) => x.name === name && x.needs(u));
  if (!q) throw new Error(`Unknown or not allowed: ${name}`);
  return q.run(u, params ?? {}, title);
}
