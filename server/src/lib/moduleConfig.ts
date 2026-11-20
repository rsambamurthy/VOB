/**
 * Layered configuration for an add-on module (Sourcing, Contracts…) — one implementation, used by every module.
 *
 * Layers (each can only narrow the one above):
 *   1. plan / licence      the module's feature (an add-on) — and, optionally, which kinds are licensed
 *   2. workspace switch    settings[module].enabled
 *   3. kinds               settings[module].kinds — sourcing formats, contract types…
 *   4. options             settings[module].features[key] (some also need another plan feature, e.g. ERP or AI)
 *   5. rule defaults       settings[module].rules[key], with settings[module].locked[] — users can't change locked rules
 *   6. per record          resolveRules(): the user's choices for unlocked rules, within each rule's range
 *
 * New kinds and options are added to the catalogue with `available: false` and switched to true when released.
 */
import { z } from 'zod';
import type { Tenant } from '../db/schema.js';
import type { WorkflowLevel } from '../config/types.js';
import { effectiveLimits } from './plans.js';
import { HttpError } from './http.js';
import type { Feature } from './features.js';

export interface KindDef { label: string; help: string; available: boolean }
export interface OptionDef { area: string; label: string; help: string; default: boolean; available: boolean; requires?: Feature }
/** `workspace` = a setting for the whole workspace rather than a default each record starts with (no lock). */
export type RuleDef =
  | { kind: 'choice'; label: string; help: string; options: Record<string, string>; default: string; requires?: string; workspace?: boolean }
  | { kind: 'number'; label: string; help: string; min: number; max: number; step?: number; unit?: string; default: number | null; nullable?: boolean; requires?: string; workspace?: boolean };
export type RuleValue = string | number | null;

/** What a module stores in tenant.settings[module]. Extra keys (approval flows…) are kept as they are. */
export interface ModuleSettings {
  enabled?: boolean;
  kinds?: Record<string, boolean>;
  features?: Record<string, boolean>;
  rules?: Record<string, RuleValue>;
  locked?: string[];
  [extra: string]: unknown;
}

export interface ModuleSpec<K extends string, O extends string, R extends string> {
  /** Shown in messages: "Sourcing", "Contracts". */
  name: string;
  /** The plan / licence feature. */
  feature: Feature;
  /** Where the settings live in tenant.settings, and the stored key for kinds (sourcing keeps its original "formats"). */
  settingsKey: 'sourcing' | 'contracts';
  kindsKey: string;
  /** "format", "contract type" — in messages. */
  kindNoun: string;
  kinds: Record<K, KindDef>;
  /** Which kinds the plan / licence includes (null = all). */
  licensedKinds?: (t: Tenant) => K[] | null;
  options: Record<O, OptionDef>;
  areas: Record<string, string>;
  rules: Record<R, RuleDef>;
  /** Stored keys that saving the main settings must keep (e.g. approval flows saved on their own). */
  keep?: string[];
}

export function defineModule<K extends string, O extends string, R extends string>(spec: ModuleSpec<K, O, R>) {
  const KIND_KEYS = Object.keys(spec.kinds) as K[];
  const OPTION_KEYS = Object.keys(spec.options) as O[];
  const RULE_KEYS = Object.keys(spec.rules) as R[];
  const stored = (t: Tenant): ModuleSettings => ((t.settings as Record<string, unknown>)[spec.settingsKey] as ModuleSettings | undefined) ?? {};
  const kindsOf = (s: ModuleSettings) => (s[spec.kindsKey] as Record<string, boolean> | undefined) ?? {};

  const licensed = (t: Tenant) => effectiveLimits(t).features[spec.feature] === true;
  const on = (t: Tenant) => licensed(t) && stored(t).enabled === true;

  function kindState(t: Tenant, k: K) {
    const allowed = spec.licensedKinds?.(t) ?? null;
    const isLicensed = licensed(t) && (allowed == null || allowed.includes(k));
    const available = spec.kinds[k].available;
    const chosen = kindsOf(stored(t))[k] === true;
    return { on: on(t) && isLicensed && available && chosen, licensed: isLicensed, available, chosen };
  }
  function optionState(t: Tenant, k: O): { on: boolean; available: boolean; chosen: boolean; needs?: Feature } {
    const d = spec.options[k];
    const chosen = stored(t).features?.[k] ?? d.default;
    const needs = d.requires && effectiveLimits(t).features[d.requires] !== true ? d.requires : undefined;
    return { on: on(t) && d.available && chosen && !needs, available: d.available, chosen, ...(needs ? { needs } : {}) };
  }
  const optionOn = (t: Tenant, k: O) => optionState(t, k).on;

  function ruleSchema(k: R) {
    const r = spec.rules[k];
    if (r.kind === 'choice') return z.enum(Object.keys(r.options) as [string, ...string[]], { errorMap: () => ({ message: `${r.label}: choose one of the options` }) });
    const n = z.number({ invalid_type_error: `${r.label} must be a number` }).min(r.min, `${r.label} must be at least ${r.min}`).max(r.max, `${r.label} must be at most ${r.max}`);
    return r.nullable ? n.nullable() : n;
  }
  const ruleValuesSchema = z.object(Object.fromEntries(RULE_KEYS.map((k) => [k, ruleSchema(k).optional()]))).strict();
  const settingsSchema = z.object({
    enabled: z.boolean(),
    [spec.kindsKey]: z.object(Object.fromEntries(KIND_KEYS.map((k) => [k, z.boolean().optional()]))).strict().default({}),
    features: z.object(Object.fromEntries(OPTION_KEYS.map((k) => [k, z.boolean().optional()]))).strict().default({}),
    rules: ruleValuesSchema.default({}),
    locked: z.array(z.enum(RULE_KEYS as [R, ...R[]])).default([]),
  });

  function ruleDefaults(t: Tenant): Record<R, RuleValue> {
    const r = stored(t).rules ?? {};
    return Object.fromEntries(RULE_KEYS.map((k) => [k, r[k] !== undefined ? r[k] : spec.rules[k].default])) as Record<R, RuleValue>;
  }
  const lockedRules = (t: Tenant) => new Set<R>((stored(t).locked ?? []) as R[]);

  /** The rules for one record: defaults plus the user's choices for unlocked rules; rules whose option is off are dropped. */
  function resolveRules(t: Tenant, choices: Partial<Record<R, unknown>> = {}, noun = 'record'): Partial<Record<R, RuleValue>> {
    const base = ruleDefaults(t);
    const locked = lockedRules(t);
    const tried = (Object.keys(choices) as R[]).filter((k) => choices[k] !== undefined && choices[k] !== base[k] && locked.has(k));
    if (tried.length) throw new HttpError(400, `${tried.map((k) => spec.rules[k].label).join(', ')} ${tried.length === 1 ? 'is' : 'are'} set by your administrator and can’t be changed for ${noun === 'event' ? 'an' : 'a'} ${noun}.`);
    const unknownKeys = Object.keys(choices).filter((k) => !(RULE_KEYS as string[]).includes(k));
    if (unknownKeys.length) throw new HttpError(400, `Unknown rule: ${unknownKeys.join(', ')}`);
    const parsed = ruleValuesSchema.safeParse(Object.fromEntries(Object.entries(choices).filter(([, v]) => v !== undefined)));
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0].message);
    const out: Partial<Record<R, RuleValue>> = { ...base, ...(parsed.data as Partial<Record<R, RuleValue>>) };
    for (const k of RULE_KEYS) { const req = spec.rules[k].requires as O | undefined; if (req && !optionOn(t, req)) delete out[k]; }
    return out;
  }

  /** Everything the configuration screen needs. */
  function config(t: Tenant) {
    const s = stored(t);
    return {
      licensed: licensed(t), enabled: s.enabled === true, on: on(t),
      kinds: KIND_KEYS.map((k) => ({ key: k, label: spec.kinds[k].label, help: spec.kinds[k].help, ...kindState(t, k) })),
      features: OPTION_KEYS.map((k) => { const d = spec.options[k]; return { key: k, area: d.area, label: d.label, help: d.help, default: d.default, ...optionState(t, k) }; }),
      areas: spec.areas,
      rules: RULE_KEYS.map((k) => ({ key: k, ...spec.rules[k], value: ruleDefaults(t)[k], locked: lockedRules(t).has(k) })),
    };
  }
  const summary = (t: Tenant) => ({ on: on(t), kinds: KIND_KEYS.filter((k) => kindState(t, k).on) });

  function assertOn(t: Tenant) { if (!on(t)) throw new HttpError(404, `${spec.name} isn’t switched on for this workspace`); }
  function assertKindOn(t: Tenant, k: K) {
    const st = kindState(t, k);
    if (st.on) return;
    const label = spec.kinds[k]?.label ?? k;
    throw new HttpError(400, !st.licensed ? `${label} isn’t included in your plan.` : !st.available ? `${label} isn’t available yet.` : `${label} is switched off in Administration → ${spec.name}.`);
  }

  /** Check what the administrator saves against the plan / licence and what has been released; list what changed. */
  function checkSettings(t: Tenant, input: unknown): { settings: ModuleSettings; changes: string[] } {
    const next = settingsSchema.parse(input) as ModuleSettings;
    const nextKinds = kindsOf(next);
    if (next.enabled && !licensed(t)) throw new HttpError(403, `${spec.name} isn’t included in your plan. Contact us to add it.`, undefined, 'PLAN_LIMIT');
    for (const k of KIND_KEYS) {
      if (!nextKinds[k]) continue;
      const st = kindState(t, k);
      if (!st.available) throw new HttpError(400, `${spec.kinds[k].label} isn’t available yet.`);
      if (!st.licensed) throw new HttpError(403, `${spec.kinds[k].label} isn’t included in your plan.`, undefined, 'PLAN_LIMIT');
    }
    for (const k of OPTION_KEYS) if (next.features?.[k] && !spec.options[k].available) throw new HttpError(400, `${spec.options[k].label} isn’t available yet.`);
    if (next.enabled && !KIND_KEYS.some((k) => nextKinds[k])) throw new HttpError(400, `Choose at least one ${spec.kindNoun} to switch ${spec.name} on.`);
    // Store only what differs from the catalogue defaults, so new defaults reach workspaces that never changed them.
    const features = Object.fromEntries(Object.entries(next.features ?? {}).filter(([k, v]) => v !== spec.options[k as O].default));
    const rules = Object.fromEntries(Object.entries(next.rules ?? {}).filter(([k, v]) => v !== spec.rules[k as R].default));
    const prev = stored(t), prevKinds = kindsOf(prev), changes: string[] = [];
    const kept = Object.fromEntries((spec.keep ?? []).filter((k) => prev[k] !== undefined).map((k) => [k, prev[k]]));
    const settings: ModuleSettings = { enabled: next.enabled, [spec.kindsKey]: nextKinds, features, rules, locked: [...new Set(next.locked)], ...kept };
    const onOff = (b: boolean | undefined) => (b ? 'on' : 'off');
    if (!!prev.enabled !== !!settings.enabled) changes.push(`${spec.name} ${onOff(settings.enabled)}`);
    for (const k of KIND_KEYS) if (!!prevKinds[k] !== !!nextKinds[k]) changes.push(`${spec.kinds[k].label} ${onOff(nextKinds[k])}`);
    for (const k of OPTION_KEYS) {
      const a = prev.features?.[k] ?? spec.options[k].default, b = (settings.features as Record<string, boolean>)[k] ?? spec.options[k].default;
      if (a !== b) changes.push(`${spec.options[k].label} ${onOff(b)}`);
    }
    for (const k of RULE_KEYS) {
      const a = prev.rules?.[k] ?? spec.rules[k].default, b = (settings.rules as Record<string, RuleValue>)[k] ?? spec.rules[k].default;
      if (a !== b) changes.push(`${spec.rules[k].label}: ${a ?? '—'} → ${b ?? '—'}`);
      const la = (prev.locked ?? []).includes(k), lb = (settings.locked ?? []).includes(k);
      if (la !== lb) changes.push(`${spec.rules[k].label} ${lb ? 'locked' : 'unlocked'}`);
    }
    return { settings, changes };
  }

  return { KIND_KEYS, OPTION_KEYS, RULE_KEYS, stored, licensed, on, kindState, optionState, optionOn, ruleValuesSchema, settingsSchema, ruleDefaults, lockedRules, resolveRules, config, summary, assertOn, assertKindOn, checkSettings };
}

/* ---------------- approval flows (events, awards, contracts…) ---------------- */

const OPS_ALLOWED = ['eq', 'neq', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty'] as const;
export const levelSchema = z.object({
  id: z.string().regex(/^[A-Za-z][\w-]{0,40}$/),
  label: z.string().trim().min(2, 'Give each level a name').max(80),
  roleKey: z.string().min(1),
  slaHours: z.number().int().min(1).max(1440).optional(),
  rule: z.object({ match: z.enum(['all', 'any']), conditions: z.array(z.object({ field: z.string(), op: z.enum(OPS_ALLOWED), value: z.union([z.string(), z.number(), z.array(z.string())]).optional() })).min(1) }).optional(),
});

/** Check an approval flow (levels like the onboarding flow) before storing it: roles exist, conditions use known fields. */
export function checkLevels(input: unknown, fieldIds: string[], roleKeys: string[]) {
  const levels = z.array(levelSchema).max(10, 'At most 10 levels').parse(input) as WorkflowLevel[];
  const fields = new Set(fieldIds);
  const issues: { path: string; message: string }[] = [];
  const ids = new Set<string>();
  for (const l of levels) {
    if (ids.has(l.id)) issues.push({ path: `levels.${l.id}`, message: 'Two levels have the same id' });
    ids.add(l.id);
    if (!roleKeys.includes(l.roleKey)) issues.push({ path: `levels.${l.id}`, message: `“${l.label}”: choose a role that exists` });
    for (const c of l.rule?.conditions ?? []) if (!fields.has(c.field)) issues.push({ path: `levels.${l.id}`, message: `“${l.label}”: a condition uses an unknown field` });
  }
  return { levels, issues };
}
