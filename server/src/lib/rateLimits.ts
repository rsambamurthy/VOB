import rateLimit from 'express-rate-limit';
import { env } from './env.js';

const common = { standardHeaders: 'draft-7' as const, legacyHeaders: false, message: { error: 'Too many requests. Please wait a few minutes and try again.' } };
const off = env.isTest ? { skip: () => true } : {};

/** Login + MFA: 20 attempts / 15 min per IP (per-account lockout is separate). */
export const loginLimiter = rateLimit({ ...common, ...off, windowMs: 15 * 60_000, limit: 20 });
/** Password reset, invite acceptance, OTP requests. */
export const sensitiveLimiter = rateLimit({ ...common, ...off, windowMs: 15 * 60_000, limit: 10 });
/** Everything under /api. */
export const apiLimiter = rateLimit({ ...common, ...off, windowMs: 60_000, limit: 300 });
