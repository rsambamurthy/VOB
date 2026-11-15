/**
 * Privacy mode, shared by everything that sends text to the AI provider (approvers' pre-review, the supplier guide):
 *  - `identifiersOf`: every value that would identify the supplier or a person (what was typed into the form, contact
 *    details, names, matching suppliers);
 *  - `leaks`: the guard — true if any of them appears in what is about to be sent;
 *  - `pseudonymise` / `reidentify`: swap identifying values in free text (a question, a buyer's remarks) for tokens
 *    ([VALUE-1]…) before sending, and put them back in what the AI writes.
 */
import type { Profile } from '../lib/profileEngine.js';
import type { Vendor } from '../db/schema.js';
import { logger } from '../lib/logger.js';

/** Answers picked from the form's fixed lists — not identifying, so never treated as typed-in values. */
export const optionValues = (config: { sections: { groups: { fields: { options?: string[] }[] }[] }[] }) =>
  new Set(config.sections.flatMap((s) => s.groups.flatMap((g) => g.fields.flatMap((f) => f.options ?? []))));

const TOKEN = /\[(supplier|other-\d+|value-\d+)\]/g;

export function identifiersOf(v: Pick<Vendor, 'name' | 'code' | 'contactEmail' | 'contactMobile' | 'contactFirstName' | 'contactLastName' | 'profile'>, dups: { code: string; name: string }[] = [], allowed: Set<string> = new Set()) {
  const out = new Set<string>();
  const addVal = (x: unknown) => { const t = String(x ?? '').trim(); if (t.length >= 4) out.add(t.toLowerCase()); };
  [v.name, v.code, v.contactEmail, v.contactMobile, `${v.contactFirstName} ${v.contactLastName}`].forEach(addVal);
  // Typed-in values with a number, an @ or several words (registration numbers, accounts, emails, names, addresses).
  for (const sec of Object.values(v.profile as Profile)) for (const val of Object.values(sec ?? {})) if (typeof val === 'string' && !allowed.has(val) && /\d|@|\S\s+\S/.test(val)) addVal(val);
  for (const d of dups) { addVal(d.name); addVal(d.code); }
  return out;
}

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (x: string, flags = 'u') => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(x)}($|[^\\p{L}\\p{N}])`, flags);

/** True if any identifying value appears in the payload (as whole words; the tokens themselves don't count). */
export function leaks(payload: unknown, ids: Set<string>, what = 'AI payload') {
  const text = (typeof payload === 'string' ? payload : JSON.stringify(payload)).toLowerCase().replace(TOKEN, ' ');
  for (const id of ids) {
    for (const form of new Set([id, JSON.stringify(id).slice(1, -1)])) {
      if (wordRe(form).test(text)) { logger.warn(`privacy guard: identifying data found in the ${what} — not sent`); return true; }
    }
  }
  return false;
}

/** Replace identifying values in free text with [VALUE-n] (numbered in order of appearance); `tokens` puts them back. */
export function pseudonymise(text: string, ids: Set<string>, tokens: Record<string, string> = {}) {
  // Every match, longest values first so a name isn't split by a shorter value inside it.
  const hits: { start: number; end: number }[] = [];
  for (const id of [...ids].sort((a, b) => b.length - a.length)) {
    for (const m of text.matchAll(wordRe(id, 'giu'))) {
      const start = (m.index ?? 0) + m[1].length, end = start + m[0].length - m[1].length - m[2].length;
      if (!hits.some((h) => start < h.end && end > h.start)) hits.push({ start, end });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  let n = Object.keys(tokens).filter((k) => k.startsWith('[VALUE-')).length;
  let out = '', at = 0;
  for (const h of hits) {
    const original = text.slice(h.start, h.end);
    const tok = Object.entries(tokens).find(([, val]) => val.toLowerCase() === original.toLowerCase())?.[0] ?? `[VALUE-${++n}]`;
    tokens[tok] ??= original;
    out += text.slice(at, h.start) + tok; at = h.end;
  }
  return { text: out + text.slice(at), tokens };
}

/** Put the real values back into what the AI wrote. */
export const reidentify = (text: string, tokens: Record<string, string>) => Object.entries(tokens).reduce((t, [k, val]) => t.split(k).join(val), text);
