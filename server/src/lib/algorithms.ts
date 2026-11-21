/**
 * Configurable algorithms — one way to define, configure and document every rule set VendorGate runs on its own
 * (invoice duplicate check today). A definition carries its steps, parameters and rules with plain-English wording; the
 * same definition drives:
 *   - the checks themselves (`resolve(t)` → the workspace's parameters and each rule's action),
 *   - Administration (`view(t)`, saved by `save(t, raw)` under settings.algorithms[key]; one AlgorithmCard on the web),
 *   - the documentation (`markdown()` → docs/ALGORITHMS.md, kept in step by a test).
 * Never hard-code a threshold an algorithm uses: add a parameter.
 */
import { z } from 'zod';
import type { Tenant } from '../db/schema.js';
import { HttpError } from './http.js';

export type RuleAction = 'block' | 'warn' | 'off';
export const ACTION_LABEL: Record<RuleAction, string> = { block: 'Block', warn: 'Warn', off: 'Off' };

export interface AlgoParam { key: string; label: string; help: string; type: 'number' | 'boolean'; default: number | boolean; min?: number; max?: number; unit?: string }
export interface AlgoRule {
  key: string; label: string;
  /** When it matches, in plain words. */
  when: string;
  /** What it catches. */
  catches: string;
  default: RuleAction;
  actions: RuleAction[];
  /** Why it can't be changed (shown instead of the choice). */
  locked?: string;
}
export interface AlgoExample { before: string; after: string; rule: string; result: string }
export interface AlgorithmDef {
  key: string; name: string; module: string; summary: string;
  /** Where it runs. */
  runs: string;
  steps: { title: string; text: string }[];
  params: AlgoParam[];
  rules: AlgoRule[];
  examples?: AlgoExample[];
  notes?: string[];
  /** Shown in Administration only when this holds (e.g. the add-on is on). */
  enabled: (t: Tenant) => boolean;
}
export interface AlgoSettings { params?: Record<string, number | boolean>; rules?: Record<string, RuleAction> }
export type Resolved = { params: Record<string, number | boolean>; rules: Record<string, RuleAction> };

const registry = new Map<string, ReturnType<typeof defineAlgorithm>>();
export const algorithms = () => [...registry.values()];
export function algorithm(key: string) {
  const a = registry.get(key);
  if (!a) throw new HttpError(404, 'Unknown algorithm');
  return a;
}

export function defineAlgorithm(def: AlgorithmDef) {
  const stored = (t: Pick<Tenant, 'settings'>): AlgoSettings => ((t.settings as { algorithms?: Record<string, AlgoSettings> }).algorithms ?? {})[def.key] ?? {};

  /** The workspace's parameters and actions (defaults where not set; locked rules always at their default). */
  function resolve(t: Pick<Tenant, 'settings'>): Resolved {
    const s = stored(t);
    const params = Object.fromEntries(def.params.map((p) => {
      const v = s.params?.[p.key];
      return [p.key, typeof v === typeof p.default ? v! : p.default];
    }));
    const rules = Object.fromEntries(def.rules.map((r) => {
      const v = s.rules?.[r.key];
      return [r.key, !r.locked && v && r.actions.includes(v) ? v : r.default];
    }));
    return { params, rules };
  }

  const schema = z.object({
    params: z.object(Object.fromEntries(def.params.map((p) => [p.key, p.type === 'boolean' ? z.boolean()
      : z.coerce.number().finite().min(p.min ?? -Infinity, `${p.label}: at least ${p.min}`).max(p.max ?? Infinity, `${p.label}: at most ${p.max}`)]))).partial().strict().default({}),
    rules: z.object(Object.fromEntries(def.rules.map((r) => [r.key, z.enum(r.actions as [RuleAction, ...RuleAction[]])]))).partial().strict().default({}),
  }).strict();

  /** Check and store; answers the new settings and what changed (for the audit). */
  function save(t: Pick<Tenant, 'settings'>, raw: unknown) {
    const input = schema.parse(raw ?? {});
    for (const r of def.rules) if (r.locked && input.rules[r.key] && input.rules[r.key] !== r.default) throw new HttpError(400, `${r.key} can’t be changed: ${r.locked}`);
    const before = resolve(t);
    const next = { params: { ...stored(t).params, ...input.params }, rules: { ...stored(t).rules, ...input.rules } } as AlgoSettings;
    const after = resolve({ settings: { ...t.settings, algorithms: { ...(t.settings as { algorithms?: object }).algorithms, [def.key]: next } } as Tenant['settings'] });
    const changes = [
      ...def.params.filter((p) => before.params[p.key] !== after.params[p.key]).map((p) => `${p.label}: ${before.params[p.key]} → ${after.params[p.key]}`),
      ...def.rules.filter((r) => before.rules[r.key] !== after.rules[r.key]).map((r) => `${r.key} ${r.label}: ${ACTION_LABEL[before.rules[r.key]]} → ${ACTION_LABEL[after.rules[r.key]]}`),
    ];
    const settings = { ...t.settings, algorithms: { ...(t.settings as { algorithms?: object }).algorithms, [def.key]: next } } as Tenant['settings'];
    return { settings, changes };
  }

  /** Everything a screen shows: the definition with this workspace's values. */
  function view(t: Pick<Tenant, 'settings'>) {
    const r = resolve(t);
    const { enabled: _e, ...rest } = def;
    return { ...rest, values: r, defaults: { params: Object.fromEntries(def.params.map((p) => [p.key, p.default])), rules: Object.fromEntries(def.rules.map((x) => [x.key, x.default])) } };
  }

  /** The definition as documentation (Markdown), defaults shown. */
  function markdown() {
    const out = [`## ${def.name}`, '', `*${def.module}* — ${def.summary}`, '', `**Runs:** ${def.runs}`, '', '### How it works', ''];
    def.steps.forEach((s, i) => out.push(`${i + 1}. **${s.title}** — ${s.text}`));
    out.push('', '### Settings (Administration)', '', '| Setting | Default | Range | Meaning |', '|---|---|---|---|');
    for (const p of def.params) out.push(`| ${p.label} | ${p.type === 'boolean' ? (p.default ? 'On' : 'Off') : `${p.default}${p.unit ? ` ${p.unit}` : ''}`} | ${p.type === 'boolean' ? 'On / Off' : `${p.min ?? ''}–${p.max ?? ''}`} | ${p.help} |`);
    if (def.rules.length) out.push('', '### Rules', '', '| Rule | Default | Can be set to | Matches when | Catches |', '|---|---|---|---|---|');
    for (const r of def.rules) out.push(`| ${r.key} ${r.label} | ${ACTION_LABEL[r.default]} | ${r.locked ? `Fixed — ${r.locked}` : r.actions.map((a) => ACTION_LABEL[a]).join(' / ')} | ${r.when} | ${r.catches} |`);
    if (def.examples?.length) {
      out.push('', '### Worked examples', '', '| Already in VendorGate | New | Rule | Result |', '|---|---|---|---|');
      for (const e of def.examples) out.push(`| ${e.before} | ${e.after} | ${e.rule} | ${e.result} |`);
    }
    if (def.notes?.length) { out.push('', '### Behaviour', ''); for (const n of def.notes) out.push(`- ${n}`); }
    return out.join('\n');
  }

  const a = { def, resolve, save, view, markdown, schema };
  registry.set(def.key, a);
  return a;
}

/** docs/ALGORITHMS.md — every registered algorithm. */
export const algorithmsMarkdown = () => [
  '# VendorGate algorithms', '',
  'Generated from the algorithm definitions (`server/src/lib/algorithms.ts`) — what Administration shows and what the checks run. Regenerate with `npm run -w server docs:algorithms`.', '',
  ...algorithms().sort((a, b) => a.def.key.localeCompare(b.def.key)).flatMap((a) => [a.markdown(), '']),
].join('\n');
