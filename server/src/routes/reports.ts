import { Router } from 'express';
import { ah, HttpError } from '../lib/http.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { dashboard, parseFilters, reportList, runReport, toXlsx } from '../services/reports.js';

export const reportsRouter = Router();
reportsRouter.use(requireStaff('reports.view'));

reportsRouter.get('/dashboard', ah(async (req, res) => {
  res.json(await dashboard(staffCtx(req).tenant.id, parseFilters(req.query)));
}));

reportsRouter.get('/', ah(async (_req, res) => { res.json(reportList()); }));

reportsRouter.get('/:key', ah(async (req, res) => {
  const s = staffCtx(req);
  const f = parseFilters(req.query);
  const out = await runReport(s.tenant.id, req.params.key, f);
  if (!out) throw new HttpError(404, 'Unknown report');
  if (req.query.format === 'xlsx') {
    const buf = await toXlsx(out.def, out.rows, { tenant: s.tenant.name, by: s.user.name, filters: f });
    await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'REPORT_EXPORTED', detail: { report: out.def.title, rows: out.rows.length }, ip: req.ip });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.key}_${new Date().toISOString().slice(0, 10)}.xlsx"`);
    return res.send(buf);
  }
  res.json({ key: req.params.key, title: out.def.title, columns: out.def.columns, total: out.rows.length, rows: out.rows.slice(0, 500) });
}));
