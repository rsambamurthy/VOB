/** Runs an online check with caching, daily limits, masking and name matching; stores the result. */
import crypto from 'node:crypto';
import { and, count, desc, eq, gt, inArray } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import { env } from '../../lib/env.js';
import { HttpError } from '../../lib/http.js';
import { validators } from '../../lib/validators.js';
import { hasFeature } from '../../services/limits.js';
import type { Vendor } from '../../db/schema.js';
import { mockKyc } from './mock.js';
import { surepassKyc } from './surepass.js';
import { nameMatch } from './nameMatch.js';
import type { KycInput, KycKind, KycProvider } from './types.js';

const i = env.int;
let provider: KycProvider = i.KYC_PROVIDER === 'surepass'
  ? surepassKyc({ baseUrl: i.SUREPASS_BASE_URL, token: i.SUREPASS_TOKEN!, paths: { gstin: i.SUREPASS_PATH_GSTIN, pan: i.SUREPASS_PATH_PAN, bank: i.SUREPASS_PATH_BANK, cin: i.SUREPASS_PATH_CIN } })
  : mockKyc;

export function setKycProvider(p: KycProvider) { provider = p; }
export const kycStatus = () => ({ provider: provider.name, live: provider.live });
export type { KycKind };

const mask = (s: string, keepStart = 2, keepEnd = 2) => (s.length <= keepStart + keepEnd ? s : `${s.slice(0, keepStart)}${'•'.repeat(Math.min(8, s.length - keepStart - keepEnd))}${s.slice(-keepEnd)}`);

function normalise(kind: KycKind, raw: Record<string, string>): { input: KycInput; masked: string; error?: string } {
  const up = (v?: string) => (v ?? '').toUpperCase().replace(/\s+/g, '');
  if (kind === 'gstin') { const gstin = up(raw.gstin); return { input: { gstin }, masked: mask(gstin, 4, 3), error: validators.gstin(gstin) ?? undefined }; }
  if (kind === 'pan') { const pan = up(raw.pan); return { input: { pan }, masked: mask(pan, 3, 1), error: validators.pan(pan) ?? undefined }; }
  if (kind === 'cin') { const cin = up(raw.cin); return { input: { cin }, masked: mask(cin, 6, 3), error: validators.cin(cin) ?? undefined }; }
  const accountNumber = (raw.accountNumber ?? '').replace(/\s+/g, ''); const ifsc = up(raw.ifsc);
  const err = !/^\d{9,18}$/.test(accountNumber) ? 'Enter a valid account number first' : validators.ifsc(ifsc) ?? undefined;
  return { input: { accountNumber, ifsc }, masked: `${mask(accountNumber, 0, 4)} · ${ifsc}`, error: err };
}

export async function runKyc(vendor: Vendor, kind: KycKind, raw: Record<string, string>, requestedBy: string) {
  const tenant = await db.query.tenants.findFirst({ where: eq(schema.tenants.id, vendor.tenantId) });
  if (tenant && !hasFeature(tenant, 'kyc')) throw new HttpError(403, 'Online verification isn’t available for this workspace', undefined, 'PLAN_LIMIT');
  const { input, masked, error } = normalise(kind, raw);
  const inputHash = crypto.createHash('sha256').update(`${kind}:${JSON.stringify(input)}`).digest('hex');
  const profile = vendor.profile as Record<string, Record<string, unknown>>;
  const legalName = String((kind === 'bank' ? profile.bank?.accountHolderName : null) || profile.basic?.vendorName || vendor.name);
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
  if (n >= i.KYC_DAILY_LIMIT) throw new HttpError(429, `Daily limit of ${i.KYC_DAILY_LIMIT} ${kind.toUpperCase()} checks reached for this vendor. Try again tomorrow.`);

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
