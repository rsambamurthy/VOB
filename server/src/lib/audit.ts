import { db, schema } from './db.js';

export async function audit(e: { tenantId: string; vendorId?: string | null; actor: string; action: string; detail?: unknown; ip?: string }) {
  await db.insert(schema.auditLogs).values({ tenantId: e.tenantId, vendorId: e.vendorId ?? null, actor: e.actor, action: e.action, detail: e.detail ?? null, ip: e.ip });
}
