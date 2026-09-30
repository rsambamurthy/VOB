/**
 * Evaluates the config in config/formSchema.ts against a vendor's saved profile:
 * conditional visibility, required rules, format validators, document requirements,
 * and builds the "Required Fields" checklist shown to vendors and reviewers.
 */
import { formSchema, documentRequirements, type Condition, type FieldDef } from '../config/formSchema.js';
import { validators, crossFieldChecks } from './validators.js';

export type Profile = Record<string, Record<string, unknown>>;

export interface ChecklistItem {
  id: string;          // "section.field" or "doc.TYPE"
  section: string;     // section key or "documents"
  label: string;
  ok: boolean;
  message?: string;    // why it's not ok
  severity: 'error' | 'warning';
}

function get(profile: Profile, path: string): string {
  const [s, f] = path.split('.');
  const v = profile?.[s]?.[f];
  return v === undefined || v === null ? '' : String(v).trim();
}

export function conditionHolds(c: Condition | undefined, profile: Profile): boolean {
  if (!c) return true;
  const v = get(profile, c.field);
  if (c.equals !== undefined) return v === c.equals;
  if (c.notEquals !== undefined) return v !== '' && v !== c.notEquals;
  if (c.in) return c.in.includes(v);
  return true;
}

function isRequired(req: FieldDef['required'], profile: Profile): boolean {
  if (req === true) return true;
  if (!req) return false;
  return conditionHolds(req, profile);
}

function countryFor(sectionKey: string, profile: Profile) {
  return sectionKey === 'bank' ? get(profile, 'bank.bankCountry') : get(profile, 'basic.supplierCountry');
}

/** Validate a single field value; returns error message or null. */
export function validateField(sectionKey: string, field: FieldDef, profile: Profile): string | null {
  if (!conditionHolds(field.showIf, profile)) return null;
  const value = get(profile, `${sectionKey}.${field.key}`);
  if (!value) return isRequired(field.required, profile) ? `${field.label} is required` : null;
  if (field.options && (field.type === 'select' || field.type === 'radio') && !field.options.includes(value)) {
    return `${field.label}: choose one of the listed options`;
  }
  if (field.type === 'number' && Number.isNaN(Number(value))) return `${field.label} must be a number`;
  if (field.validator) return validators[field.validator](value, { country: countryFor(sectionKey, profile) });
  return null;
}

/** Remove keys that are not in the schema and trim / upper-case identifiers. */
export function sanitizeSection(sectionKey: string, data: Record<string, unknown>): Record<string, unknown> {
  const section = formSchema.find((s) => s.key === sectionKey);
  if (!section) return {};
  const out: Record<string, unknown> = {};
  const upper = new Set(['gstin', 'pan', 'tan', 'cin', 'ifsc', 'swift', 'iban', 'udyam']);
  for (const g of section.groups) {
    for (const f of g.fields) {
      if (!(f.key in data)) continue;
      let v = data[f.key];
      if (typeof v === 'string') {
        v = v.trim();
        if (f.validator && upper.has(f.validator)) v = (v as string).toUpperCase().replace(/\s+/g, '');
      }
      out[f.key] = v;
    }
  }
  return out;
}

export function visibleDocRequirements(profile: Profile) {
  return documentRequirements
    .filter((d) => conditionHolds(d.showIf, profile))
    .map((d) => ({ ...d, isRequired: d.required === true || (!!d.required && typeof d.required === 'object' && conditionHolds(d.required, profile)) }));
}

export function buildChecklist(profile: Profile, docTypes: string[]): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  for (const s of formSchema) {
    for (const g of s.groups) {
      for (const f of g.fields) {
        if (!conditionHolds(f.showIf, profile)) continue;
        const required = isRequired(f.required, profile);
        const value = get(profile, `${s.key}.${f.key}`);
        const err = validateField(s.key, f, profile);
        // Optional + empty fields are not listed; required or filled-in ones are.
        if (!required && !value) continue;
        items.push({ id: `${s.key}.${f.key}`, section: s.key, label: f.label, ok: !err, message: err ?? undefined, severity: 'error' });
      }
    }
  }
  for (const d of visibleDocRequirements(profile)) {
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
