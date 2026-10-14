/**
 * Subscription billing: GST tax invoices (CGST+SGST within the seller's state, IGST across states, zero-rated exports),
 * financial-year invoice numbers, PDF invoices, and payment through Razorpay payment links (or recorded manually).
 */
import crypto from 'node:crypto';
import PDFDocument from 'pdfkit';
import { and, desc, eq, inArray, like, lte, sql } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';
import { PLANS } from '../lib/plans.js';
import { getPlatformSettings } from '../platform/settings.js';
import { GST_STATES } from '../countries/in/gstStates.js';
import { gstinCheckChar } from '../lib/validators.js';
import { countryByIso } from '../countries/list.js';
import { defineJob } from '../jobs/queue.js';
import type { Invoice, InvoiceParty, PlatformBilling, Tenant, TenantBilling } from '../db/schema.js';

const { invoices, tenants } = schema;
const DAY = 86_400_000;

/* ---------- Helpers ---------- */

/** Indian financial year of a date, e.g. 2026-10-14 → "2026-27". */
export function financialYear(d: Date) {
  const ist = new Date(d.getTime() + 5.5 * 3600_000);
  const y = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}
export function addPeriod(start: Date, cycle: 'monthly' | 'yearly') {
  const d = new Date(start);
  if (cycle === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1); else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}
export const minor = (major: number) => Math.round(major * 100);
export const fmtAmount = (minorUnits: number, currency: string) => `${currency} ${(minorUnits / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function validGstin(g: string) {
  const v = g.trim().toUpperCase();
  return /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v) && gstinCheckChar(v.slice(0, 14)) === v[14];
}

/** How GST applies: same state → CGST + SGST; other Indian state → IGST; outside India → export (zero-rated). */
export function taxFor(subtotal: number, sellerState: string, buyer: { country: string; stateCode?: string }, rate: number) {
  if (buyer.country !== 'IN') return { taxMode: 'EXPORT' as const, cgst: 0, sgst: 0, igst: 0, taxRate: 0 };
  if (buyer.stateCode === sellerState) {
    const half = Math.round((subtotal * rate) / 200);
    return { taxMode: 'INTRA' as const, cgst: half, sgst: half, igst: 0, taxRate: rate };
  }
  return { taxMode: 'INTER' as const, cgst: 0, sgst: 0, igst: Math.round((subtotal * rate) / 100), taxRate: rate };
}

export const currencyFor = (b: TenantBilling) => ((b.country ?? 'IN') === 'IN' ? 'INR' : 'USD');
export function priceFor(cfg: PlatformBilling, currency: string, plan: string, cycle: 'monthly' | 'yearly') {
  const p = cfg.prices?.[currency]?.[plan]?.[cycle];
  return typeof p === 'number' && p > 0 ? p : null;
}

/** What is missing before invoices can be issued (seller side, then buyer side). */
export function billingProblems(cfg: PlatformBilling, b: TenantBilling) {
  const out: string[] = [];
  if (!cfg.seller?.name || !cfg.seller.address || !cfg.seller.stateCode) out.push('VendorGate’s own company details (platform console → Sign-up settings → Billing)');
  if (!b.legalName) out.push('the legal name to invoice');
  if (!b.address) out.push('the billing address');
  if (!b.email) out.push('the billing email');
  if ((b.country ?? 'IN') === 'IN' && !b.stateCode) out.push('the state (GST place of supply)');
  return out;
}

const party = (b: TenantBilling): InvoiceParty => ({
  name: b.legalName!, gstin: b.gstin || undefined, address: [b.address, b.city, b.postalCode].filter(Boolean).join(', '),
  country: b.country ?? 'IN', stateCode: b.stateCode, stateName: b.stateCode ? GST_STATES[b.stateCode] : undefined, email: b.email,
});

/* ---------- Issuing ---------- */

export async function issueInvoice(tenant: Tenant, opts: { plan: string; cycle: 'monthly' | 'yearly'; periodStart?: Date; activatesPlan?: boolean; actor: string; amountOverride?: number; note?: string }) {
  const settings = await getPlatformSettings();
  const cfg = settings.billing ?? {};
  const b = tenant.billing ?? {};
  const problems = billingProblems(cfg, b);
  if (problems.length) throw new HttpError(409, `Fill in ${problems.join(', ')} before invoicing`);
  const currency = currencyFor(b);
  const unit = opts.amountOverride ?? priceFor(cfg, currency, opts.plan, opts.cycle);
  if (!unit) throw new HttpError(409, `No ${opts.cycle} price set for the ${PLANS[opts.plan]?.label ?? opts.plan} plan in ${currency}`);
  const start = opts.periodStart ?? new Date();
  const end = addPeriod(start, opts.cycle);
  const subtotal = minor(unit);
  const rate = cfg.gstRate ?? 18;
  const tax = taxFor(subtotal, cfg.seller!.stateCode, { country: b.country ?? 'IN', stateCode: b.stateCode }, rate);
  const total = subtotal + tax.cgst + tax.sgst + tax.igst;
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const lines = [{ description: `VendorGate ${PLANS[opts.plan]?.label ?? opts.plan} plan — ${opts.cycle === 'yearly' ? 'annual' : 'monthly'} subscription, ${fmt(start)} to ${fmt(new Date(end.getTime() - DAY))}`, sac: cfg.sac ?? '997331', quantity: 1, unitPrice: subtotal, amount: subtotal }];
  const seller: InvoiceParty = { name: cfg.seller!.name, gstin: cfg.seller!.gstin, address: cfg.seller!.address, country: 'IN', stateCode: cfg.seller!.stateCode, stateName: GST_STATES[cfg.seller!.stateCode], email: cfg.seller!.email };

  const inv = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(424242)`);
    const prefix = `${cfg.prefix || 'VG'}/${financialYear(new Date())}/`;
    const [last] = await tx.select({ number: invoices.number }).from(invoices).where(like(invoices.number, `${prefix}%`)).orderBy(desc(invoices.number)).limit(1);
    const seq = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
    const [row] = await tx.insert(invoices).values({
      tenantId: tenant.id, number: `${prefix}${String(seq).padStart(4, '0')}`, plan: opts.plan, cycle: opts.cycle, periodStart: start, periodEnd: end,
      dueAt: new Date(Date.now() + (cfg.dueDays ?? 15) * DAY), currency, lines, subtotal, ...tax, total, seller, buyer: party(b),
      activatesPlan: !!opts.activatesPlan, notes: opts.note ?? null,
    }).returning();
    return row;
  });
  await attachPaymentLink(inv).catch((e) => logger.warn({ err: String(e), invoice: inv.number }, 'payment link not created'));
  const fresh = (await db.query.invoices.findFirst({ where: eq(invoices.id, inv.id) }))!;
  await audit({ tenantId: tenant.id, actor: opts.actor, action: 'INVOICE_ISSUED', detail: { number: fresh.number, total: fmtAmount(fresh.total, currency) } });
  if (b.email) await sendMail({ tenantId: tenant.id, to: b.email, subject: `Invoice ${fresh.number} for VendorGate`, body: `Invoice ${fresh.number} for ${fmtAmount(fresh.total, currency)} is ready, due ${fresh.dueAt.toISOString().slice(0, 10)}.\n\nYou can download it and pay online from Administration → Billing.`, link: `${env.appBaseUrl}/staff/admin/billing` });
  return fresh;
}

/* ---------- Razorpay ---------- */

export const razorpayLive = () => !!(env.int.RAZORPAY_KEY_ID && env.int.RAZORPAY_KEY_SECRET);
let rzFetch: typeof fetch = (...a) => fetch(...a);
/** Tests. */
export function setRazorpayFetch(f: typeof fetch) { rzFetch = f; }

async function attachPaymentLink(inv: Invoice) {
  if (!razorpayLive()) return;
  const auth = Buffer.from(`${env.int.RAZORPAY_KEY_ID}:${env.int.RAZORPAY_KEY_SECRET}`).toString('base64');
  const res = await rzFetch('https://api.razorpay.com/v1/payment_links', {
    method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      amount: inv.total, currency: inv.currency, accept_partial: false, reference_id: inv.number, description: `VendorGate invoice ${inv.number}`,
      customer: { name: inv.buyer.name, email: inv.buyer.email }, notify: { email: false, sms: false }, reminder_enable: false,
      callback_url: `${env.appBaseUrl}/staff/admin/billing?paid=${inv.id}`, callback_method: 'get', notes: { invoiceId: inv.id, tenantId: inv.tenantId },
    }),
  });
  const body = await res.json().catch(() => ({})) as { id?: string; short_url?: string; error?: { description?: string } };
  if (!res.ok || !body.id) throw new Error(body.error?.description ?? `Razorpay HTTP ${res.status}`);
  await db.update(invoices).set({ paymentLinkId: body.id, paymentLinkUrl: body.short_url ?? null }).where(eq(invoices.id, inv.id));
}

export function verifyRazorpaySignature(body: string, signature: string, secret: string) {
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/** Razorpay webhook: payment_link.paid → invoice paid. */
export async function handleRazorpayEvent(e: { event: string; payload?: Record<string, { entity?: Record<string, any> }> }) {
  if (e.event !== 'payment_link.paid') return 'ignored';
  const link = e.payload?.payment_link?.entity;
  const pay = e.payload?.payment?.entity;
  const inv = link?.id ? await db.query.invoices.findFirst({ where: eq(invoices.paymentLinkId, String(link.id)) }) : undefined;
  if (!inv) return 'unknown-invoice';
  await markPaid(inv, { ref: String(pay?.id ?? link?.id), method: `razorpay${pay?.method ? ` (${pay.method})` : ''}`, actor: 'Razorpay' });
  return 'paid';
}

/** Mark an invoice paid; an upgrade invoice switches the workspace to its plan. */
export async function markPaid(inv: Invoice, p: { ref: string; method: string; actor: string; paidAt?: Date }) {
  if (inv.status === 'PAID') return inv;
  if (inv.status === 'VOID') throw new HttpError(409, 'This invoice was cancelled');
  await db.update(invoices).set({ status: 'PAID', paidAt: p.paidAt ?? new Date(), paymentRef: p.ref.slice(0, 120), paymentMethod: p.method.slice(0, 60) }).where(eq(invoices.id, inv.id));
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, inv.tenantId) });
  if (tenant) {
    const billing = { ...tenant.billing, cycle: inv.cycle as 'monthly' | 'yearly', nextInvoiceOn: inv.periodEnd.toISOString().slice(0, 10), autoInvoice: tenant.billing.autoInvoice ?? true };
    await db.update(tenants).set({ billing, ...(inv.activatesPlan && tenant.plan !== inv.plan ? { plan: inv.plan, trialEndsAt: null } : {}), ...(tenant.status === 'SUSPENDED' && tenant.statusReason?.startsWith('Unpaid') ? { status: 'ACTIVE' as const, statusReason: null } : {}) }).where(eq(tenants.id, tenant.id));
    if (inv.activatesPlan && tenant.plan !== inv.plan) await audit({ tenantId: tenant.id, actor: p.actor, action: 'PLAN_CHANGED', detail: { from: tenant.plan, to: inv.plan, invoice: inv.number } });
    await audit({ tenantId: tenant.id, actor: p.actor, action: 'INVOICE_PAID', detail: { number: inv.number, method: p.method } });
  }
  return (await db.query.invoices.findFirst({ where: eq(invoices.id, inv.id) }))!;
}

export async function voidInvoice(inv: Invoice, actor: string, reason: string) {
  if (inv.status === 'PAID') throw new HttpError(409, 'A paid invoice can’t be cancelled — issue a credit note instead');
  await db.update(invoices).set({ status: 'VOID', notes: `${inv.notes ? `${inv.notes}\n` : ''}Cancelled: ${reason}` }).where(eq(invoices.id, inv.id));
  await audit({ tenantId: inv.tenantId, actor, action: 'INVOICE_VOIDED', detail: { number: inv.number, reason } });
}

/* ---------- Daily run: renewals and reminders ---------- */

export async function runBillingDaily(now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const due = await db.select().from(tenants).where(and(eq(tenants.status, 'ACTIVE'), inArray(tenants.plan, ['standard', 'enterprise']), sql`${tenants.billing}->>'autoInvoice' = 'true'`, sql`${tenants.billing}->>'nextInvoiceOn' <= ${today}`));
  let issued = 0;
  for (const t of due) {
    const open = await db.query.invoices.findFirst({ where: and(eq(invoices.tenantId, t.id), eq(invoices.status, 'DUE'), sql`${invoices.periodStart}::date = ${t.billing.nextInvoiceOn}::date`) });
    if (open) continue;
    try {
      await issueInvoice(t, { plan: t.plan, cycle: t.billing.cycle ?? 'monthly', periodStart: new Date(`${t.billing.nextInvoiceOn}T00:00:00Z`), actor: 'system (renewal)' });
      await db.update(tenants).set({ billing: { ...t.billing, nextInvoiceOn: addPeriod(new Date(`${t.billing.nextInvoiceOn}T00:00:00Z`), t.billing.cycle ?? 'monthly').toISOString().slice(0, 10) } }).where(eq(tenants.id, t.id));
      issued++;
    } catch (e) { logger.warn({ tenant: t.slug, err: String(e) }, 'renewal invoice not issued'); }
  }
  // Reminders: the day after the due date, then 7 days after.
  const overdue = await db.select().from(invoices).where(and(eq(invoices.status, 'DUE'), lte(invoices.dueAt, now)));
  let reminded = 0;
  for (const inv of overdue) {
    const daysLate = Math.floor((now.getTime() - inv.dueAt.getTime()) / DAY);
    const want = daysLate >= 7 ? 2 : daysLate >= 1 ? 1 : 0;
    if (want <= inv.remindersSent || !inv.buyer.email) continue;
    await sendMail({ tenantId: inv.tenantId, to: inv.buyer.email, subject: `Reminder: invoice ${inv.number} is overdue`, body: `Invoice ${inv.number} for ${fmtAmount(inv.total, inv.currency)} was due on ${inv.dueAt.toISOString().slice(0, 10)}. Please pay it from Administration → Billing.`, link: `${env.appBaseUrl}/staff/admin/billing` });
    await db.update(invoices).set({ remindersSent: want }).where(eq(invoices.id, inv.id));
    reminded++;
  }
  return { issued, reminded };
}

defineJob('billing.daily', async () => { logger.info(await runBillingDaily(), 'billing daily run'); }, { retryLimit: 1, expireInSeconds: 1800 });

/* ---------- PDF ---------- */

const words = (n: number): string => {
  const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const t = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (x: number) => (x < 20 ? a[x] : `${t[Math.floor(x / 10)]}${x % 10 ? ` ${a[x % 10]}` : ''}`);
  const three = (x: number) => `${x >= 100 ? `${a[Math.floor(x / 100)]} Hundred${x % 100 ? ' ' : ''}` : ''}${x % 100 ? two(x % 100) : ''}`;
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7), lakh = Math.floor((n % 1e7) / 1e5), thousand = Math.floor((n % 1e5) / 1000), rest = n % 1000;
  if (crore) parts.push(`${words(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (rest) parts.push(three(rest));
  return parts.join(' ');
};
export const amountInWords = (minorUnits: number, currency: string) => {
  const major = Math.floor(minorUnits / 100), cents = minorUnits % 100;
  const unit = currency === 'INR' ? ['Rupees', 'Paise'] : [currency, 'Cents'];
  return `${unit[0]} ${words(major)}${cents ? ` and ${words(cents)} ${unit[1]}` : ''} only`;
};

export async function invoicePdf(inv: Invoice, exportNote?: string): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Invoice ${inv.number}`, Author: inv.seller.name } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  const navy = '#1f2758', grey = '#555555';
  const money = (v: number) => fmtAmount(v, inv.currency);
  const d = (x: Date) => x.toISOString().slice(0, 10);

  doc.fillColor(navy).font('Helvetica-Bold').fontSize(18).text(inv.taxMode === 'EXPORT' ? 'TAX INVOICE (EXPORT OF SERVICES)' : 'TAX INVOICE', { align: 'right' });
  doc.fontSize(10).font('Helvetica').fillColor(grey).text(`Invoice no. ${inv.number}`, { align: 'right' }).text(`Date ${d(inv.issuedAt)} · Due ${d(inv.dueAt)}`, { align: 'right' });
  if (inv.status !== 'DUE') doc.fillColor(inv.status === 'PAID' ? '#1a7f37' : '#b42318').font('Helvetica-Bold').text(inv.status === 'PAID' ? `PAID ${inv.paidAt ? d(inv.paidAt) : ''}` : 'CANCELLED', { align: 'right' });
  doc.moveDown(1);

  const top = doc.y;
  const block = (title: string, p: InvoiceParty, x: number) => {
    doc.fillColor(navy).font('Helvetica-Bold').fontSize(9).text(title, x, top, { width: 240 });
    doc.fillColor('#111111').font('Helvetica-Bold').fontSize(10).text(p.name, x, doc.y, { width: 240 });
    doc.font('Helvetica').fontSize(9).fillColor(grey).text(p.address, { width: 240 });
    if (p.stateName) doc.text(`State: ${p.stateName} (${p.stateCode})`, { width: 240 });
    if (p.country !== 'IN') doc.text(`Country: ${countryByIso(p.country)?.name ?? p.country}`, { width: 240 });
    if (p.gstin) doc.text(`GSTIN: ${p.gstin}`, { width: 240 });
    if (p.email) doc.text(p.email, { width: 240 });
    return doc.y;
  };
  const y1 = block('FROM', inv.seller, 48);
  const y2 = block('BILL TO', inv.buyer, 310);
  doc.y = Math.max(y1, y2) + 10;
  doc.x = 48;
  doc.fontSize(9).fillColor(grey).text(`Place of supply: ${inv.buyer.country === 'IN' ? `${inv.buyer.stateName} (${inv.buyer.stateCode})` : `Outside India (${inv.buyer.country})`}`);
  doc.moveDown(0.8);

  // Lines
  const cols = [48, 300, 360, 410, 480];
  const rowY = doc.y;
  doc.rect(48, rowY - 4, 500, 18).fill(navy);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9);
  ['Description', 'SAC', 'Qty', 'Rate', 'Amount'].forEach((h, i) => doc.text(h, cols[i] + 4, rowY, { width: i ? 70 : 250, align: i >= 3 ? 'right' : 'left' }));
  doc.fillColor('#111111').font('Helvetica').fontSize(9);
  let y = rowY + 20;
  for (const l of inv.lines) {
    doc.text(l.description, cols[0] + 4, y, { width: 245 });
    const h = doc.y - y;
    doc.text(l.sac, cols[1] + 4, y, { width: 55 }).text(String(l.quantity), cols[2] + 4, y, { width: 45 })
      .text(money(l.unitPrice).replace(`${inv.currency} `, ''), cols[3] + 4, y, { width: 66, align: 'right' }).text(money(l.amount).replace(`${inv.currency} `, ''), cols[4] + 4, y, { width: 64, align: 'right' });
    y += Math.max(h, 12) + 8;
  }
  doc.moveTo(48, y).lineTo(548, y).strokeColor('#dddddd').stroke();
  y += 8;
  const sumRow = (label: string, v: number, bold = false) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9).fillColor('#111111').text(label, 330, y, { width: 140, align: 'right' }).text(money(v), 470, y, { width: 78, align: 'right' }); y += bold ? 18 : 14; };
  sumRow('Taxable value', inv.subtotal);
  if (inv.taxMode === 'INTRA') { sumRow(`CGST ${inv.taxRate / 2}%`, inv.cgst); sumRow(`SGST ${inv.taxRate / 2}%`, inv.sgst); }
  else if (inv.taxMode === 'INTER') sumRow(`IGST ${inv.taxRate}%`, inv.igst);
  else sumRow('IGST 0% (export)', 0);
  sumRow('Total', inv.total, true);
  doc.font('Helvetica-Oblique').fontSize(9).fillColor(grey).text(amountInWords(inv.total, inv.currency), 48, y + 4, { width: 500 });
  doc.moveDown(1.2);
  if (inv.taxMode === 'EXPORT') doc.font('Helvetica').text(exportNote || 'Supply meant for export of services under LUT without payment of integrated tax.', { width: 500 });
  doc.font('Helvetica').fontSize(9).fillColor(grey).text('Whether tax is payable on reverse charge: No', { width: 500 });
  if (inv.paymentLinkUrl && inv.status === 'DUE') doc.moveDown(0.5).fillColor(navy).text(`Pay online: ${inv.paymentLinkUrl}`, { link: inv.paymentLinkUrl, underline: true });
  if (inv.notes) doc.moveDown(0.5).fillColor(grey).text(inv.notes, { width: 500 });
  doc.moveDown(2).fillColor(grey).fontSize(8).text(`This is a computer-generated invoice from ${inv.seller.name}. VendorGate is a product of ${inv.seller.name}.`, { width: 500, align: 'center' });
  doc.end();
  return done;
}
