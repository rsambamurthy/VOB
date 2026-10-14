/**
 * Onboarding configuration model (per tenant, versioned) and its validation.
 *
 *  sections   → tabs → groups → fields shown to the vendor
 *  documents  → uploads, each with optional required / show conditions
 *  workflow   → ordered approval levels; each level names a role and may have a rule
 *               (e.g. "only for IMPORT vendors" or "only when turnover > ₹5 cr") and an SLA
 *  guide      → help text shown in the vendor portal
 *
 * Conditions reference profile answers as "section.field", or "vendor.vendorType".
 */
import { z } from 'zod';
import { packFor, validatorNames } from '../countries/registry.js';

type ValidatorName = string;

export const FIELD_TYPES = ['text', 'textarea', 'select', 'radio', 'number', 'email', 'tel', 'date', 'url'] as const;
export const OPS = ['eq', 'neq', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty'] as const;

export type FieldType = (typeof FIELD_TYPES)[number];
export type Op = (typeof OPS)[number];

/**
 * eq / neq / in / notIn compare text; gt / gte / lt / lte compare numbers;
 * empty / notEmpty ignore value. `neq` and `notIn` are false when the field is still empty,
 * so a field like "foreign TIN" doesn't appear before the country has been chosen.
 */
export interface Condition { field: string; op: Op; value?: string | number | string[] }
export interface Rule { match: 'all' | 'any'; conditions: Condition[] }

/** A workspace's Arabic wording for its own form (supplier portal in Arabic). Empty = the built-in translation, else English. */
export interface ArabicText { label?: string; help?: string; placeholder?: string; options?: string[]; title?: string; body?: string }
export interface Translations { ar?: ArabicText }

export interface FieldDef {
  key: string;
  label: string;
  tr?: Translations;
  type: FieldType;
  required?: boolean | Condition;
  showIf?: Condition;
  options?: string[];
  validator?: ValidatorName;
  placeholder?: string;
  help?: string;
  /** Text direction for the input, e.g. 'rtl' for an Arabic name. */
  dir?: 'rtl' | 'ltr' | 'auto';
}
export interface GroupDef { key: string; label: string; fields: FieldDef[]; tr?: Translations }
export interface SectionDef { key: string; label: string; groups: GroupDef[]; tr?: Translations }
export interface DocumentRequirement {
  type: string;
  label: string;
  tr?: Translations;
  required?: boolean | Condition;
  showIf?: Condition;
  help?: string;
  /** Track an expiry date for this document (reminders 30 and 7 days before). */
  hasExpiry?: boolean;
  /** Put the vendor on hold automatically when this document lapses, until a renewal is approved. */
  holdOnExpiry?: boolean;
}
export interface WorkflowLevel {
  id: string;
  label: string;
  roleKey: string;
  /** Level only applies when this rule holds. Omit for "always". */
  rule?: Rule;
  /** Hours allowed before the step is overdue and reminders/escalation fire. */
  slaHours?: number;
}
/**
 * After approval, vendors change details through change requests. Each rule says which approval
 * levels must sign off when matching fields change. Patterns: "bank.*" (whole tab), "tax.gstin"
 * (one field) or "documents" (new / renewed documents). If no rule matches, defaultLevelIds apply.
 */
export interface ChangeRule { match: string[]; levelIds: string[] }
export interface ChangeApproval { rules: ChangeRule[]; defaultLevelIds: string[] }

export interface OnboardingConfig {
  sections: SectionDef[];
  documents: DocumentRequirement[];
  workflow: { levels: WorkflowLevel[]; changes?: ChangeApproval };
  guide: { title: string; body: string; tr?: Translations }[];
}

/**
 * Fields the platform itself depends on (ERP export, validators, verification, invites).
 * They can be relabelled, re-ordered, moved between groups and have their rules changed,
 * but not deleted or re-keyed.
 */
export const CORE_FIELDS = [
  'basic.vendorName', 'basic.tradingName', 'basic.entityType', 'basic.supplierCountry', 'basic.address', 'basic.region', 'basic.district', 'basic.postalCode',
  'basic.contactName', 'basic.contactEmail', 'basic.contactMobile', 'basic.accountsEmail', 'basic.paymentTerms',
  'bank.bankCountry', 'bank.bankName', 'bank.accountHolderName', 'bank.accountNumber', 'bank.bankBranch', 'bank.swift', 'bank.iban',
  'tax.vatNumber', 'tax.foreignTin',
  'risk.currency', 'risk.annualTurnover',
] as const;
/** Platform core fields plus the ones the workspace's home country pack relies on. */
export const coreFieldsFor = (homeCountry?: string | null): string[] => [...CORE_FIELDS, ...(packFor(homeCountry ?? 'IN').coreFields ?? [])];
export const CORE_SECTIONS = ['basic', 'bank', 'tax', 'risk'] as const;

/** Things a condition can point at besides profile fields. */
export const VENDOR_ATTRIBUTES = [{ key: 'vendor.vendorType', label: 'Vendor type', options: ['DOMESTIC', 'IMPORT', 'GOVERNMENT'] }] as const;

export const vendorTypes = [
  { value: 'DOMESTIC', label: 'Domestic' },
  { value: 'IMPORT', label: 'Import (foreign)' },
  { value: 'GOVERNMENT', label: 'Government' },
] as const;

/* ---------- Structural validation (zod) ---------- */

const KEY = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/, 'Keys must start with a letter and use letters, digits or _ (max 40)');
const DOC_KEY = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Document codes must be UPPER_CASE letters, digits or _');
const condition = z.object({
  field: z.string().min(3),
  op: z.enum(OPS),
  value: z.union([z.string().max(200), z.number(), z.array(z.string().max(200)).max(50)]).optional(),
});
const arText = z.object({
  label: z.string().max(200).optional(), help: z.string().max(400).optional(), placeholder: z.string().max(160).optional(),
  options: z.array(z.string().max(160)).max(200).optional(), title: z.string().max(160).optional(), body: z.string().max(3000).optional(),
}).strict();
const tr = z.object({ ar: arText.optional() }).strict().optional();
const field = z.object({
  key: KEY, tr,
  label: z.string().min(1).max(160),
  type: z.enum(FIELD_TYPES),
  required: z.union([z.boolean(), condition]).optional(),
  showIf: condition.optional(),
  options: z.array(z.string().min(1).max(120)).max(200).optional(),
  validator: z.string().refine((v) => validatorNames().includes(v), (v) => ({ message: `Unknown format check “${v}”` })).optional(),
  placeholder: z.string().max(120).optional(),
  help: z.string().max(300).optional(),
  dir: z.enum(['rtl', 'ltr', 'auto']).optional(),
});
export const configSchema = z.object({
  sections: z.array(z.object({
    key: KEY, label: z.string().min(1).max(60), tr,
    groups: z.array(z.object({ key: KEY, label: z.string().min(1).max(80), tr, fields: z.array(field).max(80) })).max(20),
  })).min(1).max(12),
  documents: z.array(z.object({
    type: DOC_KEY, label: z.string().min(1).max(120), tr,
    required: z.union([z.boolean(), condition]).optional(), showIf: condition.optional(),
    help: z.string().max(300).optional(), hasExpiry: z.boolean().optional(), holdOnExpiry: z.boolean().optional(),
  })).max(60),
  workflow: z.object({
    levels: z.array(z.object({
      id: KEY, label: z.string().min(1).max(80), roleKey: z.string().min(1).max(60),
      rule: z.object({ match: z.enum(['all', 'any']), conditions: z.array(condition).min(1).max(10) }).optional(),
      slaHours: z.number().int().min(1).max(24 * 60).optional(),
    })).max(10),
    changes: z.object({
      rules: z.array(z.object({ match: z.array(z.string().min(1).max(80)).min(1).max(20), levelIds: z.array(KEY).min(1).max(10) })).max(20),
      defaultLevelIds: z.array(KEY).min(1).max(10),
    }).optional(),
  }),
  guide: z.array(z.object({ title: z.string().min(1).max(120), body: z.string().max(2000), tr })).max(20),
});

/* ---------- Semantic validation (references, duplicates, core fields) ---------- */

export interface ConfigIssue { path: string; message: string }

export function findIssues(cfg: OnboardingConfig, roleKeys: string[], coreFields: readonly string[] = coreFieldsFor('IN')): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const fieldIds = new Map<string, FieldDef>();
  const sectionKeys = new Set<string>();
  for (const s of cfg.sections) {
    if (sectionKeys.has(s.key)) issues.push({ path: `sections.${s.key}`, message: `Duplicate tab key "${s.key}"` });
    sectionKeys.add(s.key);
    const groupKeys = new Set<string>();
    for (const g of s.groups) {
      if (groupKeys.has(g.key)) issues.push({ path: `sections.${s.key}.${g.key}`, message: `Duplicate group key "${g.key}" in ${s.label}` });
      groupKeys.add(g.key);
      for (const f of g.fields) {
        const id = `${s.key}.${f.key}`;
        if (fieldIds.has(id)) issues.push({ path: id, message: `Field key "${f.key}" is used twice in ${s.label}` });
        fieldIds.set(id, f);
        if ((f.type === 'select' || f.type === 'radio') && !f.options?.length) issues.push({ path: id, message: `“${f.label}” needs at least one option` });
      }
    }
  }
  for (const s of CORE_SECTIONS) if (!sectionKeys.has(s)) issues.push({ path: `sections.${s}`, message: `The “${s}” tab is required by the platform and can’t be removed` });
  for (const id of coreFields) if (!fieldIds.has(id)) issues.push({ path: id, message: `Built-in field ${id} is missing — it can be relabelled or moved within its tab, but not deleted or renamed` });

  const checkCond = (c: Condition | undefined, where: string) => {
    if (!c) return;
    const target = fieldIds.get(c.field);
    const isVendorAttr = VENDOR_ATTRIBUTES.some((a) => a.key === c.field);
    if (!target && !isVendorAttr) issues.push({ path: where, message: `Condition refers to “${c.field}”, which doesn’t exist` });
    if (['gt', 'gte', 'lt', 'lte'].includes(c.op) && (c.value === undefined || c.value === '' || Number.isNaN(Number(c.value)))) issues.push({ path: where, message: 'Number comparisons need a numeric value' });
    if (['in', 'notIn'].includes(c.op) && (!Array.isArray(c.value) || c.value.length === 0)) issues.push({ path: where, message: '“is one of” needs at least one value' });
    if (['eq', 'neq'].includes(c.op) && (c.value === undefined || c.value === '')) issues.push({ path: where, message: 'Comparison needs a value' });
  };
  for (const [id, f] of fieldIds) {
    checkCond(f.showIf, id);
    if (typeof f.required === 'object') checkCond(f.required, id);
    if (f.showIf?.field === id || (typeof f.required === 'object' && f.required.field === id)) issues.push({ path: id, message: `“${f.label}” can’t depend on itself` });
  }
  const docTypes = new Set<string>();
  for (const d of cfg.documents) {
    if (docTypes.has(d.type)) issues.push({ path: `documents.${d.type}`, message: `Duplicate document code ${d.type}` });
    docTypes.add(d.type);
    checkCond(d.showIf, `documents.${d.type}`);
    if (typeof d.required === 'object') checkCond(d.required, `documents.${d.type}`);
  }
  if (!cfg.workflow.levels.length) issues.push({ path: 'workflow', message: 'Add at least one approval level' });
  const levelIds = new Set<string>();
  cfg.workflow.levels.forEach((l, i) => {
    const where = `workflow.levels.${l.id}`;
    if (levelIds.has(l.id)) issues.push({ path: where, message: `Duplicate level id ${l.id}` });
    levelIds.add(l.id);
    if (!roleKeys.includes(l.roleKey)) issues.push({ path: where, message: `Level ${i + 1} (“${l.label}”) is assigned to a role that doesn’t exist` });
    l.rule?.conditions.forEach((c) => checkCond(c, where));
  });
  const ch = cfg.workflow.changes;
  if (ch) {
    const known = new Set(cfg.workflow.levels.map((l) => l.id));
    const sections = new Set(cfg.sections.map((s) => s.key));
    for (const id of [...ch.defaultLevelIds, ...ch.rules.flatMap((r) => r.levelIds)]) {
      if (!known.has(id)) issues.push({ path: 'workflow.changes', message: `Change-approval rule uses level “${id}”, which isn’t in the approval flow` });
    }
    for (const r of ch.rules) for (const m of r.match) {
      const ok = m === 'documents' || (m.endsWith('.*') ? sections.has(m.slice(0, -2)) : fieldIds.has(m));
      if (!ok) issues.push({ path: 'workflow.changes', message: `Change-approval rule matches “${m}”, which doesn’t exist` });
    }
  }
  if (cfg.workflow.levels.length && cfg.workflow.levels.every((l) => l.rule)) {
    issues.push({ path: 'workflow', message: 'At least one approval level must apply to every vendor (have no rule)' });
  }
  return issues;
}

export function allFieldIds(cfg: OnboardingConfig) {
  return cfg.sections.flatMap((s) => s.groups.flatMap((g) => g.fields.map((f) => `${s.key}.${f.key}`)));
}
