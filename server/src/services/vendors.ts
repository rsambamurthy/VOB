/**
 * Creating suppliers — one at a time from the Invite screen, in bulk from Excel (invite to onboard), or
 * imported as already approved (existing supplier master). All three follow the same rules: unique name,
 * the workspace's mobile format, plan limits, VND-nnnnn codes.
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { and, eq, ne, sql } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { env } from '../lib/env.js';
import { HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { validators } from '../lib/validators.js';
import { packFor } from '../countries/registry.js';
import { mailSupplier } from '../i18n/emails.js';
import { supplierLanguages, vendorLanguage } from '../i18n/index.js';
import type { Profile } from '../lib/profileEngine.js';
import type { Tenant } from '../db/schema.js';
import { withIdentity } from './duplicates.js';

const { vendors } = schema;

export const createSchema = z.object({
  name: z.string().trim().min(2, 'Vendor name is required').max(200),
  vendorType: z.enum(['DOMESTIC', 'IMPORT', 'GOVERNMENT']),
  contactFirstName: z.string().trim().min(1, 'First name is required').max(100),
  contactLastName: z.string().trim().min(1, 'Last name is required').max(100),
  contactEmail: z.string().trim().email('Enter a valid email'),
  contactMobile: z.string().trim().min(1, 'Enter a mobile number'),
  notify: z.boolean().default(true),
  /** Portal and email language for this supplier (where the country offers a choice). */
  language: z.enum(['en', 'ar']).optional(),
});
export type CreateInput = z.infer<typeof createSchema>;

/** Problems with one supplier's basic details (before anything is written). */
export function basicProblems(tenant: Tenant, input: CreateInput): string[] {
  const out: string[] = [];
  const mobileErr = validators.phone(input.contactMobile, { country: input.vendorType === 'IMPORT' ? '' : packFor(tenant.country).name });
  if (mobileErr) out.push(mobileErr);
  return out;
}

export async function nameTaken(tenantId: string, name: string) {
  return db.query.vendors.findFirst({ where: and(eq(vendors.tenantId, tenantId), sql`lower(${vendors.name}) = lower(${name})`, ne(vendors.status, 'REJECTED')) });
}

export async function nextVendorCode(tenantId: string) {
  // Only VND-<digits> codes count; codes set another way (e.g. VND-ORD-1) must not break numbering.
  const [{ max }] = await db.select({ max: sql<number>`coalesce(max(substring(${vendors.code} from 5)::bigint) filter (where ${vendors.code} ~ '^VND-[0-9]{1,15}$'), 0)` }).from(vendors).where(eq(vendors.tenantId, tenantId));
  return `VND-${String(Number(max) + 1).padStart(5, '0')}`;
}

export const portalLink = (v: { inviteToken: string }) => `${env.appBaseUrl}/onboard/${v.inviteToken}`;

export async function sendInvite(tenant: Tenant, v: { tenantId: string; name: string; contactEmail: string; contactFirstName: string; inviteToken: string; language: string | null }) {
  const link = portalLink(v);
  await mailSupplier(vendorLanguage(tenant, v), { tenantId: v.tenantId, to: v.contactEmail, link }, 'invite', { first: v.contactFirstName, buyer: tenant.name, vendor: v.name });
  return link;
}

/**
 * Creates the supplier. `approved` imports an existing supplier as already approved (no onboarding, no
 * approval steps), with the profile answers given; otherwise it starts onboarding (status INVITED).
 */
export async function createVendor(tenant: Tenant, input: CreateInput, actor: { id: string; name: string }, opts: { ip?: string; approved?: { profile: Profile; erpCode?: string } } = {}) {
  const problems = basicProblems(tenant, input);
  if (problems.length) throw new HttpError(400, problems[0], [{ path: ['contactMobile'], message: problems[0] }]);
  const dup = await nameTaken(tenant.id, input.name);
  if (dup) throw new HttpError(409, `A vendor named "${dup.name}" already exists (${dup.code})`);
  const { notify, language, ...data } = input;
  const email = data.contactEmail.toLowerCase();
  const home = packFor(tenant.country).name;
  const base: Profile = {
    basic: { vendorName: data.name, supplierCountry: data.vendorType === 'IMPORT' ? '' : home, contactName: `${data.contactFirstName} ${data.contactLastName}`, contactEmail: email, contactMobile: data.contactMobile },
    bank: { bankCountry: data.vendorType === 'IMPORT' ? '' : home },
  };
  const profile = opts.approved ? mergeProfile(base, opts.approved.profile) : base;
  const now = new Date();
  const [vendor] = await db.insert(vendors).values({
    ...data, tenantId: tenant.id, contactEmail: email, language: language && supplierLanguages(tenant).includes(language) ? language : null,
    code: await nextVendorCode(tenant.id), inviteToken: crypto.randomBytes(24).toString('base64url'), createdById: actor.id, ...withIdentity(profile),
    ...(opts.approved ? { status: 'APPROVED' as const, decidedAt: now, submittedAt: now, erpVendorId: opts.approved.erpCode || null } : {}),
  }).returning();
  if (opts.approved?.erpCode) await db.insert(schema.supplierCodes).values({ tenantId: tenant.id, vendorId: vendor.id, code: opts.approved.erpCode }).onConflictDoNothing();
  await audit({ tenantId: tenant.id, vendorId: vendor.id, actor: actor.name, action: opts.approved ? 'VENDOR_IMPORTED' : 'VENDOR_CREATED', detail: { vendorType: data.vendorType, ...(opts.approved?.erpCode ? { erpCode: opts.approved.erpCode } : {}) }, ip: opts.ip });
  if (notify && !opts.approved) {
    await sendInvite(tenant, vendor);
    await audit({ tenantId: tenant.id, vendorId: vendor.id, actor: actor.name, action: 'INVITE_SENT', detail: { to: vendor.contactEmail }, ip: opts.ip });
  }
  if (notify && opts.approved) {
    // Imported suppliers are asked to sign in, check what was brought across and add anything missing.
    await db.update(vendors).set({ lastReviewAt: now }).where(eq(vendors.id, vendor.id));
    await mailSupplier(vendorLanguage(tenant, vendor), { tenantId: tenant.id, to: vendor.contactEmail, link: portalLink(vendor) }, 'importedConfirm', { first: vendor.contactFirstName, buyer: tenant.name, vendor: vendor.name });
    await audit({ tenantId: tenant.id, vendorId: vendor.id, actor: actor.name, action: 'CONFIRMATION_REQUESTED', detail: { to: vendor.contactEmail }, ip: opts.ip });
  }
  return vendor;
}

/** Profile answers from an import over the defaults; empty values don't overwrite. */
function mergeProfile(base: Profile, extra: Profile): Profile {
  const out: Profile = structuredClone(base);
  for (const [sec, vals] of Object.entries(extra)) for (const [k, v] of Object.entries(vals ?? {})) if (v !== '' && v !== null && v !== undefined) out[sec] = { ...(out[sec] ?? {}), [k]: v };
  return out;
}
