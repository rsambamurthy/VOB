/**
 * Imports canonical purchase orders (from any source) into the portal.
 *
 * - New POs start PENDING acceptance; if their buying group auto-accepts, acceptDueAt is set.
 * - Re-imports update the mirror. A line whose quantity, price, need-by date or item changed goes
 *   back to PENDING (the supplier must accept the change); accepted, unchanged lines stay accepted.
 * - The supplier is matched by ERP supplier code; unmatched POs are kept and listed for mapping.
 */
import crypto from 'node:crypto';
import { packFor } from '../../countries/registry.js';
import { addWorkingDays, calendarFor, formatDay } from '../../lib/calendar.js';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { ZodError } from 'zod';
import { db, schema } from '../../lib/db.js';
import { env } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../lib/audit.js';
import { sendMail } from '../../lib/mailer.js';
import type { PoLine, PurchaseOrder, Tenant } from '../../db/schema.js';
import { canonicalPo, type CanonicalLine, type CanonicalPo } from './model.js';

import { matchReceipts } from '../collab/shipments.js';
import { langForVendorId, mailDate, mailSupplier, snippet } from '../../i18n/emails.js';
const { purchaseOrders, poLines, poReceipts, legalEntities, sites, buyingGroups, supplierCodes, supplierContacts, vendors, poImports, tenants } = schema;
const DAY = 86_400_000;
const n4 = (v: number | undefined | null) => (v === undefined || v === null ? null : String(Math.round(v * 10000) / 10000));
const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '') === (b ?? '');
const sameNum = (a: string | number | null | undefined, b: string | number | null | undefined) => Number(a ?? 0) === Number(b ?? 0);

export type ImportSource = 'api' | 'csv' | 'oracle' | 'demo';
export interface ImportResult { importId: string; created: number; updated: number; unchanged: number; failed: number; unmapped: number; errors: string[]; poIds: string[] }

/** Header acceptance from its lines (cancelled lines don't count). */
export function rollUp(lines: Pick<PoLine, 'acceptance' | 'status'>[]) {
  const live = lines.filter((l) => l.status !== 'CANCELLED');
  if (!live.length) return 'ACCEPTED';
  const accepted = live.filter((l) => l.acceptance !== 'PENDING');
  if (accepted.length === live.length) return accepted.every((l) => l.acceptance === 'AUTO_ACCEPTED') ? 'AUTO_ACCEPTED' : 'ACCEPTED';
  return accepted.length ? 'PARTIAL' : 'PENDING';
}

/** Everyone at a supplier who should hear about its orders: main contact + active portal contacts. */
export async function supplierRecipients(vendorId: string) {
  const v = await db.query.vendors.findFirst({ where: eq(vendors.id, vendorId) });
  if (!v || v.erasedAt) return [];
  const extra = await db.select().from(supplierContacts).where(and(eq(supplierContacts.vendorId, vendorId), eq(supplierContacts.active, true)));
  const list = [{ name: `${v.contactFirstName} ${v.contactLastName}`.trim(), email: v.contactEmail }, ...extra.map((c) => ({ name: c.name, email: c.email }))];
  return list.filter((x, i) => list.findIndex((y) => y.email.toLowerCase() === x.email.toLowerCase()) === i);
}

export const supplierLink = (t: Pick<Tenant, 'slug'>, path = '/vendor/orders') => `${env.appBaseUrl}/s/${t.slug}?next=${encodeURIComponent(path)}`;
const money = (v: string | number | null | undefined, cur: string, t?: Pick<Tenant, 'country'>) => new Intl.NumberFormat(packFor(t?.country).locale ?? 'en-GB', { style: 'currency', currency: cur }).format(Number(v ?? 0));

export async function notifySupplierOfPo(tenant: Tenant, po: PurchaseOrder, kind: 'NEW' | 'REVISED' | 'REMINDER') {
  if (!po.vendorId) return;
  const lang = await langForVendorId(po.vendorId);
  const due = po.acceptDueAt ? snippet(lang, 'poDueAuto', { date: lang === 'ar' ? mailDate(po.acceptDueAt, lang) : formatDay(po.acceptDueAt, tenant) }) : snippet(lang, 'poDueManual');
  const key = kind === 'NEW' ? 'poNew' : kind === 'REVISED' ? 'poRevised' : 'poReminder';
  for (const r of await supplierRecipients(po.vendorId)) {
    await mailSupplier(lang, { tenantId: tenant.id, to: r.email, link: supplierLink(tenant, `/vendor/orders/${po.id}`) }, key, { name: r.name, buyer: tenant.name, po: po.poNumber, rev: po.revision, amount: money(po.total, po.currency, kind === 'REMINDER' ? undefined : tenant), due });
  }
}

/** Finds the vendor for a set of ERP supplier identifiers. */
async function matchVendor(tenantId: string, codes: string[]) {
  if (!codes.length) return null;
  const mapped = await db.select({ vendorId: supplierCodes.vendorId }).from(supplierCodes).where(and(eq(supplierCodes.tenantId, tenantId), inArray(supplierCodes.code, codes))).limit(1);
  if (mapped[0]) return mapped[0].vendorId;
  const byErp = await db.select({ id: vendors.id }).from(vendors)
    .where(and(eq(vendors.tenantId, tenantId), isNull(vendors.erasedAt), or(inArray(vendors.erpVendorId, codes), inArray(vendors.code, codes)))).limit(1);
  return byErp[0]?.id ?? null;
}

/** Masters are created on first sight (named by their code) so an import never fails on them. */
async function master<T extends typeof legalEntities | typeof sites | typeof buyingGroups>(table: T, tenantId: string, ref: { code: string; name?: string } | null | undefined, cache: Map<string, string>, extra: Record<string, unknown> = {}) {
  if (!ref) return null;
  const key = ref.code;
  if (cache.has(key)) return cache.get(key)!;
  const t = table as any;
  const found = await db.select({ id: t.id, name: t.name }).from(t).where(and(eq(t.tenantId, tenantId), eq(t.code, key))).limit(1);
  let id: string;
  if (found[0]) {
    id = found[0].id;
    if (ref.name && found[0].name === key) await db.update(t).set({ name: ref.name }).where(eq(t.id, id)); // replace a placeholder name
  } else {
    const [row] = await db.insert(t).values({ tenantId, code: key, name: ref.name ?? key, ...extra }).onConflictDoNothing().returning({ id: t.id });
    id = row?.id ?? (await db.select({ id: t.id }).from(t).where(and(eq(t.tenantId, tenantId), eq(t.code, key))).limit(1))[0].id;
  }
  cache.set(key, id);
  return id;
}

const lineChanged = (old: PoLine, l: CanonicalLine) => !sameNum(old.quantity, l.quantity) || !sameNum(old.unitPrice, l.unitPrice) || !same(old.needByDate, l.needByDate) || !same(old.itemCode, l.itemCode);

export async function importPurchaseOrders(tenant: Tenant, inputs: unknown[], source: ImportSource, requestedBy: string, opts: { notify?: boolean } = {}): Promise<ImportResult> {
  const notify = opts.notify ?? true;
  const res: ImportResult = { importId: '', created: 0, updated: 0, unchanged: 0, failed: 0, unmapped: 0, errors: [], poIds: [] };
  const caches = { entity: new Map<string, string>(), site: new Map<string, string>(), group: new Map<string, string>() };
  const toNotify: { po: PurchaseOrder; kind: 'NEW' | 'REVISED' }[] = [];

  for (const [i, raw] of inputs.entries()) {
    let po: CanonicalPo;
    // No currency from the ERP: use the workspace's home currency.
    if (raw && typeof raw === 'object' && !(raw as any).currency) (raw as any).currency = packFor(tenant.country).currency;
    try { po = canonicalPo.parse(raw); }
    catch (e) {
      res.failed++;
      const label = (raw as any)?.poNumber ?? (raw as any)?.SEGMENT1 ?? `#${i + 1}`;
      res.errors.push(`PO ${label}: ${e instanceof ZodError ? e.issues.map((x) => `${x.path.join('.')} ${x.message}`).slice(0, 3).join('; ') : String(e)}`);
      continue;
    }
    try {
      const dup = new Set<string>();
      for (const l of po.lines) { if (dup.has(l.erpId)) throw new Error(`line id ${l.erpId} appears twice`); dup.add(l.erpId); }
      const entityId = await master(legalEntities, tenant.id, po.entity, caches.entity);
      const groupId = await master(buyingGroups, tenant.id, po.buyingGroup, caches.group);
      const group = groupId ? await db.query.buyingGroups.findFirst({ where: eq(buyingGroups.id, groupId) }) : null;
      const vendorId = await matchVendor(tenant.id, [po.supplierCode, ...(po.supplierAltCodes ?? [])]);
      if (!vendorId) res.unmapped++;
      const siteIds = new Map<string, string | null>();
      for (const l of po.lines) siteIds.set(l.erpId, await master(sites, tenant.id, l.site, caches.site, { entityId }));
      const total = po.lines.filter((l) => l.status !== 'CANCELLED').reduce((t, l) => t + (l.amount ?? l.quantity * l.unitPrice), 0);
      const hash = crypto.createHash('sha256').update(JSON.stringify(po)).digest('hex');
      const header = {
        poNumber: po.poNumber, revision: po.revision, vendorId, supplierCode: po.supplierCode, supplierSiteCode: po.supplierSiteCode ?? null,
        entityId, buyingGroupId: groupId, buyerName: po.buyer?.name ?? null, buyerEmail: po.buyer?.email?.toLowerCase() ?? null,
        poType: po.poType ?? null, currency: po.currency.toUpperCase(), poDate: po.poDate ?? null, paymentTerms: po.paymentTerms ?? null, incoterms: po.incoterms ?? null,
        total: n4(total), status: po.status, notes: po.notes ?? null, attachments: po.attachments ?? [], source, syncedAt: new Date(), contentHash: hash,
      };
      const lineValues = (l: CanonicalLine) => ({
        lineNo: l.lineNo, lineType: l.lineType ?? (l.itemCode ? 'GOODS' : 'SERVICE'), itemCode: l.itemCode ?? null, description: l.description, uom: l.uom ?? null,
        quantity: n4(l.quantity)!, unitPrice: n4(l.unitPrice)!, amount: n4(l.amount ?? l.quantity * l.unitPrice)!, taxCode: l.taxCode ?? null, taxRate: n4(l.taxRate),
        hsn: l.hsn ?? null, siteId: siteIds.get(l.erpId) ?? null, needByDate: l.needByDate ?? null, promisedDate: l.promisedDate ?? null, tolerancePct: n4(l.tolerancePct),
        receivedQty: n4(l.receivedQty ?? 0)!, billedQty: n4(l.billedQty ?? 0)!, status: l.status ?? 'OPEN',
      });
      const dueFrom = (from: Date) => (group?.autoAcceptDays !== null && group?.autoAcceptDays !== undefined ? addWorkingDays(from, group.autoAcceptDays, calendarFor(tenant)) : null);

      const existing = await db.query.purchaseOrders.findFirst({ where: and(eq(purchaseOrders.tenantId, tenant.id), eq(purchaseOrders.erpId, po.erpId)) });
      const outcome = await db.transaction(async (tx) => {
        if (!existing) {
          const now = new Date();
          const [row] = await tx.insert(purchaseOrders).values({ tenantId: tenant.id, erpId: po.erpId, ...header, acceptance: po.status === 'OPEN' ? 'PENDING' : 'ACCEPTED', acceptDueAt: po.status === 'OPEN' ? dueFrom(now) : null, firstSeenAt: now }).returning();
          const ls = await tx.insert(poLines).values(po.lines.map((l) => ({ tenantId: tenant.id, poId: row.id, erpId: l.erpId, ...lineValues(l), acceptance: (l.status ?? 'OPEN') === 'OPEN' && po.status === 'OPEN' ? 'PENDING' : 'ACCEPTED' }))).returning();
          await upsertReceipts(tx, tenant.id, row.id, ls, po);
          return { row, kind: 'created' as const, reset: false };
        }
        if (existing.contentHash === hash && existing.vendorId === vendorId) return { row: existing, kind: 'unchanged' as const, reset: false };
        const old = await tx.select().from(poLines).where(eq(poLines.poId, existing.id));
        let reset = false;
        for (const l of po.lines) {
          const o = old.find((x) => x.erpId === l.erpId);
          const v = lineValues(l);
          if (!o) {
            await tx.insert(poLines).values({ tenantId: tenant.id, poId: existing.id, erpId: l.erpId, ...v, acceptance: v.status === 'OPEN' && po.status === 'OPEN' ? 'PENDING' : 'ACCEPTED' });
            if (v.status === 'OPEN' && po.status === 'OPEN') reset = true;
          } else {
            const changed = o.acceptance !== 'PENDING' && v.status === 'OPEN' && lineChanged(o, l);
            if (changed) reset = true;
            // Quantities the ERP didn't send keep what VendorGate tracked (receipts, approved invoices).
            await tx.update(poLines).set({ ...v, receivedQty: l.receivedQty === undefined ? o.receivedQty : v.receivedQty, billedQty: l.billedQty === undefined ? o.billedQty : v.billedQty, ...(changed ? { acceptance: 'PENDING', acceptedAt: null, acceptedBy: null, acceptNote: null } : {}) }).where(eq(poLines.id, o.id));
          }
        }
        const lines = await tx.select().from(poLines).where(eq(poLines.poId, existing.id));
        const acceptance = po.status === 'OPEN' ? rollUp(lines) : existing.acceptance;
        const [row] = await tx.update(purchaseOrders).set({
          ...header, acceptance,
          ...(reset ? { acceptDueAt: dueFrom(new Date()), acceptedAt: null, remindedAt: null } : {}),
          ...(acceptance === 'ACCEPTED' || acceptance === 'AUTO_ACCEPTED' ? {} : { acceptedAt: null }),
        }).where(eq(purchaseOrders.id, existing.id)).returning();
        await upsertReceipts(tx, tenant.id, existing.id, lines, po);
        return { row, kind: 'updated' as const, reset };
      });
      res[outcome.kind]++;
      res.poIds.push(outcome.row.id);
      if (outcome.kind !== 'unchanged' && po.receipts?.length) await matchReceipts(outcome.row.id).catch((err) => logger.warn({ err }, 'receipt matching failed'));
      const becameMapped = existing && !existing.vendorId && outcome.row.vendorId;
      if (outcome.row.status === 'OPEN' && outcome.row.vendorId && (outcome.kind === 'created' || becameMapped) && outcome.row.acceptance === 'PENDING') toNotify.push({ po: outcome.row, kind: 'NEW' });
      else if (outcome.reset && outcome.row.vendorId) toNotify.push({ po: outcome.row, kind: 'REVISED' });
      if (outcome.kind !== 'unchanged') await audit({ tenantId: tenant.id, vendorId: outcome.row.vendorId, actor: requestedBy, action: outcome.kind === 'created' ? 'PO_RECEIVED' : outcome.reset ? 'PO_REVISED' : 'PO_UPDATED', detail: { po: po.poNumber, revision: po.revision, source } });
    } catch (e: any) {
      res.failed++;
      res.errors.push(`PO ${po.poNumber}: ${String(e?.message ?? e).slice(0, 300)}`);
      logger.warn({ err: e, po: po.poNumber }, 'purchase order import failed');
    }
  }

  const status = res.failed && !(res.created + res.updated + res.unchanged) ? 'FAILED' : res.failed ? 'PARTIAL' : 'OK';
  const [imp] = await db.insert(poImports).values({ tenantId: tenant.id, source, requestedBy, status, created: res.created, updated: res.updated, unchanged: res.unchanged, failed: res.failed, unmapped: res.unmapped, errors: res.errors.slice(0, 50) }).returning();
  res.importId = imp.id;
  if (notify) for (const x of toNotify) await notifySupplierOfPo(tenant, x.po, x.kind).catch((err) => logger.warn({ err }, 'PO notification failed'));
  return res;
}

async function upsertReceipts(tx: any, tenantId: string, poId: string, lines: PoLine[], po: CanonicalPo) {
  for (const r of po.receipts ?? []) {
    const line = r.lineErpId ? lines.find((l) => l.erpId === r.lineErpId) : undefined;
    const ship = r.shipmentNumber ? (await tx.select({ id: schema.shipments.id }).from(schema.shipments).where(and(eq(schema.shipments.poId, poId), eq(schema.shipments.number, r.shipmentNumber))))[0] : undefined;
    const v = { tenantId, poId, lineId: line?.id ?? null, erpId: r.erpId, receiptNumber: r.receiptNumber, receiptDate: r.receiptDate ?? null, quantity: n4(r.quantity)!, shipmentId: ship?.id ?? null };
    await tx.insert(poReceipts).values(v).onConflictDoUpdate({ target: [poReceipts.tenantId, poReceipts.erpId], set: v });
  }
}

/** Link an ERP supplier code to a vendor and attach any purchase orders already waiting under it. */
export async function mapSupplierCode(tenant: Tenant, vendorId: string, code: string, actor: string) {
  const v = await db.query.vendors.findFirst({ where: and(eq(vendors.tenantId, tenant.id), eq(vendors.id, vendorId)) });
  if (!v) throw Object.assign(new Error('Vendor not found'), { status: 404 });
  const clean = code.trim();
  const taken = await db.query.supplierCodes.findFirst({ where: and(eq(supplierCodes.tenantId, tenant.id), eq(supplierCodes.code, clean)) });
  if (taken && taken.vendorId !== vendorId) throw Object.assign(new Error('That supplier code already belongs to another vendor'), { status: 409 });
  if (!taken) await db.insert(supplierCodes).values({ tenantId: tenant.id, vendorId, code: clean });
  const attached = await db.update(purchaseOrders).set({ vendorId }).where(and(eq(purchaseOrders.tenantId, tenant.id), eq(purchaseOrders.supplierCode, clean), isNull(purchaseOrders.vendorId))).returning();
  await audit({ tenantId: tenant.id, vendorId, actor, action: 'SUPPLIER_CODE_MAPPED', detail: { code: clean, purchaseOrders: attached.length } });
  for (const po of attached) if (po.status === 'OPEN' && po.acceptance === 'PENDING') await notifySupplierOfPo(tenant, po, 'NEW').catch(() => {});
  return attached.length;
}

export const tenantById = (id: string) => db.query.tenants.findFirst({ where: eq(tenants.id, id) });
