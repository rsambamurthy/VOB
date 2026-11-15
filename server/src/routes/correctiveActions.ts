/** Corrective actions (services/correctiveActions.ts): staff routes, and the supplier's answering routes. */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { upload } from '../lib/upload.js';
import { canAct } from '../services/approvers.js';
import type { Tenant, Vendor } from '../db/schema.js';
import { actionsFor, actionsOverview, attachEvidence, canReview, raiseActions, removeEvidence, reviewAction, saveResponse, submitResponse, suggestActions, updateAction } from '../services/correctiveActions.js';

export const actionsRouter = Router();
const priority = z.enum(['HIGH', 'MEDIUM', 'LOW']);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a due date');

async function vendorOf(tenantId: string, id: string) {
  const v = await db.query.vendors.findFirst({ where: and(eq(schema.vendors.tenantId, tenantId), eq(schema.vendors.id, id)) });
  if (!v || v.erasedAt) throw new HttpError(404, 'Vendor not found');
  return v;
}
/** Raising: anyone allowed to manage corrective actions, or an approver who can act on the supplier's current step. */
async function canRaise(req: Request, v: Vendor) {
  const s = staffCtx(req);
  if (s.permissions.has('actions.manage')) return true;
  const pending = await db.query.approvalSteps.findFirst({ where: and(eq(schema.approvalSteps.vendorId, v.id), eq(schema.approvalSteps.cycle, v.reviewCycle), eq(schema.approvalSteps.status, 'PENDING')) });
  return !!pending && (await canAct(pending, s.user.id));
}
const me = (req: Request) => { const s = staffCtx(req); return { id: s.user.id, name: s.user.name, email: s.user.email, ip: req.ip, permissions: s.permissions as Set<string> }; };

actionsRouter.get('/', requireStaff('vendors.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  const filter = z.enum(['open', 'review', 'overdue', 'closed', 'mine']).catch('open').parse(req.query.filter ?? 'open');
  res.json(await actionsOverview(s.tenant.id, filter, s.user.id));
}));

/** A supplier's actions, and what VendorGate suggests raising. */
actionsRouter.get('/vendor/:vendorId', requireStaff('vendors.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await vendorOf(s.tenant.id, req.params.vendorId);
  const raise = ['UNDER_REVIEW', 'APPROVED', 'SENT_BACK', 'IN_PROGRESS'].includes(v.status) && (await canRaise(req, v));
  const list = await actionsFor(v.id);
  res.json({
    actions: list.map((a) => ({ ...a, canReview: canReview({ raisedById: a.raisedById ?? null }, me(req)) })),
    canRaise: raise, condition: v.status !== 'APPROVED',
    suggestions: raise ? await suggestActions(s.tenant, v) : [],
  });
}));

actionsRouter.post('/vendor/:vendorId', requireStaff('vendors.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await vendorOf(s.tenant.id, req.params.vendorId);
  if (!(await canRaise(req, v))) throw new HttpError(403, 'Only approvers of this supplier, or people allowed to manage corrective actions, can raise them');
  const { items } = z.object({ items: z.array(z.object({
    title: z.string().trim().min(3, 'Give each action a title').max(200), description: z.string().trim().max(2000).optional(),
    priority, dueOn: day, source: z.string().max(200).optional(), sourceLabel: z.string().max(200).optional(),
  })).min(1, 'Add at least one action').max(20) }).parse(req.body);
  res.status(201).json(await raiseActions(s.tenant, v, items, me(req)));
}));

actionsRouter.post('/:actionId/review', requireStaff('vendors.view'), ah(async (req, res) => {
  const input = z.object({ decision: z.enum(['ACCEPT', 'REJECT']), remarks: z.string().trim().max(1000).optional() }).parse(req.body);
  await reviewAction(staffCtx(req).tenant, req.params.actionId, input, me(req));
  res.json({ ok: true });
}));

actionsRouter.patch('/:actionId', requireStaff('vendors.view'), ah(async (req, res) => {
  const input = z.object({ dueOn: day.optional(), priority: priority.optional(), cancel: z.boolean().optional(), reason: z.string().trim().max(500).optional() }).parse(req.body);
  await updateAction(staffCtx(req).tenant, req.params.actionId, input, me(req));
  res.json({ ok: true });
}));

/** The supplier's side, mounted in the portal. */
export function supplierActionRoutes(router: Router, opts: { vendor: (req: Request) => Promise<Vendor>; tenant: (req: Request) => Tenant; actor: (req: Request, v: Vendor) => { name: string; userId?: string; ip?: string } }) {
  router.get('/actions', ah(async (req, res) => res.json(await actionsFor((await opts.vendor(req)).id, { forSupplier: true }))));
  router.put('/actions/:actionId', ah(async (req, res) => {
    const v = await opts.vendor(req);
    await saveResponse(v, req.params.actionId, z.object({ note: z.string().max(4000).default('') }).parse(req.body).note);
    res.json(await actionsFor(v.id, { forSupplier: true }));
  }));
  router.post('/actions/:actionId/file', upload.single('file'), ah(async (req, res) => {
    const v = await opts.vendor(req);
    if (!req.file) throw new HttpError(400, 'No file uploaded');
    await attachEvidence(v, req.params.actionId, req.file, opts.actor(req, v).userId);
    res.status(201).json(await actionsFor(v.id, { forSupplier: true }));
  }));
  router.delete('/actions/:actionId/file/:documentId', ah(async (req, res) => {
    const v = await opts.vendor(req);
    await removeEvidence(v, req.params.actionId, req.params.documentId);
    res.json(await actionsFor(v.id, { forSupplier: true }));
  }));
  router.post('/actions/:actionId/submit', ah(async (req, res) => {
    const v = await opts.vendor(req);
    const { note } = z.object({ note: z.string().max(4000).optional() }).parse(req.body);
    await submitResponse(opts.tenant(req), v, req.params.actionId, note, opts.actor(req, v));
    res.json(await actionsFor(v.id, { forSupplier: true }));
  }));
}
