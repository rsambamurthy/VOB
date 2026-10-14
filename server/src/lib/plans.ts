/**
 * Subscription plans. A tenant's effective limits = its plan's values, overridden by tenant.limits
 * (set per tenant in the platform console). null = unlimited.
 */
import type { Tenant, TenantLimits } from '../db/schema.js';

export type Feature = 'erp' | 'ai' | 'kyc' | 'collab';
export interface PlanDef {
  label: string;
  maxUsers: number | null;
  maxVendors: number | null;
  emailsPerDay: number | null;
  /** AI help answers per workspace per day */
  helpAnswersPerDay?: number | null;
  features: Record<Feature, boolean>;
}

export const PLANS: Record<string, PlanDef> = {
  trial: { label: 'Trial', maxUsers: 5, maxVendors: 25, emailsPerDay: 200, helpAnswersPerDay: 30, features: { erp: false, ai: false, kyc: true, collab: true } },
  standard: { label: 'Standard', maxUsers: 25, maxVendors: 1000, emailsPerDay: 2000, helpAnswersPerDay: 300, features: { erp: true, ai: true, kyc: true, collab: true } },
  enterprise: { label: 'Enterprise', maxUsers: null, maxVendors: null, emailsPerDay: null, helpAnswersPerDay: null, features: { erp: true, ai: true, kyc: true, collab: true } },
};
export const PLAN_KEYS = Object.keys(PLANS) as [string, ...string[]];
export const FEATURE_LABELS: Record<Feature, string> = { erp: 'ERP integration', ai: 'AI document reading', kyc: 'Verification checks (GSTIN, PAN, bank)', collab: 'Supplier collaboration (purchase orders)' };

export function effectiveLimits(t: Pick<Tenant, 'plan' | 'limits'>): PlanDef {
  const p = PLANS[t.plan] ?? PLANS.standard;
  const o: TenantLimits = t.limits ?? {};
  const pick = (k: 'maxUsers' | 'maxVendors' | 'emailsPerDay') => (o[k] === undefined ? p[k] : o[k] ?? null);
  return { label: p.label, maxUsers: pick('maxUsers'), maxVendors: pick('maxVendors'), emailsPerDay: pick('emailsPerDay'), helpAnswersPerDay: p.helpAnswersPerDay ?? null, features: { ...p.features, ...(o.features ?? {}) } };
}

export const trialExpired = (t: Pick<Tenant, 'plan' | 'trialEndsAt'>) => t.plan === 'trial' && !!t.trialEndsAt && t.trialEndsAt < new Date();
