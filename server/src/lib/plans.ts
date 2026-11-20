/**
 * Subscription plans. A tenant's effective limits = its plan's values, overridden by tenant.limits
 * (set per tenant in the platform console). null = unlimited.
 */
import type { Tenant, TenantLimits } from '../db/schema.js';
import { licenceLimits } from './licence.js';
import { FEATURE_LABELS, resolveFeatures, type Feature, type SourcingFormat } from './features.js';

export { FEATURE_LABELS, type Feature };

const onPrem = () => process.env.DEPLOYMENT_MODE === 'onprem';

export interface PlanDef {
  label: string;
  maxUsers: number | null;
  maxVendors: number | null;
  emailsPerDay: number | null;
  /** AI help answers per workspace per day */
  helpAnswersPerDay?: number | null;
  /** "Ask VendorGate" questions per day (AI search). */
  askPerDay?: number | null;
  features: Record<Feature, boolean>;
  /** Sourcing formats included (null = all). Only matters when the sourcing feature is on. */
  sourcingFormats?: SourcingFormat[] | null;
}

export const PLANS: Record<string, PlanDef> = {
  trial: { label: 'Trial', maxUsers: 5, maxVendors: 25, emailsPerDay: 200, helpAnswersPerDay: 30, askPerDay: 30, features: { onboarding: true, erp: false, ai: false, kyc: true, collab: true, sourcing: false, contracts: false } },
  standard: { label: 'Standard', maxUsers: 25, maxVendors: 1000, emailsPerDay: 2000, helpAnswersPerDay: 300, askPerDay: 300, features: { onboarding: true, erp: true, ai: true, kyc: true, collab: true, sourcing: false, contracts: false } },
  enterprise: { label: 'Enterprise', maxUsers: null, maxVendors: null, emailsPerDay: null, helpAnswersPerDay: null, askPerDay: null, features: { onboarding: true, erp: true, ai: true, kyc: true, collab: true, sourcing: false, contracts: false } },
  /** Contracts on its own: no supplier onboarding, sourcing or purchase orders. */
  contracts: { label: 'Contracts', maxUsers: 25, maxVendors: 0, emailsPerDay: 2000, helpAnswersPerDay: 300, askPerDay: 0, features: { onboarding: false, erp: true, ai: true, kyc: true, collab: false, sourcing: false, contracts: true } },
};
export const PLAN_KEYS = Object.keys(PLANS) as [string, ...string[]];

export function effectiveLimits(t: Pick<Tenant, 'plan' | 'limits'>): PlanDef {
  // On-prem: the licence sets users, suppliers and features; nothing else is limited.
  if (onPrem()) { const l = licenceLimits(); return { label: 'On-premises licence', maxUsers: l.maxUsers, maxVendors: l.maxVendors, emailsPerDay: null, helpAnswersPerDay: null, askPerDay: null, features: l.features, sourcingFormats: l.sourcingFormats }; }
  const p = PLANS[t.plan] ?? PLANS.standard;
  const o: TenantLimits = t.limits ?? {};
  const pick = (k: 'maxUsers' | 'maxVendors' | 'emailsPerDay') => (o[k] === undefined ? p[k] : o[k] ?? null);
  return { label: p.label, maxUsers: pick('maxUsers'), maxVendors: pick('maxVendors'), emailsPerDay: pick('emailsPerDay'), helpAnswersPerDay: p.helpAnswersPerDay ?? null, askPerDay: p.askPerDay ?? null, features: resolveFeatures(p.features, o.features), sourcingFormats: o.sourcingFormats === undefined ? (p.sourcingFormats ?? null) : o.sourcingFormats };
}

export const trialExpired = (t: Pick<Tenant, 'plan' | 'trialEndsAt'>) => t.plan === 'trial' && !!t.trialEndsAt && t.trialEndsAt < new Date();
