/**
 * Screen text for the supplier portal in English and Arabic.
 *
 *   en.json — every key, in English (the source)
 *   ar.json — Arabic; a missing key falls back to English
 *
 * Text is looked up by key: t('portal.submit'). Values can contain {placeholders}; a key with
 * plural forms has variants key_zero / _one / _two / _few / _many / _other, chosen with {count}.
 * Export both files to a spreadsheet for review with `npm run i18n:export` (see docs/TRANSLATIONS.md).
 * Staff screens are English only.
 */
import { useSyncExternalStore } from 'react';
import en from './en.json';
import ar from './ar.json';

export type Lang = 'en' | 'ar';
type Dict = typeof en;
type Full = keyof Dict;
type Plural = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
type Base<K> = K extends `${infer B}_${Plural}` ? B : never;
export type Key = Full | Base<Full>;

const DICTS: Record<Lang, Partial<Record<string, string>>> = { en, ar };
export const LANG_NAMES: Record<Lang, string> = { en: 'English', ar: 'العربية' };

let lang: Lang = 'en';
const subs = new Set<() => void>();
const STORE = 'vg.supplierLang';

function apply() {
  const el = document.documentElement;
  el.lang = lang;
  el.dir = lang === 'ar' ? 'rtl' : 'ltr';
}

export function setLang(l: Lang, opts: { remember?: boolean } = {}) {
  if (opts.remember) try { localStorage.setItem(STORE, l); } catch { /* private mode */ }
  if (l === lang) return;
  lang = l;
  apply();
  subs.forEach((f) => f());
}
export const getLang = () => lang;
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
/** Re-render when the language changes; returns the current language. */
export const useLang = () => useSyncExternalStore(subscribe, getLang, getLang);

/** The supplier's preferred language among those the buyer offers: their saved choice, else the browser's, else the fallback. */
export function preferredLang(available: Lang[] | undefined, fallback: Lang = 'en'): Lang {
  const list = available?.length ? available : ['en' as Lang];
  let saved: string | null = null;
  try { saved = localStorage.getItem(STORE); } catch { /* ignore */ }
  if (saved && list.includes(saved as Lang)) return saved as Lang;
  if (list.includes('ar') && navigator.language?.toLowerCase().startsWith('ar')) return 'ar';
  return list.includes(fallback) ? fallback : list[0];
}

const rules = new Map<Lang, Intl.PluralRules>();
function lookup(key: string, l: Lang) { return DICTS[l][key] ?? DICTS.en[key]; }

export function t(key: Key, vars?: Record<string, string | number | null | undefined>): string {
  let s: string | undefined;
  if (vars && typeof vars.count === 'number') {
    let pr = rules.get(lang);
    if (!pr) { pr = new Intl.PluralRules(lang); rules.set(lang, pr); }
    const form = vars.count === 0 && lookup(`${key}_zero`, lang) ? 'zero' : pr.select(vars.count);
    s = DICTS[lang][`${key}_${form}`] ?? DICTS[lang][`${key}_other`] ?? DICTS.en[`${key}_${new Intl.PluralRules('en').select(vars.count)}`] ?? DICTS.en[`${key}_other`];
  }
  s ??= lookup(key, lang) ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
  return s;
}

/** Text from the buyer's configuration: its Arabic version when Arabic is shown and one exists. */
export function tr<T extends { tr?: { ar?: Record<string, unknown> } }>(obj: T | undefined | null, field: string, fallback = ''): string {
  if (!obj) return fallback;
  const own = (obj as Record<string, unknown>)[field];
  if (lang === 'ar') { const v = obj.tr?.ar?.[field]; if (typeof v === 'string' && v.trim()) return v; }
  return typeof own === 'string' ? own : fallback;
}

/** Arrow for "back" links, pointing the right way for the reading direction. */
export const backArrow = () => (lang === 'ar' ? '→' : '←');
export const fwdArrow = () => (lang === 'ar' ? '←' : '→');
