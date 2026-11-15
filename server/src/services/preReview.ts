/**
 * Pre-review for approvers. When a supplier is submitted, VendorGate gathers what an approver would check —
 * missing items, verification results, documents that disagree with the form, duplicates, risk, questionnaire
 * results, agreements, earlier send-backs — into findings, and (when the workspace switches it on) asks the AI
 * for a summary, a recommendation and questions for the supplier. Advisory only.
 *
 * Built from the same services the vendor page uses (formState, checks, extractions, duplicates, risk…), so
 * the pre-review never disagrees with what the approver sees.
 */
import crypto from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { maskField, isSensitive } from '../lib/fieldCrypto.js';
import type { Profile } from '../lib/profileEngine.js';
import { checkDef, checkInputs, checksForVendor, inputsComplete } from '../countries/registry.js';
import { latestChecks } from '../integrations/kyc/index.js';
import { extractionsFor } from '../integrations/ai/index.js';
import { hasFeature } from './limits.js';
import { getPublished } from './config.js';
import { formState } from './onboarding.js';
import { duplicatesOf, duplicateText } from './duplicates.js';
import { refreshRisk } from './risk.js';
import { aiPrecision, ageOf, comparisons, comparisonConcerns, describeAge, describeTurnover, peerComparison, turnoverOf } from './aiFacts.js';
import { defineJob, enqueue } from '../jobs/queue.js';
import { preReviewer, mockPreReviewer, recommendFromFacts, type Finding, type PreReviewResult } from '../integrations/ai/preReviewer.js';
import type { Tenant, Vendor } from '../db/schema.js';

const { preReviews, vendors, documents, approvalSteps } = schema;
const DAY = 86_400_000;

/** May this workspace send submissions to the AI provider for pre-review? (VendorGate's own findings are always made.) */
export const aiPreReviewOn = (t: Tenant) => !!t.settings.aiPreReview && hasFeature(t, 'ai');

/**
 * VendorGate's own findings, and what the AI may see in privacy mode:
 *  - only general facts — choices from the form's fixed lists, ranges (company age, turnover), which documents
 *    exist, each check as passed / failed / not run, questionnaire bands, agreements accepted or not;
 *  - every finding reworded without real values (`aiText`); names replaced by tokens ([SUPPLIER], [OTHER-1]);
 *  - never names, numbers, addresses, emails, phone numbers, free text, remarks or document contents.
 * `tokens` maps the tokens back to the real names, applied on our side to what the AI writes. A guard refuses to
 * send if any real value from the supplier's record (or a matching supplier's name) appears in the payload.
 */
export async function gather(tenant: Tenant, v: Vendor & { documents: (typeof documents.$inferSelect)[] }) {
  const { config } = await getPublished(tenant.id);
  const profile = v.profile as Profile;
  // Same order however the documents were loaded, so the fingerprint only changes when the data does.
  v = { ...v, documents: [...v.documents].sort((a, b) => a.docType.localeCompare(b.docType) || a.id.localeCompare(b.id)) };
  const facts: Finding[] = [];
  const add = (f: Omit<Finding, 'source'>, aiText?: string) => facts.push({ ...f, source: 'checks', aiText: aiText ?? f.text });
  const sectionOf = (fieldId: string) => fieldId.split('.')[0];
  const docLabelOf = (type: string) => config.documents.find((x) => x.type === type)?.label ?? type;

  // Missing items and warnings, by the same rules as the form (labels and rules only — safe as they are).
  const form = await formState(tenant, config, v, { forStaff: true });
  for (const c of form.checklist.filter((x) => !x.ok)) {
    if (c.severity === 'error') add({ severity: 'high', text: c.message ?? `${c.label} is missing`, tab: c.section, fixable: true }, `Missing or invalid: ${c.label}`);
    else add({ severity: 'medium', text: c.message ?? c.label, tab: c.section, fixable: true }, `To check: ${c.id.startsWith('cross.') ? 'two answers on the form don’t fit together' : c.label}`);
  }
  // Verifications.
  const checks = await latestChecks(v.id);
  const checkResult: Record<string, string> = {};
  for (const c of checks) {
    const def = checkDef(c.kind)?.def;
    if (!def) continue;
    if (c.status === 'ERROR') { checkResult[def.label] = 'could not run'; add({ severity: 'info', text: `${def.label} check couldn't run: ${c.message}` }, `${def.label}: the check could not run`); }
    else if (c.status !== 'VERIFIED') { checkResult[def.label] = 'failed'; add({ severity: 'high', text: `${def.label}: ${c.message}`, tab: sectionOf(def.anchor) }, `${def.label}: failed${def.monitor === 'critical' ? ' (registration or sanctions — serious)' : ''}`); }
    else if (c.nameMatch !== null && c.nameMatch < 70) { checkResult[def.label] = 'passed, but the name on record differs'; add({ severity: 'medium', text: `${def.label}: the name on record “${c.nameOnRecord}” doesn't match the supplier's name`, tab: sectionOf(def.anchor), fixable: true }, `${def.label}: the name on record doesn't match [SUPPLIER]`); }
    else checkResult[def.label] = 'passed';
  }
  for (const { def } of checksForVendor(tenant.country, profile)) {
    if (!checkResult[def.label] && inputsComplete(def, checkInputs(def, profile))) { checkResult[def.label] = 'not run yet'; add({ severity: 'info', text: `${def.label} hasn't been verified yet — run it under Verifications`, tab: sectionOf(def.anchor) }); }
  }
  // Documents that disagree with the form.
  const extractions = await extractionsFor(v.id, profile, config);
  for (const e of extractions) {
    for (const x of e.suggestions.filter((y) => y.state === 'differs')) {
      const show = (val: string) => (x.sensitive ? maskField(x.fieldId, val) : val);
      add({ severity: 'medium', text: `${x.fieldLabel}: the form says “${show(x.current)}” but the ${e.docLabel || 'document'} shows “${show(x.value)}”`, tab: sectionOf(x.fieldId), fixable: true }, `${x.fieldLabel}: the form and the ${e.docLabel || 'document'} disagree`);
    }
    if (e.status === 'DONE' && e.summary && /not a |could not be read/i.test(e.summary)) add({ severity: 'medium', text: `${e.docLabel}: ${e.summary}`, tab: 'documents', fixable: true }, `${e.docLabel}: may be the wrong document or unreadable`);
  }
  const soon = new Date(Date.now() + 60 * DAY).toISOString().slice(0, 10);
  for (const d of v.documents.filter((x) => x.status === 'ACTIVE' && x.expiresOn && x.expiresOn <= soon)) {
    add({ severity: 'medium', text: `${docLabelOf(d.docType)} expires on ${d.expiresOn} — within 60 days`, tab: 'documents', fixable: true }, `${docLabelOf(d.docType)} expires within 60 days`);
  }
  // Duplicates (other suppliers become [OTHER-1], [OTHER-2]…), risk, questionnaires.
  const tokens: Record<string, string> = { '[SUPPLIER]': v.name };
  const dups = await duplicatesOf(v);
  dups.forEach((d, i) => { tokens[`[OTHER-${i + 1}]`] = `${d.code} ${d.name}`; });
  if (dups.length) add({ severity: 'high', text: `Possible duplicate of ${duplicateText(dups)}` }, `[SUPPLIER] may be a duplicate: ${dups.map((d, i) => `[OTHER-${i + 1}] (${d.status.toLowerCase().replace('_', ' ')}) has the same ${d.matches.join(', ')}`).join('; ')}`);
  const risk = await refreshRisk(v.id, { alert: false });
  for (const x of risk?.signals.filter((y) => y.critical && !y.code.startsWith('check.') && y.code !== 'duplicate') ?? []) add({ severity: 'high', text: x.label }, 'A serious risk finding');
  for (const q of form.questionnaires.filter((x) => x.result)) {
    const r = q.result!;
    const ko = (r.knockouts as string[] | null) ?? [];
    const koText = ko.length ? q.questions.find((x) => x.id === ko[0])?.text ?? '' : '';
    if (r.band === 'HIGH') add({ severity: 'high', text: `${q.title}: high risk (${r.percent ?? '–'}%)${ko.length ? ` — knock-out answer to “${koText}”` : ''}`, tab: 'questionnaires' }, `${q.title}: high risk${ko.length ? ` — knock-out answer to “${koText}”` : ''}`);
    else if (r.band === 'MEDIUM') add({ severity: 'medium', text: `${q.title}: medium risk (${r.percent}%)`, tab: 'questionnaires' });
  }
  // Values that don't fit together (worked out here — e.g. GSTIN state vs address).
  const consistency = comparisons(v);
  for (const c of comparisonConcerns(consistency)) add({ ...c, fixable: c.severity === 'medium' });
  // Earlier send-backs (the remarks are free text: the AI only learns there was one), and buyer fill-in.
  const backs = await db.select({ remarks: approvalSteps.remarks, cycle: approvalSteps.cycle, label: approvalSteps.label }).from(approvalSteps)
    .where(and(eq(approvalSteps.vendorId, v.id), eq(approvalSteps.status, 'SENT_BACK'))).orderBy(desc(approvalSteps.cycle)).limit(3);
  for (const b of backs) add({ severity: 'info', text: `Sent back before at ${b.label}: “${b.remarks ?? ''}” — check it was fixed` }, `Sent back before at ${b.label}; check the earlier remarks were addressed`);
  if (v.consentIp?.startsWith('buyer:')) add({ severity: 'info', text: `Filled in by ${v.consentIp.slice(7)} on the supplier's behalf` }, "Filled in by the buyer's staff on the supplier's behalf");

  // What the AI may see: choices from fixed lists only, and ranges — never typed-in values.
  const choices: Record<string, string> = {};
  for (const sec of config.sections) for (const f of sec.groups.flatMap((g) => g.fields)) {
    const val = profile[sec.key]?.[f.key];
    if ((f.type === 'select' || f.type === 'radio') && f.options?.includes(String(val ?? '')) && !isSensitive(`${sec.key}.${f.key}`)) choices[f.label] = String(val);
  }
  const precision = aiPrecision(tenant);
  const turnover = turnoverOf(profile);
  const payload = {
    supplier: '[SUPPLIER]', vendorType: v.vendorType,
    form: choices,
    amounts: { precision, companyAge: describeAge(ageOf(profile), precision), annualTurnover: describeTurnover(turnover, String(profile.risk?.currency ?? ''), precision) },
    // Worked out here; the AI gets only yes / no.
    consistency,
    // Where the supplier sits among your approved suppliers (none if fewer than 5 to compare with).
    peers: await peerComparison(tenant, v),
    documents: v.documents.filter((d) => d.status === 'ACTIVE').map((d) => ({ document: docLabelOf(d.docType), validUntil: d.expiresOn ? (d.expiresOn < new Date().toISOString().slice(0, 10) ? 'expired' : d.expiresOn <= soon ? 'within 60 days' : 'valid') : 'no expiry' })),
    verifications: checkResult,
    questionnaires: form.questionnaires.filter((q) => q.status === 'SUBMITTED').map((q) => ({ title: q.title, risk: q.result?.band ?? null, knockOuts: ((q.result?.knockouts as string[] | null) ?? []).length,
      choiceAnswers: Object.fromEntries(q.questions.filter((x) => x.type === 'yesno' || x.type === 'choice' || x.type === 'multi').map((x) => [x.text, q.answers[x.id] ?? null])) })),
    agreements: Object.fromEntries(form.agreements.map((a) => [a.title, a.accepted ? 'accepted' : 'not accepted'])),
    risk: risk ? { band: risk.band, score: risk.score } : null,
    findings: facts.map((f) => ({ severity: f.severity, text: f.aiText ?? f.text, tab: f.tab })),
  };
  // Other suppliers being approved moves the peer comparison — that alone doesn't make this pre-review out of date.
  const hash = crypto.createHash('sha256').update(JSON.stringify({ facts: facts.map((f) => f.text), payload: { ...payload, peers: null } })).digest('hex').slice(0, 32);
  // The guard: if anything identifying slipped in, the AI gets nothing (the pre-review is written from the checks alone).
  // Exact turnover is allowed through when the workspace chose exact amounts (a number with no name attached).
  const allowed = new Set([...Object.values(choices), ...(precision === 'exact' && profile.risk?.annualTurnover ? [String(profile.risk.annualTurnover)] : [])]);
  const safe = !leaks(payload, identifiersOf(v, dups, allowed));
  return { facts, payload: safe ? payload : null, tokens, hash };
}

/** Every value that would identify the supplier or a person: what was typed into the form, contact details, names. */
function identifiersOf(v: Vendor, dups: { code: string; name: string }[], fixedChoices: Set<string>) {
  const out = new Set<string>();
  const addVal = (x: unknown) => { const t = String(x ?? '').trim(); if (t.length >= 4) out.add(t.toLowerCase()); };
  [v.name, v.code, v.contactEmail, v.contactMobile, `${v.contactFirstName} ${v.contactLastName}`].forEach(addVal);
  // Typed-in values with a number, an @ or several words (registration numbers, accounts, emails, names, addresses).
  for (const sec of Object.values(v.profile as Profile)) for (const val of Object.values(sec ?? {})) if (typeof val === 'string' && !fixedChoices.has(val) && /\d|@|\S\s+\S/.test(val)) addVal(val);
  for (const d of dups) { addVal(d.name); addVal(d.code); }
  return out;
}

/** True if any identifying value appears in the payload (as whole words; the placeholders themselves don't count). */
function leaks(payload: unknown, ids: Set<string>) {
  const text = JSON.stringify(payload).toLowerCase().replace(/\[(supplier|other-\d+)\]/g, ' ');
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const id of ids) {
    for (const form of new Set([id, JSON.stringify(id).slice(1, -1)])) {
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${esc(form)}($|[^\\p{L}\\p{N}])`, 'u').test(text)) { logger.warn('pre-review: identifying data found in the AI payload — not sent'); return true; }
    }
  }
  return false;
}

/** Put the real names back into what the AI wrote. */
const reidentify = (text: string, tokens: Record<string, string>) => Object.entries(tokens).reduce((t, [k, val]) => t.split(k).join(val), text);

/** Make (or remake) the pre-review for the supplier's current review cycle. */
export async function generatePreReview(vendorId: string, requestedBy = 'system (on submit)') {
  const v = await db.query.vendors.findFirst({ where: eq(vendors.id, vendorId), with: { documents: true } });
  if (!v || v.erasedAt) return null;
  const tenant = (await db.query.tenants.findFirst({ where: eq(schema.tenants.id, v.tenantId) }))!;
  const useAi = aiPreReviewOn(tenant);
  const reviewer = useAi ? preReviewer() : mockPreReviewer;
  const [row] = await db.insert(preReviews).values({ tenantId: v.tenantId, vendorId: v.id, cycle: v.reviewCycle, provider: reviewer.name, live: reviewer.live, inputHash: '-', requestedBy }).returning();
  try {
    const { facts, payload, tokens, hash } = await gather(tenant, v);
    let ai: PreReviewResult;
    let sent: unknown = null;
    try {
      if (reviewer.live && !payload) throw new Error('privacy guard: payload not safe to send');
      const raw = await reviewer.review({ vendor: reviewer.live ? '[SUPPLIER]' : v.name, buyer: tenant.name, facts: reviewer.live ? facts.map((f) => ({ ...f, text: f.aiText ?? f.text })) : facts, digest: reviewer.live ? payload : null });
      if (reviewer.live) sent = payload;
      ai = reviewer.live
        ? { ...raw, summary: reidentify(raw.summary, tokens), questions: raw.questions.map((q) => reidentify(q, tokens)), findings: raw.findings.map((f) => ({ ...f, text: reidentify(f.text, tokens) })) }
        : raw;
    } catch (err) {
      // AI unavailable: VendorGate's own findings still help.
      logger.warn({ err, vendor: v.id }, 'AI pre-review failed — showing findings only');
      const plain = await mockPreReviewer.review({ vendor: v.name, buyer: tenant.name, facts, digest: null });
      ai = { ...plain, summary: `${plain.summary} (The AI summary couldn't be written just now.)` };
    }
    const order = { high: 0, medium: 1, info: 2 } as const;
    const findings = [...facts.map(({ aiText: _a, ...f }) => f), ...ai.findings].sort((a, b) => order[a.severity] - order[b.severity]);
    // Never softer than the findings themselves (VendorGate's and the AI's own) call for.
    const rank = { APPROVE: 0, REVIEW: 1, SEND_BACK: 2 } as const;
    const floor = recommendFromFacts(findings);
    const result: PreReviewResult = { ...ai, findings, recommendation: rank[ai.recommendation] >= rank[floor] ? ai.recommendation : floor };
    // Nothing reached the AI (provider down, or the privacy guard stopped it): record it as a checks-only pre-review.
    const live = sent !== null;
    await db.update(preReviews).set({ status: 'READY', result, inputHash: hash, sentToAi: sent, ...(live ? {} : { provider: mockPreReviewer.name, live: false }) }).where(eq(preReviews.id, row.id));
    await audit({ tenantId: v.tenantId, vendorId: v.id, actor: requestedBy, action: 'PRE_REVIEW_READY', detail: { recommendation: result.recommendation, findings: result.findings.length, ai: live ? 'yes' : 'no' } });
    return { ...row, status: 'READY', result, inputHash: hash, live };
  } catch (err: any) {
    logger.error({ err, vendor: v.id }, 'pre-review failed');
    await db.update(preReviews).set({ status: 'FAILED', error: String(err?.message ?? err).slice(0, 300) }).where(eq(preReviews.id, row.id));
    return null;
  }
}

defineJob<{ vendorId: string }>('prereview.generate', async ({ vendorId }) => { await generatePreReview(vendorId); }, { retryLimit: 1, expireInSeconds: 300 });
export const queuePreReview = (vendorId: string) => enqueue('prereview.generate', { vendorId }, { singletonKey: `prereview:${vendorId}` });

/** The latest pre-review of the current cycle, and whether the supplier's data changed since. */
export async function latestPreReview(tenant: Tenant, v: Vendor & { documents: (typeof documents.$inferSelect)[] }) {
  const find = () => db.query.preReviews.findFirst({ where: and(eq(preReviews.vendorId, v.id), eq(preReviews.cycle, v.reviewCycle)), orderBy: desc(preReviews.createdAt) });
  let row = await find();
  // Submitted before pre-reviews existed (or the job was lost): make one now.
  if (!row && v.status === 'UNDER_REVIEW') { await queuePreReview(v.id); row = await find(); }
  if (!row) return null;
  let stale = false;
  if (row.status === 'READY' && v.status === 'UNDER_REVIEW') stale = (await gather(tenant, v).catch(() => null))?.hash !== row.inputHash;
  return { id: row.id, status: row.status, provider: row.provider, live: row.live, result: row.result as PreReviewResult | null, createdAt: row.createdAt, requestedBy: row.requestedBy, stale, aiOn: aiPreReviewOn(tenant), sentToAi: row.sentToAi ?? null };
}

/** Asked for again by a person (e.g. after the supplier fixed something). At most once a minute per supplier. */
export async function regeneratePreReview(tenant: Tenant, vendorId: string, who: string) {
  const v = await db.query.vendors.findFirst({ where: and(eq(vendors.tenantId, tenant.id), eq(vendors.id, vendorId)) });
  if (!v) throw new HttpError(404, 'Vendor not found');
  const last = await db.query.preReviews.findFirst({ where: eq(preReviews.vendorId, v.id), orderBy: desc(preReviews.createdAt) });
  if (last && Date.now() - last.createdAt.getTime() < 60_000 && last.status !== 'FAILED') throw new HttpError(429, 'A pre-review was just made — wait a minute before asking again');
  return generatePreReview(v.id, who);
}

