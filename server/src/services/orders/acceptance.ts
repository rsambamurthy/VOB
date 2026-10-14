/**
 * Supplier acknowledgement of purchase orders: whole PO or chosen lines, by the supplier (or a buyer
 * on their behalf), or automatically when the buying group's waiting period runs out.
 */
import { and, eq, inArray, isNotNull, isNull, lte, lt, or } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import { HttpError } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../lib/audit.js';
import { addWorkingDays, calendarFor } from '../../lib/calendar.js';
import { sendMail } from '../../lib/mailer.js';
import { env } from '../../lib/env.js';
import { defineJob } from '../../jobs/queue.js';
import { hasFeature } from '../limits.js';
import type { PurchaseOrder, Tenant } from '../../db/schema.js';
import { notifySupplierOfPo, rollUp, supplierRecipients, supplierLink } from './importer.js';
import { queueAcknowledgement } from './outbound.js';
import { langForVendorId, mailSupplier, snippet } from '../../i18n/emails.js';

const { purchaseOrders, poLines, tenants } = schema;
const DAY = 86_400_000;

export interface Acceptor { name: string; email?: string | null; kind: 'SUPPLIER' | 'BUYER' | 'SYSTEM' }

export async function acceptPurchaseOrder(tenant: Tenant, po: PurchaseOrder, lineIds: string[] | 'all', by: Acceptor, note?: string | null, ip?: string) {
  if (po.status !== 'OPEN') throw new HttpError(409, 'This purchase order is closed or cancelled');
  const auto = by.kind === 'SYSTEM';
  const result = await db.transaction(async (tx) => {
    // Lock the header so two people accepting at once can't both send an acknowledgement.
    await tx.select({ id: purchaseOrders.id }).from(purchaseOrders).where(eq(purchaseOrders.id, po.id)).for('update');
    const all = await tx.select().from(poLines).where(eq(poLines.poId, po.id));
    const target = all.filter((l) => l.status === 'OPEN' && l.acceptance === 'PENDING' && (lineIds === 'all' || lineIds.includes(l.id)));
    if (lineIds !== 'all' && lineIds.some((id) => !all.find((l) => l.id === id))) throw new HttpError(400, 'One or more lines are not on this purchase order');
    if (!target.length) throw new HttpError(409, 'Nothing is waiting for acceptance on this purchase order');
    const now = new Date();
    await tx.update(poLines).set({ acceptance: auto ? 'AUTO_ACCEPTED' : 'ACCEPTED', acceptedAt: now, acceptedBy: by.email ? `${by.name} <${by.email}>` : by.name, acceptNote: note?.trim() || null })
      .where(inArray(poLines.id, target.map((l) => l.id)));
    const after = await tx.select().from(poLines).where(eq(poLines.poId, po.id));
    const acceptance = rollUp(after);
    const done = acceptance === 'ACCEPTED' || acceptance === 'AUTO_ACCEPTED';
    const [row] = await tx.update(purchaseOrders).set({ acceptance, acceptedAt: done ? now : null, ...(done ? { acceptDueAt: null } : {}) }).where(eq(purchaseOrders.id, po.id)).returning();
    return { po: row, lines: target };
  });
  const who = by.kind === 'BUYER' ? `${by.name} (on behalf of the supplier)` : by.name;
  await audit({ tenantId: tenant.id, vendorId: po.vendorId, actor: auto ? 'system' : by.email ?? by.name, action: auto ? 'PO_AUTO_ACCEPTED' : 'PO_ACCEPTED',
    detail: { po: po.poNumber, lines: result.lines.map((l) => l.lineNo).join(', '), ...(note ? { note } : {}), ...(by.kind === 'BUYER' ? { onBehalf: true } : {}) }, ip });
  await queueAcknowledgement(result.po, { lineIds: result.lines.map((l) => l.id), by: auto ? 'system (auto-accepted)' : who, auto, note }).catch((err) => logger.error({ err }, 'could not queue PO acknowledgement'));

  // Tell the buyer (and the supplier when the system accepted for them).
  const what = result.po.acceptance === 'PARTIAL' ? `${result.lines.length} line${result.lines.length === 1 ? '' : 's'} of purchase order ${po.poNumber}` : `purchase order ${po.poNumber}`;
  if (result.po.buyerEmail) {
    await sendMail({ tenantId: tenant.id, to: result.po.buyerEmail, subject: `${auto ? 'Auto-accepted' : 'Accepted'}: ${po.poNumber}`,
      body: `Hello ${result.po.buyerName ?? ''},\n\n${auto ? `No response was received, so ${what} was accepted automatically.` : `${who} accepted ${what}.`}${note ? `\n\nNote: "${note}"` : ''}`,
      link: `${env.appBaseUrl}/staff/orders/${po.id}` }).catch(() => {});
  }
  if (auto && po.vendorId) {
    const lang = await langForVendorId(po.vendorId);
    const whatL = result.po.acceptance === 'PARTIAL' ? snippet(lang, 'poWhatLines', { n: result.lines.length, po: po.poNumber }) : snippet(lang, 'poWhatWhole', { po: po.poNumber });
    for (const r of await supplierRecipients(po.vendorId)) await mailSupplier(lang, { tenantId: tenant.id, to: r.email, link: supplierLink(tenant, `/vendor/orders/${po.id}`) }, 'poAutoAccepted', { name: r.name, po: po.poNumber, what: lang === 'en' ? what : whatL, buyer: tenant.name }).catch(() => {});
  }
  return result.po;
}

/** Accept whatever is still pending on POs whose waiting period has run out. */
export async function runAutoAccept(now = new Date()) {
  const due = await db.select().from(purchaseOrders).where(and(eq(purchaseOrders.status, 'OPEN'), inArray(purchaseOrders.acceptance, ['PENDING', 'PARTIAL']), isNotNull(purchaseOrders.acceptDueAt), lte(purchaseOrders.acceptDueAt, now))).limit(500);
  let n = 0;
  const cache = new Map<string, Tenant | undefined>();
  for (const po of due) {
    if (!cache.has(po.tenantId)) cache.set(po.tenantId, await db.query.tenants.findFirst({ where: eq(tenants.id, po.tenantId) }));
    const t = cache.get(po.tenantId);
    if (!t || t.status !== 'ACTIVE' || !hasFeature(t, 'collab')) continue;
    try { await acceptPurchaseOrder(t, po, 'all', { name: 'system', kind: 'SYSTEM' }); n++; }
    catch (err) { logger.warn({ err, po: po.poNumber }, 'auto-accept failed'); }
  }
  return n;
}

/** One reminder per PO: a day before auto-acceptance, or after 3 days when the group never auto-accepts. */
export async function runAcceptanceReminders(now = new Date()) {
  const soon = new Date(now.getTime() + DAY), old = new Date(now.getTime() - 3 * DAY);
  const rows = await db.select().from(purchaseOrders).where(and(
    eq(purchaseOrders.status, 'OPEN'), inArray(purchaseOrders.acceptance, ['PENDING', 'PARTIAL']), isNull(purchaseOrders.remindedAt), isNotNull(purchaseOrders.vendorId),
    or(and(isNotNull(purchaseOrders.acceptDueAt), lte(purchaseOrders.acceptDueAt, soon)), and(isNull(purchaseOrders.acceptDueAt), lt(purchaseOrders.firstSeenAt, old))),
  )).limit(500);
  for (const po of rows) {
    const t = await db.query.tenants.findFirst({ where: eq(tenants.id, po.tenantId) });
    if (!t || t.status !== 'ACTIVE' || !hasFeature(t, 'collab')) continue;
    await notifySupplierOfPo(t, po, 'REMINDER').catch(() => {});
    await db.update(purchaseOrders).set({ remindedAt: now }).where(eq(purchaseOrders.id, po.id));
  }
  return rows.length;
}

/** When a buying group's waiting period changes, re-time the POs still waiting in it. */
export async function retimeGroup(tenantId: string, groupId: string, days: number | null) {
  const waiting = await db.select().from(purchaseOrders).where(and(eq(purchaseOrders.tenantId, tenantId), eq(purchaseOrders.buyingGroupId, groupId), eq(purchaseOrders.status, 'OPEN'), inArray(purchaseOrders.acceptance, ['PENDING', 'PARTIAL'])));
  const cal = calendarFor(await db.query.tenants.findFirst({ where: eq(schema.tenants.id, tenantId) }));
  for (const po of waiting) await db.update(purchaseOrders).set({ acceptDueAt: days === null ? null : addWorkingDays(po.firstSeenAt, days, cal) }).where(eq(purchaseOrders.id, po.id));
  return waiting.length;
}

defineJob('po.hourly', async () => {
  const accepted = await runAutoAccept();
  const reminded = await runAcceptanceReminders();
  if (accepted || reminded) logger.info({ accepted, reminded }, 'purchase order sweep');
});

