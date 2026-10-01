import type { Condition, Rule } from '../config/types.js';

export type Profile = Record<string, Record<string, unknown>>;
/** What conditions can read: the vendor's profile plus a few vendor attributes. */
export interface EvalContext { profile: Profile; vendor?: { vendorType?: string } }

export function readValue(path: string, ctx: EvalContext): string {
  const [s, f] = path.split('.');
  const raw = s === 'vendor' ? (ctx.vendor as Record<string, unknown> | undefined)?.[f] : ctx.profile?.[s]?.[f];
  return raw === undefined || raw === null ? '' : String(raw).trim();
}

export function conditionHolds(c: Condition | undefined, ctx: EvalContext): boolean {
  if (!c) return true;
  const v = readValue(c.field, ctx);
  const list = Array.isArray(c.value) ? c.value.map(String) : c.value === undefined ? [] : [String(c.value)];
  const num = Number(v.replace(/,/g, ''));
  const target = Number(c.value);
  switch (c.op) {
    case 'eq': return v === String(c.value ?? '');
    case 'neq': return v !== '' && v !== String(c.value ?? '');
    case 'in': return list.includes(v);
    case 'notIn': return v !== '' && !list.includes(v);
    case 'gt': return v !== '' && num > target;
    case 'gte': return v !== '' && num >= target;
    case 'lt': return v !== '' && num < target;
    case 'lte': return v !== '' && num <= target;
    case 'empty': return v === '';
    case 'notEmpty': return v !== '';
    default: return false;
  }
}

export function ruleHolds(r: Rule | undefined, ctx: EvalContext): boolean {
  if (!r || !r.conditions.length) return true;
  return r.match === 'any' ? r.conditions.some((c) => conditionHolds(c, ctx)) : r.conditions.every((c) => conditionHolds(c, ctx));
}

export function isRequired(req: boolean | Condition | undefined, ctx: EvalContext) {
  if (req === true) return true;
  if (!req) return false;
  return conditionHolds(req, ctx);
}
