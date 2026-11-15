/** Vendors → Risk: risk scores and monitoring (services/risk.ts). */
import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { monitorVendor, riskOverview, riskSettings } from '../services/risk.js';

export const riskRouter = Router();

riskRouter.get('/', requireStaff('vendors.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  const band = z.enum(['LOW', 'MEDIUM', 'HIGH']).optional().catch(undefined).parse(req.query.band);
  res.json({ ...(await riskOverview(s.tenant.id, band)), settings: riskSettings(s.tenant), canChangeSettings: s.permissions.has('tenant.settings'), canCheck: s.permissions.has('vendors.block') });
}));

riskRouter.put('/settings', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const risk = z.object({
    monitorDays: z.number().int().min(0).max(365),
    alertEmails: z.string().trim().max(500).refine((v) => !v || v.split(/[,;\s]+/).filter(Boolean).every((e) => z.string().email().safeParse(e).success), 'Enter email addresses separated by commas'),
    autoHold: z.boolean(),
    holdOnOverdueAction: z.boolean().default(false),
  }).parse(req.body);
  await db.update(schema.tenants).set({ settings: { ...s.tenant.settings, risk } }).where(eq(schema.tenants.id, s.tenant.id));
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'RISK_SETTINGS_CHANGED', detail: { monitorDays: risk.monitorDays, autoHold: risk.autoHold ? 'on' : 'off', holdOnOverdueAction: risk.holdOnOverdueAction ? 'on' : 'off' }, ip: req.ip });
  res.json({ settings: risk });
}));

/** Re-check registration status and sanctions now, and recompute the score. */
riskRouter.post('/vendors/:id/check', requireStaff('vendors.block'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await db.query.vendors.findFirst({ where: and(eq(schema.vendors.tenantId, s.tenant.id), eq(schema.vendors.id, req.params.id)) });
  if (!v || v.erasedAt) throw new HttpError(404, 'Vendor not found');
  res.json(await monitorVendor(v, s.user.name));
}));
