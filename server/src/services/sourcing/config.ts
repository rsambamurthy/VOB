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
import type { WorkflowLevel } from '../../config/types.js';
import { effectiveLimits } from '../../lib/plans.js';
import { defineModule, checkLevels, type OptionDef, type RuleDef } from '../../lib/moduleConfig.js';
import { SOURCING_FORMATS, SOURCING_FORMAT_KEYS, type Feature, type SourcingFormat } from '../../lib/features.js';

/* ---------------- catalogue ---------------- */

export type SubFeatureArea = 'bidders' | 'sealed' | 'live' | 'evaluation' | 'money' | 'controls' | 'notifications' | 'integrations' | 'ai';
export const AREA_LABELS: Record<SubFeatureArea, string> = {
  bidders: 'Bidders', sealed: 'Sealed bids', live: 'Live bidding', evaluation: 'Evaluation', money: 'Money',
  controls: 'Controls', notifications: 'Notifications', integrations: 'Integrations', ai: 'AI',
};

interface SubFeatureDef extends OptionDef { area: SubFeatureArea }
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
  /** Event approval flow (levels like the onboarding approval flow). Missing = DEFAULT_EVENT_APPROVAL. */
  approval?: { levels: WorkflowLevel[] };
  /** Award approval flow. Missing = DEFAULT_APPROVAL.award. */
  awardApproval?: { levels: WorkflowLevel[] };
}

/* ---------------- effective configuration (the shared module layers, lib/moduleConfig.ts) ---------------- */

const M = defineModule({
  name: 'Sourcing', feature: 'sourcing', settingsKey: 'sourcing', kindsKey: 'formats', kindNoun: 'format',
  kinds: SOURCING_FORMATS, options: SUB_FEATURES, areas: AREA_LABELS, rules: RULES as Record<RuleKey, RuleDef>,
  licensedKinds: (t) => effectiveLimits(t).sourcingFormats ?? null,
  keep: ['approval', 'awardApproval'],
});
const stored = (t: Tenant) => M.stored(t) as SourcingSettings;

/** Validates what the administrator saves (Administration → Sourcing). */
export const sourcingSettingsSchema = M.settingsSchema;
/** Layer 1: the plan or licence includes Sourcing. */
export const sourcingLicensed = M.licensed;
/** Layers 1–2: Sourcing is usable in this workspace. */
export const sourcingOn = M.on;
/** Why a format can or can't be used — for the configuration screen and error messages. */
export const formatState = M.kindState;
export const formatOn = (t: Tenant, f: SourcingFormat) => M.kindState(t, f).on;
export const featureState = M.optionState;
export const featureOn = M.optionOn;
/** The administrator's rule defaults (catalogue defaults where not set). */
export const ruleDefaults = (t: Tenant) => M.ruleDefaults(t) as RuleValues;
export const lockedRules = M.lockedRules;

/**
 * Layer 6: the rules for one event — the shared resolver, then Sourcing's value-based policy (two envelopes above a value).
 */
export function resolveRules(t: Tenant, choices: Partial<Record<RuleKey, unknown>> = {}, ctx: { estimatedValue?: number | null } = {}): Partial<RuleValues> {
  const out = M.resolveRules(t, choices, 'event') as Partial<RuleValues>;
  if (out.twoEnvelopeAbove != null && ctx.estimatedValue != null && ctx.estimatedValue > out.twoEnvelopeAbove) out.envelope = 'two';
  return out;
}

/** Everything the screens need: the catalogue with each item's state, and the stored choices. */
export function sourcingConfig(t: Tenant) {
  const { kinds, ...rest } = M.config(t);
  return { ...rest, formats: kinds };
}
/** Short version for the signed-in user's session (menus). */
export function sourcingSummary(t: Tenant) { const { on, kinds } = M.summary(t); return { on, formats: kinds }; }

/** Route guard: Sourcing is not there at all when it's off (404, like any missing page). */
export const assertSourcingOn = M.assertOn;
export const assertFormatOn = M.assertKindOn;

/** Check what the administrator wants to save; returns the settings to store and what changed (for the audit log). */
export function checkSourcingSettings(t: Tenant, input: z.input<typeof sourcingSettingsSchema>): { settings: SourcingSettings; changes: string[] } {
  const { settings, changes } = M.checkSettings(t, input);
  return { settings: settings as SourcingSettings, changes };
}

/* ---------------- approval flows: events and awards ---------------- */

/**
 * Two approval flows, both with the same shape and editor as the onboarding approval flow:
 *   event — before bidders are invited; conditions on `event.estimatedValue`, `event.format`, `event.category`
 *   award — before the award goes out; conditions on `award.value`, `award.notBest` (Yes when any lot isn't awarded
 *           to the best price), `award.format`, `award.category`
 */
export type FlowKind = 'event' | 'award';
const v = (field: string, gt: number) => ({ match: 'all' as const, conditions: [{ field, op: 'gt' as const, value: gt }] });
export const DEFAULT_APPROVAL: Record<FlowKind, WorkflowLevel[]> = {
  event: [
    { id: 'finance', label: 'Finance approval', roleKey: 'FINANCE_MANAGER', rule: v('event.estimatedValue', 1_000_000), slaHours: 48 },
    { id: 'senior', label: 'Senior management approval', roleKey: 'ADMIN', rule: v('event.estimatedValue', 10_000_000), slaHours: 48 },
  ],
  award: [
    { id: 'finance', label: 'Finance approval', roleKey: 'FINANCE_MANAGER', rule: v('award.value', 1_000_000), slaHours: 48 },
    { id: 'senior', label: 'Senior management approval', roleKey: 'ADMIN', rule: { match: 'any', conditions: [{ field: 'award.value', op: 'gt', value: 10_000_000 }, { field: 'award.notBest', op: 'eq', value: 'Yes' }] }, slaHours: 48 },
  ],
};
export const DEFAULT_EVENT_APPROVAL = DEFAULT_APPROVAL.event;
const storedLevels = (t: Tenant, kind: FlowKind) => (kind === 'event' ? stored(t).approval?.levels : stored(t).awardApproval?.levels);
export const approvalLevels = (t: Tenant, kind: FlowKind): WorkflowLevel[] => storedLevels(t, kind) ?? DEFAULT_APPROVAL[kind];
export const eventApprovalLevels = (t: Tenant) => approvalLevels(t, 'event');

/** What each flow's rules can test (for the condition editor and validation). */
export async function approvalCatalog(t: Tenant, kind: FlowKind) {
  const { getPublished } = await import('../config.js');
  const { config } = await getPublished(t.id);
  const cat = config.sections.flatMap((s) => s.groups.flatMap((g) => g.fields.map((f) => ({ id: `${s.key}.${f.key}`, f })))).find((x) => x.id === 'basic.supplyCategory')?.f;
  const category = { label: 'Category', type: cat?.options?.length ? 'select' : 'text', ...(cat?.options?.length ? { options: cat.options } : {}) };
  const format = { label: 'Format', type: 'select', options: SOURCING_FORMAT_KEYS.map((k) => SOURCING_FORMATS[k].label) };
  return kind === 'event'
    ? [{ id: 'event.estimatedValue', label: 'Estimated value', type: 'number' }, { id: 'event.format', ...format }, { id: 'event.category', ...category }]
    : [{ id: 'award.value', label: 'Awarded value', type: 'number' }, { id: 'award.notBest', label: 'Not awarded to the best price', type: 'select', options: ['Yes', 'No'] }, { id: 'award.format', ...format }, { id: 'award.category', ...category }];
}
export const eventConditionCatalog = (t: Tenant) => approvalCatalog(t, 'event');
/** The values an event's approval rules are tested against. */
export const eventRuleContext = (e: { estimatedValue: string | number | null; format: string; categories: string[] }) =>
  ({ profile: { event: { estimatedValue: e.estimatedValue ?? '', format: SOURCING_FORMATS[e.format as SourcingFormat]?.label ?? e.format, category: e.categories[0] ?? '' } } });
/** The values an award's approval rules are tested against. */
export const awardRuleContext = (e: { format: string; categories: string[] }, value: number, notBest: boolean) =>
  ({ profile: { award: { value, notBest: notBest ? 'Yes' : 'No', format: SOURCING_FORMATS[e.format as SourcingFormat]?.label ?? e.format, category: e.categories[0] ?? '' } } });

/** Check an approval flow before storing it. */
export async function checkApproval(t: Tenant, kind: FlowKind, input: unknown, roleKeys: string[]) {
  return checkLevels(input, (await approvalCatalog(t, kind)).map((c) => c.id), roleKeys);
}
