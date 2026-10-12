import { eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { DEFAULT_ROLES } from '../lib/permissions.js';
import { HttpError } from '../lib/http.js';
import { hashPassword } from '../lib/password.js';
import { createStaffUser } from './users.js';
import { DEFAULT_HOME, isHomeCountry, packFor } from '../countries/registry.js';
import { seedInitialConfig, templateFor } from './config.js';
import type { TenantBranding, TenantLimits } from '../db/schema.js';

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
/** Workspace IDs nobody can take (they look official or clash with app paths). */
export const RESERVED_SLUGS = new Set(['admin', 'administrator', 'api', 'app', 'platform', 'www', 'mail', 'email', 'support', 'help', 'status', 'billing',
  'login', 'signup', 'sign-up', 'register', 'staff', 'vendor', 'vendors', 'onboard', 'root', 'system', 'test', 'demo', 'vendorgate', 'integrata', 'integratatech', 'security', 'privacy']);

/** null = the workspace ID can be used; otherwise why not. */
export async function slugProblem(raw: string) {
  const slug = raw.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) return 'Use 3–40 lowercase letters, digits or hyphens (not at the start or end)';
  if (RESERVED_SLUGS.has(slug)) return 'That workspace ID is reserved';
  if (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, slug) })) return 'That workspace ID is taken';
  return null;
}

/** Suggests a free workspace ID from a company name ("Acme Industries Pvt Ltd" → "acme-industries"). */
export async function suggestSlug(company: string) {
  const base = company.toLowerCase().replace(/\b(pvt|private|ltd|limited|llp|inc|co|company|corp|corporation|the)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '') || 'workspace';
  const padded = base.length < 3 ? `${base}-co` : base;
  for (let i = 0; i < 50; i++) {
    const s = i ? `${padded}-${i + 1}` : padded;
    if (!(await slugProblem(s))) return s;
  }
  return `${padded}-${Date.now().toString(36)}`;
}

export interface CreateTenantInput {
  slug: string; name: string; adminName: string; adminEmail: string; branding?: TenantBranding;
  /** Home country (ISO code) — picks the country pack. Default India. */
  country?: string;
  plan?: string; limits?: TenantLimits; trialEndsAt?: Date | null; source?: 'platform' | 'signup' | 'cli' | 'bootstrap'; notes?: string;
  /** Self-service sign-up: the admin already chose a password (and verified the email), so no invitation is sent. */
  adminPassword?: string;
  invitedBy?: string;
}

/** Creates a workspace with the default roles and its first administrator (invited, or active when a password is given). */
export async function createTenant(input: CreateTenantInput) {
  const slug = input.slug.trim().toLowerCase();
  const country = (input.country ?? DEFAULT_HOME).toUpperCase();
  if (!isHomeCountry(country)) throw new HttpError(400, `Workspaces can’t be set up in ${country} yet`);
  const problem = await slugProblem(slug);
  if (problem) throw new HttpError(problem.includes('taken') ? 409 : 400, problem === 'That workspace ID is taken' ? problem : `Workspace ID: ${problem}`);
  const [tenant] = await db.insert(schema.tenants).values({
    slug, name: input.name.trim(), branding: input.branding ?? {}, country,
    // Gulf workspaces count deadlines in working days (Fri–Sat off) from the start; Indian ones count every day.
    settings: packFor(country).skipWeekendsByDefault ? { skipWeekends: true } : {},
    plan: input.plan ?? 'standard', limits: input.limits ?? {}, trialEndsAt: input.trialEndsAt ?? null, source: input.source ?? 'platform', notes: input.notes,
  }).returning();
  const createdRoles = await db.insert(schema.roles).values(DEFAULT_ROLES.map((r) => ({ tenantId: tenant.id, key: r.key, name: r.name, description: r.description, permissions: r.permissions, isSystem: r.key === 'ADMIN' }))).returning();
  const admin = createdRoles.find((r) => r.key === 'ADMIN')!;
  await seedInitialConfig(tenant.id, templateFor(country));
  if (input.adminPassword) {
    const [user] = await db.insert(schema.users).values({ tenantId: tenant.id, name: input.adminName.trim(), email: input.adminEmail.trim().toLowerCase(), status: 'ACTIVE', passwordHash: await hashPassword(input.adminPassword), passwordChangedAt: new Date(), lastLoginAt: new Date() }).returning();
    await db.insert(schema.userRoles).values({ userId: user.id, roleId: admin.id });
    return { tenant, admin: user, inviteLink: null as string | null, roles: createdRoles };
  }
  const { user, inviteLink } = await createStaffUser(tenant, { name: input.adminName, email: input.adminEmail, roleIds: [admin.id] }, input.invitedBy ?? 'The VendorGate team');
  return { tenant, admin: user, inviteLink: inviteLink as string | null, roles: createdRoles };
}
