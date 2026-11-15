/**
 * The supplier guide — one service for the supplier portal and a buyer filling in for the supplier:
 *  - next step: the one thing to do now (a send-back point, else the first missing item in tab order, else the first
 *    thing an approver would ask about);
 *  - check before submitting: what an approver would pick up (from `submissionIssues`, the same rules as the
 *    approvers' pre-review), so the supplier can fix it first;
 *  - send-back to-do: the buyer's remarks as a list linked to the right tabs (AI in privacy mode, or by rules);
 *  - ask: a question answered from the help topics and a value-free description of this registration.
 * Nothing the supplier typed is sent to the AI: values are replaced by placeholders and a guard refuses otherwise.
 */
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { HttpError } from '../lib/http.js';
import type { Profile } from '../lib/profileEngine.js';
import type { Tenant, Vendor } from '../db/schema.js';
import { localizeConfig, translateMessage, type Lang } from '../i18n/index.js';
import { dataEntryMode } from '../integrations/ai/index.js';
import { guideWriter, rulesGuideWriter, type TabInfo } from '../integrations/ai/guideWriter.js';
import type { HelpSource } from '../integrations/ai/helpAnswer.js';
import { getPublished } from './config.js';
import { formState, isEditableStatus } from './onboarding.js';
import { hasFeature } from './limits.js';
import { submissionIssues } from './submissionIssues.js';
import { identifiersOf, leaks, optionValues, pseudonymise, reidentify } from './aiPrivacy.js';
import { answerHelpQuestion } from '../routes/help.js';

const { approvalSteps, helpTopics } = schema;
type VendorWithDocs = Vendor & { documents: (typeof schema.documents.$inferSelect)[] };
export interface GuideItem { text: string; tab?: string; severity: 'high' | 'medium' | 'info' }

/** May send-back remarks go to the AI (privacy mode) to become a to-do list? Otherwise they are split by rules. */
export const aiGuideOn = (t: Tenant) => t.settings.aiGuide !== false && hasFeature(t, 'ai');

/** Form tabs in the order the supplier sees them (documents first when the form is filled from documents). */
function tabOrder(tenant: Tenant, sections: string[]) {
  const extra = ['questionnaires', 'agreements'];
  return dataEntryMode(tenant) === 'automatic' ? ['documents', ...sections, ...extra] : [...sections, 'documents', ...extra];
}

export async function supplierGuide(tenant: Tenant, v: VendorWithDocs, opts: { lang: Lang; forStaff?: boolean }) {
  const { config } = await getPublished(tenant.id);
  const lang = opts.forStaff ? 'en' : opts.lang;
  const form = await formState(tenant, config, v, opts.forStaff ? { forStaff: true } : { lang });
  const { issues } = await submissionIssues(tenant, config, v, form);
  const say = (i: (typeof issues)[number]) => (opts.forStaff ? i.staff : translateMessage(i.supplier, lang));
  const order = tabOrder(tenant, config.sections.map((s) => s.key));
  const rank = (tab?: string) => { const n = tab ? order.indexOf(tab) : -1; return n < 0 ? 99 : n; };

  const missing = issues.filter((i) => i.kind === 'missing').sort((a, b) => rank(a.tab) - rank(b.tab));
  const asIs = (i: (typeof issues)[number]): GuideItem => ({ text: say(i), tab: i.tab, severity: i.severity });
  const approverWouldAsk = issues.filter((i) => i.kind !== 'missing' && i.kind !== 'warning' && (i.fixable || i.kind === 'check_failed')).map(asIs);
  const worthChecking = issues.filter((i) => i.kind === 'warning' || (!i.fixable && i.kind !== 'check_failed' && i.kind !== 'missing')).map(asIs);
  const sendBack = v.status === 'SENT_BACK' ? await sendBackTodo(tenant, v, config, lang) : null;
  const next: GuideItem | null = sendBack?.items[0] ? { ...sendBack.items[0], severity: 'high' } : missing[0] ? asIs(missing[0]) : approverWouldAsk[0] ?? null;
  return {
    editable: isEditableStatus(v.status), remaining: missing.length, ready: missing.length === 0,
    next, nextKind: sendBack?.items[0] ? 'sendBack' : missing[0] ? 'missing' : approverWouldAsk[0] ? 'check' : 'ready',
    beforeSubmit: { approverWouldAsk, worthChecking },
    sendBack,
    canAsk: tenant.settings.helpAi !== false,
  };
}

/** Tabs and field labels (no values) — what the AI may know about the form. */
function tabsOf(config: Parameters<typeof localizeConfig>[0]): TabInfo[] {
  return [
    ...config.sections.map((s) => ({ key: s.key, label: s.label, fields: s.groups.flatMap((g) => g.fields.map((f) => f.label)) })),
    { key: 'documents', label: 'Documents', fields: config.documents.map((d) => d.label) },
  ];
}

/** The latest send-back remarks as a to-do list (made once per send-back and language, then kept). */
async function sendBackTodo(tenant: Tenant, v: VendorWithDocs, config: Awaited<ReturnType<typeof getPublished>>['config'], lang: Lang) {
  const [step] = await db.select().from(approvalSteps).where(and(eq(approvalSteps.vendorId, v.id), eq(approvalSteps.cycle, v.reviewCycle), eq(approvalSteps.status, 'SENT_BACK'))).orderBy(desc(approvalSteps.actedAt)).limit(1);
  if (!step?.remarks) return null;
  if (step.todo && step.todo.lang === lang) return { remarks: step.remarks, by: step.todo.by, items: step.todo.items };
  const tabs = tabsOf(config);
  let by: 'ai' | 'rules' = 'rules';
  let items = await rulesGuideWriter.todo({ remarks: step.remarks, tabs, language: lang });
  const w = guideWriter();
  if (w.live && aiGuideOn(tenant)) {
    // Privacy mode: the remarks go with the supplier's values replaced by placeholders; the guard checks before sending.
    const ids = identifiersOf(v, [], optionValues(config));
    const { text, tokens } = pseudonymise(step.remarks, ids);
    if (!leaks({ text, tabs }, ids, 'send-back remarks')) {
      try {
        const out = await w.todo({ remarks: text, tabs, language: lang });
        if (out.length) { items = out.map((i) => ({ ...i, text: reidentify(i.text, tokens) })); by = 'ai'; }
      } catch (err) { logger.warn({ err, vendor: v.id }, 'send-back to-do: AI unavailable — split by rules'); }
    }
  }
  await db.update(approvalSteps).set({ todo: { lang, by, items } }).where(eq(approvalSteps.id, step.id));
  return { remarks: step.remarks, by, items };
}

/** A value-free description of this registration for the AI: what each field and document is for, and whether it's done. */
async function registrationArticle(tenant: Tenant, v: VendorWithDocs, lang: Lang): Promise<HelpSource> {
  const { config: stored } = await getPublished(tenant.id);
  const config = localizeConfig(stored, lang);
  const form = await formState(tenant, stored, v, { lang });
  const problems = new Map(form.checklist.filter((c) => !c.ok).map((c) => [c.id, c.message ?? c.label]));
  const profile = v.profile as Profile;
  const lines: string[] = [`This supplier's registration with ${tenant.name}. Status: ${v.status.toLowerCase().replace('_', ' ')}. Vendor type: ${v.vendorType.toLowerCase()}.`];
  for (const s of config.sections) {
    lines.push(`\n## Tab “${s.label}”`);
    for (const f of s.groups.flatMap((g) => g.fields)) {
      const id = `${s.key}.${f.key}`;
      const filled = profile[s.key]?.[f.key] !== undefined && profile[s.key]?.[f.key] !== '';
      lines.push(`- ${f.label}${f.help ? ` — ${f.help}` : ''}: ${problems.has(id) ? `PROBLEM: ${problems.get(id)}` : filled ? 'filled in' : 'empty'}`);
    }
  }
  lines.push('\n## Tab “Documents”');
  for (const d of form.docRequirements) lines.push(`- ${d.label}${d.help ? ` — ${d.help}` : ''}: ${d.required ? 'required' : 'optional'}, ${v.documents.some((x) => x.docType === d.type && x.status === 'ACTIVE') ? 'uploaded' : 'not uploaded'}`);
  for (const a of form.agreements) lines.push(`- Agreement “${a.title}”: ${a.accepted ? 'accepted' : 'not accepted yet'}`);
  for (const q of form.questionnaires) lines.push(`- Questionnaire “${q.title}”: ${q.status === 'SUBMITTED' ? 'answered' : 'not answered yet'}`);
  let body = lines.join('\n');
  // Guard: a problem message that repeats a value is dropped rather than sent.
  if (leaks(body, identifiersOf(v, [], optionValues(stored)), 'registration description')) body = body.replace(/PROBLEM: .*$/gm, 'PROBLEM: needs correcting');
  return { id: 'this-registration', title: 'This registration', summary: 'The fields and documents of this registration and what is still missing (no values).', body };
}

/** A question from the supplier (or the buyer filling in), answered from the help topics and this registration. */
export async function askGuide(tenant: Tenant, v: VendorWithDocs, input: { question: string; articles: HelpSource[]; who: string; lang: Lang; forStaff?: boolean }) {
  const lang = input.forStaff ? 'en' : input.lang;
  const { config } = await getPublished(tenant.id);
  const ids = identifiersOf(v, [], optionValues(config));
  const { text, tokens } = pseudonymise(input.question, ids);
  const own = await db.select().from(helpTopics).where(eq(helpTopics.tenantId, tenant.id));
  const articles: HelpSource[] = [
    await registrationArticle(tenant, v, lang),
    ...own.filter((t) => t.audience !== 'staff').slice(0, 4).map((t) => ({ id: `ws-${t.id}`, title: t.title, summary: t.summary ?? undefined, body: t.body })),
    ...input.articles,
  ].slice(0, 12);
  if (leaks({ text, articles }, ids, 'guide question')) throw new HttpError(400, 'Please ask without including your own details (numbers, names or addresses).');
  const r = await answerHelpQuestion(tenant, input.who, 'supplier', text, articles, lang);
  return { ...r, answer: reidentify(r.answer, tokens), sources: r.sources.filter((s) => s !== 'this-registration' && !s.startsWith('ws-')) };
}
