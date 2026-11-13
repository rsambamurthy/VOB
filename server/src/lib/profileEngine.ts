/**
 * Evaluates a tenant's onboarding config against a vendor's saved profile:
 * conditional visibility, required rules, format validators, document requirements,
 * and builds the "Required Fields" checklist shown to vendors and reviewers.
 */
import type { Condition, FieldDef, OnboardingConfig } from '../config/types.js';
import { validators, crossFieldChecks, UPPERCASE_VALIDATORS } from './validators.js';
import { conditionHolds, isRequired, readValue, type EvalContext, type Profile } from './conditions.js';

export type { Profile };

export interface ChecklistItem {
  id: string;          // "section.field" or "doc.TYPE"
  section: string;     // section key or "documents"
  label: string;
  ok: boolean;
  message?: string;
  severity: 'error' | 'warning';
}

const ctxOf = (profile: Profile, vendorType?: string): EvalContext => ({ profile, vendor: { vendorType } });

function countryFor(sectionKey: string, ctx: EvalContext) {
  return sectionKey === 'bank' ? readValue('bank.bankCountry', ctx) : readValue('basic.supplierCountry', ctx);
}

export function validateField(sectionKey: string, field: FieldDef, ctx: EvalContext): string | null {
  if (!conditionHolds(field.showIf, ctx)) return null;
  const value = readValue(`${sectionKey}.${field.key}`, ctx);
  if (!value) return isRequired(field.required, ctx) ? `${field.label} is required` : null;
  if (field.options?.length && (field.type === 'select' || field.type === 'radio') && !field.options.includes(value)) {
    return `${field.label}: choose one of the listed options`;
  }
  if (field.type === 'number' && Number.isNaN(Number(value.replace(/,/g, '')))) return `${field.label} must be a number`;
  if (field.validator && validators[field.validator]) return validators[field.validator](value, { country: countryFor(sectionKey, ctx) });
  return null;
}


/** Keep only keys defined in this section; trim text and normalise identifiers. */
export function sanitizeSection(cfg: OnboardingConfig, sectionKey: string, data: Record<string, unknown>): Record<string, unknown> {
  const section = cfg.sections.find((s) => s.key === sectionKey);
  if (!section) return {};
  const out: Record<string, unknown> = {};
  for (const g of section.groups) {
    for (const f of g.fields) {
      if (!(f.key in data)) continue;
      let v = data[f.key];
      if (v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;
      if (typeof v === 'string') {
        v = v.trim().slice(0, 2000);
        if (f.validator && UPPERCASE_VALIDATORS.has(f.validator)) v = (v as string).toUpperCase().replace(/\s+/g, '');
      }
      out[f.key] = v;
    }
  }
  return out;
}

export function visibleDocRequirements(cfg: OnboardingConfig, profile: Profile, vendorType?: string, opts: { undecided?: boolean } = {}) {
  const ctx = ctxOf(profile, vendorType);
  return cfg.documents.flatMap((d) => {
    if (conditionHolds(d.showIf, ctx)) return [{ ...d, isRequired: isRequired(d.required, ctx) }];
    // Documents first: the answer that decides this document isn't given yet, so offer it as "upload if it applies".
    if (opts.undecided && d.showIf && (d.showIf.op === 'eq' || d.showIf.op === 'in') && !readValue(d.showIf.field, ctx)) return [{ ...d, isRequired: false, appliesIf: describeCondition(cfg, d.showIf) }];
    return [];
  });
}

/** "Do you hold a GST number? — Yes", for showing why a document may apply. */
function describeCondition(cfg: OnboardingConfig, c: Condition) {
  const [sec, key] = c.field.split('.');
  const label = cfg.sections.find((s) => s.key === sec)?.groups.flatMap((g) => g.fields).find((f) => f.key === key)?.label ?? c.field;
  const values = Array.isArray(c.value) ? c.value.map(String) : c.value === undefined ? [] : [String(c.value)];
  return { field: label, values, op: c.op };
}

/**
 * A value filled into a field that sits behind a question ("GSTIN" behind "Do you hold a GST number?")
 * answers that question too, when the question is still blank and has a single "equals" answer.
 * Changes `profile` in place; returns the questions answered as "section.field".
 */
export function fillImpliedAnswers(cfg: OnboardingConfig, profile: Profile, filledIds: string[], vendorType?: string): string[] {
  const answered: string[] = [];
  const queue = [...filledIds];
  while (queue.length) {
    const [sec, key] = queue.shift()!.split('.');
    const c = cfg.sections.find((s) => s.key === sec)?.groups.flatMap((g) => g.fields).find((f) => f.key === key)?.showIf;
    if (!c || readValue(c.field, ctxOf(profile, vendorType))) continue;
    const v = c.op === 'eq' ? c.value : c.op === 'in' && Array.isArray(c.value) && c.value.length === 1 ? c.value[0] : undefined;
    if (v === undefined || v === '') continue;
    const [qs, qk] = c.field.split('.');
    if (!cfg.sections.some((s) => s.key === qs && s.groups.some((g) => g.fields.some((f) => f.key === qk)))) continue;
    profile[qs] = { ...(profile[qs] ?? {}), [qk]: String(v) };
    answered.push(c.field); queue.push(c.field);
  }
  return answered;
}

/**
 * The answer implied by uploading a document that was offered "if it applies": a GST certificate means
 * "Do you hold a GST number?" is Yes. Only for a single-value "equals" condition on an empty field.
 */
export function answerImpliedBy(cfg: OnboardingConfig, docType: string, profile: Profile, vendorType?: string): { section: string; field: string; value: string } | null {
  const d = cfg.documents.find((x) => x.type === docType);
  const c = d?.showIf;
  if (!c || readValue(c.field, ctxOf(profile, vendorType))) return null;
  const v = c.op === 'eq' ? c.value : c.op === 'in' && Array.isArray(c.value) && c.value.length === 1 ? c.value[0] : undefined;
  if (v === undefined || v === '') return null;
  const [section, field] = c.field.split('.');
  if (!cfg.sections.some((s) => s.key === section && s.groups.some((g) => g.fields.some((f) => f.key === field)))) return null;
  return { section, field, value: String(v) };
}

export function buildChecklist(cfg: OnboardingConfig, profile: Profile, docTypes: string[], vendorType?: string): ChecklistItem[] {
  const ctx = ctxOf(profile, vendorType);
  const items: ChecklistItem[] = [];
  for (const s of cfg.sections) {
    for (const g of s.groups) {
      for (const f of g.fields) {
        if (!conditionHolds(f.showIf, ctx)) continue;
        const required = isRequired(f.required, ctx);
        const value = readValue(`${s.key}.${f.key}`, ctx);
        if (!required && !value) continue;
        const err = validateField(s.key, f, ctx);
        items.push({ id: `${s.key}.${f.key}`, section: s.key, label: f.label, ok: !err, message: err ?? undefined, severity: 'error' });
      }
    }
  }
  for (const d of visibleDocRequirements(cfg, profile, vendorType)) {
    if (!d.isRequired) continue;
    const ok = docTypes.includes(d.type);
    items.push({ id: `doc.${d.type}`, section: 'documents', label: d.label, ok, message: ok ? undefined : `${d.label} must be uploaded`, severity: 'error' });
  }
  for (const c of crossFieldChecks(profile)) {
    const isWarning = c.field === 'bank.accountHolderName';
    items.push({ id: `cross.${c.field}`, section: c.field.split('.')[0], label: c.message, ok: false, message: c.message, severity: isWarning ? 'warning' : 'error' });
  }
  return items;
}

export function isSubmittable(checklist: ChecklistItem[]) {
  return checklist.every((i) => i.ok || i.severity === 'warning');
}
