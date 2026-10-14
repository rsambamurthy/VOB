/**
 * Field-level encryption at rest. Sensitive profile values (PAN, bank account, IBAN, TAN, foreign TIN)
 * are stored as "enc:v1:<AES-256-GCM>" inside the profile JSON; whole JSON blobs that may contain them
 * (ERP payloads, AI extraction results) are stored as {"$enc": "..."}. Encryption and decryption happen
 * in the column types (db/schema.ts), so the rest of the code always sees plain values.
 */
import { decrypt, encrypt } from './crypto.js';
import { SENSITIVE_FIELDS } from '../countries/registry.js';

/** Which fields are sensitive comes from the country packs (PAN and TAN in India, Qatar TIN, Oman tax card, bank account, IBAN…). */
export const SENSITIVE_PATHS: readonly string[] = Object.keys(SENSITIVE_FIELDS);
export const isSensitive = (fieldId: string) => SENSITIVE_PATHS.includes(fieldId);

const PREFIX = 'enc:v1:';
export const isSealed = (v: unknown): v is string => typeof v === 'string' && v.startsWith(PREFIX);
export const sealValue = (v: unknown) => (typeof v === 'string' && v !== '' && !isSealed(v) ? PREFIX + encrypt(v) : v);
export const openValue = (v: unknown) => (isSealed(v) ? decrypt(v.slice(PREFIX.length)) : v);

type Profile = Record<string, Record<string, unknown>>;
function mapPaths(p: Profile, fn: (v: unknown) => unknown): Profile {
  if (!p || typeof p !== 'object') return p;
  const out: Profile = { ...p };
  for (const path of SENSITIVE_PATHS) {
    const [sec, key] = path.split('.');
    if (out[sec] && typeof out[sec] === 'object' && key in out[sec]) out[sec] = { ...out[sec], [key]: fn(out[sec][key]) };
  }
  return out;
}
export const sealProfile = (p: Profile) => mapPaths(p, sealValue);
export const openProfile = (p: Profile) => mapPaths(p, openValue);

type Change = { fieldId: string; label: string; old: string; new: string };
export const sealChanges = (cs: Change[]) => (cs ?? []).map((c) => (isSensitive(c.fieldId) ? { ...c, old: sealValue(c.old) as string, new: sealValue(c.new) as string } : c));
export const openChanges = (cs: Change[]) => (cs ?? []).map((c) => (isSensitive(c.fieldId) ? { ...c, old: openValue(c.old) as string, new: openValue(c.new) as string } : c));

export const sealJson = (v: unknown) => (v === null || v === undefined ? v : { $enc: PREFIX + encrypt(JSON.stringify(v)) });
export function openJson<T>(v: unknown): T {
  if (v && typeof v === 'object' && '$enc' in (v as object) && isSealed((v as { $enc: unknown }).$enc)) return JSON.parse(decrypt((v as { $enc: string }).$enc.slice(PREFIX.length)));
  return v as T; // legacy plain value (before encryption was switched on)
}

/** Display mask: keep the first `start` and last `end` characters. */
export function mask(v: unknown, start = 2, end = 2) {
  const s = v === undefined || v === null ? '' : String(v);
  if (!s) return '';
  return s.length <= start + end ? '•'.repeat(s.length) : `${s.slice(0, start)}${'•'.repeat(Math.min(6, s.length - start - end))}${s.slice(-end)}`;
}
/** How each sensitive field is masked for display. */
export const MASKS: Readonly<Record<string, [number, number]>> = SENSITIVE_FIELDS;
export const maskField = (fieldId: string, v: unknown) => mask(v, ...(MASKS[fieldId] ?? [0, 4]));
/** Copy of a profile with every sensitive value masked (for staff views). */
export function maskProfile(p: Profile): Profile {
  if (!p || typeof p !== 'object') return p;
  const out: Profile = { ...p };
  for (const path of SENSITIVE_PATHS) {
    const [sec, key] = path.split('.');
    if (out[sec] && typeof out[sec] === 'object' && out[sec][key]) out[sec] = { ...out[sec], [key]: maskField(path, out[sec][key]) };
  }
  return out;
}
