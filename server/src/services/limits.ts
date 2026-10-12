/** Enforces plan limits. Errors carry code PLAN_LIMIT so the UI can explain them. */
import { and, count, eq, gte, ne } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { HttpError } from '../lib/http.js';
import { effectiveLimits, FEATURE_LABELS, trialExpired, type Feature } from '../lib/plans.js';
import type { Tenant } from '../db/schema.js';

const limitError = (msg: string) => new HttpError(403, msg, undefined, 'PLAN_LIMIT');
const fmt = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

function assertTrialActive(t: Tenant) {
  if (trialExpired(t)) throw limitError(`Your free trial ended on ${fmt(t.trialEndsAt!)}. Contact us to choose a plan — your data is kept.`);
}

export async function usage(tenantId: string) {
  const [[u], [v], [e]] = await Promise.all([
    db.select({ n: count() }).from(schema.users).where(and(eq(schema.users.tenantId, tenantId), ne(schema.users.status, 'DISABLED'))),
    db.select({ n: count() }).from(schema.vendors).where(eq(schema.vendors.tenantId, tenantId)),
    db.select({ n: count() }).from(schema.emailOutbox).where(and(eq(schema.emailOutbox.tenantId, tenantId), gte(schema.emailOutbox.createdAt, startOfDay()))),
  ]);
  return { users: Number(u.n), vendors: Number(v.n), emailsToday: Number(e.n) };
}

/** Start of today in India time (limits reset at midnight IST). */
export function startOfDay(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - 5.5 * 3600_000);
}

export async function assertCanAddUser(t: Tenant) {
  assertTrialActive(t);
  const max = effectiveLimits(t).maxUsers;
  if (max !== null && (await usage(t.id)).users >= max) throw limitError(`Your plan allows ${max} users. Disable someone who no longer needs access, or contact us to raise the limit.`);
}

export async function assertCanAddVendor(t: Tenant) {
  assertTrialActive(t);
  const max = effectiveLimits(t).maxVendors;
  if (max !== null && (await usage(t.id)).vendors >= max) throw limitError(`Your plan allows ${max} vendors. Contact us to raise the limit.`);
}

export function hasFeature(t: Tenant, f: Feature) { return effectiveLimits(t).features[f] !== false; }
export function assertFeature(t: Tenant, f: Feature) {
  if (!hasFeature(t, f)) throw limitError(`${FEATURE_LABELS[f]} isn’t included in your plan. Contact us to add it.`);
}

/** null = within the limit; otherwise the reason the email can't be sent today. */
export async function emailLimitReason(tenantId: string) {
  const t = await db.query.tenants.findFirst({ where: eq(schema.tenants.id, tenantId) });
  if (!t) return null;
  const max = effectiveLimits(t).emailsPerDay;
  if (max === null) return null;
  const [r] = await db.select({ n: count() }).from(schema.emailOutbox).where(and(eq(schema.emailOutbox.tenantId, tenantId), gte(schema.emailOutbox.createdAt, startOfDay()), ne(schema.emailOutbox.status, 'FAILED')));
  return Number(r.n) >= max ? `Daily email limit of ${max} reached for this workspace` : null;
}
