/**
 * What an approver would pick up in a submission, worked out by VendorGate's own rules — shared by:
 *  - the approvers' pre-review (staff wording, and a value-free `ai` wording for privacy mode);
 *  - the supplier guide and the check before submitting (the supplier's wording, “your …”).
 * Staff-only matters (duplicates, risk, questionnaire scores, earlier remarks) are added by the pre-review itself.
 */
import { checkDef, checkInputs, checksForVendor, inputsComplete } from '../countries/registry.js';
import { latestChecks } from '../integrations/kyc/index.js';
import { extractionsFor } from '../integrations/ai/index.js';
import { maskField } from '../lib/fieldCrypto.js';
import type { Profile } from '../lib/profileEngine.js';
import type { OnboardingConfig } from '../config/types.js';
import type { Tenant, Vendor } from '../db/schema.js';
import { comparisons, comparisonConcerns } from './aiFacts.js';
import type { formState } from './onboarding.js';

export type IssueKind = 'missing' | 'warning' | 'check_failed' | 'check_error' | 'check_name' | 'check_not_run' | 'doc_differs' | 'doc_unreadable' | 'doc_expiring' | 'consistency';
export interface Issue {
  kind: IssueKind; severity: 'high' | 'medium' | 'info'; tab?: string;
  /** Only the supplier can fix it — a reason to send back. */
  fixable: boolean;
  /** Approvers' wording, the supplier's wording (English; translated for the supplier), and the AI's (no real values). */
  staff: string; supplier: string; ai: string;
}
const DAY = 86_400_000;
type Form = Awaited<ReturnType<typeof formState>>;

export async function submissionIssues(tenant: Tenant, config: OnboardingConfig, v: Vendor & { documents: { status: string; docType: string; expiresOn: string | null }[] }, form: Form) {
  const profile = v.profile as Profile;
  const out: Issue[] = [];
  const add = (i: Issue) => out.push(i);
  const sectionOf = (fieldId: string) => fieldId.split('.')[0];
  const docLabelOf = (type: string) => config.documents.find((x) => x.type === type)?.label ?? type;

  // Missing items and warnings, by the same rules as the form.
  for (const c of form.checklist.filter((x) => !x.ok)) {
    if (c.severity === 'error') add({ kind: 'missing', severity: 'high', tab: c.section, fixable: true, staff: c.message ?? `${c.label} is missing`, supplier: c.message ?? `${c.label} is missing`, ai: `Missing or invalid: ${c.label}` });
    else add({ kind: 'warning', severity: 'medium', tab: c.section, fixable: true, staff: c.message ?? c.label, supplier: c.message ?? c.label, ai: `To check: ${c.id.startsWith('cross.') ? 'two answers on the form don’t fit together' : c.label}` });
  }
  // Verifications.
  const checkResult: Record<string, string> = {};
  for (const c of await latestChecks(v.id)) {
    const def = checkDef(c.kind)?.def;
    if (!def) continue;
    const label = def.label;
    if (c.status === 'ERROR') { checkResult[label] = 'could not run'; add({ kind: 'check_error', severity: 'info', fixable: false, staff: `${label} check couldn't run: ${c.message}`, supplier: `${label} couldn't be verified just now. Try again later.`, ai: `${label}: the check could not run` }); }
    else if (c.status !== 'VERIFIED') { checkResult[label] = 'failed'; add({ kind: 'check_failed', severity: 'high', tab: sectionOf(def.anchor), fixable: false, staff: `${label}: ${c.message}`, supplier: `${label} check failed: ${c.message}. Correct it if it was typed wrongly, then verify again.`, ai: `${label}: failed${def.monitor === 'critical' ? ' (registration or sanctions — serious)' : ''}` }); }
    else if (c.nameMatch !== null && c.nameMatch < 70) { checkResult[label] = 'passed, but the name on record differs'; add({ kind: 'check_name', severity: 'medium', tab: sectionOf(def.anchor), fixable: true, staff: `${label}: the name on record “${c.nameOnRecord}” doesn't match the supplier's name`, supplier: `${label}: the name on record “${c.nameOnRecord}” doesn't match your company name. Use the exact registered name, or be ready to explain the difference.`, ai: `${label}: the name on record doesn't match [SUPPLIER]` }); }
    else checkResult[label] = 'passed';
  }
  for (const { def } of checksForVendor(tenant.country, profile)) {
    if (!checkResult[def.label] && inputsComplete(def, checkInputs(def, profile))) { checkResult[def.label] = 'not run yet'; add({ kind: 'check_not_run', severity: 'info', tab: sectionOf(def.anchor), fixable: false, staff: `${def.label} hasn't been verified yet — run it under Verifications`, supplier: `${def.label} hasn't been verified yet. Use Verify next to it.`, ai: `${def.label} hasn't been verified yet — run it under Verifications` }); }
  }
  // Documents that disagree with the form.
  for (const e of await extractionsFor(v.id, profile, config)) {
    const doc = e.docLabel || 'document';
    for (const x of e.suggestions.filter((y) => y.state === 'differs')) {
      const show = (val: string) => (x.sensitive ? maskField(x.fieldId, val) : val);
      add({ kind: 'doc_differs', severity: 'medium', tab: sectionOf(x.fieldId), fixable: true, staff: `${x.fieldLabel}: the form says “${show(x.current)}” but the ${doc} shows “${show(x.value)}”`, supplier: `${x.fieldLabel}: you entered “${show(x.current)}” but your ${doc} shows “${show(x.value)}”. Correct whichever is wrong.`, ai: `${x.fieldLabel}: the form and the ${doc} disagree` });
    }
    if (e.status === 'DONE' && e.summary && /not a |could not be read/i.test(e.summary)) add({ kind: 'doc_unreadable', severity: 'medium', tab: 'documents', fixable: true, staff: `${e.docLabel}: ${e.summary}`, supplier: `${e.docLabel}: this may be the wrong document, or hard to read. Upload a clear copy of the right one.`, ai: `${e.docLabel}: may be the wrong document or unreadable` });
  }
  const soon = new Date(Date.now() + 60 * DAY).toISOString().slice(0, 10);
  for (const d of v.documents.filter((x) => x.status === 'ACTIVE' && x.expiresOn && x.expiresOn <= soon)) {
    add({ kind: 'doc_expiring', severity: 'medium', tab: 'documents', fixable: true, staff: `${docLabelOf(d.docType)} expires on ${d.expiresOn} — within 60 days`, supplier: `${docLabelOf(d.docType)} expires on ${d.expiresOn}. Upload the renewed one if you have it.`, ai: `${docLabelOf(d.docType)} expires within 60 days` });
  }
  // Values that don't fit together (worked out here — e.g. GSTIN state vs address).
  const consistency = comparisons(v);
  for (const c of comparisonConcerns(consistency)) add({ kind: 'consistency', severity: c.severity, tab: c.tab, fixable: c.severity === 'medium', staff: c.text, supplier: c.supplierText, ai: c.text });
  return { issues: out, checkResult, consistency, soon };
}
