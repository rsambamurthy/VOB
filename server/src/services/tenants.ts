import { eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { DEFAULT_ROLES } from '../lib/permissions.js';
import { HttpError } from '../lib/http.js';
import { createStaffUser } from './users.js';
import type { TenantBranding } from '../db/schema.js';

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/** Creates a workspace with the default roles and invites its first administrator. */
export async function createTenant(input: { slug: string; name: string; adminName: string; adminEmail: string; branding?: TenantBranding }) {
  const slug = input.slug.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'Workspace ID must be 3–40 lowercase letters, digits or hyphens');
  if (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, slug) })) throw new HttpError(409, 'That workspace ID is taken');
  const [tenant] = await db.insert(schema.tenants).values({ slug, name: input.name.trim(), branding: input.branding ?? {}, settings: {} }).returning();
  const createdRoles = await db.insert(schema.roles).values(DEFAULT_ROLES.map((r) => ({ tenantId: tenant.id, key: r.key, name: r.name, description: r.description, permissions: r.permissions, isSystem: r.key === 'ADMIN' }))).returning();
  const admin = createdRoles.find((r) => r.key === 'ADMIN')!;
  const { user, inviteLink } = await createStaffUser(tenant, { name: input.adminName, email: input.adminEmail, roleIds: [admin.id] }, 'The VendorGate team');
  return { tenant, admin: user, inviteLink, roles: createdRoles };
}
