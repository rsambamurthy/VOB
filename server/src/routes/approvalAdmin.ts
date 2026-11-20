/**
 * Administration screens for approval flows other than suppliers (sourcing events and awards, contracts): one shape
 * for the levels editor (levels, what rules can test, the workspace's roles) and one way to check and store levels.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import type { Tenant, TenantSettings } from '../db/schema.js';
import type { WorkflowLevel } from '../config/types.js';
import { checkLevels } from '../lib/moduleConfig.js';

const roleRows = (tenantId: string) => db.select({ key: schema.roles.key, name: schema.roles.name }).from(schema.roles).where(eq(schema.roles.tenantId, tenantId));

/** What the LevelsEditor needs. */
export async function approvalSetupFor(tenantId: string, levels: WorkflowLevel[], catalog: { id: string; label: string; type: string; options?: string[] }[], kind?: string) {
  return { ...(kind ? { kind } : {}), levels, catalog, roles: await roleRows(tenantId) };
}

/**
 * Check levels against the catalogue and the workspace's roles, store them under settings[settingsKey][field] and
 * audit the change. Returns the tenant with the new settings.
 */
export async function saveFlowLevels(t: Tenant, input: unknown, opts: { catalog: { id: string }[]; settingsKey: 'sourcing' | 'contracts'; field: string; auditAction: string; flow?: string; actor: string; ip?: string }) {
  const roleKeys = (await roleRows(t.id)).map((r) => r.key);
  const { levels, issues } = checkLevels(input, opts.catalog.map((c) => c.id), roleKeys);
  if (issues.length) throw new HttpError(400, issues[0].message, issues);
  const settings = { ...t.settings, [opts.settingsKey]: { ...((t.settings as Record<string, unknown>)[opts.settingsKey] as object ?? {}), [opts.field]: { levels } } } as TenantSettings;
  await db.update(schema.tenants).set({ settings }).where(eq(schema.tenants.id, t.id));
  await audit({ tenantId: t.id, actor: opts.actor, action: opts.auditAction, detail: { ...(opts.flow ? { flow: opts.flow } : {}), levels: levels.map((l) => l.label) }, ip: opts.ip });
  return { tenant: { ...t, settings }, levels };
}
