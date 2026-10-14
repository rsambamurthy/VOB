/**
 * Supplier-facing languages (English and, for Gulf workspaces, Arabic).
 *
 *   config.ar.json   — Arabic for the built-in Gulf form templates (labels, help, options, documents, guide),
 *                      keyed by the English text. A workspace's own Arabic (field.tr.ar) always wins.
 *   messages.ar.json — Arabic for messages the server sends to suppliers (validation, errors, check results),
 *                      keyed by the English text; {name} placeholders match any text and are carried over.
 *   emails.ar.ts     — supplier emails.
 *
 * Staff screens and staff emails stay in English.
 */
import type { OnboardingConfig } from '../config/types.js';
import type { Tenant, Vendor } from '../db/schema.js';
import { packFor } from '../countries/registry.js';
import CONFIG_AR from './config.ar.json' with { type: 'json' };
import MESSAGES_AR from './messages.ar.json' with { type: 'json' };

export type Lang = 'en' | 'ar';
export const LANGS: Lang[] = ['en', 'ar'];

/** Languages the buyer's supplier portal offers (from its home country). */
export const supplierLanguages = (t: Pick<Tenant, 'country'>): Lang[] => packFor(t.country).languages ?? ['en'];

/** The language new suppliers get unless they choose another. */
export function defaultSupplierLanguage(t: Pick<Tenant, 'country' | 'settings'>): Lang {
  const langs = supplierLanguages(t);
  const want = t.settings.supplierLanguage;
  return want && langs.includes(want) ? want : 'en';
}

/** The language to use with a supplier: their own choice if the buyer still offers it, else the buyer's default. */
export function vendorLanguage(t: Pick<Tenant, 'country' | 'settings'>, v?: Pick<Vendor, 'language'> | null): Lang {
  const l = v?.language as Lang | null | undefined;
  return l && supplierLanguages(t).includes(l) ? l : defaultSupplierLanguage(t);
}

export const asLang = (s: unknown): Lang | undefined => (s === 'en' || s === 'ar' ? s : undefined);

/* ---------- Text lookup ---------- */

const CONFIG: Record<string, string> = CONFIG_AR;
const EXACT: Record<string, string> = {};
const PATTERNS: { re: RegExp; names: string[]; ar: string; weight: number }[] = [];
for (const [en, ar] of Object.entries(MESSAGES_AR as Record<string, string>)) {
  if (!/\{\w+\}/.test(en)) { EXACT[en] = ar; continue; }
  const names: string[] = [];
  const src = en.split(/(\{\w+\})/).map((part) => {
    const m = /^\{(\w+)\}$/.exec(part);
    if (m) { names.push(m[1]); return '(.+?)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('');
  PATTERNS.push({ re: new RegExp(`^${src}$`, 's'), names, ar, weight: en.replace(/\{\w+\}/g, '').length });
}
PATTERNS.sort((a, b) => b.weight - a.weight);

/** The built-in Arabic for template text (shown as hints in the configuration editor). */
export const arabicDefaults = () => CONFIG;

/** Arabic for a label from the built-in templates (or the same text when there is none). */
export const arLabel = (en: string | undefined | null) => (en ? CONFIG[en] ?? EXACT[en] ?? en : en ?? '');

function one(msg: string): string | null {
  const hit = EXACT[msg] ?? CONFIG[msg];
  if (hit) return hit;
  for (const p of PATTERNS) {
    const m = p.re.exec(msg);
    if (!m) continue;
    return p.ar.replace(/\{(\w+)\}/g, (all, k) => { const i = p.names.indexOf(k); return i >= 0 ? arLabel(m[i + 1]) : all; });
  }
  return null;
}

/** A server message in the supplier's language. Unknown messages stay in English. */
export function translateMessage(msg: string, lang: Lang): string {
  if (lang === 'en' || !msg) return msg;
  const whole = one(msg);
  if (whole) return whole;
  // Several sentences joined together (e.g. all the problems with an invoice).
  const parts = msg.split(/(?<=\S)\. (?=[A-Z])/);
  if (parts.length > 1) return parts.map((p) => one(p.replace(/\.$/, '')) ?? p).join('. ');
  return msg;
}

/* ---------- The onboarding form in the supplier's language ---------- */

type Tr = { tr?: { ar?: Record<string, unknown> } };
const own = (o: Tr, k: string) => { const v = o.tr?.ar?.[k]; return typeof v === 'string' && v.trim() ? v : undefined; };
const pick = (o: Tr & Record<string, any>, k: string) => (o[k] ? own(o, k) ?? arLabel(o[k]) : o[k]);

/**
 * The configuration as the supplier sees it: labels, help and placeholders in Arabic (the workspace's
 * own wording first, then the built-in translation), and `optionLabels` for choices. Stored option
 * values stay in English so validation and reports are unchanged.
 */
export function localizeConfig<T extends Pick<OnboardingConfig, 'sections' | 'documents' | 'guide'> & { workflow?: OnboardingConfig['workflow'] }>(cfg: T, lang: Lang): T {
  if (lang === 'en') return cfg;
  return {
    ...cfg,
    sections: cfg.sections.map((s) => ({
      ...s, label: pick(s as any, 'label'),
      groups: s.groups.map((g) => ({
        ...g, label: pick(g as any, 'label'),
        fields: g.fields.map((f) => ({
          ...f, label: pick(f as any, 'label'), help: pick(f as any, 'help'), placeholder: pick(f as any, 'placeholder'),
          ...(f.options ? { optionLabels: f.options.map((o, i) => (f.tr?.ar?.options?.[i]?.trim() || arLabel(o))) } : {}),
        })),
      })),
    })),
    documents: cfg.documents.map((d) => ({ ...d, label: pick(d as any, 'label'), help: pick(d as any, 'help') })),
    guide: cfg.guide.map((g) => ({ ...g, title: pick(g as any, 'title'), body: pick(g as any, 'body') })),
    ...(cfg.workflow ? { workflow: { ...cfg.workflow, levels: cfg.workflow.levels.map((l) => ({ ...l, label: arLabel(l.label) })) } } : {}),
  };
}
