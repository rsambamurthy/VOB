/**
 * Sourcing configuration — the one place that decides what is switched on and which rules apply.
 *
 * Layers (each can only narrow the one above):
 *   1. plan / licence      feature `sourcing` (an add-on, off unless included) and `sourcingFormats`
 *   2. workspace switch    settings.sourcing.enabled
 *   3. formats             settings.sourcing.formats[format]
 *   4. sub-features        settings.sourcing.features[key]   (some also need another plan feature, e.g. ERP or AI)
 *   5. rule defaults       settings.sourcing.rules[key], with settings.sourcing.locked[] — buyers can't change locked rules
 *   6. per event           resolveRules(): the buyer's choices for unlocked rules, within each rule's range
 *
 * Every screen, route and job asks this module (sourcingOn / formatOn / featureOn / resolveRules); nothing re-checks
 * settings by hand.
 */
import { z } from 'zod';
import type { Tenant } from '../../db/schema.js';
import { effectiveLimits } from '../../lib/plans.js';
import { HttpError } from '../../lib/http.js';
import { SOURCING_FORMATS, SOURCING_FORMAT_KEYS, type Feature, type SourcingFormat } from '../../lib/features.js';

/* ---------------- catalogue ---------------- */

export type SubFeatureArea = 'bidders' | 'sealed' | 'live' | 'evaluation' | 'money' | 'controls' | 'notifications' | 'integrations' | 'ai';
export const AREA_LABELS: Record<SubFeatureArea, string> = {
  bidders: 'Bidders', sealed: 'Sealed bids', live: 'Live bidding', evaluation: 'Evaluation', money: 'Money',
  controls: 'Controls', notifications: 'Notifications', integrations: 'Integrations', ai: 'AI',
};

interface SubFeatureDef { area: SubFeatureArea; label: string; help: string; default: boolean; available: boolean; requires?: Feature }
/** Optional capabilities, each switched on or off by the administrator. `available` = built and released. */
export const SUB_FEATURES = {
  outsideBidders: { area: 'bidders', label: 'Invite outside bidders', help: 'Invite companies that aren’t VendorGate suppliers yet. They register through a short bidder form and complete full onboarding only if they win.', default: true, available: true },
  blockOverdueActions: { area: 'bidders', label: 'Leave out suppliers with overdue corrective actions', help: 'Suppliers with an overdue corrective action aren’t suggested and can’t be invited.', default: false, available: true },
  publicEvents: { area: 'bidders', label: 'Public events', help: 'Also publish open events on a public page that any company can respond to.', default: false, available: false },
  twoEnvelope: { area: 'sealed', label: 'Two-envelope bids', help: 'Technical offer first; commercial offers are opened only for bidders who qualify technically.', default: true, available: true },
  clarifications: { area: 'sealed', label: 'Clarifications', help: 'Bidders ask questions; answers go to every bidder without saying who asked.', default: true, available: true },
  bidRevision: { area: 'sealed', label: 'Revise bids before the deadline', help: 'Bidders may change or withdraw a sealed bid until the deadline; only the last version counts.', default: true, available: true },
  digitalSignature: { area: 'sealed', label: 'Digital signature on bids (DSC)', help: 'Bidders sign sealed bids with a class 3 digital signature certificate.', default: false, available: false },
  autoExtension: { area: 'live', label: 'Auto-extension', help: 'A bid in the last minutes extends the end time, so nobody can win with a last-second bid.', default: true, available: true },
  practiceAuction: { area: 'live', label: 'Practice auctions', help: 'Let bidders try the live screen before the real event.', default: false, available: false },
  proxyBidding: { area: 'live', label: 'Proxy bidding', help: 'A bidder sets a floor and the system bids for them by the minimum step.', default: false, available: false },
  multiLotModes: { area: 'live', label: 'Sequential and staggered lots', help: 'Close lots one after another or a few minutes apart, not only together.', default: false, available: false },
  technicalScoring: { area: 'evaluation', label: 'Technical scoring sheets', help: 'Evaluators score technical offers; bidders below the pass mark are left out of the commercial round.', default: true, available: true },
  awardReason: { area: 'evaluation', label: 'Reason required when not awarding to the best price', help: 'Awarding to anyone other than L1 (or H1 when selling) needs a written reason.', default: true, available: true },
  weightedBidding: { area: 'evaluation', label: 'Total-cost (weighted) bidding', help: 'Compare offers on total cost: freight, payment terms, quality and other factors, not price alone.', default: false, available: false },
  splitAward: { area: 'evaluation', label: 'Split awards', help: 'Award one lot to more than one bidder by quantity share.', default: false, available: false },
  emd: { area: 'money', label: 'Earnest money deposit (EMD)', help: 'Bidders pay a deposit before bidding; refunded after award.', default: false, available: false },
  multiCurrency: { area: 'money', label: 'Several currencies', help: 'Bids in other currencies, converted at rates fixed for the event.', default: false, available: false },
  conflictDeclaration: { area: 'controls', label: 'Conflict-of-interest declarations', help: 'Bidders and evaluators declare any conflict of interest before taking part.', default: true, available: true },
  collusionFlags: { area: 'controls', label: 'Collusion indicators', help: 'Flag patterns such as identical bids or bidders who join but never bid.', default: false, available: false },
  publicSector: { area: 'controls', label: 'Public-sector rule set', help: 'Rules for Indian public procurement (GFR / CVC): two-envelope bids, technical qualification before a reverse auction, L1 rules.', default: false, available: false },
  startReminders: { area: 'notifications', label: 'Reminders before an event starts', help: 'Email bidders a day and an hour before a live event.', default: true, available: true },
  resultLetters: { area: 'notifications', label: 'Award and regret letters', help: 'Email every bidder the outcome after the award is approved.', default: true, available: true },
  awardToErp: { area: 'integrations', label: 'Send awards to the ERP', help: 'Create the purchase order in the connected ERP when an award is approved.', default: true, available: true, requires: 'erp' },
  erpRequisitions: { area: 'integrations', label: 'Events from ERP requisitions', help: 'Start an event from a purchase requisition sent by the ERP.', default: false, available: false, requires: 'erp' },
  aiComparison: { area: 'ai', label: 'AI bid comparison summary', help: 'A written summary of the bids and anything unusual, in privacy mode (no names or values leave VendorGate).', default: false, available: false, requires: 'ai' },
} as const satisfies Record<string, SubFeatureDef>;
export type SubFeature = keyof typeof SUB_FEATURES;
export const SUB_FEATURE_KEYS = Object.keys(SUB_FEATURES) as SubFeature[];

type RuleDef =
  | { kind: 'choice'; label: string; help: string; options: Record<string, string>; default: string; requires?: SubFeature }
  | { kind: 'number'; label: string; help: string; min: number; max: number; step?: number; unit?: string; default: number | null; nullable?: boolean; requires?: SubFeature };
/** Rule defaults for new events. The administrator sets the default and whether buyers may change it. */
export const RULES = {
  visibility: { kind: 'choice', label: 'What bidders see during a live auction', help: 'Bidder names are never shown to other bidders.', options: { rank: 'Their own rank only (L1, L2…)', rank_best: 'Their rank and the best price', ladder: 'Rank and all prices (no names)' }, default: 'rank' },
  minStepPct: { kind: 'number', label: 'Minimum bid step', help: 'Each new bid must beat the bidder’s last bid by at least this much.', min: 0.1, max: 20, step: 0.1, unit: '%', default: 0.5 },
  confirmDropPct: { kind: 'number', label: 'Ask to confirm drops larger than', help: 'Guards against typing mistakes: a bid this much better than the current best must be confirmed.', min: 1, max: 90, step: 1, unit: '%', default: 20 },
  extensionMinutes: { kind: 'number', label: 'Auto-extension', help: 'A bid in the last N minutes extends the end by N minutes.', min: 1, max: 30, step: 1, unit: 'minutes', default: 5, requires: 'autoExtension' },
  maxExtensions: { kind: 'number', label: 'Most extensions', help: 'Stop extending after this many extensions.', min: 1, max: 100, step: 1, default: 20, requires: 'autoExtension' },
  envelope: { kind: 'choice', label: 'Sealed bid envelopes', help: 'Two envelopes: technical first, commercial opened only for qualified bidders.', options: { single: 'One envelope (price and terms together)', two: 'Two envelopes (technical, then commercial)' }, default: 'single', requires: 'twoEnvelope' },
  twoEnvelopeAbove: { kind: 'number', label: 'Two envelopes required above', help: 'Events with an estimated value above this always use two envelopes. Empty = never required.', min: 0, max: 1e12, step: 1, unit: 'currency', default: null, nullable: true, requires: 'twoEnvelope' },
  openingQuorum: { kind: 'number', label: 'People needed to open sealed bids', help: 'Sealed bids open only when this many members of the opening committee have approved.', min: 1, max: 5, step: 1, default: 2 },
} as const satisfies Record<string, RuleDef>;
export type RuleKey = keyof typeof RULES;
export const RULE_KEYS = Object.keys(RULES) as RuleKey[];
export type RuleValues = { [K in RuleKey]: (typeof RULES)[K] extends { kind: 'choice' } ? string : number | null };

/* ---------------- stored settings ---------------- */

/** tenant.settings.sourcing */
export interface SourcingSettings {
  enabled?: boolean;
  formats?: Partial<Record<SourcingFormat, boolean>>;
  features?: Partial<Record<SubFeature, boolean>>;
  rules?: Partial<Record<RuleKey, string | number | null>>;
  /** Rules buyers can't change per event. */
  locked?: RuleKey[];
}

function ruleSchema(k: RuleKey) {
  const r: RuleDef = RULES[k];
  if (r.kind === 'choice') return z.enum(Object.keys(r.options) as [string, ...string[]], { errorMap: () => ({ message: `${r.label}: choose one of the options` }) });
  const n = z.number({ invalid_type_error: `${r.label} must be a number` }).min(r.min, `${r.label} must be at least ${r.min}`).max(r.max, `${r.label} must be at most ${r.max}`);
  return r.nullable ? n.nullable() : n;
}
const ruleValuesSchema = z.object(Object.fromEntries(RULE_KEYS.map((k) => [k, ruleSchema(k).optional()]))).strict();

/** Validates what the administrator saves (Administration → Sourcing). */
export const sourcingSettingsSchema = z.object({
  enabled: z.boolean(),
  formats: z.object(Object.fromEntries(SOURCING_FORMAT_KEYS.map((k) => [k, z.boolean().optional()]))).strict().default({}),
  features: z.object(Object.fromEntries(SUB_FEATURE_KEYS.map((k) => [k, z.boolean().optional()]))).strict().default({}),
  rules: ruleValuesSchema.default({}),
  locked: z.array(z.enum(RULE_KEYS as [RuleKey, ...RuleKey[]])).default([]),
});

/* ---------------- effective configuration ---------------- */

const stored = (t: Tenant): SourcingSettings => t.settings.sourcing ?? {};

/** Layer 1: the plan or licence includes Sourcing. */
export const sourcingLicensed = (t: Tenant) => effectiveLimits(t).features.sourcing === true;
/** Layers 1–2: Sourcing is usable in this workspace. */
export const sourcingOn = (t: Tenant) => sourcingLicensed(t) && stored(t).enabled === true;

/** Why a format can or can't be used — for the configuration screen and error messages. */
export function formatState(t: Tenant, f: SourcingFormat): { on: boolean; licensed: boolean; available: boolean; chosen: boolean } {
  const lim = effectiveLimits(t);
  const licensed = sourcingLicensed(t) && (lim.sourcingFormats == null || lim.sourcingFormats.includes(f));
  const available = SOURCING_FORMATS[f].available;
  const chosen = stored(t).formats?.[f] === true;
  return { on: sourcingOn(t) && licensed && available && chosen, licensed, available, chosen };
}
export const formatOn = (t: Tenant, f: SourcingFormat) => formatState(t, f).on;

export function featureState(t: Tenant, k: SubFeature): { on: boolean; available: boolean; chosen: boolean; needs?: Feature } {
  const d: SubFeatureDef = SUB_FEATURES[k];
  const chosen = stored(t).features?.[k] ?? d.default;
  const needs = d.requires && effectiveLimits(t).features[d.requires] !== true ? d.requires : undefined;
  return { on: sourcingOn(t) && d.available && chosen && !needs, available: d.available, chosen, ...(needs ? { needs } : {}) };
}
export const featureOn = (t: Tenant, k: SubFeature) => featureState(t, k).on;

/** The administrator's rule defaults (catalogue defaults where not set). */
export function ruleDefaults(t: Tenant): RuleValues {
  const r = stored(t).rules ?? {};
  return Object.fromEntries(RULE_KEYS.map((k) => [k, r[k] !== undefined ? r[k] : RULES[k].default])) as RuleValues;
}
export const lockedRules = (t: Tenant) => new Set<RuleKey>(stored(t).locked ?? []);

/**
 * Layer 6: the rules for one event. Starts from the administrator's defaults and applies the buyer's choices for
 * unlocked rules (each checked against its range). Changing a locked rule is refused. Rules whose sub-feature is off
 * are dropped (e.g. no extension minutes without auto-extension). Value-based policies are applied last
 * (two envelopes above a value).
 */
export function resolveRules(t: Tenant, choices: Partial<Record<RuleKey, unknown>> = {}, ctx: { estimatedValue?: number | null } = {}): Partial<RuleValues> {
  const base = ruleDefaults(t);
  const locked = lockedRules(t);
  const tried = (Object.keys(choices) as RuleKey[]).filter((k) => choices[k] !== undefined && choices[k] !== base[k] && locked.has(k));
  if (tried.length) throw new HttpError(400, `${tried.map((k) => RULES[k].label).join(', ')} ${tried.length === 1 ? 'is' : 'are'} set by your administrator and can’t be changed for an event.`);
  const unknownKeys = Object.keys(choices).filter((k) => !(RULE_KEYS as string[]).includes(k));
  if (unknownKeys.length) throw new HttpError(400, `Unknown rule: ${unknownKeys.join(', ')}`);
  const parsed = ruleValuesSchema.safeParse(Object.fromEntries(Object.entries(choices).filter(([, v]) => v !== undefined)));
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0].message);
  const out: Partial<RuleValues> = { ...base, ...(parsed.data as Partial<RuleValues>) };
  for (const k of RULE_KEYS) {
    const req = (RULES[k] as RuleDef).requires;
    if (req && !featureOn(t, req)) delete out[k];
  }
  if (out.twoEnvelopeAbove != null && ctx.estimatedValue != null && ctx.estimatedValue > out.twoEnvelopeAbove) out.envelope = 'two';
  return out;
}

/** Everything the screens need: the catalogue with each item's state, and the stored choices. */
export function sourcingConfig(t: Tenant) {
  const s = stored(t);
  return {
    licensed: sourcingLicensed(t),
    enabled: s.enabled === true,
    on: sourcingOn(t),
    formats: SOURCING_FORMAT_KEYS.map((k) => ({ key: k, label: SOURCING_FORMATS[k].label, help: SOURCING_FORMATS[k].help, ...formatState(t, k) })),
    features: SUB_FEATURE_KEYS.map((k) => { const d: SubFeatureDef = SUB_FEATURES[k]; return { key: k, area: d.area, label: d.label, help: d.help, default: d.default, ...featureState(t, k) }; }),
    areas: AREA_LABELS,
    rules: RULE_KEYS.map((k) => ({ key: k, ...(RULES[k] as RuleDef), value: ruleDefaults(t)[k], locked: lockedRules(t).has(k) })),
  };
}
/** Short version for the signed-in user's session (menus). */
export function sourcingSummary(t: Tenant) {
  return { on: sourcingOn(t), formats: SOURCING_FORMAT_KEYS.filter((k) => formatOn(t, k)) };
}

/** Route guard: Sourcing is not there at all when it's off (404, like any missing page). */
export function assertSourcingOn(t: Tenant) {
  if (!sourcingOn(t)) throw new HttpError(404, 'Sourcing isn’t switched on for this workspace');
}
export function assertFormatOn(t: Tenant, f: SourcingFormat) {
  const st = formatState(t, f);
  if (st.on) return;
  throw new HttpError(400, !st.licensed ? `${SOURCING_FORMATS[f].label} isn’t included in your plan.` : !st.available ? `${SOURCING_FORMATS[f].label} isn’t available yet.` : `${SOURCING_FORMATS[f].label} is switched off in Administration → Sourcing.`);
}

/**
 * Check what the administrator wants to save against the plan/licence and what has been released.
 * Returns the settings to store and a short list of what changed (for the audit log).
 */
export function checkSourcingSettings(t: Tenant, input: z.input<typeof sourcingSettingsSchema>): { settings: SourcingSettings; changes: string[] } {
  const next = sourcingSettingsSchema.parse(input) as SourcingSettings;
  if (next.enabled && !sourcingLicensed(t)) throw new HttpError(403, 'Sourcing isn’t included in your plan. Contact us to add it.', undefined, 'PLAN_LIMIT');
  for (const f of SOURCING_FORMAT_KEYS) {
    if (!next.formats?.[f]) continue;
    const st = formatState(t, f);
    if (!st.available) throw new HttpError(400, `${SOURCING_FORMATS[f].label} isn’t available yet.`);
    if (!st.licensed) throw new HttpError(403, `${SOURCING_FORMATS[f].label} isn’t included in your plan.`, undefined, 'PLAN_LIMIT');
  }
  for (const k of SUB_FEATURE_KEYS) {
    const d: SubFeatureDef = SUB_FEATURES[k];
    if (next.features?.[k] && !d.available) throw new HttpError(400, `${d.label} isn’t available yet.`);
  }
  if (next.enabled && !SOURCING_FORMAT_KEYS.some((f) => next.formats?.[f])) throw new HttpError(400, 'Choose at least one format to switch Sourcing on.');
  // Store only what differs from the catalogue defaults, so new defaults reach workspaces that never changed them.
  const features = Object.fromEntries(Object.entries(next.features ?? {}).filter(([k, v]) => v !== SUB_FEATURES[k as SubFeature].default));
  const rules = Object.fromEntries(Object.entries(next.rules ?? {}).filter(([k, v]) => v !== RULES[k as RuleKey].default));
  const settings: SourcingSettings = { enabled: next.enabled, formats: next.formats, features, rules, locked: [...new Set(next.locked)] };

  const prev = stored(t), changes: string[] = [];
  const onOff = (b: boolean | undefined) => (b ? 'on' : 'off');
  if (!!prev.enabled !== !!settings.enabled) changes.push(`Sourcing ${onOff(settings.enabled)}`);
  for (const f of SOURCING_FORMAT_KEYS) if (!!prev.formats?.[f] !== !!settings.formats?.[f]) changes.push(`${SOURCING_FORMATS[f].label} ${onOff(settings.formats?.[f])}`);
  for (const k of SUB_FEATURE_KEYS) {
    const a = prev.features?.[k] ?? SUB_FEATURES[k].default, b = settings.features?.[k] ?? SUB_FEATURES[k].default;
    if (a !== b) changes.push(`${SUB_FEATURES[k].label} ${onOff(b)}`);
  }
  for (const k of RULE_KEYS) {
    const a = prev.rules?.[k] ?? RULES[k].default, b = settings.rules?.[k] ?? RULES[k].default;
    if (a !== b) changes.push(`${RULES[k].label}: ${a ?? '—'} → ${b ?? '—'}`);
    const la = (prev.locked ?? []).includes(k), lb = settings.locked!.includes(k);
    if (la !== lb) changes.push(`${RULES[k].label} ${lb ? 'locked' : 'unlocked'}`);
  }
  return { settings, changes };
}
