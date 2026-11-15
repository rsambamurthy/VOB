/**
 * Ongoing risk monitoring. Each supplier gets a risk score (0–100, higher = riskier) and a band, from signals
 * VendorGate already knows: verification results, duplicates, bank changes, questionnaire results, expired
 * documents, performance, outstanding agreements… Approved suppliers' registration status (GSTIN, CR) and
 * sanctions screening are re-checked every few weeks (checks marked `monitor` in the country packs).
 *
 * A serious ("critical") hit — registration cancelled or not found, a sanctions match, the bank account of
 * another supplier — makes the supplier High risk, alerts the people chosen, and with the workspace switch on
 * puts the supplier on hold (payment and PO hold in the ERP) until a person reviews it.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';
import type { Profile } from '../lib/profileEngine.js';
import { checkDef, checkInputs, checksForVendor, inputsComplete } from '../countries/registry.js';
import { latestChecks, runKyc } from '../integrations/kyc/index.js';
import { changeDuplicates, duplicatesOf, duplicateText } from './duplicates.js';
import { agreementsFor } from './agreements.js';
import { responseHistory } from './questionnaires.js';
import { scorecardFor } from './scorecards.js';
import { usersWithPermission } from './approvers.js';
import { applySystemHold } from './lifecycle.js';
import { defineJob } from '../jobs/queue.js';
import type { Tenant, Vendor } from '../db/schema.js';

const { vendors, changeRequests, auditLogs, documents } = schema;
const DAY = 86_400_000;
export type Band = 'LOW' | 'MEDIUM' | 'HIGH';
export interface Signal { code: string; label: string; points: number; critical?: boolean }
export const DEFAULT_MONITOR_DAYS = 30;
export const riskSettings = (t: Pick<Tenant, 'settings'>) => ({ monitorDays: DEFAULT_MONITOR_DAYS, autoHold: false, alertEmails: '', ...(t.settings.risk ?? {}) });

/** Score → band. Any critical signal is High whatever the score. */
export function bandOf(score: number, signals: Signal[]): Band {
  if (signals.some((s) => s.critical) || score >= 50) return 'HIGH';
  return score >= 25 ? 'MEDIUM' : 'LOW';
}

/** Is the GST / registration result active? (VERIFIED, and a status, when given, that isn't cancelled or suspended.) */
const inactive = (c: { status: string; data: Record<string, string> | null }) => {
  if (c.status !== 'VERIFIED') return true;
  const st = (c.data?.gstStatus ?? c.data?.status ?? c.data?.crStatus ?? '').toLowerCase();
  return /cancel|suspend|inactive|expired|struck/.test(st);
};

/** All the signals for one supplier. */
export async function signalsFor(tenant: Tenant, v: Vendor): Promise<Signal[]> {
  const out: Signal[] = [];
  const now = Date.now();
  // Verifications (latest result of each kind).
  for (const c of await latestChecks(v.id)) {
    const def = checkDef(c.kind)?.def;
    if (!def || c.status === 'ERROR') continue;
    if (def.monitor === 'critical' && inactive(c)) out.push({ code: `check.${c.kind}`, label: `${def.label}: ${c.message}`, points: 60, critical: true });
    else if (c.status !== 'VERIFIED') out.push({ code: `check.${c.kind}`, label: `${def.label}: ${c.message}`, points: 15 });
    else if (c.nameMatch !== null && c.nameMatch < 70) out.push({ code: `name.${c.kind}`, label: `${def.label}: name on record “${c.nameOnRecord}” doesn’t match`, points: 10 });
  }
  // Same tax number or bank account as another supplier.
  const dups = await duplicatesOf(v);
  if (dups.length) {
    const bank = dups.some((d) => d.matches.some((m) => /bank|IBAN/i.test(m)));
    out.push({ code: 'duplicate', label: `Possible duplicate of ${duplicateText(dups)}`, points: bank ? 40 : 25, critical: bank && v.status === 'APPROVED' });
  }
  // Bank details changed recently, or often.
  const bankChanges = (await db.select({ decidedAt: changeRequests.decidedAt, changes: changeRequests.changes }).from(changeRequests)
    .where(and(eq(changeRequests.vendorId, v.id), eq(changeRequests.status, 'APPROVED'), gte(changeRequests.decidedAt, new Date(now - 365 * DAY)))))
    .filter((c) => (c.changes as { fieldId: string }[]).some((x) => x.fieldId.startsWith('bank.')));
  if (bankChanges.some((c) => c.decidedAt && now - c.decidedAt.getTime() < 90 * DAY)) out.push({ code: 'bankChanged', label: 'Bank details changed in the last 90 days', points: 10 });
  if (bankChanges.length >= 2) out.push({ code: 'bankChangedOften', label: `Bank details changed ${bankChanges.length} times in 12 months`, points: 15 });
  // Contact email changed recently (often paired with bank-change fraud).
  const contact = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.vendorId, v.id), eq(auditLogs.action, 'CONTACT_EMAIL_CHANGED'), gte(auditLogs.createdAt, new Date(now - 30 * DAY)))).limit(1);
  if (contact.length) out.push({ code: 'contactChanged', label: 'Contact email changed in the last 30 days', points: 5 });
  // Questionnaires: latest result of each.
  const seen = new Set<string>();
  for (const r of await responseHistory(v.id)) {
    if (seen.has(r.questionnaireId)) continue;
    seen.add(r.questionnaireId);
    if (r.band === 'HIGH') out.push({ code: `questionnaire.${r.questionnaireId}`, label: `High-risk questionnaire answers${(r.knockouts as string[] | null)?.length ? ' (knock-out answer)' : ''}`, points: 25 });
    else if (r.band === 'MEDIUM') out.push({ code: `questionnaire.${r.questionnaireId}`, label: 'Medium-risk questionnaire answers', points: 10 });
  }
  // Documents.
  const today = new Date().toISOString().slice(0, 10), soon = new Date(now + 30 * DAY).toISOString().slice(0, 10);
  const docs = await db.select({ expiresOn: documents.expiresOn }).from(documents).where(and(eq(documents.vendorId, v.id), eq(documents.status, 'ACTIVE')));
  const expired = docs.filter((d) => d.expiresOn && d.expiresOn < today).length, expiring = docs.filter((d) => d.expiresOn && d.expiresOn >= today && d.expiresOn <= soon).length;
  if (expired) out.push({ code: 'docsExpired', label: `${expired} document${expired > 1 ? 's' : ''} expired`, points: 15 });
  else if (expiring) out.push({ code: 'docsExpiring', label: `${expiring} document${expiring > 1 ? 's' : ''} expiring within 30 days`, points: 5 });
  if (v.status === 'APPROVED') {
    // Performance (scorecard over the last 90 days), outstanding agreements.
    const card = await scorecardFor(tenant, v.id, 90).catch(() => null);
    if (card?.score !== null && card?.score !== undefined && card.score < 70) out.push({ code: 'performance', label: `Poor performance: scorecard ${Math.round(card.score)} (grade ${card.grade})`, points: 15 });
    if ((await agreementsFor(v)).some((a) => a.required && a.outstanding)) out.push({ code: 'agreement', label: 'Agreement not accepted', points: 5 });
  }
  if (v.emailBouncedAt) out.push({ code: 'emailBouncing', label: 'Contact email bouncing', points: 5 });
  return out;
}

/** Recompute and store a supplier's risk; alert (and hold, when switched on) when it newly turns serious. */
export async function refreshRisk(vendorId: string, opts: { alert?: boolean } = { alert: true }) {
  const v = await db.query.vendors.findFirst({ where: eq(vendors.id, vendorId) });
  if (!v || v.erasedAt || v.status === 'REJECTED') return null;
  const tenant = (await db.query.tenants.findFirst({ where: eq(schema.tenants.id, v.tenantId) }))!;
  const signals = await signalsFor(tenant, v);
  const score = Math.min(100, signals.reduce((n, s) => n + s.points, 0));
  const band = bandOf(score, signals);
  const before = new Set(((v.riskSignals as Signal[] | null) ?? []).filter((s) => s.critical).map((s) => s.code));
  const newCritical = signals.filter((s) => s.critical && !before.has(s.code));
  await db.update(vendors).set({ riskScore: score, riskBand: band, riskSignals: signals, riskUpdatedAt: new Date() }).where(eq(vendors.id, v.id));
  const worse = band === 'HIGH' && v.riskBand !== 'HIGH';
  if ((worse || newCritical.length) && v.status === 'APPROVED') {
    await audit({ tenantId: v.tenantId, vendorId: v.id, actor: 'system (risk monitoring)', action: 'RISK_RAISED', detail: { band, score, from: v.riskBand ?? 'none', signals: (newCritical.length ? newCritical : signals).map((s) => s.label).join(' · ').slice(0, 500) } });
    const s = riskSettings(tenant);
    let held = false;
    if (s.autoHold && newCritical.length) held = !!(await applySystemHold(v.id, 'RISK', `Risk monitoring: ${newCritical.map((x) => x.label).join('; ')}`, 'system (risk monitoring)', { signals: newCritical.map((x) => x.label).join(' · ') }))?.isNew;
    if (opts.alert !== false) await alert(tenant, v, band, score, newCritical.length ? newCritical : signals, held);
  }
  return { score, band, signals };
}

async function alert(tenant: Tenant, v: Vendor, band: Band, score: number, signals: Signal[], held: boolean) {
  const s = riskSettings(tenant);
  const to = s.alertEmails ? s.alertEmails.split(/[,;\s]+/).filter(Boolean).map((email) => ({ email, name: '' })) : await usersWithPermission(tenant.id, 'vendors.block');
  for (const a of to.slice(0, 20)) {
    await sendMail({ tenantId: tenant.id, to: a.email, subject: `${held ? 'On hold — ' : ''}${band === 'HIGH' ? 'High' : band} risk: ${v.name}`,
      body: `Hello${a.name ? ` ${a.name}` : ''},\n\nRisk monitoring rated ${v.name} (${v.code}) ${band.toLowerCase()} risk (score ${score} of 100):\n\n- ${signals.map((x) => x.label).join('\n- ')}\n\n${held ? 'The supplier has been put on hold (payment and purchase-order hold in the ERP) until someone reviews it and unblocks it.\n\n' : ''}Open the supplier to review.`,
      link: `${env.appBaseUrl}/staff/vendors/${v.id}` });
  }
}

/* ---------------- Monitoring ---------------- */

/** Re-run the monitored checks (registration status, sanctions) for one supplier, then refresh its risk. */
export async function monitorVendor(v: Vendor, requestedBy = 'system (risk monitoring)') {
  const tenant = await db.query.tenants.findFirst({ where: eq(schema.tenants.id, v.tenantId) });
  for (const { def } of checksForVendor(tenant?.country, v.profile as Profile).filter((c) => c.def.monitor)) {
    const input = checkInputs(def, v.profile as Profile);
    if (inputsComplete(def, input)) await runKyc(v, def.kind, input, requestedBy).catch((err) => logger.warn({ err, vendor: v.id, kind: def.kind }, 'monitoring check failed'));
  }
  await db.update(vendors).set({ lastMonitoredAt: new Date() }).where(eq(vendors.id, v.id));
  return refreshRisk(v.id);
}

/** Daily: approved suppliers due for monitoring are re-checked; everyone else's risk is refreshed. */
export async function runRiskMonitoring(now = new Date(), limit = 300) {
  const tenants = await db.select().from(schema.tenants).where(eq(schema.tenants.status, 'ACTIVE'));
  let monitored = 0, refreshed = 0;
  for (const t of tenants) {
    const days = riskSettings(t).monitorDays;
    if (days > 0) {
      const due = await db.select().from(vendors).where(and(eq(vendors.tenantId, t.id), eq(vendors.status, 'APPROVED'), isNull(vendors.erasedAt),
        or(isNull(vendors.lastMonitoredAt), lt(vendors.lastMonitoredAt, new Date(now.getTime() - days * DAY))))).orderBy(asc(vendors.lastMonitoredAt)).limit(limit);
      for (const v of due) { await monitorVendor(v).catch((err) => logger.error({ err, vendor: v.id }, 'risk monitoring failed')); monitored++; }
    }
    const stale = await db.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.tenantId, t.id), inArray(vendors.status, ['APPROVED', 'UNDER_REVIEW']), isNull(vendors.erasedAt),
      or(isNull(vendors.riskUpdatedAt), lt(vendors.riskUpdatedAt, new Date(now.getTime() - DAY / 2))))).orderBy(asc(vendors.riskUpdatedAt)).limit(limit);
    for (const v of stale) { await refreshRisk(v.id).catch((err) => logger.error({ err, vendor: v.id }, 'risk refresh failed')); refreshed++; }
  }
  return { monitored, refreshed };
}

defineJob('risk.daily', async () => { logger.info(await runRiskMonitoring(), 'risk monitoring run'); }, { retryLimit: 1, expireInSeconds: 3600 });

/* ---------------- The Risk page ---------------- */

export async function riskOverview(tenantId: string, band?: Band) {
  const rows = await db.select({ id: vendors.id, code: vendors.code, name: vendors.name, status: vendors.status, vendorType: vendors.vendorType, riskScore: vendors.riskScore, riskBand: vendors.riskBand, riskSignals: vendors.riskSignals, riskUpdatedAt: vendors.riskUpdatedAt, lastMonitoredAt: vendors.lastMonitoredAt, blockedAt: vendors.blockedAt, blockSource: vendors.blockSource })
    .from(vendors).where(and(eq(vendors.tenantId, tenantId), inArray(vendors.status, ['APPROVED', 'UNDER_REVIEW']), isNull(vendors.erasedAt), ...(band ? [eq(vendors.riskBand, band)] : [])))
    .orderBy(desc(sql`coalesce(${vendors.riskScore}, -1)`), asc(vendors.name)).limit(500);
  const counts = await db.select({ band: vendors.riskBand, n: sql<number>`count(*)::int` }).from(vendors)
    .where(and(eq(vendors.tenantId, tenantId), inArray(vendors.status, ['APPROVED', 'UNDER_REVIEW']), isNull(vendors.erasedAt))).groupBy(vendors.riskBand);
  const held = await db.select({ n: sql<number>`count(*)::int` }).from(vendors).where(and(eq(vendors.tenantId, tenantId), eq(vendors.blockSource, 'RISK')));
  return { rows, counts: Object.fromEntries(counts.map((c) => [c.band ?? 'NONE', c.n])), heldByRisk: held[0].n };
}

/* ---------------- Bank-change risk (for reviewers of a change request) ---------------- */

/**
 * How risky a proposed bank change looks: another supplier's account, a recent contact-email change, a change
 * soon after approval or soon after the last one, a different bank country, a holder name that isn't the supplier.
 */
export async function bankChangeRisk(v: Vendor, changes: { fieldId: string; new: string; old?: string }[], raisedByBuyer: boolean) {
  const bank = changes.filter((c) => c.fieldId.startsWith('bank.'));
  if (!bank.length) return null;
  const now = Date.now();
  const reasons: Signal[] = [];
  const dups = await changeDuplicates(v.tenantId, v, changes);
  if (dups.length) reasons.push({ code: 'otherSupplier', label: `The new account belongs to ${duplicateText(dups)}`, points: 60, critical: true });
  const contact = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.vendorId, v.id), eq(auditLogs.action, 'CONTACT_EMAIL_CHANGED'), gte(auditLogs.createdAt, new Date(now - 30 * DAY)))).limit(1);
  if (contact.length) reasons.push({ code: 'contactChanged', label: 'The contact email was changed in the last 30 days', points: 25 });
  if (v.decidedAt && now - v.decidedAt.getTime() < 30 * DAY) reasons.push({ code: 'newSupplier', label: 'Supplier approved less than 30 days ago', points: 15 });
  const recent = (await db.select({ changes: changeRequests.changes }).from(changeRequests).where(and(eq(changeRequests.vendorId, v.id), eq(changeRequests.status, 'APPROVED'), gte(changeRequests.decidedAt, new Date(now - 180 * DAY)))))
    .some((c) => (c.changes as { fieldId: string }[]).some((x) => x.fieldId.startsWith('bank.')));
  if (recent) reasons.push({ code: 'recentChange', label: 'Bank details were already changed in the last 6 months', points: 20 });
  const country = bank.find((c) => c.fieldId === 'bank.bankCountry');
  if (country && country.new && country.new !== (v.profile as Profile).basic?.supplierCountry) reasons.push({ code: 'foreignBank', label: `New bank is in ${country.new}, not the supplier's country`, points: 20 });
  const holder = bank.find((c) => c.fieldId === 'bank.accountHolderName');
  const norm = (x: unknown) => String(x ?? '').toLowerCase().replace(/\b(pvt|private|ltd|limited|llc|llp|co|company|the)\b/g, '').replace(/[^a-z0-9؀-ۿ]/g, '');
  if (holder && holder.new && norm(holder.new) !== norm((v.profile as Profile).basic?.vendorName ?? v.name)) reasons.push({ code: 'holderName', label: `Account holder “${holder.new}” is not the supplier's name`, points: 25 });
  if (!raisedByBuyer && !reasons.length) return { band: 'LOW' as Band, score: 0, reasons };
  const score = Math.min(100, reasons.reduce((n, r) => n + r.points, 0));
  return { band: bandOf(score, reasons), score, reasons };
}
