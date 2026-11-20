/**
 * Sourcing (RFQs and e-auctions).
 *   /api/admin/sourcing   Administration → Sourcing: switch, formats, sub-features, rule defaults and locks
 *   /api/staff/sourcing   the module itself — 404 unless Sourcing is on (services/sourcing/config.ts)
 */
import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { effectiveLimits } from '../lib/plans.js';
import { z } from 'zod';
import type { Request } from 'express';
import { approvalCatalog, approvalLevels, assertSourcingOn, checkApproval, checkSourcingSettings, eventConditionCatalog, sourcingConfig, type FlowKind } from '../services/sourcing/config.js';
import { cancelEvent, copyEvent, createEvent, deleteEvent, eventDetail, eventInput, itemsInput, itemsTemplate, listEvents, readItems, saveItems, sourcingTerms, submitEvent, updateEvent, withdrawEvent, type EventFilter } from '../services/sourcing/events.js';
import { decideFlow, flowView, waitingFor } from '../services/approvalFlow.js';
import { addBidders, addOutsideBidder, publishAnswer, removeBidder, sendInvitations, suggestBidders } from '../services/sourcing/bidders.js';
import { bidLogCsv, buyerLive, cancelStrike, confirmStrike, extendAuction, pauseAuction, requestStrike, resumeAuction, verifyChain } from '../services/sourcing/live.js';
import { subscribeLive } from '../lib/liveHub.js';
import { proposeAward, withdrawAward } from '../services/sourcing/awards.js';
import { confirmOpening, finishTechnical, saveScores, startFromSealed } from '../services/sourcing/submissions.js';
import { excelUpload } from '../lib/upload.js';
import { localeFor } from '../countries/registry.js';

export const sourcingAdminRouter = Router();

const approvalSetup = async (tenantId: string, tenant: Parameters<typeof approvalLevels>[0], kind: FlowKind = 'event') => ({
  kind, levels: approvalLevels(tenant, kind), catalog: await approvalCatalog(tenant, kind),
  roles: await db.select({ key: schema.roles.key, name: schema.roles.name }).from(schema.roles).where(eq(schema.roles.tenantId, tenantId)),
});
sourcingAdminRouter.get('/', requireStaff('tenant.settings'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  res.json({ ...sourcingConfig(tenant), plan: effectiveLimits(tenant).label, approval: await approvalSetup(tenant.id, tenant), awardApproval: await approvalSetup(tenant.id, tenant, 'award') });
}));

/** Event (/approval) and award (/approval?kind=award) approval flows: levels like the onboarding approval flow. */
sourcingAdminRouter.put('/approval', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const kind: FlowKind = req.query.kind === 'award' ? 'award' : 'event';
  const roleKeys = (await db.select({ key: schema.roles.key }).from(schema.roles).where(eq(schema.roles.tenantId, s.tenant.id))).map((r) => r.key);
  const { levels, issues } = await checkApproval(s.tenant, kind, req.body?.levels, roleKeys);
  if (issues.length) throw new HttpError(400, issues[0].message, issues);
  const tenant = { ...s.tenant, settings: { ...s.tenant.settings, sourcing: { ...(s.tenant.settings.sourcing ?? {}), [kind === 'event' ? 'approval' : 'awardApproval']: { levels } } } };
  await db.update(schema.tenants).set({ settings: tenant.settings }).where(eq(schema.tenants.id, s.tenant.id));
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'SOURCING_APPROVAL_FLOW_CHANGED', detail: { flow: kind, levels: levels.map((l) => l.label) }, ip: req.ip });
  res.json({ approval: await approvalSetup(s.tenant.id, tenant, kind) });
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

const by = (req: Request) => { const s = staffCtx(req); return { id: s.user.id, name: s.user.name, ip: req.ip }; };

/** What the event form needs: formats and rules (config), sourcing terms, categories, currency. */
sourcingRouter.get('/setup', requireStaff('sourcing.view'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  const catalog = await eventConditionCatalog(tenant);
  res.json({ config: sourcingConfig(tenant), terms: await sourcingTerms(tenant.id), categories: catalog.find((c) => c.id === 'event.category')?.options ?? [], currency: localeFor(tenant.country).currency });
}));

sourcingRouter.get('/events', requireStaff('sourcing.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  const filter = z.enum(['all', 'drafts', 'approval', 'approved', 'templates', 'mine']).catch('all').parse(req.query.filter ?? 'all') as EventFilter;
  res.json({ events: await listEvents(s.tenant, filter, s.user.id) });
}));

/** How many events are waiting for this user's approval (My approvals). */
sourcingRouter.get('/approvals/count', ah(async (req, res) => {
  const s = staffCtx(req);
  res.json({ waiting: (await waitingFor(s.tenant.id, s.user.id, 'sourcing_event')).length });
}));

sourcingRouter.post('/events', requireStaff('sourcing.events'), ah(async (req, res) => {
  const s = staffCtx(req);
  const fromTemplate = typeof req.body?.fromTemplate === 'string' ? req.body.fromTemplate : null;
  const e = fromTemplate ? await copyEvent(s.tenant, fromTemplate, by(req), { title: req.body?.title }) : await createEvent(s.tenant, eventInput.parse(req.body), by(req), { template: req.body?.template === true });
  res.status(201).json({ event: e });
}));

/** Approvers of the current step can open the event even without sourcing.view. */
sourcingRouter.get('/events/:id', ah(async (req, res) => {
  const s = staffCtx(req);
  if (!s.permissions.has('sourcing.view') && !(await flowView(s.tenant.id, 'sourcing_event', req.params.id, s.user.id)).canAct) throw new HttpError(403, 'You don’t have permission to do this');
  res.json(await eventDetail(s.tenant, req.params.id, s.user.id, s.permissions as Set<string>));
}));

sourcingRouter.patch('/events/:id', requireStaff('sourcing.events'), ah(async (req, res) => {
  const s = staffCtx(req);
  await updateEvent(s.tenant, req.params.id, eventInput.partial().parse(req.body), by(req));
  res.json(await eventDetail(s.tenant, req.params.id, s.user.id, s.permissions as Set<string>));
}));

sourcingRouter.put('/events/:id/items', requireStaff('sourcing.events'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { lots } = itemsInput.parse(req.body);
  await saveItems(s.tenant, req.params.id, lots, by(req), req.query.from === 'excel' ? 'excel' : 'screen');
  res.json(await eventDetail(s.tenant, req.params.id, s.user.id, s.permissions as Set<string>));
}));

sourcingRouter.get('/items-template.xlsx', requireStaff('sourcing.events'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="sourcing-items.xlsx"');
  res.send(Buffer.from(await itemsTemplate(localeFor(tenant.country).currency)));
}));

/** Read lots and lines from Excel; nothing is saved until the buyer confirms (PUT /items?from=excel). */
sourcingRouter.post('/items/excel', requireStaff('sourcing.events'), excelUpload.single('file'), ah(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose the Excel file to upload');
  res.json(await readItems(req.file.buffer));
}));

sourcingRouter.post('/events/:id/submit', requireStaff('sourcing.events'), ah(async (req, res) => {
  const s = staffCtx(req);
  const r = await submitEvent(s.tenant, req.params.id, by(req));
  res.json({ ...r, ...(await eventDetail(s.tenant, req.params.id, s.user.id, s.permissions as Set<string>)) });
}));
sourcingRouter.post('/events/:id/withdraw', requireStaff('sourcing.events'), ah(async (req, res) => {
  const s = staffCtx(req);
  await withdrawEvent(s.tenant, req.params.id, by(req));
  res.json(await eventDetail(s.tenant, req.params.id, s.user.id, s.permissions as Set<string>));
}));
sourcingRouter.post('/events/:id/cancel', requireStaff('sourcing.events'), ah(async (req, res) => {
  const s = staffCtx(req);
  await cancelEvent(s.tenant, req.params.id, z.object({ reason: z.string().max(1000) }).parse(req.body).reason, by(req));
  res.json(await eventDetail(s.tenant, req.params.id, s.user.id, s.permissions as Set<string>));
}));
sourcingRouter.post('/events/:id/copy', requireStaff('sourcing.events'), ah(async (req, res) => {
  const s = staffCtx(req);
  res.status(201).json({ event: await copyEvent(s.tenant, req.params.id, by(req), { template: req.body?.template === true }) });
}));
sourcingRouter.delete('/events/:id', requireStaff('sourcing.events'), ah(async (req, res) => {
  const s = staffCtx(req);
  await deleteEvent(s.tenant, req.params.id, by(req));
  res.json({ ok: true });
}));

/** Approve, send back or reject (whoever holds the current step's role; never the event's owner). */
sourcingRouter.post('/events/:id/decision', ah(async (req, res) => {
  const s = staffCtx(req);
  const { action, remarks } = z.object({ action: z.enum(['APPROVE', 'SEND_BACK', 'REJECT']), remarks: z.string().max(2000).default('') }).parse(req.body);
  const r = await decideFlow(s.tenant.id, 'sourcing_event', req.params.id, { id: s.user.id, name: s.user.name }, action, remarks, req.ip);
  res.json({ ...r, ...(await eventDetail(s.tenant, req.params.id, s.user.id, s.permissions as Set<string>)) });
}));

/* ---------- bidders and clarifications ---------- */

sourcingRouter.get('/events/:id/suggestions', requireStaff('sourcing.events'), ah(async (req, res) => {
  res.json({ suppliers: await suggestBidders(staffCtx(req).tenant, req.params.id, String(req.query.q ?? '')) });
}));
sourcingRouter.post('/events/:id/bidders', requireStaff('sourcing.events'), ah(async (req, res) => {
  const s = staffCtx(req);
  const added = await addBidders(s.tenant, req.params.id, z.object({ vendorIds: z.array(z.string()).max(500) }).parse(req.body).vendorIds, by(req));
  res.json({ added, ...(await eventDetail(s.tenant, req.params.id, s.user.id, s.permissions as Set<string>)) });
}));
sourcingRouter.post('/events/:id/outside-bidders', requireStaff('sourcing.events'), ah(async (req, res) => {
  const s = staffCtx(req);
  await addOutsideBidder(s.tenant, req.params.id, req.body, by(req));
  res.status(201).json(await eventDetail(s.tenant, req.params.id, s.user.id, s.permissions as Set<string>));
}));
sourcingRouter.delete('/events/:id/bidders/:bidderId', requireStaff('sourcing.events'), ah(async (req, res) => {
  const s = staffCtx(req);
  await removeBidder(s.tenant, req.params.id, req.params.bidderId, by(req));
  res.json(await eventDetail(s.tenant, req.params.id, s.user.id, s.permissions as Set<string>));
}));
sourcingRouter.post('/events/:id/invitations', requireStaff('sourcing.events'), ah(async (req, res) => {
  const s = staffCtx(req);
  const sent = await sendInvitations(s.tenant, req.params.id, by(req));
  res.json({ sent, ...(await eventDetail(s.tenant, req.params.id, s.user.id, s.permissions as Set<string>)) });
}));
/** Answer a bidder's question (questionId) or post an announcement — shared with every bidder. */
sourcingRouter.post('/events/:id/clarifications', requireStaff('sourcing.events'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { questionId, answer } = z.object({ questionId: z.string().nullable().optional(), answer: z.string() }).parse(req.body);
  const told = await publishAnswer(s.tenant, req.params.id, questionId ?? null, answer, by(req));
  res.json({ told, ...(await eventDetail(s.tenant, req.params.id, s.user.id, s.permissions as Set<string>)) });
}));

/* ---------- sealed bids: opening, technical evaluation, start prices ---------- */

sourcingRouter.post('/events/:id/open', requireStaff('sourcing.open'), ah(async (req, res) => {
  const s = staffCtx(req);
  const r = await confirmOpening(s.tenant, req.params.id, by(req));
  res.json({ ...r, ...(await eventDetail(s.tenant, req.params.id, s.user.id, s.permissions as Set<string>)) });
}));
sourcingRouter.put('/events/:id/scores/:bidderId', requireStaff('sourcing.evaluate'), ah(async (req, res) => {
  const s = staffCtx(req);
  await saveScores(s.tenant, req.params.id, req.params.bidderId, req.body, by(req));
  res.json(await eventDetail(s.tenant, req.params.id, s.user.id, s.permissions as Set<string>));
}));
sourcingRouter.post('/events/:id/technical/finish', requireStaff('sourcing.events'), ah(async (req, res) => {
  const s = staffCtx(req);
  await finishTechnical(s.tenant, req.params.id, req.body, by(req));
  res.json(await eventDetail(s.tenant, req.params.id, s.user.id, s.permissions as Set<string>));
}));
sourcingRouter.post('/events/:id/start-prices', requireStaff('sourcing.events'), ah(async (req, res) => {
  const s = staffCtx(req);
  const set = await startFromSealed(s.tenant, req.params.id, by(req));
  res.json({ set, ...(await eventDetail(s.tenant, req.params.id, s.user.id, s.permissions as Set<string>)) });
}));

/* ---------- live auction ---------- */

sourcingRouter.get('/events/:id/live', requireStaff('sourcing.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  res.json({ live: await buyerLive(s.tenant, req.params.id, s.user.id) });
}));
/** Server-sent events: "something changed" — the screen fetches /live again. */
sourcingRouter.get('/events/:id/stream', requireStaff('sourcing.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  const e = await db.query.sourcingEvents.findFirst({ where: and(eq(schema.sourcingEvents.tenantId, s.tenant.id), eq(schema.sourcingEvents.id, req.params.id)) });
  if (!e) throw new HttpError(404, 'Event not found');
  subscribeLive(`event:${e.id}`, res);
}));
sourcingRouter.get('/events/:id/bids.csv', requireStaff('sourcing.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  const csv = await bidLogCsv(s.tenant, req.params.id);
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'SOURCING_BID_LOG_EXPORTED', detail: { eventId: req.params.id }, ip: req.ip });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="bid-history.csv"');
  res.send(`\ufeff${csv}`);
}));
sourcingRouter.get('/events/:id/verify', requireStaff('sourcing.view'), ah(async (req, res) => {
  res.json(await verifyChain(staffCtx(req).tenant, req.params.id));
}));
const reason = z.object({ reason: z.string().max(1000).default('') });
sourcingRouter.post('/events/:id/pause', requireStaff('sourcing.live'), ah(async (req, res) => {
  const s = staffCtx(req);
  await pauseAuction(s.tenant, req.params.id, reason.parse(req.body).reason, by(req));
  res.json({ live: await buyerLive(s.tenant, req.params.id, s.user.id) });
}));
sourcingRouter.post('/events/:id/resume', requireStaff('sourcing.live'), ah(async (req, res) => {
  const s = staffCtx(req);
  await resumeAuction(s.tenant, req.params.id, by(req));
  res.json({ live: await buyerLive(s.tenant, req.params.id, s.user.id) });
}));
sourcingRouter.post('/events/:id/extend', requireStaff('sourcing.live'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { minutes, reason: why } = z.object({ minutes: z.number(), reason: z.string().max(1000).default('') }).parse(req.body);
  await extendAuction(s.tenant, req.params.id, minutes, why, by(req));
  res.json({ live: await buyerLive(s.tenant, req.params.id, s.user.id) });
}));
/** A message to every bidder: shown on their auction screen and emailed. */
sourcingRouter.post('/events/:id/message', requireStaff('sourcing.live'), ah(async (req, res) => {
  const s = staffCtx(req);
  const told = await publishAnswer(s.tenant, req.params.id, null, z.object({ message: z.string() }).parse(req.body).message, by(req), { email: 'sourcingLiveMessage' });
  res.json({ told, live: await buyerLive(s.tenant, req.params.id, s.user.id) });
}));
sourcingRouter.post('/events/:id/bids/:bidId/strike', requireStaff('sourcing.live'), ah(async (req, res) => {
  const s = staffCtx(req);
  await requestStrike(s.tenant, req.params.id, req.params.bidId, reason.parse(req.body).reason, by(req));
  res.json({ live: await buyerLive(s.tenant, req.params.id, s.user.id) });
}));
sourcingRouter.post('/events/:id/bids/:bidId/strike/confirm', requireStaff('sourcing.live'), ah(async (req, res) => {
  const s = staffCtx(req);
  await confirmStrike(s.tenant, req.params.id, req.params.bidId, by(req));
  res.json({ live: await buyerLive(s.tenant, req.params.id, s.user.id) });
}));
sourcingRouter.delete('/events/:id/bids/:bidId/strike', requireStaff('sourcing.live'), ah(async (req, res) => {
  const s = staffCtx(req);
  await cancelStrike(s.tenant, req.params.id, req.params.bidId, by(req));
  res.json({ live: await buyerLive(s.tenant, req.params.id, s.user.id) });
}));

/* ---------- award ---------- */

sourcingRouter.post('/events/:id/award', requireStaff('sourcing.events'), ah(async (req, res) => {
  const s = staffCtx(req);
  const r = await proposeAward(s.tenant, req.params.id, req.body, by(req));
  res.json({ ...r, ...(await eventDetail(s.tenant, req.params.id, s.user.id, s.permissions as Set<string>)) });
}));
sourcingRouter.post('/events/:id/award/withdraw', requireStaff('sourcing.events'), ah(async (req, res) => {
  const s = staffCtx(req);
  await withdrawAward(s.tenant, req.params.id, by(req));
  res.json(await eventDetail(s.tenant, req.params.id, s.user.id, s.permissions as Set<string>));
}));
/** Approve, send back or reject the award (whoever holds the current step's role; never the person who proposed it). */
sourcingRouter.post('/events/:id/award/decision', ah(async (req, res) => {
  const s = staffCtx(req);
  const { action, remarks } = z.object({ action: z.enum(['APPROVE', 'SEND_BACK', 'REJECT']), remarks: z.string().max(2000).default('') }).parse(req.body);
  const r = await decideFlow(s.tenant.id, 'sourcing_award', req.params.id, { id: s.user.id, name: s.user.name }, action, remarks, req.ip);
  res.json({ ...r, ...(await eventDetail(s.tenant, req.params.id, s.user.id, s.permissions as Set<string>)) });
}));
