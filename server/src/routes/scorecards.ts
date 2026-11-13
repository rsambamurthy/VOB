/** Supplier performance scorecards (staff). The supplier's own view is in vendorPortal.ts. */
import { Router } from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { METRICS, scorecardFor, scorecards, weightsFor, type MetricKey } from '../services/scorecards.js';

export const scorecardsRouter = Router();
const daysOf = (q: unknown) => { const d = Number(q); return [30, 90, 180, 365].includes(d) ? d : 90; };

scorecardsRouter.get('/', requireStaff('vendors.view'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  res.json({ ...(await scorecards(tenant, daysOf(req.query.days))), metrics: METRICS.map(({ key, label, help }) => ({ key, label, help })) });
}));

scorecardsRouter.get('/export.xlsx', requireStaff('reports.view'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  const days = daysOf(req.query.days);
  const r = await scorecards(tenant, days);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Scorecards');
  ws.addRow([`Supplier scorecards — ${r.period.from} to ${r.period.to}`]).font = { bold: true, size: 13 };
  ws.addRow([]);
  const head = ws.addRow(['Supplier', 'Code', 'Score', 'Grade', 'Change', ...METRICS.map((m) => `${m.label} (${r.weights[m.key]}%)`), 'Data points']);
  head.font = { bold: true };
  for (const x of r.rows) {
    ws.addRow([x.name, x.code, x.score, x.grade, x.change, ...x.metrics.map((m) => (m.value === null ? null : Math.round(m.value * 1000) / 10)), x.points]);
  }
  ws.columns.forEach((c, i) => { c.width = i === 0 ? 34 : i < 5 ? 10 : 20; });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="supplier-scorecards-${r.period.to}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

scorecardsRouter.get('/settings', requireStaff('vendors.view'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  res.json({ weights: weightsFor(tenant), graceDays: tenant.settings.scorecard?.graceDays ?? 0, showToSuppliers: !!tenant.settings.scorecard?.showToSuppliers, metrics: METRICS.map(({ key, label, weight }) => ({ key, label, defaultWeight: weight })) });
}));

scorecardsRouter.put('/settings', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const input = z.object({
    weights: z.object(Object.fromEntries(METRICS.map((m) => [m.key, z.number().int().min(0).max(100)])) as Record<MetricKey, z.ZodNumber>),
    graceDays: z.number().int().min(0).max(30),
    showToSuppliers: z.boolean(),
  }).parse(req.body);
  if (!Object.values(input.weights).some((w) => w > 0)) throw new HttpError(400, 'At least one measure needs a weight above 0.');
  await db.update(schema.tenants).set({ settings: { ...s.tenant.settings, scorecard: input } }).where(eq(schema.tenants.id, s.tenant.id));
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'SCORECARD_SETTINGS_UPDATED', detail: input, ip: req.ip });
  res.json({ ok: true });
}));

scorecardsRouter.get('/:vendorId', requireStaff('vendors.view'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  const v = await db.query.vendors.findFirst({ where: and(eq(schema.vendors.id, req.params.vendorId), eq(schema.vendors.tenantId, tenant.id)) });
  if (!v) throw new HttpError(404, 'Supplier not found');
  res.json({ vendor: { id: v.id, name: v.name, code: v.code, status: v.status }, ...(await scorecardFor(tenant, v.id, daysOf(req.query.days))) });
}));

/** Buyers rate a supplier (1–5 per criterion, any left out). */
scorecardsRouter.post('/:vendorId/ratings', requireStaff('orders.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await db.query.vendors.findFirst({ where: and(eq(schema.vendors.id, req.params.vendorId), eq(schema.vendors.tenantId, s.tenant.id)) });
  if (!v) throw new HttpError(404, 'Supplier not found');
  const star = z.number().int().min(1).max(5).nullable().optional();
  const input = z.object({ quality: star, delivery: star, service: star, communication: star, comment: z.string().trim().max(1000).optional() }).parse(req.body);
  if (![input.quality, input.delivery, input.service, input.communication].some(Boolean)) throw new HttpError(400, 'Rate at least one of quality, delivery, service or communication.');
  const [row] = await db.insert(schema.supplierRatings).values({
    tenantId: s.tenant.id, vendorId: v.id, quality: input.quality ?? null, delivery: input.delivery ?? null, service: input.service ?? null, communication: input.communication ?? null,
    comment: input.comment || null, ratedById: s.user.id, ratedByName: s.user.name,
  }).returning();
  await audit({ tenantId: s.tenant.id, vendorId: v.id, actor: s.user.name, action: 'SUPPLIER_RATED', detail: { quality: row.quality, delivery: row.delivery, service: row.service, communication: row.communication }, ip: req.ip });
  res.status(201).json(row);
}));
