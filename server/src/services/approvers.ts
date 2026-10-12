/**
 * Who may act on an approval step:
 *   - if the step is assigned to a person → that person
 *   - otherwise → every active user holding the step's role
 *   - plus anyone those people have delegated to (active out-of-office window)
 */
import { and, eq, gt, inArray, lte } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import type { ApprovalStep } from '../db/schema.js';

const { users, userRoles, delegations } = schema;

export async function directApprovers(step: Pick<ApprovalStep, 'tenantId' | 'roleId' | 'assigneeUserId'>): Promise<string[]> {
  if (step.assigneeUserId) {
    const u = await db.query.users.findFirst({ where: and(eq(users.id, step.assigneeUserId), eq(users.tenantId, step.tenantId), eq(users.status, 'ACTIVE')) });
    return u ? [u.id] : [];
  }
  const rows = await db.select({ id: users.id }).from(userRoles).innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.roleId, step.roleId), eq(users.tenantId, step.tenantId), eq(users.status, 'ACTIVE')));
  return rows.map((r) => r.id);
}

export async function activeDelegatesOf(tenantId: string, fromUserIds: string[], at = new Date()) {
  if (!fromUserIds.length) return [];
  return db.select({ fromUserId: delegations.fromUserId, toUserId: delegations.toUserId }).from(delegations)
    .innerJoin(users, eq(users.id, delegations.toUserId))
    .where(and(eq(delegations.tenantId, tenantId), inArray(delegations.fromUserId, fromUserIds), lte(delegations.startsAt, at), gt(delegations.endsAt, at), eq(users.status, 'ACTIVE')));
}

/** All user ids who can act on the step right now. */
export async function approverIds(step: Pick<ApprovalStep, 'tenantId' | 'roleId' | 'assigneeUserId'>): Promise<Set<string>> {
  const direct = await directApprovers(step);
  const delegated = await activeDelegatesOf(step.tenantId, direct);
  return new Set([...direct, ...delegated.map((d) => d.toUserId)]);
}

/** Users whose work this user is currently covering. */
export async function coveringFor(tenantId: string, userId: string, at = new Date()) {
  const rows = await db.select({ fromUserId: delegations.fromUserId }).from(delegations)
    .where(and(eq(delegations.tenantId, tenantId), eq(delegations.toUserId, userId), lte(delegations.startsAt, at), gt(delegations.endsAt, at)));
  return rows.map((r) => r.fromUserId);
}

export async function canAct(step: Pick<ApprovalStep, 'tenantId' | 'roleId' | 'assigneeUserId'>, userId: string) {
  return (await approverIds(step)).has(userId);
}

export async function emailsFor(ids: Iterable<string>) {
  const list = [...ids];
  if (!list.length) return [];
  return db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, list));
}

/** Active users holding a permission through any of their roles. */
export async function usersWithPermission(tenantId: string, perm: string) {
  const rows = await db.select({ name: schema.users.name, email: schema.users.email, permissions: schema.roles.permissions }).from(schema.userRoles)
    .innerJoin(schema.users, eq(schema.users.id, schema.userRoles.userId)).innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
    .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.status, 'ACTIVE')));
  const seen = new Map<string, { name: string; email: string }>();
  for (const r of rows) if (r.permissions.includes(perm)) seen.set(r.email, { name: r.name, email: r.email });
  return [...seen.values()];
}
