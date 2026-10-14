/** F1 help: AI answers from the help articles, and each workspace's own help topics. */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, asc, count, eq, gte, inArray } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { effectiveLimits } from '../lib/plans.js';
import { helpAnswerer } from '../integrations/ai/helpAnswer.js';
import type { Tenant } from '../db/schema.js';

export const helpRouter = Router();
const { helpTopics, helpQuestions } = schema;

/** Who is asking: a signed-in staff user (staff help) or a supplier in the portal (supplier help). */
function asker(req: Request, audience: 'staff' | 'supplier'): { tenant: Tenant; who: string } {
  if (audience === 'staff') {
    const s = req.staff;
    if (!s || s.mfaPending || s.mfaSetupRequired) throw new HttpError(401, 'Please sign in');
    return { tenant: s.tenant, who: s.user.email };
  }
  const v = req.vendor;
  if (!v) throw new HttpError(401, 'Please sign in');
  return { tenant: v.tenant, who: v.contactEmail ?? 'supplier' };
}

helpRouter.post('/ask', ah(async (req, res) => {
  const input = z.object({
    question: z.string().trim().min(3, 'Type a question').max(500),
    audience: z.enum(['staff', 'supplier']),
    articles: z.array(z.object({ id: z.string().max(80), title: z.string().max(200), summary: z.string().max(400).optional(), body: z.string().max(20000) })).min(1).max(12),
  }).parse(req.body);
  const { tenant, who } = asker(req, input.audience);
  if (tenant.settings.helpAi === false) throw new HttpError(403, 'AI answers are turned off for this workspace', undefined, 'HELP_AI_OFF');
  const limit = effectiveLimits(tenant).helpAnswersPerDay;
  const a = helpAnswerer();
  if (limit !== null && limit !== undefined && a.live) {
    const [{ n }] = await db.select({ n: count() }).from(helpQuestions).where(and(eq(helpQuestions.tenantId, tenant.id), gte(helpQuestions.createdAt, new Date(Date.now() - 86_400_000)), eq(helpQuestions.provider, a.name)));
    if (Number(n) >= limit) throw new HttpError(429, 'Your workspace has used today’s AI help answers. Search the help topics instead, or try again tomorrow.', undefined, 'PLAN_LIMIT');
  }
  const r = await a.answer(input.question, input.articles, { audience: input.audience, product: tenant.branding.productName ?? 'VendorGate' });
  await db.insert(helpQuestions).values({ tenantId: tenant.id, audience: input.audience, askedBy: who, question: input.question, answered: r.answered, sources: r.sources, provider: a.name });
  res.json({ ...r, test: !a.live });
}));

/* ---------- Workspace help topics ---------- */

const topicOut = (t: typeof helpTopics.$inferSelect) => ({ id: `ws-${t.id}`, topicId: t.id, title: t.title, summary: t.summary, body: t.body, audience: t.audience, keywords: t.keywords ?? '', updatedAt: t.updatedAt, updatedBy: t.updatedBy });

/** Topics for the person asking: staff see staff + both; suppliers see supplier + both of the buyer's workspace. */
helpRouter.get('/topics', ah(async (req, res) => {
  const tenant = req.staff?.tenant ?? req.vendor?.tenant;
  if (!tenant) return res.json([]);
  const audiences = req.staff && !req.query.supplier ? ['staff', 'both'] : ['supplier', 'both'];
  const rows = await db.select().from(helpTopics).where(and(eq(helpTopics.tenantId, tenant.id), inArray(helpTopics.audience, audiences))).orderBy(asc(helpTopics.title));
  res.json(rows.map(topicOut));
}));

const topicInput = z.object({
  title: z.string().trim().min(3).max(120), summary: z.string().trim().max(240).default(''), body: z.string().trim().min(10, 'Write the help text').max(20000),
  audience: z.enum(['staff', 'supplier', 'both']), keywords: z.string().trim().max(300).optional(),
});

helpRouter.get('/topics/all', requireStaff('tenant.settings'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  res.json((await db.select().from(helpTopics).where(eq(helpTopics.tenantId, tenant.id)).orderBy(asc(helpTopics.title))).map(topicOut));
}));
helpRouter.post('/topics', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const [{ n }] = await db.select({ n: count() }).from(helpTopics).where(eq(helpTopics.tenantId, s.tenant.id));
  if (Number(n) >= 100) throw new HttpError(409, 'A workspace can have up to 100 help topics');
  const [row] = await db.insert(helpTopics).values({ ...topicInput.parse(req.body), tenantId: s.tenant.id, updatedBy: s.user.name }).returning();
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'HELP_TOPIC_ADDED', detail: { title: row.title }, ip: req.ip });
  res.status(201).json(topicOut(row));
}));
helpRouter.put('/topics/:id', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const [row] = await db.update(helpTopics).set({ ...topicInput.parse(req.body), updatedBy: s.user.name, updatedAt: new Date() }).where(and(eq(helpTopics.id, req.params.id), eq(helpTopics.tenantId, s.tenant.id))).returning();
  if (!row) throw new HttpError(404, 'Help topic not found');
  res.json(topicOut(row));
}));
helpRouter.delete('/topics/:id', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const [row] = await db.delete(helpTopics).where(and(eq(helpTopics.id, req.params.id), eq(helpTopics.tenantId, s.tenant.id))).returning();
  if (!row) throw new HttpError(404, 'Help topic not found');
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'HELP_TOPIC_DELETED', detail: { title: row.title }, ip: req.ip });
  res.json({ ok: true });
}));
