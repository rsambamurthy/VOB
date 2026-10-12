import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { env } from '../lib/env.js';
import { sendMail } from '../lib/mailer.js';
import { HttpError } from '../lib/http.js';
import type { Tenant } from '../db/schema.js';

const { users, userRoles, roles, authTokens } = schema;

const TTL = { INVITE: 7 * 24 * 3600_000, PASSWORD_RESET: 60 * 60_000 } as const;

export async function issueToken(tenantId: string, userId: string, purpose: 'INVITE' | 'PASSWORD_RESET') {
  // Invalidate previous unused tokens of the same purpose.
  await db.delete(authTokens).where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, purpose)));
  const token = randomToken();
  await db.insert(authTokens).values({ tenantId, userId, purpose, tokenHash: sha256(token), expiresAt: new Date(Date.now() + TTL[purpose]) });
  return token;
}

/** Looks up a one-time token; returns the user + token row if valid and unused. */
export async function consumeToken(token: string, purpose: 'INVITE' | 'PASSWORD_RESET', { markUsed = true } = {}) {
  const row = await db.query.authTokens.findFirst({ where: and(eq(authTokens.tokenHash, sha256(token)), eq(authTokens.purpose, purpose)) });
  if (!row || row.usedAt || row.expiresAt < new Date()) throw new HttpError(400, purpose === 'INVITE' ? 'This invitation link is invalid or has expired. Ask your administrator to resend it.' : 'This reset link is invalid or has expired. Request a new one.');
  const user = await db.query.users.findFirst({ where: and(eq(users.id, row.userId), eq(users.tenantId, row.tenantId)) });
  const tenant = await db.query.tenants.findFirst({ where: eq(schema.tenants.id, row.tenantId) });
  if (!user || !tenant) throw new HttpError(400, 'Link is no longer valid');
  if (markUsed) await db.update(authTokens).set({ usedAt: new Date() }).where(eq(authTokens.id, row.id));
  return { user, tenant };
}

export async function sendStaffInvite(tenant: Tenant, user: { id: string; name: string; email: string }, invitedBy: string) {
  const token = await issueToken(tenant.id, user.id, 'INVITE');
  const link = `${env.appBaseUrl}/accept-invite/${token}`;
  await sendMail({
    tenantId: tenant.id, to: user.email, subject: `You're invited to ${tenant.name} on ${tenant.branding.productName ?? 'VendorGate'}`,
    body: `Hello ${user.name},\n\n${invitedBy} has invited you to the ${tenant.name} workspace (workspace ID: ${tenant.slug}).\nOpen the link below to set your password. The link is valid for 7 days.`,
    link,
  });
  return link;
}

export async function createStaffUser(tenant: Tenant, input: { name: string; email: string; roleIds: string[] }, invitedBy: string) {
  const email = input.email.trim().toLowerCase();
  const exists = await db.query.users.findFirst({ where: and(eq(users.tenantId, tenant.id), eq(users.email, email)) });
  if (exists) throw new HttpError(409, 'A user with this email already exists in this workspace');
  if (input.roleIds.length) {
    const valid = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.tenantId, tenant.id), inArray(roles.id, input.roleIds)));
    if (valid.length !== input.roleIds.length) throw new HttpError(400, 'One or more roles are invalid');
  }
  const [user] = await db.insert(users).values({ tenantId: tenant.id, name: input.name.trim(), email, status: 'INVITED' }).returning();
  if (input.roleIds.length) await db.insert(userRoles).values(input.roleIds.map((roleId) => ({ userId: user.id, roleId })));
  const inviteLink = await sendStaffInvite(tenant, user, invitedBy);
  return { user, inviteLink };
}
