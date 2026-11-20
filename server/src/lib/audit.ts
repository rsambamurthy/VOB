import { db, schema } from './db.js';

type AuditEntry = { tenantId: string; vendorId?: string | null; actor: string; action: string; detail?: unknown; ip?: string };
const listeners: ((e: AuditEntry) => void)[] = [];
/** Run something after every audited change (e.g. dropping a cache that depends on vendor data). */
export const onAudit = (fn: (e: AuditEntry) => void) => { listeners.push(fn); };

export async function audit(e: AuditEntry) {
  await db.insert(schema.auditLogs).values({ tenantId: e.tenantId, vendorId: e.vendorId ?? null, actor: e.actor, action: e.action, detail: e.detail ?? null, ip: e.ip });
  for (const fn of listeners) fn(e);
}
