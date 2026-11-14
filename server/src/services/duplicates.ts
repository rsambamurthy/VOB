/**
 * Duplicate suppliers. Two suppliers that share a tax or registration number or a bank account are probably the
 * same business (or one is pretending to be the other). Identifiers are encrypted at rest, so each supplier
 * carries keyed hashes of its normalised identifiers (vendors.identity_keys) and matching is a GIN-indexed
 * array overlap — nothing is decrypted to compare.
 *
 * Shown to staff only (vendor page, list flag, approval, change requests, Excel import) — never to suppliers,
 * who must not learn which other suppliers a workspace has or whose bank account they typed.
 */
import crypto from 'node:crypto';
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { env } from '../lib/env.js';
import type { Profile } from '../lib/profileEngine.js';

const { vendors, duplicateDismissals } = schema;

export type IdentityKind = 'pan' | 'gstin' | 'cin' | 'udyam' | 'cr' | 'vat' | 'tin' | 'licence' | 'iban' | 'bank';
export const KIND_LABEL: Record<IdentityKind, string> = {
  pan: 'PAN', gstin: 'GSTIN', cin: 'CIN', udyam: 'Udyam number', cr: 'CR number', vat: 'VAT number', tin: 'tax ID',
  licence: 'trade licence', iban: 'IBAN', bank: 'bank account',
};

const compact = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).toUpperCase().replace(/[\s\-./]/g, '') : '');
const GSTIN = /^\d{2}([A-Z]{5}\d{4}[A-Z])[A-Z0-9]{3}$/;

/** Normalised identifiers of a profile, as [kind, value] (value already scoped where numbers are only unique per country). */
export function identifiers(p: Profile): [IdentityKind, string][] {
  const tax = p.tax ?? {}, bank = p.bank ?? {}, basic = p.basic ?? {};
  const country = compact(basic.supplierCountry) || '-';
  const out: [IdentityKind, string][] = [];
  const add = (k: IdentityKind, v: string, min = 4) => { if (v.length >= min && !/^0+$/.test(v)) out.push([k, v]); };
  const pan = compact(tax.pan), gstin = compact(tax.gstin);
  add('pan', pan, 10);
  add('gstin', gstin, 15);
  // The PAN inside a GSTIN: the same company registered in another state, or one supplier giving only a GSTIN.
  const m = GSTIN.exec(gstin); if (m && m[1] !== pan) add('pan', m[1], 10);
  add('cin', compact(tax.cin), 21);
  add('udyam', compact(basic.udyamNumber), 12);
  add('cr', compact(tax.crNumber) && `${country}|${compact(tax.crNumber)}`);
  add('vat', compact(tax.vatNumber) && `${country}|${compact(tax.vatNumber)}`);
  for (const f of ['tinNumber', 'foreignTin']) add('tin', compact(tax[f]) && `${country}|${compact(tax[f])}`);
  add('licence', compact(tax.licenceNumber) && `${country}|${compact(tax.licenceNumber)}`);
  add('iban', compact(bank.iban), 15);
  const acct = compact(bank.accountNumber);
  // Account numbers are unique per bank: pair with the IFSC / bank part of SWIFT / routing number when given.
  if (acct.length >= 6 && !/^0+$/.test(acct)) add('bank', `${acct}|${compact(bank.ifsc).slice(0, 4) || compact(bank.swift).slice(0, 4) || compact(bank.routingNumber) || compact(bank.bankName)}`);
  return out;
}

let hmacKey: Buffer | undefined;
const keyFor = () => (hmacKey ??= crypto.createHash('sha256').update('vendorgate identity keys\0').update(env.encryptionKey).digest());
const hash = (k: IdentityKind, v: string) => `${k}:${crypto.createHmac('sha256', keyFor()).update(`${k}\0${v}`).digest('base64url').slice(0, 22)}`;

export const identityKeys = (p: Profile) => [...new Set(identifiers(p).map(([k, v]) => hash(k, v)))].sort();
/** Use wherever a vendor's profile is written, so the duplicate index stays current. */
export const withIdentity = <P extends Profile>(profile: P) => ({ profile, identityKeys: identityKeys(profile) });

export interface DuplicateMatch { id: string; code: string; name: string; status: string; matches: string[] }
const kindsOf = (keys: string[]) => [...new Set(keys.map((k) => k.split(':')[0] as IdentityKind))];
const pair = (a: string, b: string) => (a < b ? [a, b] : [b, a]);

/**
 * Other suppliers in the workspace sharing an identifier with `keys` (rejected and erased ones included where
 * the data still exists: a rejected supplier coming back under a new name is exactly what to catch).
 */
export async function findDuplicates(tenantId: string, keys: string[], exceptVendorId?: string | null, opts: { includeDismissed?: boolean } = {}): Promise<DuplicateMatch[]> {
  if (!keys.length) return [];
  const rows = await db.select({ id: vendors.id, code: vendors.code, name: vendors.name, status: vendors.status, identityKeys: vendors.identityKeys }).from(vendors)
    .where(and(eq(vendors.tenantId, tenantId), isNull(vendors.erasedAt), sql`${vendors.identityKeys} && ARRAY[${sql.join(keys.map((k) => sql`${k}`), sql`, `)}]::text[]`,
      ...(exceptVendorId ? [ne(vendors.id, exceptVendorId)] : [])))
    .limit(20);
  let list = rows;
  if (exceptVendorId && !opts.includeDismissed && rows.length) {
    const dismissed = await db.select({ a: duplicateDismissals.vendorA, b: duplicateDismissals.vendorB }).from(duplicateDismissals)
      .where(and(eq(duplicateDismissals.tenantId, tenantId), or(eq(duplicateDismissals.vendorA, exceptVendorId), eq(duplicateDismissals.vendorB, exceptVendorId))));
    const ok = new Set(dismissed.map((d) => (d.a === exceptVendorId ? d.b : d.a)));
    list = rows.filter((r) => !ok.has(r.id));
  }
  const mine = new Set(keys);
  return list.map((r) => ({ id: r.id, code: r.code, name: r.name, status: r.status, matches: kindsOf((r.identityKeys ?? []).filter((k) => mine.has(k))).map((k) => KIND_LABEL[k]) }));
}

/** Duplicates of a saved supplier. */
export async function duplicatesOf(v: { id: string; tenantId: string; identityKeys: string[] | null; profile: unknown }) {
  return findDuplicates(v.tenantId, v.identityKeys ?? identityKeys(v.profile as Profile), v.id);
}

/** Which of these suppliers have an open (not dismissed) duplicate — one query, for list flags. */
export async function vendorsWithDuplicates(tenantId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const r = await db.execute(sql`
    select distinct v.id from vendors v
    join vendors o on o.tenant_id = v.tenant_id and o.id <> v.id and o.erased_at is null and o.identity_keys && v.identity_keys
    where v.tenant_id = ${tenantId} and v.id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) and v.erased_at is null and cardinality(v.identity_keys) > 0
      and not exists (select 1 from duplicate_dismissals d where d.tenant_id = v.tenant_id and d.vendor_a = least(v.id, o.id) and d.vendor_b = greatest(v.id, o.id))`);
  return new Set(((r as unknown as { rows: { id: string }[] }).rows).map((x) => x.id));
}

export async function dismissDuplicate(tenantId: string, vendorId: string, otherId: string, note: string, byName: string) {
  const [a, b] = pair(vendorId, otherId);
  const both = await db.select({ id: vendors.id }).from(vendors).where(and(eq(vendors.tenantId, tenantId), inArray(vendors.id, [a, b])));
  if (both.length !== 2) return false;
  await db.insert(duplicateDismissals).values({ tenantId, vendorA: a, vendorB: b, note, byName }).onConflictDoNothing();
  return true;
}

/** Fills identity keys for suppliers that don't have them (new column; after a key rotation, all of them). */
export async function refreshIdentityKeys(all = false) {
  let n = 0;
  for (;;) {
    const batch = await db.select({ id: vendors.id, profile: vendors.profile, keys: vendors.identityKeys }).from(vendors)
      .where(all ? sql`true` : isNull(vendors.identityKeys)).orderBy(vendors.id).limit(500).offset(all ? n : 0);
    if (!batch.length) break;
    for (const v of batch) await db.update(vendors).set({ identityKeys: identityKeys(v.profile as Profile) }).where(eq(vendors.id, v.id));
    n += batch.length;
    if (batch.length < 500) break;
  }
  return n;
}

/** Duplicates a change request would create: other suppliers matching identifiers the change introduces (e.g. a new bank account). */
export async function changeDuplicates(tenantId: string, vendor: { id: string; profile: unknown }, changes: { fieldId: string; new: string }[]) {
  const current = vendor.profile as Profile;
  const proposed = structuredClone(current ?? {});
  for (const c of changes) { const [s, k] = c.fieldId.split('.'); proposed[s] = { ...(proposed[s] ?? {}), [k]: c.new }; }
  const before = new Set(identityKeys(current ?? {}));
  const added = identityKeys(proposed).filter((k) => !before.has(k));
  return findDuplicates(tenantId, added, vendor.id, { includeDismissed: true });
}

export const duplicateText = (d: DuplicateMatch[]) => d.map((x) => `${x.code} ${x.name} (same ${x.matches.join(', ')})`).join('; ');
