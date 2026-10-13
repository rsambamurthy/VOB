import rateLimit from 'express-rate-limit';
import { env } from './env.js';

const common = { standardHeaders: 'draft-7' as const, legacyHeaders: false, message: { error: 'Too many requests. Please wait a few minutes and try again.' } };
// Off in unit tests, and in the browser-test server (E2E_NO_RATE_LIMITS, ignored in production) which signs in dozens of times.
const off = env.isTest || (process.env.E2E_NO_RATE_LIMITS === 'true' && !env.isProd) ? { skip: () => true } : {};

/** Login + MFA: 20 attempts / 15 min per IP (per-account lockout is separate). */
export const loginLimiter = rateLimit({ ...common, ...off, windowMs: 15 * 60_000, limit: 20 });
/** Password reset, invite acceptance, OTP requests. */
export const sensitiveLimiter = rateLimit({ ...common, ...off, windowMs: 15 * 60_000, limit: 10 });
/** Everything under /api. */
export const apiLimiter = rateLimit({ ...common, ...off, windowMs: 60_000, limit: 300 });
/** As-you-type availability checks (workspace ID on the sign-up page): 60 / min per IP. */
export const lookupLimiter = rateLimit({ ...common, ...off, windowMs: 60_000, limit: 60 });
