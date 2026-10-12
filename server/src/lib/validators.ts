/**
 * Field format checks. The checks themselves live in the country packs (src/countries); this is the
 * merged view by name. Each returns null when valid, or an error message.
 */
import { VALIDATORS, crossChecks } from '../countries/registry.js';
import type { Profile } from '../countries/types.js';

export type ValidatorName = string;
export { gstinCheckChar } from '../countries/in/validators.js';

export const validators: Record<string, (v: string, ctx?: { country?: string }) => string | null> =
  Object.fromEntries(Object.entries(VALIDATORS).map(([k, d]) => [k, (v: string, ctx?: { country?: string }) => d.check(v, ctx ?? {})]));

/** Validators whose values are stored upper-case without spaces. */
export const UPPERCASE_VALIDATORS = new Set(Object.entries(VALIDATORS).filter(([, d]) => d.upper).map(([k]) => k));

/** Cross-field consistency checks that single-field validators can't express. */
export function crossFieldChecks(profile: Profile): { field: string; message: string }[] {
  const issues = crossChecks(profile);
  const holder = String(profile.bank?.accountHolderName ?? '').trim().toLowerCase();
  const name = String(profile.basic?.vendorName ?? '').trim().toLowerCase();
  if (holder && name && !holder.includes(name.split(/\s+/)[0])) {
    issues.push({ field: 'bank.accountHolderName', message: 'Account holder name does not appear to match the vendor name — reviewers will check this' });
  }
  return issues;
}
