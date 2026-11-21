/**
 * Administration → configurable algorithms (lib/algorithms.ts): read and change parameters and rule actions. Each algorithm is
 * listed only when the workspace's plan has its product. Changes are audited with what changed.
 */
import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { algorithm, algorithms } from '../lib/algorithms.js';
// Registers the algorithms (side effects).
import '../services/invoices/duplicates.js';
import '../services/invoices/inbox.js';

export const algorithmsRouter = Router();
algorithmsRouter.use(requireStaff('tenant.settings'));
algorithmsRouter.get('/', ah(async (req, res) => {
  const t = staffCtx(req).tenant;
  res.json({ algorithms: algorithms().filter((a) => a.def.enabled(t)).map((a) => a.view(t)) });
}));
const visible = (req: Parameters<typeof staffCtx>[0], key: string) => {
  const a = algorithm(key);
  if (!a.def.enabled(staffCtx(req).tenant)) throw new HttpError(404, 'Unknown algorithm');
  return a;
};
algorithmsRouter.get('/:key', ah(async (req, res) => { res.json(visible(req, req.params.key).view(staffCtx(req).tenant)); }));
algorithmsRouter.get('/:key/document.md', ah(async (req, res) => {
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.key}.md"`);
  res.send(visible(req, req.params.key).markdown());
}));
algorithmsRouter.put('/:key', ah(async (req, res) => {
  const s = staffCtx(req);
  const a = visible(req, req.params.key);
  const { settings, changes } = a.save(s.tenant, req.body);
  await db.update(schema.tenants).set({ settings }).where(eq(schema.tenants.id, s.tenant.id));
  if (changes.length) await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'ALGORITHM_CHANGED', detail: { algorithm: a.def.name, changes: changes.join('; ') }, ip: req.ip });
  res.json({ ...a.view({ ...s.tenant, settings }), changes });
}));
