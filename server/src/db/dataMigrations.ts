/**
 * Encrypts sensitive values that were stored before field encryption existed, and (with force)
 * re-encrypts everything under the current ENCRYPTION_KEY after a key rotation. Safe to run repeatedly.
 */
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { isSealed, openChanges, openJson, openProfile, SENSITIVE_PATHS, isSensitive } from '../lib/fieldCrypto.js';
import { logger } from '../lib/logger.js';

type Row = Record<string, unknown>;
const rows = async (q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as { rows: Row[] }).rows;

/** New permissions added in later releases reach every workspace's Administrator role. */
export async function grantNewAdminPermissions() {
  const { ALL_PERMISSIONS } = await import('../lib/permissions.js');
  for (const r of await rows(sql`select id, permissions from roles where key = 'ADMIN'`)) {
    const have = new Set((r.permissions ?? []) as string[]);
    const missing = ALL_PERMISSIONS.filter((p) => !have.has(p));
    if (missing.length) await db.update(schema.roles).set({ permissions: [...have, ...missing] }).where(eq(schema.roles.id, r.id as string));
  }
  // Roles added to the defaults later are created in workspaces that don't have them yet — only for products the workspace has.
  const { ensureDefaultRoles } = await import('../services/tenants.js');
  for (const t of await db.select().from(schema.tenants)) await ensureDefaultRoles(t, { keys: ['BUYER', 'CONTRACT_MANAGER', 'LEGAL', 'CONTRACT_VIEWER', 'CONTRACT_APPROVER', 'AP_CLERK', 'INVOICE_APPROVER', 'INVOICE_VIEWER'] });
  // Invoices add-on: portal invoices from before it was switched on join their supplier's party.
  const { invoicesOn } = await import('../services/invoices/config.js');
  const { linkInvoicesToParties } = await import('../services/invoices/record.js');
  for (const t of await db.select().from(schema.tenants)) if (invoicesOn(t)) await linkInvoicesToParties(t).catch(() => {});
}

export async function sealExistingData(force = false) {
  let n = 0;
  for (const r of await rows(sql`select id, profile from vendors`)) {
    const p = r.profile as Record<string, Record<string, unknown>>;
    const plain = SENSITIVE_PATHS.some((path) => { const [s, k] = path.split('.'); const v = p?.[s]?.[k]; return typeof v === 'string' && v !== '' && !isSealed(v); });
    if (plain || force) { await db.update(schema.vendors).set({ profile: openProfile(p) }).where(eq(schema.vendors.id, r.id as string)); n++; }
  }
  for (const r of await rows(sql`select id, changes from change_requests`)) {
    const cs = (r.changes ?? []) as { fieldId: string; label: string; old: string; new: string }[];
    const plain = cs.some((c) => isSensitive(c.fieldId) && ((c.old && !isSealed(c.old)) || (c.new && !isSealed(c.new))));
    if (plain || (force && cs.some((c) => isSensitive(c.fieldId)))) { await db.update(schema.changeRequests).set({ changes: openChanges(cs) }).where(eq(schema.changeRequests.id, r.id as string)); n++; }
  }
  for (const r of await rows(sql`select id, fields from document_extractions`)) {
    if (Array.isArray(r.fields) ? r.fields.length : force) { await db.update(schema.documentExtractions).set({ fields: openJson(r.fields) }).where(eq(schema.documentExtractions.id, r.id as string)); n++; }
  }
  for (const r of await rows(sql`select id, request from erp_syncs where request is not null`)) {
    const legacy = !(r.request && typeof r.request === 'object' && '$enc' in (r.request as object));
    if (legacy || force) { await db.update(schema.erpSyncs).set({ request: openJson(r.request) }).where(eq(schema.erpSyncs.id, r.id as string)); n++; }
  }
  if (n) logger.info({ rows: n, force }, 'sensitive data encrypted');
  // Duplicate-check keys: fill any missing; after a key rotation (force) recompute all, since they are keyed on ENCRYPTION_KEY.
  const { refreshIdentityKeys } = await import('../services/duplicates.js');
  const k = await refreshIdentityKeys(force);
  if (k) logger.info({ vendors: k }, 'duplicate-check keys computed');
  return n;
}
