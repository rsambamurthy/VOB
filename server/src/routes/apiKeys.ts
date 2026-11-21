/**
 * API keys for the workspace's ERP or middleware (/api/v1): purchase orders, receipts, payments, invoice results and code lists.
 * One router, mounted under Purchasing setup (/api/purchasing/api-keys) and Administration (/api/admin/api-keys) — the latter
 * for workspaces with the Invoices add-on but no purchase orders.
 */
import { Router } from 'express';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { requireStaff, staffCtx } from '../auth/session.js';

const { apiKeys } = schema;
export const apiKeysRouter = Router();

apiKeysRouter.get('/', requireStaff('tenant.settings'), ah(async (req, res) => {
  const rows = await db.select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt, createdAt: apiKeys.createdAt })
    .from(apiKeys).where(eq(apiKeys.tenantId, staffCtx(req).tenant.id)).orderBy(desc(apiKeys.createdAt));
  res.json(rows);
}));
apiKeysRouter.post('/', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { name } = z.object({ name: z.string().trim().min(2).max(80) }).parse(req.body);
  const key = `vg_${randomToken(30)}`;
  await db.insert(apiKeys).values({ tenantId: s.tenant.id, name, prefix: key.slice(0, 10), keyHash: sha256(key), createdById: s.user.id });
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'API_KEY_CREATED', detail: { name, prefix: key.slice(0, 10) }, ip: req.ip });
  res.status(201).json({ key, name }); // shown once
}));
apiKeysRouter.delete('/:id', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const [row] = await db.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.tenantId, s.tenant.id), eq(apiKeys.id, req.params.id), isNull(apiKeys.revokedAt))).returning();
  if (!row) throw new HttpError(404, 'Key not found or already revoked');
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'API_KEY_REVOKED', detail: { name: row.name, prefix: row.prefix }, ip: req.ip });
  res.json({ ok: true });
}));
