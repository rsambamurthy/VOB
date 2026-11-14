/**
 * Self-registration: public "Become a supplier" links. An applicant fills in a short application and confirms
 * their email with a code; buyers then screen it — Accept creates the supplier and sends the normal
 * invitation (services/vendors.ts), Decline tells the applicant. Nothing becomes a vendor until accepted.
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { env } from '../lib/env.js';
import { HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';
import { validators } from '../lib/validators.js';
import { fillImpliedAnswers, sanitizeSection, type Profile } from '../lib/profileEngine.js';
import { packFor, vendorTypesFor } from '../countries/registry.js';
import { mailSupplier } from '../i18n/emails.js';
import { defaultSupplierLanguage, supplierLanguages, type Lang } from '../i18n/index.js';
import { getPublished } from './config.js';
import { assertCanAddVendor } from './limits.js';
import { usersWithPermission } from './approvers.js';
import { basicProblems, createSchema, createVendor, nameTaken } from './vendors.js';
import { findDuplicates, identityKeys } from './duplicates.js';
import type { Tenant } from '../db/schema.js';
import type { OnboardingConfig } from '../config/types.js';

const { registrationLinks, supplierApplications, vendors } = schema;
export type RegistrationLink = typeof registrationLinks.$inferSelect;
export type Application = typeof supplierApplications.$inferSelect;
const CODE_MINUTES = 30;
const MAX_ATTEMPTS = 5;

export const applyUrl = (slug: string) => `${env.appBaseUrl}/apply/${slug}`;
const newSlug = () => crypto.randomBytes(9).toString('base64url');

/* ---------------- Links ---------------- */

export async function createLink(tenantId: string, input: { name: string; vendorType?: string | null; intro?: string | null; notifyEmails?: string | null }, by: { name: string; ip?: string }) {
  const [l] = await db.insert(registrationLinks).values({ tenantId, slug: newSlug(), name: input.name.trim(), vendorType: input.vendorType || null, intro: input.intro?.trim() || null, notifyEmails: input.notifyEmails?.trim() || null, createdByName: by.name }).returning();
  await audit({ tenantId, actor: by.name, action: 'REGISTRATION_LINK_CREATED', detail: { name: l.name }, ip: by.ip });
  return l;
}

export async function updateLink(tenantId: string, id: string, patch: Partial<Pick<RegistrationLink, 'name' | 'vendorType' | 'intro' | 'notifyEmails' | 'active'>>, by: { name: string; ip?: string }) {
  const l = await db.query.registrationLinks.findFirst({ where: and(eq(registrationLinks.tenantId, tenantId), eq(registrationLinks.id, id)) });
  if (!l) throw new HttpError(404, 'Link not found');
  await db.update(registrationLinks).set(patch).where(eq(registrationLinks.id, id));
  await audit({ tenantId, actor: by.name, action: patch.active === false ? 'REGISTRATION_LINK_DISABLED' : patch.active === true ? 'REGISTRATION_LINK_ENABLED' : 'REGISTRATION_LINK_UPDATED', detail: { name: patch.name ?? l.name }, ip: by.ip });
  return { ...l, ...patch };
}

export async function listLinks(tenantId: string) {
  const links = await db.select().from(registrationLinks).where(eq(registrationLinks.tenantId, tenantId)).orderBy(desc(registrationLinks.createdAt));
  const counts = await db.select({ linkId: supplierApplications.linkId, status: supplierApplications.status, n: sql<number>`count(*)::int` }).from(supplierApplications)
    .where(and(eq(supplierApplications.tenantId, tenantId), ne(supplierApplications.status, 'UNVERIFIED'))).groupBy(supplierApplications.linkId, supplierApplications.status);
  return links.map((l) => {
    const c = (st: string) => counts.find((x) => x.linkId === l.id && x.status === st)?.n ?? 0;
    return { ...l, url: applyUrl(l.slug), applications: c('PENDING') + c('ACCEPTED') + c('DECLINED'), pending: c('PENDING'), accepted: c('ACCEPTED') };
  });
}

/* ---------------- The public page ---------------- */

/** The home country's main registration number (GSTIN in India, CR number in Saudi Arabia…) and the form field it fills. */
function registrationIdFor(tenant: Pick<Tenant, 'country'>, config: OnboardingConfig) {
  const id = packFor(tenant.country).registerIds?.find((r) => !r.masked);
  if (!id) return null;
  const [sec, key] = id.field.split('.');
  const field = config.sections.find((s) => s.key === sec)?.groups.flatMap((g) => g.fields).find((f) => f.key === key);
  return field ? { fieldId: id.field, label: id.label, validator: field.validator, placeholder: field.placeholder } : null;
}

async function activeLink(slug: string) {
  const l = await db.query.registrationLinks.findFirst({ where: eq(registrationLinks.slug, slug) });
  const t = l && (await db.query.tenants.findFirst({ where: eq(schema.tenants.id, l.tenantId) }));
  if (!l || !t || !l.active || t.status !== 'ACTIVE') throw new HttpError(404, 'This registration link is no longer open');
  return { link: l, tenant: t };
}

/** What the public page shows: the buyer's name and branding, languages, and the questions. */
export async function publicPage(slug: string) {
  const { link, tenant } = await activeLink(slug);
  const { config } = await getPublished(tenant.id);
  const home = packFor(tenant.country);
  return {
    buyer: { name: tenant.name, branding: tenant.branding, languages: supplierLanguages(tenant), defaultLanguage: defaultSupplierLanguage(tenant) },
    link: { name: link.name, intro: link.intro, vendorType: link.vendorType },
    vendorTypes: vendorTypesFor(tenant.country),
    homeCountry: home.name,
    mobileExample: home.mobile?.example,
    registrationId: registrationIdFor(tenant, config),
  };
}

const opt = (max: number) => z.string().trim().max(max).optional().transform((v) => v || undefined);
export const applySchema = createSchema.omit({ notify: true }).extend({
  registrationId: opt(40), website: opt(200), supplies: opt(500), message: opt(1000),
  /** A hidden field people leave empty and bots fill in. */
  company: z.string().max(200).optional(),
});
export type ApplyInput = z.input<typeof applySchema>;

async function sendCode(tenant: Tenant, a: Application) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await db.update(supplierApplications).set({ codeHash: await bcrypt.hash(code, 8), codeExpiresAt: new Date(Date.now() + CODE_MINUTES * 60_000), codeAttempts: 0 }).where(eq(supplierApplications.id, a.id));
  await mailSupplier(langOf(tenant, a.language), { tenantId: tenant.id, to: a.email }, 'applicationCode', { first: a.contactFirstName, buyer: tenant.name, code });
  return env.devShowOtp ? code : undefined;
}
const langOf = (t: Tenant, l?: string | null): Lang => (l && supplierLanguages(t).includes(l as Lang) ? (l as Lang) : defaultSupplierLanguage(t));

/** Step 1: the application. Checked like an invitation (same rules), then a code is emailed to confirm the address. */
export async function apply(slug: string, raw: unknown, ctx: { ip?: string; userAgent?: string }) {
  const { link, tenant } = await activeLink(slug);
  const input = applySchema.parse({ ...(raw as object), ...(link.vendorType ? { vendorType: link.vendorType } : {}) });
  if (input.company) return { id: crypto.randomUUID(), devOtp: undefined }; // bot: pretend it worked
  const problems = basicProblems(tenant, { ...input, notify: false });
  if (problems.length) throw new HttpError(400, problems[0], [{ path: ['contactMobile'], message: problems[0] }]);
  const { config } = await getPublished(tenant.id);
  const reg = registrationIdFor(tenant, config);
  const registrationId = input.vendorType !== 'IMPORT' && input.registrationId ? input.registrationId.toUpperCase().replace(/\s+/g, '') : undefined;
  if (registrationId && reg?.validator && validators[reg.validator]) {
    const err = validators[reg.validator](registrationId, { country: packFor(tenant.country).name });
    if (err) throw new HttpError(400, err, [{ path: ['registrationId'], message: err }]);
  }
  const [a] = await db.insert(supplierApplications).values({
    tenantId: tenant.id, linkId: link.id, companyName: input.name, vendorType: input.vendorType, contactFirstName: input.contactFirstName, contactLastName: input.contactLastName,
    email: input.contactEmail.toLowerCase(), mobile: input.contactMobile, registrationId: registrationId ?? null, website: input.website ?? null, supplies: input.supplies ?? null,
    message: input.message ?? null, language: langOf(tenant, input.language), ip: ctx.ip ?? null, userAgent: ctx.userAgent?.slice(0, 300) ?? null,
  }).returning();
  return { id: a.id, devOtp: await sendCode(tenant, a) };
}

async function unverified(slug: string, id: string) {
  const { link, tenant } = await activeLink(slug);
  const a = await db.query.supplierApplications.findFirst({ where: and(eq(supplierApplications.id, id), eq(supplierApplications.linkId, link.id)) });
  if (!a) throw new HttpError(404, 'Application not found');
  return { link, tenant, a };
}

export async function resendCode(slug: string, id: string) {
  const { tenant, a } = await unverified(slug, id);
  if (a.status !== 'UNVERIFIED') return { ok: true };
  return { ok: true, devOtp: await sendCode(tenant, a) };
}

/** Step 2: the code from the email. The application then goes to the buyer, who is told about it. */
export async function verify(slug: string, id: string, code: string) {
  const { link, tenant, a } = await unverified(slug, id);
  if (a.status !== 'UNVERIFIED') return { ok: true };
  if (!a.codeHash || !a.codeExpiresAt || a.codeExpiresAt < new Date()) throw new HttpError(400, 'This code has expired. Ask for a new one.');
  if (a.codeAttempts >= MAX_ATTEMPTS) throw new HttpError(429, 'Too many wrong codes. Ask for a new one.');
  if (!(await bcrypt.compare(code.trim(), a.codeHash))) {
    await db.update(supplierApplications).set({ codeAttempts: a.codeAttempts + 1 }).where(eq(supplierApplications.id, a.id));
    throw new HttpError(400, 'That code is not right. Check the email and try again.');
  }
  await db.update(supplierApplications).set({ status: 'PENDING', verifiedAt: new Date(), codeHash: null }).where(eq(supplierApplications.id, a.id));
  await audit({ tenantId: tenant.id, actor: a.email, action: 'SUPPLIER_APPLIED', detail: { company: a.companyName, link: link.name }, ip: a.ip ?? undefined });
  // Tell the people the link names, or everyone who can invite suppliers.
  const to = link.notifyEmails ? link.notifyEmails.split(/[,;\s]+/).filter(Boolean) : (await usersWithPermission(tenant.id, 'vendors.create')).map((u) => u.email);
  for (const email of [...new Set(to)].slice(0, 20)) {
    await sendMail({ tenantId: tenant.id, to: email, subject: `New supplier application: ${a.companyName}`, body: `${a.companyName} applied to become a supplier through “${link.name}”.\n\nContact: ${a.contactFirstName} ${a.contactLastName} (${a.email})${a.supplies ? `\nSupplies: ${a.supplies}` : ''}\n\nReview it and accept or decline.`, link: `${env.appBaseUrl}/staff/applications` });
  }
  return { ok: true };
}

/* ---------------- Screening ---------------- */

/** Things a reviewer should know: a supplier with the same name, email or registration number, or an earlier application. */
async function hintsFor(tenant: Tenant, config: OnboardingConfig, a: Application) {
  const hints: { kind: 'vendor' | 'application'; text: string; vendorId?: string }[] = [];
  const sameName = await nameTaken(tenant.id, a.companyName);
  if (sameName) hints.push({ kind: 'vendor', text: `A supplier with this name exists: ${sameName.code} ${sameName.name} (${sameName.status.replace('_', ' ').toLowerCase()})`, vendorId: sameName.id });
  const sameEmail = await db.query.vendors.findFirst({ where: and(eq(vendors.tenantId, tenant.id), eq(vendors.contactEmail, a.email), ...(sameName ? [ne(vendors.id, sameName.id)] : [])) });
  if (sameEmail) hints.push({ kind: 'vendor', text: `${sameEmail.code} ${sameEmail.name} uses the same contact email`, vendorId: sameEmail.id });
  const reg = registrationIdFor(tenant, config);
  if (a.registrationId && reg) {
    for (const d of await findDuplicates(tenant.id, identityKeys(prefillOf(a, reg.fieldId, packFor(tenant.country).name)))) {
      if (d.id !== sameName?.id) hints.push({ kind: 'vendor', text: `${d.code} ${d.name} has the same ${d.matches.join(', ')}`, vendorId: d.id });
    }
  }
  const earlier = await db.select({ id: supplierApplications.id, status: supplierApplications.status, createdAt: supplierApplications.createdAt }).from(supplierApplications)
    .where(and(eq(supplierApplications.tenantId, tenant.id), ne(supplierApplications.id, a.id), ne(supplierApplications.status, 'UNVERIFIED'), sql`(${supplierApplications.email} = ${a.email} or lower(${supplierApplications.companyName}) = lower(${a.companyName}))`)).limit(3);
  for (const e of earlier) hints.push({ kind: 'application', text: `Applied before (${e.status.toLowerCase()}, ${e.createdAt.toISOString().slice(0, 10)})` });
  return hints;
}

/** The form answers an application gives (registration number, website, what they supply). */
function prefillOf(a: Pick<Application, 'registrationId' | 'website' | 'supplies'>, regField: string | undefined, homeCountry: string): Profile {
  const p: Profile = { basic: { supplierCountry: homeCountry } };
  if (a.registrationId && regField) { const [s, k] = regField.split('.'); p[s] = { ...(p[s] ?? {}), [k]: a.registrationId }; }
  if (a.website) p.basic.websiteUrl = a.website;
  if (a.supplies) p.basic.itemsSupplied = a.supplies;
  return p;
}

export async function listApplications(tenant: Tenant, status: string) {
  const { config } = await getPublished(tenant.id);
  const rows = await db.select().from(supplierApplications).where(and(eq(supplierApplications.tenantId, tenant.id), eq(supplierApplications.status, status))).orderBy(desc(supplierApplications.createdAt)).limit(200);
  const links = rows.length ? await db.select({ id: registrationLinks.id, name: registrationLinks.name }).from(registrationLinks).where(inArray(registrationLinks.id, [...new Set(rows.map((r) => r.linkId))])) : [];
  const reg = registrationIdFor(tenant, config);
  return Promise.all(rows.map(async ({ codeHash: _c, codeAttempts: _n, codeExpiresAt: _e, ...a }) => ({
    ...a, linkName: links.find((l) => l.id === a.linkId)?.name ?? '', registrationLabel: reg?.label ?? 'Registration number',
    hints: status === 'PENDING' ? await hintsFor(tenant, config, a as Application) : [],
  })));
}

export const pendingCount = async (tenantId: string) =>
  (await db.select({ n: sql<number>`count(*)::int` }).from(supplierApplications).where(and(eq(supplierApplications.tenantId, tenantId), eq(supplierApplications.status, 'PENDING'))))[0].n;

async function pendingApplication(tenantId: string, id: string) {
  const a = await db.query.supplierApplications.findFirst({ where: and(eq(supplierApplications.tenantId, tenantId), eq(supplierApplications.id, id)) });
  if (!a) throw new HttpError(404, 'Application not found');
  if (a.status !== 'PENDING') throw new HttpError(409, 'This application has already been decided');
  return a;
}

/** Accept: the supplier is created (same rules as an invitation) with what they gave, and invited to complete registration. */
export async function acceptApplication(tenant: Tenant, id: string, overrides: { name?: string; vendorType?: 'DOMESTIC' | 'IMPORT' | 'GOVERNMENT' }, actor: { id: string; name: string; ip?: string }) {
  const a = await pendingApplication(tenant.id, id);
  await assertCanAddVendor(tenant);
  const link = await db.query.registrationLinks.findFirst({ where: eq(registrationLinks.id, a.linkId) });
  const { config } = await getPublished(tenant.id);
  const vendorType = overrides.vendorType ?? (a.vendorType as 'DOMESTIC' | 'IMPORT' | 'GOVERNMENT');
  const raw = prefillOf(a, vendorType === 'IMPORT' ? undefined : registrationIdFor(tenant, config)?.fieldId, vendorType === 'IMPORT' ? '' : packFor(tenant.country).name);
  const prefill: Profile = {};
  for (const [sec, vals] of Object.entries(raw)) prefill[sec] = sanitizeSection(config, sec, vals);
  fillImpliedAnswers(config, prefill, Object.entries(prefill).flatMap(([s, v]) => Object.keys(v).map((k) => `${s}.${k}`)), vendorType);
  const input = createSchema.parse({ name: overrides.name?.trim() || a.companyName, vendorType, contactFirstName: a.contactFirstName, contactLastName: a.contactLastName, contactEmail: a.email, contactMobile: a.mobile, notify: true, language: a.language ?? undefined });
  const vendor = await createVendor(tenant, input, actor, { ip: actor.ip, prefill, source: `Application via “${link?.name ?? 'registration link'}”`, inviteTemplate: 'applicationAccepted' });
  await db.update(supplierApplications).set({ status: 'ACCEPTED', vendorId: vendor.id, decidedAt: new Date(), decidedByName: actor.name }).where(eq(supplierApplications.id, a.id));
  await audit({ tenantId: tenant.id, vendorId: vendor.id, actor: actor.name, action: 'APPLICATION_ACCEPTED', detail: { link: link?.name, appliedAt: a.createdAt.toISOString() }, ip: actor.ip });
  return vendor;
}

export async function declineApplication(tenant: Tenant, id: string, reason: string, notify: boolean, actor: { name: string; ip?: string }) {
  const a = await pendingApplication(tenant.id, id);
  await db.update(supplierApplications).set({ status: 'DECLINED', declineReason: reason.trim() || null, decidedAt: new Date(), decidedByName: actor.name }).where(eq(supplierApplications.id, a.id));
  await audit({ tenantId: tenant.id, actor: actor.name, action: 'APPLICATION_DECLINED', detail: { company: a.companyName, reason, told: notify ? 'yes' : 'no' }, ip: actor.ip });
  if (notify) await mailSupplier(langOf(tenant, a.language), { tenantId: tenant.id, to: a.email }, 'applicationDeclined', { first: a.contactFirstName, buyer: tenant.name, vendor: a.companyName, reason: reason.trim() });
}
