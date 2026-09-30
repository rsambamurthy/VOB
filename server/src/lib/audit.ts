import { db, schema } from './db.js';

export async function audit(vendorId: string | null, actor: string, action: string, detail?: unknown) {
  await db.insert(schema.auditLogs).values({ vendorId, actor, action, detail: detail ?? null });
}
