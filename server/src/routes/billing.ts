/** Workspace billing (Administration → Billing): billing details, upgrade from trial, invoices and payment. */
import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { env } from '../lib/env.js';
import { ah, HttpError } from '../lib/http.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { PLANS } from '../lib/plans.js';
import { getPlatformSettings } from '../platform/settings.js';
import { GST_STATES } from '../countries/in/gstStates.js';
import { COUNTRY_LIST } from '../countries/list.js';
import { billingProblems, currencyFor, invoicePdf, issueInvoice, markPaid, priceFor, razorpayLive, validGstin } from '../services/billing.js';
import type { Invoice, TenantBilling } from '../db/schema.js';

export const billingRouter = Router();
const { invoices, tenants } = schema;

export const publicInvoice = (i: Invoice) => ({
  id: i.id, number: i.number, status: i.status, plan: i.plan, planLabel: PLANS[i.plan]?.label ?? i.plan, cycle: i.cycle, periodStart: i.periodStart, periodEnd: i.periodEnd,
  issuedAt: i.issuedAt, dueAt: i.dueAt, currency: i.currency, subtotal: i.subtotal, tax: i.cgst + i.sgst + i.igst, total: i.total, taxMode: i.taxMode,
  paidAt: i.paidAt, paymentMethod: i.paymentMethod, paymentRef: i.paymentRef, payUrl: i.status === 'DUE' ? i.paymentLinkUrl : null, activatesPlan: i.activatesPlan,
  overdue: i.status === 'DUE' && i.dueAt < new Date(),
});

export const billingDetailsSchema = z.object({
  legalName: z.string().trim().min(2, 'Enter the legal name to invoice').max(160),
  gstin: z.string().trim().toUpperCase().max(15).optional().or(z.literal('')),
  address: z.string().trim().min(5, 'Enter the billing address').max(300),
  city: z.string().trim().max(80).optional().or(z.literal('')),
  postalCode: z.string().trim().max(12).optional().or(z.literal('')),
  country: z.string().trim().length(2).toUpperCase().default('IN'),
  stateCode: z.string().trim().regex(/^\d{2}$/).optional().or(z.literal('')),
  email: z.string().trim().email('Enter the billing email').max(200),
  cycle: z.enum(['monthly', 'yearly']).optional(),
});

/** Clean billing details: GSTIN checked; for India the state follows the GSTIN. */
export function cleanBilling(input: z.infer<typeof billingDetailsSchema>, cur: TenantBilling): TenantBilling {
  const gstin = input.gstin || undefined;
  if (gstin) {
    if (input.country !== 'IN') throw new HttpError(422, 'A GSTIN applies only to an Indian billing address', { gstin: 'Only for India' });
    if (!validGstin(gstin)) throw new HttpError(422, 'That GSTIN is not valid', { gstin: 'Check the GSTIN' });
  }
  const stateCode = input.country === 'IN' ? (gstin ? gstin.slice(0, 2) : input.stateCode || undefined) : undefined;
  if (input.country === 'IN' && (!stateCode || !GST_STATES[stateCode])) throw new HttpError(422, 'Choose the state of the billing address', { stateCode: 'Choose a state' });
  return { ...cur, legalName: input.legalName, gstin, address: input.address, city: input.city || undefined, postalCode: input.postalCode || undefined, country: input.country, stateCode, email: input.email, cycle: input.cycle ?? cur.cycle };
}

billingRouter.get('/', requireStaff('tenant.settings'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  const cfg = (await getPlatformSettings()).billing ?? {};
  const currency = currencyFor(tenant.billing);
  const rows = await db.select().from(invoices).where(eq(invoices.tenantId, tenant.id)).orderBy(desc(invoices.issuedAt)).limit(60);
  res.json({
    plan: tenant.plan, planLabel: PLANS[tenant.plan]?.label ?? tenant.plan, trialEndsAt: tenant.trialEndsAt, billing: tenant.billing, currency,
    prices: Object.fromEntries(['standard', 'enterprise'].map((p) => [p, { monthly: priceFor(cfg, currency, p, 'monthly'), yearly: priceFor(cfg, currency, p, 'yearly') }])),
    gstRate: cfg.gstRate ?? 18, invoices: rows.map(publicInvoice), online: razorpayLive(), testPay: !razorpayLive() && !env.isProd,
    problems: billingProblems(cfg, tenant.billing).filter((p) => !p.startsWith('VendorGate')), sellerReady: !billingProblems(cfg, {}).some((p) => p.startsWith('VendorGate')),
    states: Object.entries(GST_STATES).map(([code, name]) => ({ code, name })), countries: COUNTRY_LIST.map((c) => ({ code: c.iso, name: c.name })),
  });
}));

billingRouter.put('/details', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const billing = cleanBilling(billingDetailsSchema.parse(req.body), s.tenant.billing);
  await db.update(tenants).set({ billing }).where(eq(tenants.id, s.tenant.id));
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'BILLING_DETAILS_UPDATED', ip: req.ip });
  res.json({ billing });
}));

/** Upgrade from the trial: issues the first invoice; the plan switches when it is paid. */
billingRouter.post('/upgrade', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { cycle } = z.object({ cycle: z.enum(['monthly', 'yearly']) }).parse(req.body);
  if (s.tenant.plan !== 'trial') throw new HttpError(409, 'Your workspace is already on a paid plan');
  const open = await db.query.invoices.findFirst({ where: and(eq(invoices.tenantId, s.tenant.id), eq(invoices.status, 'DUE'), eq(invoices.activatesPlan, true)) });
  if (open) return res.json({ invoice: publicInvoice(open) });
  const inv = await issueInvoice(s.tenant, { plan: 'standard', cycle, activatesPlan: true, actor: s.user.name });
  res.status(201).json({ invoice: publicInvoice(inv) });
}));

billingRouter.get('/invoices/:id/pdf', requireStaff('tenant.settings'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  const inv = await db.query.invoices.findFirst({ where: and(eq(invoices.id, req.params.id), eq(invoices.tenantId, tenant.id)) });
  if (!inv) throw new HttpError(404, 'Invoice not found');
  const pdf = await invoicePdf(inv, (await getPlatformSettings()).billing?.exportNote);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${inv.number.replace(/\//g, '-')}.pdf"`);
  res.send(pdf);
}));

/** Test mode only (no Razorpay keys, not production): pretend the payment went through. */
billingRouter.post('/invoices/:id/test-pay', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  if (razorpayLive() || env.isProd) throw new HttpError(403, 'Pay with the payment link');
  const inv = await db.query.invoices.findFirst({ where: and(eq(invoices.id, req.params.id), eq(invoices.tenantId, s.tenant.id)) });
  if (!inv) throw new HttpError(404, 'Invoice not found');
  res.json({ invoice: publicInvoice(await markPaid(inv, { ref: `TEST-${Date.now()}`, method: 'test payment', actor: s.user.name })) });
}));
