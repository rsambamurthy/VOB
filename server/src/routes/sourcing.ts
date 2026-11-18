/**
 * Sourcing (RFQs and e-auctions).
 *   /api/admin/sourcing   Administration → Sourcing: switch, formats, sub-features, rule defaults and locks
 *   /api/staff/sourcing   the module itself — 404 unless Sourcing is on (services/sourcing/config.ts)
 */
import { Router } from 'express';
import { and, count, desc, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { effectiveLimits } from '../lib/plans.js';
import { assertSourcingOn, checkSourcingSettings, sourcingConfig } from '../services/sourcing/config.js';

export const sourcingAdminRouter = Router();

sourcingAdminRouter.get('/', requireStaff('tenant.settings'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  res.json({ ...sourcingConfig(tenant), plan: effectiveLimits(tenant).label });
}));

sourcingAdminRouter.put('/', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { settings, changes } = checkSourcingSettings(s.tenant, req.body ?? {});
  const tenant = { ...s.tenant, settings: { ...s.tenant.settings, sourcing: settings } };
  await db.update(schema.tenants).set({ settings: tenant.settings }).where(eq(schema.tenants.id, s.tenant.id));
  if (changes.length) await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'SOURCING_SETTINGS_CHANGED', detail: { changes }, ip: req.ip });
  res.json({ ...sourcingConfig(tenant), plan: effectiveLimits(tenant).label, changes });
}));

export const sourcingRouter = Router();
sourcingRouter.use(requireStaff(), (req, _res, next) => { try { assertSourcingOn(staffCtx(req).tenant); next(); } catch (e) { next(e); } });

/** What's switched on and the rule defaults (buyers see this when they set up an event). */
sourcingRouter.get('/config', requireStaff('sourcing.view'), ah(async (req, res) => {
  res.json(sourcingConfig(staffCtx(req).tenant));
}));

sourcingRouter.get('/events', requireStaff('sourcing.view'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  const events = await db.select({
    id: schema.sourcingEvents.id, number: schema.sourcingEvents.number, title: schema.sourcingEvents.title, format: schema.sourcingEvents.format,
    status: schema.sourcingEvents.status, currency: schema.sourcingEvents.currency, estimatedValue: schema.sourcingEvents.estimatedValue,
    bidDeadline: schema.sourcingEvents.bidDeadline, liveStartsAt: schema.sourcingEvents.liveStartsAt, createdAt: schema.sourcingEvents.createdAt,
  }).from(schema.sourcingEvents).where(eq(schema.sourcingEvents.tenantId, tenant.id)).orderBy(desc(schema.sourcingEvents.createdAt)).limit(200);
  const bidders = events.length ? await db.select({ eventId: schema.sourcingBidders.eventId, n: count() }).from(schema.sourcingBidders).where(eq(schema.sourcingBidders.tenantId, tenant.id)).groupBy(schema.sourcingBidders.eventId) : [];
  res.json({ events: events.map((e) => ({ ...e, bidders: bidders.find((b) => b.eventId === e.id)?.n ?? 0 })) });
}));

sourcingRouter.get('/events/:id', requireStaff('sourcing.view'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  const e = await db.query.sourcingEvents.findFirst({ where: and(eq(schema.sourcingEvents.tenantId, tenant.id), eq(schema.sourcingEvents.id, req.params.id)) });
  if (!e) throw new HttpError(404, 'Event not found');
  res.json({ event: e });
}));
