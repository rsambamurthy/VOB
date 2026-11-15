/**
 * On-prem licences: a signed token issued by Integratatech for one customer's installation.
 *
 *   VGL1.<base64url(JSON payload)>.<base64url(Ed25519 signature of "VGL1.<payload>")>
 *
 * The payload names the customer, the dates it is valid, the user and supplier limits and the features. Only the
 * public key is in the product (lib/licenceKeys.ts), so a customer can't make or change a licence.
 *
 * States: valid → expiring (30 days or less left) → grace (expired, up to `graceDays`, default 15) → readonly.
 * Read-only: staff can sign in and see everything but can't change anything (except installing a new licence);
 * the supplier portal, ERP integration and background jobs keep working.
 *
 * This module is pure (no database): the current licence is cached here and loaded by services/licence.ts.
 */
import crypto from 'node:crypto';
import { DEV_PUBLIC_KEY, PRODUCTION_PUBLIC_KEY } from './licenceKeys.js';

export type LicenceFeature = 'erp' | 'ai' | 'kyc' | 'collab';
export interface Licence {
  v: 1;
  /** Licence number, e.g. "VG-2026-0007". */
  id: string;
  customer: string;
  issuedAt: string;
  /** YYYY-MM-DD, inclusive. */
  validFrom: string;
  validUntil: string;
  /** null = unlimited */
  maxUsers: number | null;
  maxVendors: number | null;
  features?: Partial<Record<LicenceFeature, boolean>>;
  /** Days after validUntil before the system turns read-only. Default 15. */
  graceDays?: number;
  notes?: string;
}
export type LicenceState = 'valid' | 'expiring' | 'grace' | 'readonly' | 'missing' | 'notYetValid';

const PREFIX = 'VGL1';
const b64u = (b: Buffer) => b.toString('base64url');
export const WARN_DAYS = 30;
export const DEFAULT_GRACE_DAYS = 15;

/** Issue a licence (Integratatech's licence tool and tests). */
export function signLicence(payload: Licence, privateKeyPem: string) {
  const body = `${PREFIX}.${b64u(Buffer.from(JSON.stringify(payload)))}`;
  const sig = crypto.sign(null, Buffer.from(body), crypto.createPrivateKey(privateKeyPem));
  return `${body}.${b64u(sig)}`;
}

const keys = (prod: boolean) => [PRODUCTION_PUBLIC_KEY, ...(prod ? [] : [DEV_PUBLIC_KEY])].filter((k): k is string => !!k);

/** Check a licence token's signature and shape. */
export function verifyLicence(token: string, opts: { production?: boolean } = {}): { ok: true; licence: Licence } | { ok: false; error: string } {
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, error: 'This is not a VendorGate licence file' };
  const body = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], 'base64url');
  const good = keys(opts.production ?? process.env.NODE_ENV === 'production').some((k) => { try { return crypto.verify(null, body, crypto.createPublicKey(k), sig); } catch { return false; } });
  if (!good) return { ok: false, error: 'The licence signature is not valid — it was changed, or not issued by Integratatech' };
  let lic: Licence;
  try { lic = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return { ok: false, error: 'The licence can’t be read' }; }
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (lic.v !== 1 || !lic.id || !lic.customer || !day.test(lic.validFrom) || !day.test(lic.validUntil)) return { ok: false, error: 'The licence is incomplete' };
  return { ok: true, licence: lic };
}

const dayMs = 86_400_000;
const utcDay = (s: string) => Date.parse(`${s}T00:00:00Z`);
const today = (now: Date) => Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);

/** Where a licence stands on a given day. */
export function licenceState(lic: Licence | null, now = new Date()) {
  if (!lic) return { state: 'missing' as LicenceState, daysLeft: null, graceEndsOn: null };
  const t = today(now);
  const daysLeft = Math.round((utcDay(lic.validUntil) - t) / dayMs);
  const grace = lic.graceDays ?? DEFAULT_GRACE_DAYS;
  const graceEndsOn = new Date(utcDay(lic.validUntil) + grace * dayMs).toISOString().slice(0, 10);
  const state: LicenceState = t < utcDay(lic.validFrom) ? 'notYetValid' : daysLeft > WARN_DAYS ? 'valid' : daysLeft >= 0 ? 'expiring' : -daysLeft <= grace ? 'grace' : 'readonly';
  return { state, daysLeft, graceEndsOn };
}
export const isReadOnly = (s: LicenceState) => s === 'readonly' || s === 'missing' || s === 'notYetValid';

/* ---------------- The installed licence (cache) ---------------- */

let current: { licence: Licence; token: string; installedAt: Date; installedBy: string } | null = null;
export function setCurrentLicence(x: typeof current) { current = x; }
export const currentLicence = () => current;

/** What the app shows and enforces. */
export function licenceStatus(now = new Date()) {
  const lic = current?.licence ?? null;
  const s = licenceState(lic, now);
  const message = {
    valid: null,
    expiring: lic ? `The VendorGate licence ends on ${lic.validUntil} (${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} left). Ask Integratatech for a renewal.` : null,
    grace: lic ? `The VendorGate licence ended on ${lic.validUntil}. VendorGate turns read-only on ${s.graceEndsOn} unless a new licence is installed.` : null,
    readonly: 'The VendorGate licence has expired. VendorGate is read-only until a new licence is installed (Administration → Licence). Suppliers can still use their portal.',
    missing: 'No VendorGate licence is installed. VendorGate is read-only until one is installed (Administration → Licence).',
    notYetValid: lic ? `The installed licence starts on ${lic.validFrom}. VendorGate is read-only until then.` : null,
  }[s.state];
  return { ...s, readOnly: isReadOnly(s.state), message, licence: lic && { id: lic.id, customer: lic.customer, validFrom: lic.validFrom, validUntil: lic.validUntil, maxUsers: lic.maxUsers, maxVendors: lic.maxVendors, features: lic.features ?? {}, graceDays: lic.graceDays ?? DEFAULT_GRACE_DAYS },
    installedAt: current?.installedAt ?? null, installedBy: current?.installedBy ?? null };
}

/** Limits and features from the licence (plans.effectiveLimits uses these on-prem). Without a licence: no limits (it's read-only anyway). */
export function licenceLimits() {
  const lic = current?.licence;
  const f = lic?.features ?? {};
  return { maxUsers: lic?.maxUsers ?? null, maxVendors: lic?.maxVendors ?? null,
    features: { erp: f.erp !== false, ai: f.ai !== false, kyc: f.kyc !== false, collab: f.collab !== false } };
}
