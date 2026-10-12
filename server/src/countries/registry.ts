/**
 * Pack registry: which packs exist, inheritance, and the merged views the rest of the app uses.
 * Add a country by writing its pack and listing it in PACKS — nothing else in the app changes.
 */
import { basePack } from './base.js';
import { indiaPack } from './in/index.js';
import { countryByName } from './list.js';
import type { CheckDef, CheckProvider, CountryPack, ExtractedField, Profile, ReadableDocument, ValidatorDef } from './types.js';

export const PACKS: CountryPack[] = [indiaPack];
export const DEFAULT_HOME = 'IN';

const byCode = new Map<string, CountryPack>([[basePack.code, basePack], ...PACKS.map((p) => [p.code, p] as const)]);

/** The pack with everything it inherits (BASE ← extends ← pack). Unknown codes get BASE. */
const resolved = new Map<string, CountryPack>();
export function packFor(code?: string | null): CountryPack {
  const key = (code ?? '').toUpperCase();
  const hit = resolved.get(key);
  if (hit) return hit;
  const own = byCode.get(key);
  if (!own) return basePack;
  const parent = own.extends ? packFor(own.extends) : basePack;
  const merged: CountryPack = {
    ...parent, ...own,
    validators: { ...parent.validators, ...own.validators },
    formats: { ...parent.formats, ...own.formats },
    documents: { ...parent.documents, ...own.documents },
    checks: [...(parent.checks ?? []), ...(own.checks ?? [])],
    erp: { ...parent.erp, ...own.erp },
  };
  resolved.set(key, merged);
  return merged;
}

/** Pack for a country as named in the supplier-country fields ("India"); BASE if it has none. */
export const packForCountryName = (name?: string | null) => packFor(countryByName(name)?.iso);

/** Countries a workspace can be set up in. */
export const homeCountries = () => PACKS.filter((p) => p.homeCountry && p.template).map((p) => ({ code: p.code, name: p.name, currency: p.currency, locale: p.locale }));
export const isHomeCountry = (code: string) => homeCountries().some((c) => c.code === code);

/** What the web app needs to format numbers and dates for a workspace. */
export function localeFor(code?: string | null) {
  const p = packFor(code ?? DEFAULT_HOME);
  return { country: p.code, countryName: p.name, currency: p.currency ?? 'USD', locale: p.locale ?? 'en-GB', weekend: p.weekend ?? [0, 6], privacyLaw: p.privacy?.lawShort ?? null };
}

/* ---------- Field formats (global by name) ---------- */

const generic = (kind: 'postalCode' | 'bankAccount', label: string): ValidatorDef => ({
  label,
  check: (v, ctx) => {
    const rule = packForCountryName(ctx.country).formats?.[kind] ?? basePack.formats![kind]!;
    return rule.pattern.test(v) ? null : rule.message;
  },
});

function buildValidators() {
  const all: Record<string, ValidatorDef & { pack: string }> = {};
  const add = (code: string, defs?: Record<string, ValidatorDef>) => {
    for (const [name, def] of Object.entries(defs ?? {})) {
      if (all[name] && all[name].pack !== code) throw new Error(`Validator "${name}" is defined by both ${all[name].pack} and ${code}`);
      all[name] = { ...def, pack: code };
    }
  };
  add(basePack.code, basePack.validators);
  add(basePack.code, { postalCode: generic('postalCode', 'Postal / PIN code'), bankAccount: generic('bankAccount', 'Bank account number') });
  for (const p of PACKS) add(p.code, p.validators);
  return all;
}
export const VALIDATORS = buildValidators();
export const validatorNames = () => Object.keys(VALIDATORS);
export const validatorList = () => Object.entries(VALIDATORS).map(([key, v]) => ({ key, label: v.label, country: v.pack === basePack.code ? null : packFor(v.pack).name }));

/** Consistency checks from every pack (each only looks at its own fields). */
export const crossChecks = (p: Profile) => PACKS.flatMap((pk) => pk.crossChecks?.(p) ?? []);

/* ---------- Online checks (global by kind) ---------- */

const CHECKS = new Map<string, { def: CheckDef; pack: string }>();
for (const p of PACKS) for (const c of p.checks ?? []) {
  if (CHECKS.has(c.kind)) throw new Error(`Check "${c.kind}" is defined twice`);
  CHECKS.set(c.kind, { def: c, pack: p.code });
}
export const checkDef = (kind: string) => CHECKS.get(kind);
export const allChecks = () => [...CHECKS.values()];
/** For the web app: what can be verified, which field gets the button, and which fields it reads. */
export const checkList = () => allChecks().map(({ def, pack }) => ({ kind: def.kind, label: def.label, anchor: def.anchor, buttonLabel: def.buttonLabel ?? 'Verify', inputs: def.inputs, country: packFor(pack).name }));

const providers = new Map<string, CheckProvider>();
export function checkProvider(packCode: string): CheckProvider | undefined {
  if (!providers.has(packCode)) { const f = packFor(packCode).checkProvider; if (f) providers.set(packCode, f()); }
  return providers.get(packCode);
}
/** Tests and admin tooling: swap the provider for one pack. */
export function setCheckProvider(packCode: string, p: CheckProvider) { providers.set(packCode, p); }
/** Provider status per pack, for the Integrations page. */
export const checkProviders = () => PACKS.filter((p) => p.checks?.length).map((p) => { const pr = checkProvider(p.code)!; return { country: p.name, title: p.checksTitle ?? `${p.name} checks`, provider: pr.name, live: pr.live }; });

/** Read a check's inputs out of a vendor profile. */
export function checkInputs(def: CheckDef, profile: Profile) {
  const out: Record<string, string> = {};
  for (const [k, fieldId] of Object.entries(def.inputs)) { const [sec, f] = fieldId.split('.'); const v = profile[sec]?.[f]; out[k] = v === undefined || v === null ? '' : String(v); }
  return out;
}

/* ---------- Document reading (global by document code) ---------- */

const DOCUMENTS: Record<string, ReadableDocument> = {};
for (const p of PACKS) for (const [code, d] of Object.entries(p.documents ?? {})) {
  if (DOCUMENTS[code]) throw new Error(`Readable document "${code}" is defined twice`);
  DOCUMENTS[code] = d;
}
export const readableDocuments = () => DOCUMENTS;
export const deriveExtracted = (fields: ExtractedField[]) => PACKS.flatMap((p) => p.deriveExtracted?.(fields) ?? []);
