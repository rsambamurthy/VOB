/**
 * Questionnaires by supplier category — ESG, information security, quality, anti-bribery… Targeted by any form
 * answer ("Category of Supply is Services", vendor type…), the same conditions the form uses for "show if".
 *
 * - Onboarding: required questionnaires that apply must be submitted before the supplier can submit for approval.
 * - Any time: a buyer can send a questionnaire to a supplier (e.g. a yearly ESG review); it shows in their portal.
 * - Scoring: each choice carries points; the total as % of the maximum gives a Low / Medium / High risk band.
 *   A "knock-out" answer makes it High whatever the score. Scores and bands are for the buyer only.
 *
 * One implementation for the supplier portal, a buyer filling in for the supplier, and reviewers.
 */
import { z } from 'zod';
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { conditionHolds } from '../lib/conditions.js';
import type { ChecklistItem, Profile } from '../lib/profileEngine.js';
import { conditionSchema, type Condition } from '../config/types.js';
import { storeUpload } from '../integrations/storage/index.js';
import type { Tenant, Vendor } from '../db/schema.js';

const { questionnaires, questionnaireResponses } = schema;
type Lang = 'en' | 'ar';

/* ---------------- Shape of a questionnaire ---------------- */

const option = z.object({ label: z.string().trim().min(1).max(200), labelAr: z.string().trim().max(200).optional(), points: z.number().int().min(-100).max(100).default(0), knockout: z.boolean().optional() });
export const questionSchema = z.object({
  id: z.string().min(1).max(40),
  text: z.string().trim().min(3, 'Write the question').max(500),
  textAr: z.string().trim().max(500).optional(),
  help: z.string().trim().max(500).optional(),
  helpAr: z.string().trim().max(500).optional(),
  type: z.enum(['yesno', 'choice', 'multi', 'text', 'number', 'file']),
  required: z.boolean().default(true),
  options: z.array(option).max(20).optional(),
  /** Points for a file being attached (type file). */
  points: z.number().int().min(0).max(100).optional(),
  /** Follow-up: shown only when an earlier question was answered with this value ("If yes, upload your ISO certificate"). */
  showIf: z.object({ questionId: z.string(), equals: z.string() }).optional(),
});
export type Question = z.infer<typeof questionSchema>;

export const questionnaireSchema = z.object({
  title: z.string().trim().min(3, 'Give the questionnaire a name').max(150),
  titleAr: z.string().trim().max(150).optional(),
  description: z.string().trim().max(2000).optional(),
  descriptionAr: z.string().trim().max(2000).optional(),
  appliesIf: conditionSchema.nullable().optional(),
  required: z.boolean().default(true),
  questions: z.array(questionSchema).min(1, 'Add at least one question').max(100),
  bands: z.object({ low: z.number().int().min(1).max(100), medium: z.number().int().min(0).max(100) }).refine((b) => b.medium <= b.low, 'The Medium threshold must be at or below the Low one').default({ low: 75, medium: 50 }),
}).superRefine((q, ctx) => {
  const c = q.appliesIf;
  if (c && !['empty', 'notEmpty'].includes(c.op) && (c.value === undefined || c.value === '' || (Array.isArray(c.value) && !c.value.length))) ctx.addIssue({ code: 'custom', path: ['appliesIf'], message: '“Asked of”: choose the value the answer must have' });
  const ids = new Set<string>();
  q.questions.forEach((x, i) => {
    if (ids.has(x.id)) ctx.addIssue({ code: 'custom', path: ['questions', i, 'id'], message: 'Two questions have the same id' });
    ids.add(x.id);
    if (['choice', 'multi'].includes(x.type) && !(x.options?.length)) ctx.addIssue({ code: 'custom', path: ['questions', i], message: `“${x.text}” needs its answer choices` });
    if (x.showIf && !ids.has(x.showIf.questionId)) ctx.addIssue({ code: 'custom', path: ['questions', i], message: `“${x.text}” follows a question that isn’t before it` });
  });
});
export type QuestionnaireInput = z.infer<typeof questionnaireSchema>;
type Q = typeof questionnaires.$inferSelect;
type R = typeof questionnaireResponses.$inferSelect;
type Answers = Record<string, unknown>;
type FileAnswer = { documentId: string; fileName: string };

/** Yes / No questions get their two options with sensible points if none were given. */
function normalise(qs: Question[]): Question[] {
  return qs.map((q) => (q.type === 'yesno' && !q.options?.length ? { ...q, options: [{ label: 'Yes', labelAr: 'نعم', points: 10 }, { label: 'No', labelAr: 'لا', points: 0 }] } : q));
}

/* ---------------- Setting up (Administration → Questionnaires) ---------------- */

export async function saveQuestionnaire(tenantId: string, id: string | null, input: QuestionnaireInput, by: { name: string; ip?: string }) {
  const values = { ...input, titleAr: input.titleAr || null, description: input.description || null, descriptionAr: input.descriptionAr || null, appliesIf: input.appliesIf ?? null, questions: normalise(input.questions), updatedByName: by.name, updatedAt: new Date() };
  if (id) {
    const q = await getQuestionnaire(tenantId, id);
    await db.update(questionnaires).set(values).where(eq(questionnaires.id, q.id));
    await audit({ tenantId, actor: by.name, action: 'QUESTIONNAIRE_UPDATED', detail: { title: input.title, questions: input.questions.length }, ip: by.ip });
    return { ...q, ...values };
  }
  const [q] = await db.insert(questionnaires).values({ tenantId, ...values }).returning();
  await audit({ tenantId, actor: by.name, action: 'QUESTIONNAIRE_CREATED', detail: { title: q.title, questions: input.questions.length }, ip: by.ip });
  return q;
}

export async function setQuestionnaireStatus(tenantId: string, id: string, status: 'ACTIVE' | 'ARCHIVED', by: { name: string; ip?: string }) {
  const q = await getQuestionnaire(tenantId, id);
  await db.update(questionnaires).set({ status }).where(eq(questionnaires.id, q.id));
  await audit({ tenantId, actor: by.name, action: status === 'ARCHIVED' ? 'QUESTIONNAIRE_ARCHIVED' : 'QUESTIONNAIRE_RESTORED', detail: { title: q.title }, ip: by.ip });
}

async function getQuestionnaire(tenantId: string, id: string) {
  const q = await db.query.questionnaires.findFirst({ where: and(eq(questionnaires.tenantId, tenantId), eq(questionnaires.id, id)) });
  if (!q) throw new HttpError(404, 'Questionnaire not found');
  return q;
}

export async function listQuestionnaires(tenantId: string) {
  const qs = await db.select().from(questionnaires).where(eq(questionnaires.tenantId, tenantId)).orderBy(asc(questionnaires.sortOrder), asc(questionnaires.createdAt));
  if (!qs.length) return [];
  const rs = await db.select({ questionnaireId: questionnaireResponses.questionnaireId, band: questionnaireResponses.band }).from(questionnaireResponses)
    .where(and(eq(questionnaireResponses.tenantId, tenantId), eq(questionnaireResponses.status, 'SUBMITTED')));
  return qs.map((q) => {
    const mine = rs.filter((r) => r.questionnaireId === q.id);
    return { ...q, submitted: mine.length, highRisk: mine.filter((r) => r.band === 'HIGH').length };
  });
}

/* ---------------- Scoring ---------------- */

const visible = (q: Question, answers: Answers) => !q.showIf || String(answers[q.showIf.questionId] ?? '') === q.showIf.equals;
const answered = (q: Question, v: unknown) => (q.type === 'multi' ? Array.isArray(v) && v.length > 0 : q.type === 'file' ? !!(v as FileAnswer | undefined)?.documentId : v !== undefined && v !== null && String(v).trim() !== '');

export function score(questions: Question[], answers: Answers, bands: { low: number; medium: number }) {
  let total = 0, max = 0;
  const knockouts: string[] = [];
  for (const q of questions.filter((x) => visible(x, answers))) {
    const v = answers[q.id];
    if (q.type === 'choice' || q.type === 'yesno') {
      max += Math.max(0, ...(q.options ?? []).map((o) => o.points));
      const o = q.options?.find((x) => x.label === v);
      if (o) { total += o.points; if (o.knockout) knockouts.push(q.id); }
    } else if (q.type === 'multi') {
      max += (q.options ?? []).reduce((n, o) => n + Math.max(0, o.points), 0);
      for (const o of (q.options ?? []).filter((x) => Array.isArray(v) && v.includes(x.label))) { total += o.points; if (o.knockout) knockouts.push(q.id); }
    } else if (q.type === 'file' && q.points) {
      max += q.points;
      if (answered(q, v)) total += q.points;
    }
  }
  const percent = max > 0 ? Math.max(0, Math.round((total / max) * 100)) : null;
  const band = knockouts.length ? 'HIGH' : percent === null ? null : percent >= bands.low ? 'LOW' : percent >= bands.medium ? 'MEDIUM' : 'HIGH';
  return { score: total, maxScore: max, percent, band, knockouts: [...new Set(knockouts)] };
}

/** Keep only answers to questions that exist, with valid choices. */
function clean(questions: Question[], raw: Answers): Answers {
  const out: Answers = {};
  for (const q of questions) {
    const v = raw[q.id];
    if (v === undefined || v === null || v === '') continue;
    const labels = (q.options ?? []).map((o) => o.label);
    if (q.type === 'choice' || q.type === 'yesno') { if (labels.includes(String(v))) out[q.id] = String(v); }
    else if (q.type === 'multi') { if (Array.isArray(v)) out[q.id] = v.map(String).filter((x) => labels.includes(x)); }
    else if (q.type === 'number') { const n = Number(String(v).replace(/,/g, '')); if (!Number.isNaN(n)) out[q.id] = n; }
    else if (q.type === 'file') { const f = v as FileAnswer; if (f && typeof f.documentId === 'string') out[q.id] = { documentId: f.documentId, fileName: String(f.fileName ?? '').slice(0, 200) }; }
    else out[q.id] = String(v).slice(0, 4000);
  }
  return out;
}

/* ---------------- Which questionnaires a supplier has ---------------- */

type V = Pick<Vendor, 'id' | 'tenantId' | 'vendorType' | 'status' | 'profile'>;
const appliesTo = (q: Q, v: V) => conditionHolds((q.appliesIf as Condition | null) ?? undefined, { profile: v.profile as Profile, vendor: { vendorType: v.vendorType } });
const onboarding = (v: V) => v.status !== 'APPROVED';

export interface QuestionnaireStatus {
  questionnaire: Q; questions: Question[];
  /** The response being answered (draft) or the latest submitted one. */
  draft: R | null; latest: R | null;
  /** Still to answer: required during onboarding, or sent by a buyer and not yet submitted. */
  outstanding: boolean; requested: boolean;
}

export async function questionnairesFor(v: V): Promise<QuestionnaireStatus[]> {
  const rs = await db.select().from(questionnaireResponses).where(eq(questionnaireResponses.vendorId, v.id)).orderBy(desc(questionnaireResponses.createdAt));
  const qs = await db.select().from(questionnaires).where(and(eq(questionnaires.tenantId, v.tenantId), eq(questionnaires.status, 'ACTIVE'))).orderBy(asc(questionnaires.sortOrder), asc(questionnaires.createdAt));
  return qs.flatMap((q) => {
    const mine = rs.filter((r) => r.questionnaireId === q.id);
    const draft = mine.find((r) => r.status === 'DRAFT') ?? null;
    const latest = mine.find((r) => r.status === 'SUBMITTED') ?? null;
    const requested = !!draft?.requestedAt;
    if (!appliesTo(q, v) && !requested && !latest) return [];
    const outstanding = requested || (onboarding(v) && appliesTo(q, v) && q.required && !latest);
    return [{ questionnaire: q, questions: (q.questions as Question[]) ?? [], draft, latest, outstanding, requested }];
  });
}

const tq = (s: QuestionnaireStatus, lang: Lang) => (lang === 'ar' && s.questionnaire.titleAr) || s.questionnaire.title;

/** Checklist items (blocking submit) for required questionnaires still to answer during onboarding. */
export function questionnaireChecklist(list: QuestionnaireStatus[], v: V, lang: Lang = 'en'): ChecklistItem[] {
  if (!onboarding(v)) return [];
  return list.filter((s) => s.questionnaire.required && appliesTo(s.questionnaire, v)).map((s) => ({
    id: `questionnaire.${s.questionnaire.id}`, section: 'questionnaires', label: tq(s, lang), ok: !s.outstanding, severity: 'error' as const,
    message: s.outstanding ? `${tq(s, lang)} must be answered` : undefined,
  }));
}

/** What the supplier (or a buyer filling in for them) sees: questions in their language and their answers — no scores. */
export function questionnaireView(s: QuestionnaireStatus, lang: Lang = 'en', opts: { forStaff?: boolean } = {}) {
  const ar = lang === 'ar';
  const questions = (s.draft || !s.latest?.questions ? s.questions : (s.latest.questions as Question[])).map((q) => ({
    id: q.id, type: q.type, required: q.required, showIf: q.showIf, text: (ar && q.textAr) || q.text, help: (ar && q.helpAr) || q.help,
    options: q.options?.map((o) => ({ value: o.label, label: (ar && o.labelAr) || o.label, ...(opts.forStaff ? { points: o.points, knockout: !!o.knockout } : {}) })),
  }));
  const r = s.draft ?? s.latest;
  return {
    id: s.questionnaire.id, title: tq(s, lang), description: (ar && s.questionnaire.descriptionAr) || s.questionnaire.description,
    required: s.questionnaire.required, outstanding: s.outstanding, requested: s.requested, dueOn: s.draft?.dueOn ?? null,
    questions, answers: (r?.answers as Answers) ?? {}, status: s.draft ? 'DRAFT' : s.latest ? 'SUBMITTED' : 'NEW',
    submittedAt: s.latest?.submittedAt ?? null, submittedByName: s.latest?.submittedByName ?? null,
    ...(opts.forStaff && s.latest ? { result: { score: s.latest.score, maxScore: s.latest.maxScore, percent: s.latest.percent, band: s.latest.band, knockouts: s.latest.knockouts } } : {}),
  };
}

/* ---------------- Answering ---------------- */

async function statusOf(v: V, questionnaireId: string) {
  const s = (await questionnairesFor(v)).find((x) => x.questionnaire.id === questionnaireId);
  if (!s) throw new HttpError(404, 'Questionnaire not found');
  return s;
}
async function draftFor(v: V, s: QuestionnaireStatus) {
  if (s.draft) return s.draft;
  const [d] = await db.insert(questionnaireResponses).values({ tenantId: v.tenantId, questionnaireId: s.questionnaire.id, vendorId: v.id, answers: (s.latest?.answers as Answers) ?? {} }).returning();
  return d;
}

/** Save answers (not submitted yet). Answering again after submitting starts a new response from the last answers. */
export async function saveAnswers(v: V, questionnaireId: string, raw: Answers) {
  const s = await statusOf(v, questionnaireId);
  const d = await draftFor(v, s);
  const answers = clean(s.questions, { ...(d.answers as Answers), ...raw });
  await db.update(questionnaireResponses).set({ answers, updatedAt: new Date() }).where(eq(questionnaireResponses.id, d.id));
  return answers;
}

export async function submitAnswers(v: V, questionnaireId: string, raw: Answers, actor: { name: string; onBehalf?: boolean; ip?: string }) {
  const s = await statusOf(v, questionnaireId);
  const d = await draftFor(v, s);
  const answers = clean(s.questions, { ...(d.answers as Answers), ...raw });
  // Keep what was given even if something is still missing.
  await db.update(questionnaireResponses).set({ answers, updatedAt: new Date() }).where(eq(questionnaireResponses.id, d.id));
  const missing = s.questions.filter((q) => q.required && visible(q, answers) && !answered(q, answers[q.id]));
  if (missing.length) throw new HttpError(422, 'Answer every required question first', missing.map((q) => ({ id: q.id, label: q.text, message: `${q.text} — please answer` })));
  const result = score(s.questions, answers, s.questionnaire.bands as { low: number; medium: number });
  await db.update(questionnaireResponses).set({ answers, questions: s.questions, ...result, status: 'SUBMITTED', submittedAt: new Date(), submittedByName: actor.name, updatedAt: new Date() }).where(eq(questionnaireResponses.id, d.id));
  await audit({ tenantId: v.tenantId, vendorId: v.id, actor: actor.name, action: 'QUESTIONNAIRE_SUBMITTED', detail: { questionnaire: s.questionnaire.title, ...(result.band ? { risk: result.band, score: `${result.percent}%` } : {}), ...(actor.onBehalf ? { onBehalf: 'yes' } : {}) }, ip: actor.ip });
  return result;
}

/** A document attached as an answer (e.g. an ISO certificate). Kept on the supplier, out of the documents checklist. */
export async function attachFile(v: V, questionnaireId: string, file: { buffer: Buffer; originalname: string }, uploadedById?: string): Promise<FileAnswer> {
  await statusOf(v, questionnaireId);
  const stored = await storeUpload(v.tenantId, v.id, file);
  const [doc] = await db.insert(schema.documents).values({ tenantId: v.tenantId, vendorId: v.id, docType: 'QUESTIONNAIRE', ...stored, status: 'ATTACHMENT', ...(uploadedById ? { uploadedById } : {}) }).returning();
  return { documentId: doc.id, fileName: doc.fileName };
}

/** A buyer sends a questionnaire to a supplier (e.g. yearly ESG review); the supplier is emailed and sees it in the portal. */
export async function requestQuestionnaire(tenant: Tenant, v: Vendor, questionnaireId: string, dueOn: string | null, actor: { name: string; ip?: string }) {
  const q = await getQuestionnaire(tenant.id, questionnaireId);
  if (q.status !== 'ACTIVE') throw new HttpError(409, 'This questionnaire is archived');
  const open = await db.query.questionnaireResponses.findFirst({ where: and(eq(questionnaireResponses.vendorId, v.id), eq(questionnaireResponses.questionnaireId, q.id), eq(questionnaireResponses.status, 'DRAFT')) });
  const last = await db.query.questionnaireResponses.findFirst({ where: and(eq(questionnaireResponses.vendorId, v.id), eq(questionnaireResponses.questionnaireId, q.id), eq(questionnaireResponses.status, 'SUBMITTED')), orderBy: desc(questionnaireResponses.submittedAt) });
  const now = new Date();
  if (open) await db.update(questionnaireResponses).set({ requestedAt: now, requestedByName: actor.name, dueOn }).where(eq(questionnaireResponses.id, open.id));
  else await db.insert(questionnaireResponses).values({ tenantId: tenant.id, questionnaireId: q.id, vendorId: v.id, answers: (last?.answers as Answers) ?? {}, requestedAt: now, requestedByName: actor.name, dueOn });
  await audit({ tenantId: tenant.id, vendorId: v.id, actor: actor.name, action: 'QUESTIONNAIRE_REQUESTED', detail: { questionnaire: q.title, ...(dueOn ? { dueOn } : {}) }, ip: actor.ip });
  const { mailSupplier, mailDate } = await import('../i18n/emails.js');
  const { vendorLanguage } = await import('../i18n/index.js');
  const { portalLink } = await import('./vendors.js');
  const lang = vendorLanguage(tenant, v);
  await mailSupplier(lang, { tenantId: tenant.id, to: v.contactEmail, link: portalLink(v) }, 'questionnaireRequest', { first: v.contactFirstName, buyer: tenant.name, questionnaire: (lang === 'ar' && q.titleAr) || q.title, due: dueOn ? mailDate(dueOn, lang) : '—' });
}

/* ---------------- Flags for staff ---------------- */

/** Open requests and High-risk results, for the vendor list and page. A few queries for any number of suppliers. */
export async function questionnaireFlags(tenantId: string, vendorIds: string[]) {
  const due = new Set<string>(), high = new Set<string>();
  if (!vendorIds.length) return { due, high };
  const rows = await db.select({ vendorId: questionnaireResponses.vendorId, questionnaireId: questionnaireResponses.questionnaireId, status: questionnaireResponses.status, band: questionnaireResponses.band, requestedAt: questionnaireResponses.requestedAt, submittedAt: questionnaireResponses.submittedAt })
    .from(questionnaireResponses).innerJoin(questionnaires, and(eq(questionnaires.id, questionnaireResponses.questionnaireId), eq(questionnaires.status, 'ACTIVE')))
    .where(and(eq(questionnaireResponses.tenantId, tenantId), inArray(questionnaireResponses.vendorId, vendorIds)));
  for (const r of rows) if (r.status === 'DRAFT' && r.requestedAt) due.add(r.vendorId);
  // Latest submitted result per supplier and questionnaire.
  const latest = new Map<string, { band: string | null; at: Date }>();
  for (const r of rows.filter((x) => x.status === 'SUBMITTED' && x.submittedAt)) {
    const k = `${r.vendorId}|${r.questionnaireId}`;
    if (!latest.has(k) || latest.get(k)!.at < r.submittedAt!) latest.set(k, { band: r.band, at: r.submittedAt! });
  }
  for (const [k, x] of latest) if (x.band === 'HIGH') high.add(k.split('|')[0]);
  return { due, high };
}

/** Submitted results on a supplier, newest first (staff: history of each questionnaire). */
export async function responseHistory(vendorId: string) {
  return db.select().from(questionnaireResponses).where(and(eq(questionnaireResponses.vendorId, vendorId), eq(questionnaireResponses.status, 'SUBMITTED'), isNotNull(questionnaireResponses.submittedAt))).orderBy(desc(questionnaireResponses.submittedAt));
}
