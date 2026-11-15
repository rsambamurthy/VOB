/**
 * Corrective actions: what a buyer asks a supplier to fix after a finding, with a due date and evidence.
 *  - VendorGate suggests actions from findings (questionnaire knock-outs, failed re-checks, expired certificates,
 *    poor performance, names that don't match); staff confirm, edit or add their own.
 *  - Raised while the supplier is under review they are conditions of approval; afterwards, ongoing remediation.
 *  - The supplier answers with a note and files; whoever raised it (or anyone with actions.manage) accepts or rejects.
 *  - Daily: reminders before and after the due date; overdue actions raise the risk score and, when the workspace
 *    switches it on, a high-priority overdue action puts an approved supplier on hold (applySystemHold, like risk).
 */
import { and, asc, desc, eq, inArray, lt, lte, ne, or, isNull, sql } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';
import { sendMail } from '../lib/mailer.js';
import { checkDef } from '../countries/registry.js';
import { latestChecks } from '../integrations/kyc/index.js';
import { storeUpload } from '../integrations/storage/index.js';
import { defineJob } from '../jobs/queue.js';
import type { Tenant, Vendor } from '../db/schema.js';
import { getConfig } from './config.js';
import { responseHistory } from './questionnaires.js';
import { scorecardFor } from './scorecards.js';
import { applySystemHold } from './lifecycle.js';

const { correctiveActions: actions, vendors, documents, users } = schema;
const DAY = 86_400_000;
export type Priority = 'HIGH' | 'MEDIUM' | 'LOW';
export type Action = typeof actions.$inferSelect;
export interface Suggestion { source: string; sourceLabel: string; title: string; description: string; priority: Priority; dueInDays: number }
const OPEN_STATUSES = ['OPEN', 'SUBMITTED'];
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
export const isOverdue = (a: Pick<Action, 'status' | 'dueOn'>) => a.status === 'OPEN' && a.dueOn < today();

/* ---------------- Suggestions ---------------- */

/** Actions VendorGate would suggest from what it knows, leaving out ones already open for the same finding. */
export async function suggestActions(tenant: Tenant, v: Vendor): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  // Questionnaires: each knock-out answer, else a high-risk result.
  const seen = new Set<string>();
  const history = await responseHistory(v.id);
  const titles = new Map((history.length ? await db.select({ id: schema.questionnaires.id, title: schema.questionnaires.title }).from(schema.questionnaires).where(inArray(schema.questionnaires.id, [...new Set(history.map((h) => h.questionnaireId))])) : []).map((q) => [q.id, q.title]));
  for (const r of history) {
    if (seen.has(r.questionnaireId)) continue;
    seen.add(r.questionnaireId);
    const title = titles.get(r.questionnaireId) ?? 'questionnaire';
    const qs = (r.questions as { id: string; text: string; options?: { value?: string; label: string }[] }[] | null) ?? [];
    const answers = (r.answers ?? {}) as Record<string, unknown>;
    const kos = (r.knockouts as string[] | null) ?? [];
    for (const id of kos) {
      const q = qs.find((x) => x.id === id);
      if (!q) continue;
      const ans = String(answers[id] ?? '');
      const label = q.options?.find((o) => (o.value ?? o.label) === ans)?.label ?? ans;
      out.push({ source: `questionnaire:${r.questionnaireId}:${id}`, sourceLabel: `${title}: knock-out answer`, priority: 'HIGH', dueInDays: 30,
        title: `Address your answer to “${q.text}”`, description: `In the ${title} you answered “${label}”. Tell us what you are doing about it and attach evidence (for example a policy, certificate or action plan).` });
    }
    if (!kos.length && r.band === 'HIGH') out.push({ source: `questionnaire:${r.questionnaireId}`, sourceLabel: `${title}: high risk`, priority: 'MEDIUM', dueInDays: 30,
      title: `Reduce the risks found in the ${title}`, description: `Your answers to the ${title} show high risk. Send a short plan for the main points, with evidence of what is already done.` });
  }
  // Verifications: registration inactive or not found; name on record that doesn't match.
  const { inactive } = await import('./risk.js');
  for (const c of await latestChecks(v.id)) {
    const def = checkDef(c.kind)?.def;
    if (!def || c.status === 'ERROR') continue;
    if (def.monitor === 'critical' && inactive(c)) out.push({ source: `check:${c.kind}`, sourceLabel: `${def.label} check`, priority: 'HIGH', dueInDays: 14,
      title: `Restore your ${def.label} registration`, description: `Our ${def.label} check found: ${c.message}. Send proof that the registration is active again (for example the registration certificate or a recent status printout).` });
    else if (c.status === 'VERIFIED' && c.nameMatch !== null && c.nameMatch < 70) out.push({ source: `name:${c.kind}`, sourceLabel: `${def.label}: name on record`, priority: 'LOW', dueInDays: 30,
      title: `Explain the name on your ${def.label} record`, description: `The name on record is “${c.nameOnRecord}”, which differs from your company name. Explain why, or update the record and send proof.` });
  }
  // Documents that have expired.
  const config = await getConfig(tenant.id);
  for (const d of await db.select({ docType: documents.docType, expiresOn: documents.expiresOn }).from(documents).where(and(eq(documents.vendorId, v.id), eq(documents.status, 'ACTIVE'), lt(documents.expiresOn, today())))) {
    const label = config.documents.find((x) => x.type === d.docType)?.label ?? d.docType;
    out.push({ source: `document:${d.docType}`, sourceLabel: `${label} expired`, priority: 'MEDIUM', dueInDays: 14, title: `Upload a renewed ${label}`, description: `Your ${label} expired on ${new Date(`${d.expiresOn}T12:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })}. Attach the renewed one here (it also replaces the expired one under Documents when you upload it there).` });
  }
  // Performance.
  if (v.status === 'APPROVED') {
    const card = await scorecardFor(tenant, v.id, 90).catch(() => null);
    if (card?.score !== null && card?.score !== undefined && card.score < 70) out.push({ source: 'scorecard', sourceLabel: `Scorecard ${Math.round(card.score)} (grade ${card.grade})`, priority: 'MEDIUM', dueInDays: 30,
      title: 'Improve delivery and quality performance', description: `Your scorecard over the last 90 days is ${Math.round(card.score)} (grade ${card.grade}). Send an improvement plan: causes, actions and dates.` });
  }
  const open = new Set((await db.select({ source: actions.source }).from(actions).where(and(eq(actions.vendorId, v.id), inArray(actions.status, OPEN_STATUSES)))).map((a) => a.source));
  return out.filter((s) => !open.has(s.source));
}

/* ---------------- Raising ---------------- */

export interface Staff { id: string; name: string; email?: string; ip?: string }
export const actionInput = (x: { title: string; description?: string | null; priority: Priority; dueOn: string; source?: string; sourceLabel?: string | null }) => x;

/** Raise one or more actions; the supplier is emailed once with all of them. */
export async function raiseActions(tenant: Tenant, v: Vendor, items: ReturnType<typeof actionInput>[], by: Staff) {
  if (!items.length) throw new HttpError(400, 'Add at least one action');
  if (!['UNDER_REVIEW', 'APPROVED', 'SENT_BACK', 'IN_PROGRESS'].includes(v.status) || v.erasedAt) throw new HttpError(409, 'Corrective actions can be raised on suppliers under review or approved');
  for (const i of items) if (i.dueOn < today()) throw new HttpError(400, `“${i.title}”: the due date is in the past`);
  const condition = v.status !== 'APPROVED';
  const rows = await db.insert(actions).values(items.map((i) => ({ tenantId: tenant.id, vendorId: v.id, title: i.title, description: i.description || null, priority: i.priority, dueOn: i.dueOn,
    source: i.source || 'manual', sourceLabel: i.sourceLabel || null, condition, raisedById: by.id, raisedByName: by.name }))).returning();
  await audit({ tenantId: tenant.id, vendorId: v.id, actor: by.name, action: 'CORRECTIVE_ACTIONS_RAISED', detail: { actions: rows.map((r) => `${r.title} (due ${r.dueOn})`).join(' · ').slice(0, 500), ...(condition ? { condition: 'yes' } : {}) }, ip: by.ip });
  await mailSupplierAbout(tenant, v, 'actionsRequested', {}, rows);
  await refresh(v.id);
  return rows;
}

async function mailSupplierAbout(tenant: Tenant, v: Vendor, key: 'actionsRequested' | 'actionRejected' | 'actionReminder' | 'actionOverdue', vars: Record<string, string>, list: Action[] = []) {
  const { mailSupplier, mailDate } = await import('../i18n/emails.js');
  const { vendorLanguage } = await import('../i18n/index.js');
  const { portalLink } = await import('./vendors.js');
  const lang = vendorLanguage(tenant, v);
  await mailSupplier(lang, { tenantId: tenant.id, to: v.contactEmail, link: portalLink(v) }, key, { first: v.contactFirstName, buyer: tenant.name, ...vars,
    ...(vars.due ? { due: mailDate(vars.due, lang) } : {}), ...(list.length ? { list: list.map((r) => `- ${r.title} (${mailDate(r.dueOn, lang)})`).join('\n') } : {}) });
}
async function refresh(vendorId: string) {
  const { refreshRisk } = await import('./risk.js');
  await refreshRisk(vendorId, { alert: false }).catch((err) => logger.warn({ err, vendor: vendorId }, 'risk refresh after corrective action failed'));
}

/* ---------------- The supplier's answer ---------------- */

async function mine(v: Vendor, actionId: string) {
  const a = await db.query.correctiveActions.findFirst({ where: and(eq(actions.id, actionId), eq(actions.vendorId, v.id)) });
  if (!a || a.status === 'CANCELLED') throw new HttpError(404, 'Action not found');
  return a;
}
const editable = (a: Action) => { if (a.status !== 'OPEN') throw new HttpError(409, a.status === 'SUBMITTED' ? 'Your answer is with the buyer for review' : 'This action is closed'); };

/** Save the supplier's note (draft). */
export async function saveResponse(v: Vendor, actionId: string, note: string) {
  const a = await mine(v, actionId); editable(a);
  await db.update(actions).set({ responseNote: note || null, updatedAt: new Date() }).where(eq(actions.id, a.id));
}

/** Attach a file as evidence (kept on the supplier as an attachment, outside the documents checklist). */
export async function attachEvidence(v: Vendor, actionId: string, file: { buffer: Buffer; originalname: string }, uploadedById?: string) {
  const a = await mine(v, actionId); editable(a);
  if (a.evidence.length >= 10) throw new HttpError(400, 'Up to 10 files per action');
  const stored = await storeUpload(v.tenantId, v.id, file);
  const [doc] = await db.insert(documents).values({ tenantId: v.tenantId, vendorId: v.id, docType: 'CORRECTIVE_ACTION', ...stored, status: 'ATTACHMENT', ...(uploadedById ? { uploadedById } : {}) }).returning();
  await db.update(actions).set({ evidence: [...a.evidence, { documentId: doc.id, fileName: doc.fileName }], updatedAt: new Date() }).where(eq(actions.id, a.id));
}
export async function removeEvidence(v: Vendor, actionId: string, documentId: string) {
  const a = await mine(v, actionId); editable(a);
  await db.update(actions).set({ evidence: a.evidence.filter((e) => e.documentId !== documentId), updatedAt: new Date() }).where(eq(actions.id, a.id));
}

/** Send the answer for review; whoever raised the action is told. */
export async function submitResponse(tenant: Tenant, v: Vendor, actionId: string, note: string | undefined, actor: { name: string; ip?: string }) {
  const a = await mine(v, actionId); editable(a);
  const responseNote = (note ?? a.responseNote ?? '').trim();
  if (!responseNote && !a.evidence.length) throw new HttpError(400, 'Add a note or attach evidence');
  await db.update(actions).set({ status: 'SUBMITTED', responseNote: responseNote || null, submittedAt: new Date(), submittedByName: actor.name, updatedAt: new Date() }).where(eq(actions.id, a.id));
  await audit({ tenantId: tenant.id, vendorId: v.id, actor: actor.name, action: 'CORRECTIVE_ACTION_ANSWERED', detail: { action: a.title, files: a.evidence.length }, ip: actor.ip });
  const raiser = a.raisedById ? await db.query.users.findFirst({ where: eq(users.id, a.raisedById) }) : null;
  if (raiser?.status === 'ACTIVE') await sendMail({ tenantId: tenant.id, to: raiser.email, subject: `Evidence to review: ${v.name} — ${a.title}`,
    body: `Hello ${raiser.name},\n\n${v.name} (${v.code}) answered the corrective action “${a.title}”${a.evidence.length ? ` and attached ${a.evidence.length} file${a.evidence.length > 1 ? 's' : ''}` : ''}.\n\nOpen the supplier to accept or reject it.`,
    link: `${env.appBaseUrl}/staff/vendors/${v.id}?tab=actions` });
}

/* ---------------- Review ---------------- */

/** Who may review: whoever raised it, or anyone with actions.manage. */
export const canReview = (a: Pick<Action, 'raisedById'>, staff: { id: string; permissions: Set<string> }) => a.raisedById === staff.id || staff.permissions.has('actions.manage');

async function staffAction(tenantId: string, actionId: string) {
  const a = await db.query.correctiveActions.findFirst({ where: and(eq(actions.id, actionId), eq(actions.tenantId, tenantId)) });
  if (!a) throw new HttpError(404, 'Action not found');
  return a;
}

export async function reviewAction(tenant: Tenant, actionId: string, input: { decision: 'ACCEPT' | 'REJECT'; remarks?: string }, staff: Staff & { permissions: Set<string> }) {
  const a = await staffAction(tenant.id, actionId);
  if (!canReview(a, staff)) throw new HttpError(403, 'Only the person who raised this action, or someone allowed to manage corrective actions, can review it');
  if (a.status !== 'SUBMITTED') throw new HttpError(409, 'There is no answer to review');
  if (input.decision === 'REJECT' && !input.remarks?.trim()) throw new HttpError(400, 'Say what is still missing, so the supplier can fix it');
  const v = (await db.query.vendors.findFirst({ where: eq(vendors.id, a.vendorId) }))!;
  await db.update(actions).set({ status: input.decision === 'ACCEPT' ? 'ACCEPTED' : 'OPEN', reviewedByName: staff.name, reviewedAt: new Date(), reviewRemarks: input.remarks?.trim() || null, updatedAt: new Date(),
    ...(input.decision === 'REJECT' ? { remindedAt: null, overdueNotifiedAt: null } : {}) }).where(eq(actions.id, a.id));
  await audit({ tenantId: tenant.id, vendorId: v.id, actor: staff.name, action: input.decision === 'ACCEPT' ? 'CORRECTIVE_ACTION_ACCEPTED' : 'CORRECTIVE_ACTION_REJECTED', detail: { action: a.title, ...(input.remarks ? { remarks: input.remarks.slice(0, 300) } : {}) }, ip: staff.ip });
  if (input.decision === 'REJECT') await mailSupplierAbout(tenant, v, 'actionRejected', { action: a.title, remarks: input.remarks!.trim() });
  await refresh(v.id);
}

/** Change the due date or priority, or cancel (no longer needed). */
export async function updateAction(tenant: Tenant, actionId: string, input: { dueOn?: string; priority?: Priority; cancel?: boolean; reason?: string }, staff: Staff & { permissions: Set<string> }) {
  const a = await staffAction(tenant.id, actionId);
  if (!canReview(a, staff)) throw new HttpError(403, 'Only the person who raised this action, or someone allowed to manage corrective actions, can change it');
  if (!OPEN_STATUSES.includes(a.status)) throw new HttpError(409, 'This action is closed');
  if (input.dueOn && input.dueOn < today()) throw new HttpError(400, 'The due date is in the past');
  await db.update(actions).set({ ...(input.cancel ? { status: 'CANCELLED', reviewRemarks: input.reason?.trim() || null, reviewedByName: staff.name, reviewedAt: new Date() } : {}),
    ...(input.dueOn ? { dueOn: input.dueOn, remindedAt: null, overdueNotifiedAt: null } : {}), ...(input.priority ? { priority: input.priority } : {}), updatedAt: new Date() }).where(eq(actions.id, a.id));
  await audit({ tenantId: tenant.id, vendorId: a.vendorId, actor: staff.name, action: input.cancel ? 'CORRECTIVE_ACTION_CANCELLED' : 'CORRECTIVE_ACTION_CHANGED', detail: { action: a.title, ...(input.dueOn ? { dueOn: input.dueOn } : {}), ...(input.priority ? { priority: input.priority } : {}), ...(input.reason ? { reason: input.reason.slice(0, 300) } : {}) }, ip: staff.ip });
  await refresh(a.vendorId);
}

/* ---------------- Views ---------------- */

/** A supplier's actions (cancelled ones left out for the supplier), open first. */
export async function actionsFor(vendorId: string, opts: { forSupplier?: boolean } = {}) {
  const rows = await db.select().from(actions).where(and(eq(actions.vendorId, vendorId), ...(opts.forSupplier ? [ne(actions.status, 'CANCELLED')] : []))).orderBy(asc(actions.dueOn));
  const rank: Record<string, number> = { OPEN: 0, SUBMITTED: 1, ACCEPTED: 2, CANCELLED: 3 };
  return rows.sort((x, y) => rank[x.status] - rank[y.status]).map((a) => ({
    id: a.id, title: a.title, description: a.description, priority: a.priority, dueOn: a.dueOn, status: a.status, overdue: isOverdue(a), condition: a.condition,
    rejected: a.status === 'OPEN' && !!a.reviewedAt, reviewRemarks: a.reviewRemarks, responseNote: a.responseNote, evidence: a.evidence,
    submittedAt: a.submittedAt, reviewedAt: a.reviewedAt, reviewedByName: a.reviewedByName, raisedByName: a.raisedByName, createdAt: a.createdAt,
    ...(opts.forSupplier ? {} : { source: a.source, sourceLabel: a.sourceLabel, raisedById: a.raisedById, submittedByName: a.submittedByName }),
  }));
}

/** Open and overdue counts per supplier (vendor list, flags). */
export async function actionCounts(tenantId: string, vendorIds?: string[]) {
  const rows = await db.select({ vendorId: actions.vendorId, status: actions.status, dueOn: actions.dueOn }).from(actions)
    .where(and(eq(actions.tenantId, tenantId), inArray(actions.status, OPEN_STATUSES), ...(vendorIds ? [inArray(actions.vendorId, vendorIds.length ? vendorIds : ['-'])] : [])));
  const out = new Map<string, { open: number; overdue: number; toReview: number }>();
  for (const r of rows) {
    const c = out.get(r.vendorId) ?? { open: 0, overdue: 0, toReview: 0 };
    c.open++; if (r.status === 'SUBMITTED') c.toReview++; else if (r.dueOn < today()) c.overdue++;
    out.set(r.vendorId, c);
  }
  return out;
}

/** Vendors → Corrective actions: every action in the workspace with a filter. */
export async function actionsOverview(tenantId: string, filter: 'open' | 'review' | 'overdue' | 'closed' | 'mine', staffId?: string) {
  const t = today();
  const where = filter === 'review' ? eq(actions.status, 'SUBMITTED') : filter === 'overdue' ? and(eq(actions.status, 'OPEN'), lt(actions.dueOn, t))
    : filter === 'closed' ? inArray(actions.status, ['ACCEPTED', 'CANCELLED']) : filter === 'mine' ? and(inArray(actions.status, OPEN_STATUSES), eq(actions.raisedById, staffId ?? '-')) : inArray(actions.status, OPEN_STATUSES);
  const rows = await db.select({ a: actions, vendorName: vendors.name, vendorCode: vendors.code, vendorStatus: vendors.status }).from(actions).innerJoin(vendors, eq(vendors.id, actions.vendorId))
    .where(and(eq(actions.tenantId, tenantId), where)).orderBy(filter === 'closed' ? desc(actions.updatedAt) : asc(actions.dueOn)).limit(500);
  const counts = await db.select({ status: actions.status, overdue: sql<boolean>`${actions.status} = 'OPEN' and ${actions.dueOn} < ${t}`, n: sql<number>`count(*)::int` }).from(actions)
    .where(and(eq(actions.tenantId, tenantId), inArray(actions.status, OPEN_STATUSES))).groupBy(actions.status, sql`2`);
  const n = (f: (c: (typeof counts)[number]) => boolean) => counts.filter(f).reduce((s, c) => s + c.n, 0);
  return {
    rows: rows.map(({ a, vendorName, vendorCode, vendorStatus }) => ({ id: a.id, vendorId: a.vendorId, vendorName, vendorCode, vendorStatus, title: a.title, priority: a.priority, dueOn: a.dueOn, status: a.status, overdue: isOverdue(a), condition: a.condition, raisedByName: a.raisedByName, sourceLabel: a.sourceLabel, submittedAt: a.submittedAt })),
    counts: { open: n(() => true), review: n((c) => c.status === 'SUBMITTED'), overdue: n((c) => !!c.overdue) },
  };
}

/** For the risk score: how many open actions are overdue, and whether any is high priority. */
export async function overdueActions(vendorId: string) {
  const rows = await db.select({ priority: actions.priority, title: actions.title }).from(actions).where(and(eq(actions.vendorId, vendorId), eq(actions.status, 'OPEN'), lt(actions.dueOn, today())));
  return { count: rows.length, high: rows.filter((r) => r.priority === 'HIGH') };
}

/* ---------------- Daily: reminders, overdue, holds ---------------- */

export async function runActionReminders(now = new Date()) {
  const t = now.toISOString().slice(0, 10), soon = new Date(now.getTime() + 3 * DAY).toISOString().slice(0, 10), weekAgo = new Date(now.getTime() - 7 * DAY);
  const due = await db.select({ a: actions, v: vendors, tenant: schema.tenants }).from(actions).innerJoin(vendors, eq(vendors.id, actions.vendorId)).innerJoin(schema.tenants, eq(schema.tenants.id, actions.tenantId))
    .where(and(eq(actions.status, 'OPEN'), lte(actions.dueOn, soon), isNull(vendors.erasedAt), or(isNull(actions.remindedAt), lt(actions.remindedAt, weekAgo)))).limit(1000);
  let reminded = 0, overdue = 0, held = 0;
  const touched = new Set<string>();
  for (const { a, v, tenant } of due) {
    const late = a.dueOn < t;
    if (late && !a.overdueNotifiedAt) {
      overdue++;
      await mailSupplierAbout(tenant, v, 'actionOverdue', { action: a.title, due: a.dueOn });
      const raiser = a.raisedById ? await db.query.users.findFirst({ where: eq(users.id, a.raisedById) }) : null;
      if (raiser?.status === 'ACTIVE') await sendMail({ tenantId: tenant.id, to: raiser.email, subject: `Overdue: ${v.name} — ${a.title}`, body: `Hello ${raiser.name},\n\nThe corrective action “${a.title}” for ${v.name} (${v.code}) was due on ${a.dueOn} and hasn't been answered.`, link: `${env.appBaseUrl}/staff/vendors/${v.id}?tab=actions` });
      await audit({ tenantId: tenant.id, vendorId: v.id, actor: 'system (corrective actions)', action: 'CORRECTIVE_ACTION_OVERDUE', detail: { action: a.title, dueOn: a.dueOn } });
      await db.update(actions).set({ overdueNotifiedAt: now, remindedAt: now }).where(eq(actions.id, a.id));
      touched.add(v.id);
      const { riskSettings } = await import('./risk.js');
      if (a.priority === 'HIGH' && riskSettings(tenant).holdOnOverdueAction && v.status === 'APPROVED') {
        const h = await applySystemHold(v.id, 'RISK', `Corrective action overdue: ${a.title}`, 'system (corrective actions)', { action: a.title, dueOn: a.dueOn }, `overdue: ${a.title}`);
        if (h?.isNew) held++;
      }
    } else if (!late || a.overdueNotifiedAt) {
      reminded++;
      await mailSupplierAbout(tenant, v, 'actionReminder', { action: a.title, due: a.dueOn });
      await db.update(actions).set({ remindedAt: now }).where(eq(actions.id, a.id));
    }
  }
  for (const id of touched) await refresh(id);
  return { reminded, overdue, held };
}

defineJob('actions.daily', async () => { logger.info(await runActionReminders(), 'corrective action reminders'); }, { retryLimit: 1, expireInSeconds: 3600 });
