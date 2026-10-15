/**
 * "Ask VendorGate": staff ask a question in their own words; the AI picks one of the fixed read-only
 * searches (services/ask/queries.ts) and VendorGate runs it. Only the question goes to the AI provider.
 */
import { Router } from 'express';
import { z } from 'zod';
import { and, count, eq, gte, sql } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { effectiveLimits } from '../lib/plans.js';
import { packFor } from '../countries/registry.js';
import { getConfig } from '../services/config.js';
import { ASK_QUERIES, runAskQuery, type AskResult, type AskUser } from '../services/ask/queries.js';
import { askPlanner } from '../integrations/ai/askPlanner.js';
import { toXlsx } from '../services/reports.js';

export const askRouter = Router();
askRouter.use(requireStaff('vendors.view'));

const userOf = (req: Parameters<typeof staffCtx>[0]): AskUser => { const s = staffCtx(req); return { tenant: s.tenant, can: (p) => s.permissions.has(p as never) }; };
const allowed = (u: AskUser) => ASK_QUERIES.filter((q) => q.needs(u));

askRouter.get('/', ah(async (req, res) => {
  const u = userOf(req);
  res.json({ enabled: u.tenant.settings.askAi !== false, live: askPlanner().live, searches: allowed(u).map((q) => q.name) });
}));

askRouter.post('/', ah(async (req, res) => {
  const s = staffCtx(req);
  const u = userOf(req);
  const { question } = z.object({ question: z.string().trim().min(3, 'Type a question').max(400) }).parse(req.body);
  if (u.tenant.settings.askAi === false) throw new HttpError(403, 'Ask VendorGate is turned off for this workspace', undefined, 'ASK_OFF');
  const p = askPlanner();
  const limit = effectiveLimits(u.tenant).askPerDay;
  if (p.live && limit !== null && limit !== undefined) {
    const [{ n }] = await db.select({ n: count() }).from(schema.auditLogs).where(and(eq(schema.auditLogs.tenantId, u.tenant.id), eq(schema.auditLogs.action, 'AI_ASKED'),
      gte(schema.auditLogs.createdAt, new Date(Date.now() - 86_400_000)), sql`${schema.auditLogs.detail}->>'live' = 'true'`));
    if (Number(n) >= limit) throw new HttpError(429, 'Your workspace has used today’s AI questions. Use Reports and filters instead, or try again tomorrow.', undefined, 'PLAN_LIMIT');
  }
  const cfg = await getConfig(u.tenant.id);
  const pack = packFor(u.tenant.country);
  const plan = await p.plan(question, allowed(u), {
    today: new Date().toISOString().slice(0, 10), country: pack.name, currency: pack.currency ?? 'USD',
    levels: cfg.workflow.levels.map((l) => l.label), documents: cfg.documents.map((d) => d.label),
  });
  let result: AskResult | null = null;
  if (plan.query) result = await runAskQuery(u, plan.query, plan.params, plan.title).catch(() => null);
  await audit({ tenantId: u.tenant.id, actor: s.user.name, action: 'AI_ASKED', detail: { question, search: plan.query, params: plan.query ? plan.params : undefined, rows: result?.total ?? null, live: p.live }, ip: req.ip });
  if (plan.query === null) return res.json({ answered: false, message: plan.message, test: !p.live });
  if (!result) return res.json({ answered: false, message: 'I couldn’t run that search. Try rephrasing the question.', test: !p.live });
  res.json({ answered: true, search: { name: plan.query, params: plan.params, title: plan.title }, result, test: !p.live });
}));

/** Download the same search as Excel (re-run with the same parameters; no AI call). */
askRouter.post('/export', ah(async (req, res) => {
  const s = staffCtx(req);
  const u = userOf(req);
  const { name, params, title } = z.object({ name: z.string(), params: z.record(z.unknown()).default({}), title: z.string().max(200) }).parse(req.body);
  if (!allowed(u).some((q) => q.name === name)) throw new HttpError(403, 'Not allowed');
  const r = await runAskQuery(u, name, params, title);
  const cols = r.columns.map((c) => ({ key: c.key, label: c.label, width: c.key === 'name' ? 34 : 18, type: c.type === 'date' ? 'date' : c.type === 'datetime' ? 'datetime' : undefined }));
  const rows = r.rows.map((row) => Object.fromEntries(r.columns.map((c) => [c.key, (c.type === 'date' || c.type === 'datetime') && row[c.key] ? new Date(String(row[c.key])) as never : row[c.key]])));
  const buf = await toXlsx({ title: 'Ask VendorGate', description: title, usesRange: false, columns: cols as never, rows: async () => [] }, rows as never, { tenant: s.tenant.name, by: s.user.name, filters: { from: new Date(), to: new Date(), days: 0 } as never });
  await audit({ tenantId: u.tenant.id, actor: s.user.name, action: 'REPORT_EXPORTED', detail: { report: `Ask: ${title}`, rows: r.rows.length }, ip: req.ip });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="ask_${new Date().toISOString().slice(0, 10)}.xlsx"`);
  res.send(buf);
}));
