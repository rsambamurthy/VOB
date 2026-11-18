/**
 * The product features a plan (cloud) or licence (on-prem) can include — one list, used by plans.ts, licence.ts,
 * the platform console, the licence issuing tool and Administration → Licence.
 *
 * `addOn` features are OFF unless a plan, a workspace override or the licence switches them on explicitly;
 * the others are on unless switched off.
 */
export const FEATURES = {
  erp: { label: 'ERP integration' },
  ai: { label: 'AI features' },
  kyc: { label: 'Verification checks (GSTIN, PAN, bank)' },
  collab: { label: 'Supplier collaboration (purchase orders)' },
  sourcing: { label: 'Sourcing (RFQs and e-auctions)', addOn: true },
} as const satisfies Record<string, { label: string; addOn?: boolean }>;

export type Feature = keyof typeof FEATURES;
export const FEATURE_KEYS = Object.keys(FEATURES) as Feature[];
export const FEATURE_LABELS = Object.fromEntries(FEATURE_KEYS.map((k) => [k, FEATURES[k].label])) as Record<Feature, string>;
export const isAddOn = (f: Feature) => 'addOn' in FEATURES[f] && !!(FEATURES[f] as { addOn?: boolean }).addOn;

/** Resolve a partial feature map: add-ons need an explicit true, the rest an explicit false to be off. */
export function resolveFeatures(...layers: (Partial<Record<Feature, boolean>> | undefined)[]): Record<Feature, boolean> {
  const merged: Partial<Record<Feature, boolean>> = Object.assign({}, ...layers.filter(Boolean));
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, isAddOn(k) ? merged[k] === true : merged[k] !== false])) as Record<Feature, boolean>;
}

/**
 * Sourcing formats. A plan/licence may include only some (`sourcingFormats`, null = all).
 * `available` = built and released; later-phase formats are listed so the configuration shows what's coming.
 */
export const SOURCING_FORMATS = {
  rfq: { label: 'Sealed bid / RFQ', help: 'Bidders send one offer before a deadline; offers stay sealed until the opening committee opens them.', available: true },
  reverse: { label: 'Reverse auction', help: 'Buying: suppliers bid prices down during a live window; the lowest (L1) wins.', available: true },
  forward: { label: 'Forward auction', help: 'Selling scrap or surplus: bidders bid prices up; the highest (H1) wins.', available: false },
  japanese: { label: 'Japanese auction', help: 'The price moves in rounds; bidders confirm they are still in or drop out. The last one in wins.', available: false },
  dutch: { label: 'Dutch auction', help: 'The price moves on a timer; the first bidder to accept wins.', available: false },
} as const;
export type SourcingFormat = keyof typeof SOURCING_FORMATS;
export const SOURCING_FORMAT_KEYS = Object.keys(SOURCING_FORMATS) as SourcingFormat[];
