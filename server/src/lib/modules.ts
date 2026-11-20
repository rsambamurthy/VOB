/**
 * Product modules a workspace has (from its plan or licence): supplier onboarding, sourcing, contracts…
 * A Contracts-only workspace has no supplier onboarding, so its screens and API answer "not in your plan".
 */
import type { NextFunction, Request, Response } from 'express';
import type { Tenant } from '../db/schema.js';
import { HttpError } from './http.js';
import { effectiveLimits } from './plans.js';

export const onboardingOn = (t: Pick<Tenant, 'plan' | 'limits'>) => effectiveLimits(t).features.onboarding;
export const contractsLicensed = (t: Pick<Tenant, 'plan' | 'limits'>) => effectiveLimits(t).features.contracts;

/** API paths that belong to supplier onboarding (and what needs it: purchase orders, sourcing, supplier reports). */
const ONBOARDING_PATHS = [
  /^\/api\/staff\/(?!contracts(\/|$)|parties(\/|$)|contract-library(\/|$))/, /^\/api\/reports(\/|$)/, /^\/api\/scorecards(\/|$)/, /^\/api\/ask(\/|$)/,
  /^\/api\/questionnaires(\/|$)/, /^\/api\/agreements(\/|$)/, /^\/api\/admin\/config(\/|$)/, /^\/api\/admin\/purchasing(\/|$)/, /^\/api\/admin\/sourcing(\/|$)/,
  /^\/api\/(orders|invoices|payments|shipments|purchasing)(\/|$)/,
];

/** After sessions are loaded: a signed-in workspace without onboarding gets 404 for onboarding screens. */
export function moduleGuard(req: Request, _res: Response, next: NextFunction) {
  const t = req.staff?.tenant;
  if (t && !onboardingOn(t) && ONBOARDING_PATHS.some((re) => re.test(req.originalUrl.split('?')[0]))) {
    return next(new HttpError(404, 'Supplier onboarding isn’t included in your plan.', undefined, 'NO_ONBOARDING'));
  }
  next();
}
