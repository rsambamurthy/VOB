/** Runs an online check with caching, daily limits, masking and name matching; stores the result. */
import crypto from 'node:crypto';
import { and, count, desc, eq, gt, inArray } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import { env } from '../../lib/env.js';
import { HttpError } from '../../lib/http.js';
import { hasFeature } from '../../services/limits.js';
import type { Vendor } from '../../db/schema.js';
import { nameMatch } from './nameMatch.js';
import { checkDef, checkProvider, checkProviders, setCheckProvider } from '../../countries/registry.js';
import type { CheckProvider } from '../../countries/types.js';

const i = env.int;
/** Kept for tests: replace India's provider. */
export function setKycProvider(p: CheckProvider) { setCheckProvider('IN', p); }
export const kycStatus = () => { const all = checkProviders(); return { provider: all[0]?.provider ?? 'none', live: all.some((p) => p.live), packs: all }; };
export type KycKind = string;

export async function runKyc(vendor: Vendor, kind: KycKind, raw: Record<string, string>, requestedBy: string) {
  const tenant = await db.query.tenants.findFirst({ where: eq(schema.tenants.id, vendor.tenantId) });
  if (tenant && !hasFeature(tenant, 'kyc')) throw new HttpError(403, 'Online verification isn’t available for this workspace', undefined, 'PLAN_LIMIT');
  const found = checkDef(kind);
  if (!found) throw new HttpError(400, `Unknown check “${kind}”`);
  const { def, pack } = found;
  const provider = checkProvider(pack)!;
  const { input, masked, error } = def.normalise(raw);
  const inputHash = crypto.createHash('sha256').update(`${kind}:${JSON.stringify(input)}`).digest('hex');
  const profile = vendor.profile as Record<string, Record<string, unknown>>;
  const [ns, nf] = (def.nameField ?? '').split('.');
  const legalName = String((def.nameField ? profile[ns]?.[nf] : null) || profile.basic?.vendorName || vendor.name);
  const { verifications } = schema;
  const base = { tenantId: vendor.tenantId, vendorId: vendor.id, kind, inputHash, inputMasked: masked, provider: provider.name, test: !provider.live, requestedBy };

  if (error) {
    const [row] = await db.insert(verifications).values({ ...base, status: 'INVALID_FORMAT', message: error }).returning();
    return row;
  }
  // Re-use a recent identical result (saves provider fees, avoids repeat penny-drops).
  const since = new Date(Date.now() - i.KYC_CACHE_HOURS * 3600_000);
  const cached = await db.query.verifications.findFirst({ where: and(eq(verifications.vendorId, vendor.id), eq(verifications.inputHash, inputHash), gt(verifications.createdAt, since), inArray(verifications.status, ['VERIFIED', 'NOT_FOUND'])), orderBy: desc(verifications.createdAt) });
  if (cached) return { ...cached, cached: true };

  // Only provider calls count towards the limit (format errors never reach the provider).
  const [{ n }] = await db.select({ n: count() }).from(verifications).where(and(eq(verifications.vendorId, vendor.id), eq(verifications.kind, kind), gt(verifications.createdAt, new Date(Date.now() - 86_400_000)), inArray(verifications.status, ['VERIFIED', 'NOT_FOUND', 'ERROR'])));
  if (n >= i.KYC_DAILY_LIMIT) throw new HttpError(429, `Daily limit of ${i.KYC_DAILY_LIMIT} ${def.label} checks reached for this vendor. Try again tomorrow.`);

  const r = await provider.check(kind, input, { legalName });
  const score = nameMatch(r.nameOnRecord, legalName);
  const [row] = await db.insert(verifications).values({ ...base, status: r.status, message: r.message, nameOnRecord: r.nameOnRecord ?? null, nameMatch: score, data: r.data ?? null }).returning();
  return row;
}

/** Latest result per check type, for the vendor and staff screens. */
export async function latestChecks(vendorId: string) {
  const rows = await db.select().from(schema.verifications).where(eq(schema.verifications.vendorId, vendorId)).orderBy(desc(schema.verifications.createdAt)).limit(50);
  const latest = new Map<string, typeof rows[number]>();
  for (const r of rows) if (!latest.has(r.kind)) latest.set(r.kind, r);
  return [...latest.values()];
}
