/** Read models for purchase orders, shared by the staff and supplier screens. */
import { and, asc, count, desc, eq, ilike, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import { HttpError } from '../../lib/http.js';

const { purchaseOrders: po, poLines, poReceipts, vendors, buyingGroups, legalEntities, sites, auditLogs } = schema;

export const pendingOrderCount = async (vendorId: string) =>
  Number((await db.select({ n: count() }).from(po).where(and(eq(po.vendorId, vendorId), eq(po.status, 'OPEN'), inArray(po.acceptance, ['PENDING', 'PARTIAL']))))[0].n);

export interface ListFilter { tenantId: string; vendorId?: string; q?: string; acceptance?: string; status?: string; entityId?: string; siteId?: string; groupId?: string; unmapped?: boolean; dueSoon?: boolean; page?: number }

export async function listOrders(f: ListFilter) {
  const where: SQL[] = [eq(po.tenantId, f.tenantId)];
  if (f.vendorId) where.push(eq(po.vendorId, f.vendorId));
  if (f.q) where.push(or(ilike(po.poNumber, `%${f.q}%`), ilike(po.supplierCode, `%${f.q}%`), ilike(vendors.name, `%${f.q}%`))!);
  if (f.acceptance === 'WAITING') where.push(inArray(po.acceptance, ['PENDING', 'PARTIAL']), eq(po.status, 'OPEN'));
  else if (f.acceptance) where.push(eq(po.acceptance, f.acceptance));
  if (f.status) where.push(eq(po.status, f.status));
  if (f.entityId) where.push(eq(po.entityId, f.entityId));
  if (f.groupId) where.push(eq(po.buyingGroupId, f.groupId));
  if (f.siteId) where.push(sql`exists (select 1 from po_lines l where l.po_id = ${po.id} and l.site_id = ${f.siteId})`);
  if (f.unmapped) where.push(isNull(po.vendorId));
  if (f.dueSoon) where.push(lte(po.acceptDueAt, new Date(Date.now() + 2 * 86_400_000)), inArray(po.acceptance, ['PENDING', 'PARTIAL']));
  const size = 50, page = Math.max(1, f.page ?? 1);
  const rows = await db.select({
    id: po.id, poNumber: po.poNumber, revision: po.revision, supplierCode: po.supplierCode, vendorId: po.vendorId, vendorName: vendors.name, vendorCode: vendors.code,
    entity: legalEntities.name, group: buyingGroups.name, buyerName: po.buyerName, currency: po.currency, total: po.total, poDate: po.poDate,
    status: po.status, acceptance: po.acceptance, acceptDueAt: po.acceptDueAt, acceptedAt: po.acceptedAt, source: po.source, syncedAt: po.syncedAt,
    lines: sql<number>`(select count(*) from po_lines l where l.po_id = ${po.id})`,
    pendingLines: sql<number>`(select count(*) from po_lines l where l.po_id = ${po.id} and l.acceptance = 'PENDING' and l.status = 'OPEN')`,
    firstNeedBy: sql<string | null>`(select min(l.need_by_date) from po_lines l where l.po_id = ${po.id})`,
  }).from(po).leftJoin(vendors, eq(vendors.id, po.vendorId)).leftJoin(legalEntities, eq(legalEntities.id, po.entityId)).leftJoin(buyingGroups, eq(buyingGroups.id, po.buyingGroupId))
    .where(and(...where)).orderBy(desc(po.poDate), desc(po.firstSeenAt)).limit(size + 1).offset((page - 1) * size);
  return { rows: rows.slice(0, size).map((r) => ({ ...r, lines: Number(r.lines), pendingLines: Number(r.pendingLines) })), hasMore: rows.length > size, page };
}

export async function orderCounts(tenantId: string, vendorId?: string) {
  const base = and(eq(po.tenantId, tenantId), ...(vendorId ? [eq(po.vendorId, vendorId)] : []));
  const rows = await db.select({ acceptance: po.acceptance, status: po.status, n: count() }).from(po).where(base).groupBy(po.acceptance, po.status);
  const sum = (fn: (r: (typeof rows)[number]) => boolean) => rows.filter(fn).reduce((t, r) => t + Number(r.n), 0);
  const [unmapped] = vendorId ? [{ n: 0 }] : await db.select({ n: count() }).from(po).where(and(eq(po.tenantId, tenantId), isNull(po.vendorId)));
  const [dueSoon] = await db.select({ n: count() }).from(po).where(and(base, eq(po.status, 'OPEN'), inArray(po.acceptance, ['PENDING', 'PARTIAL']), lte(po.acceptDueAt, new Date(Date.now() + 2 * 86_400_000))));
  return {
    all: sum(() => true),
    waiting: sum((r) => r.status === 'OPEN' && (r.acceptance === 'PENDING' || r.acceptance === 'PARTIAL')),
    accepted: sum((r) => r.acceptance === 'ACCEPTED'), autoAccepted: sum((r) => r.acceptance === 'AUTO_ACCEPTED'),
    closed: sum((r) => r.status !== 'OPEN'), unmapped: Number(unmapped.n), dueSoon: Number(dueSoon.n),
  };
}

export async function orderDetail(tenantId: string, id: string, vendorId?: string) {
  const row = await db.query.purchaseOrders.findFirst({ where: and(eq(po.tenantId, tenantId), eq(po.id, id), ...(vendorId ? [eq(po.vendorId, vendorId)] : [])) });
  if (!row) throw new HttpError(404, 'Purchase order not found');
  const [lines, receipts, vendor, entity, group] = await Promise.all([
    db.select({ l: poLines, siteName: sites.name, siteCode: sites.code }).from(poLines).leftJoin(sites, eq(sites.id, poLines.siteId)).where(eq(poLines.poId, id)).orderBy(asc(poLines.lineNo)),
    db.select().from(poReceipts).where(eq(poReceipts.poId, id)).orderBy(desc(poReceipts.receiptDate)),
    row.vendorId ? db.query.vendors.findFirst({ where: eq(vendors.id, row.vendorId), columns: { id: true, name: true, code: true, status: true } }) : undefined,
    row.entityId ? db.query.legalEntities.findFirst({ where: eq(legalEntities.id, row.entityId) }) : undefined,
    row.buyingGroupId ? db.query.buyingGroups.findFirst({ where: eq(buyingGroups.id, row.buyingGroupId) }) : undefined,
  ]);
  const history = await db.select({ id: auditLogs.id, actor: auditLogs.actor, action: auditLogs.action, detail: auditLogs.detail, createdAt: auditLogs.createdAt }).from(auditLogs)
    .where(and(eq(auditLogs.tenantId, tenantId), ilike(auditLogs.action, 'PO_%'), sql`${auditLogs.detail}->>'po' = ${row.poNumber}`)).orderBy(desc(auditLogs.createdAt)).limit(50);
  const { contentHash: _h, ...header } = row;
  return {
    po: header, vendor, entity: entity ? { code: entity.code, name: entity.name } : null,
    group: group ? { code: group.code, name: group.name, autoAcceptDays: group.autoAcceptDays } : null,
    lines: lines.map(({ l, siteName, siteCode }) => ({ ...l, site: siteCode ? { code: siteCode, name: siteName } : null })),
    receipts, history,
  };
}
