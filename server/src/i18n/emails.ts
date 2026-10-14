/**
 * Emails to suppliers, in English and Arabic. Values in {braces} are filled in when sending.
 * Each email is sent in the supplier's language (vendors.language, else the workspace default).
 * The wording lives in emails.json; it is exported to the translation spreadsheet with the screen text (npm run i18n:export).
 */
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { sendMail } from '../integrations/email/index.js';
import type { Tenant, Vendor } from '../db/schema.js';
import { vendorLanguage, type Lang } from './index.js';
import EMAILS_JSON from './emails.json' with { type: 'json' };

type Mail = { subject: string; body: string };
export const EMAILS = EMAILS_JSON satisfies Record<string, Record<Lang, Mail>>;
export type EmailKey = keyof typeof EMAILS;

const fill = (s: string, vars: Record<string, unknown>) => s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));

/** One email (or a snippet's body) in the given language. */
export function emailText(lang: Lang, key: EmailKey, vars: Record<string, unknown> = {}): Mail {
  const e = EMAILS[key][lang] ?? EMAILS[key].en;
  return { subject: fill(e.subject, vars), body: fill(e.body, vars) };
}
export const snippet = (lang: Lang, key: EmailKey, vars: Record<string, unknown> = {}) => emailText(lang, key, vars).body;

/** The supplier's language for emails (loads the workspace when not given). */
export async function langForVendor(v: Pick<Vendor, 'tenantId' | 'language'>, tenant?: Pick<Tenant, 'country' | 'settings'> | null): Promise<Lang> {
  const t = tenant ?? await db.query.tenants.findFirst({ where: eq(schema.tenants.id, v.tenantId), columns: { country: true, settings: true } });
  return t ? vendorLanguage(t, v) : 'en';
}
export async function langForVendorId(vendorId: string): Promise<Lang> {
  const v = await db.query.vendors.findFirst({ where: and(eq(schema.vendors.id, vendorId)), columns: { tenantId: true, language: true } });
  return v ? langForVendor(v) : 'en';
}

/** Send a supplier email in the supplier's language. */
export async function mailSupplier(lang: Lang, m: { tenantId: string; to: string; link?: string }, key: EmailKey, vars: Record<string, unknown>) {
  const { subject, body } = emailText(lang, key, vars);
  await sendMail({ ...m, subject, body });
}

/** Dates in supplier emails: "14 Oct 2026" or, in Arabic, with the Hijri date. */
export function mailDate(d: string | Date, lang: Lang) {
  const date = typeof d === 'string' ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T12:00:00Z` : d) : d;
  if (Number.isNaN(date.getTime())) return String(d);
  if (lang === 'ar') {
    const g = new Intl.DateTimeFormat('ar-u-ca-gregory-nu-latn', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
    const h = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-latn', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
    return `${g} (${h})`;
  }
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}
