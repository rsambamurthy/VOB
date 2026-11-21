/**
 * Contract parties: suppliers and customers. A light record (name, country, registration and tax numbers, address,
 * contacts and signatories) so Contracts works without supplier onboarding. With onboarding on, a supplier party can
 * be linked to its supplier record — or sent for onboarding, which creates that record.
 */
import { and, asc, count, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../../lib/db.js';
import type { Party, Tenant } from '../../db/schema.js';
import { HttpError } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { nextRunningCode } from '../../lib/numbering.js';
import { readSheet, sheetTemplate, type RowError, type SheetColumn } from '../../lib/excel.js';
import { onboardingOn } from '../../lib/modules.js';
import { optionOn } from './config.js';

const { parties: P, contracts: C, vendors: V } = schema;
type By = { id: string; name: string; ip?: string };
export type PartyKind = 'SUPPLIER' | 'CUSTOMER';
export const PARTY_PREFIX: Record<PartyKind, string> = { SUPPLIER: 'SUP', CUSTOMER: 'CUS' };
export const KIND_LABEL: Record<PartyKind, string> = { SUPPLIER: 'Supplier', CUSTOMER: 'Customer' };

const text = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));
const contactSchema = z.object({
  name: z.string().trim().min(1, 'Give each contact a name').max(150),
  email: z.string().trim().toLowerCase().email('Enter a valid contact email').max(200).optional().or(z.literal('')).transform((v) => v || undefined),
  phone: z.string().trim().max(40).optional().transform((v) => v || undefined),
  role: z.string().trim().max(100).optional().transform((v) => v || undefined),
  signatory: z.boolean().optional(),
});
export const partyInput = z.object({
  kind: z.enum(['SUPPLIER', 'CUSTOMER']),
  name: z.string().trim().min(2, 'Enter the party’s name').max(200),
  legalName: text(200),
  country: z.string().trim().toUpperCase().length(2, 'Choose a country'),
  registrationNo: text(60),
  taxNo: text(60),
  address: z.object({ line1: z.string().trim().max(300), city: z.string().trim().max(100), region: z.string().trim().max(100), postalCode: z.string().trim().max(20) }).partial().default({})
    .transform((a) => Object.fromEntries(Object.entries(a).filter(([, v]) => v)) as { line1?: string; city?: string; region?: string; postalCode?: string }),
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(200).nullable().optional().or(z.literal('')).transform((v) => v || null),
  phone: text(40),
  website: z.string().trim().max(300).nullable().optional().or(z.literal('')).transform((v) => v || null).refine((v) => !v || /^https?:\/\//i.test(v), 'The website must start with http:// or https://'),
  contacts: z.array(contactSchema).max(20).default([]),
  notes: text(2000),
  /** Accounts payable (Invoices add-on): ERP supplier and site, payment terms, coding defaults, who gets debit notes. Left out = unchanged. */
  ap: z.object({
    erpSupplierCode: z.string().trim().max(60), erpSiteCode: z.string().trim().max(60), paymentTerms: z.string().trim().max(60),
    defaultAccount: z.string().trim().max(60), defaultCostCentre: z.string().trim().max(60),
    accountsEmail: z.string().trim().toLowerCase().email('Enter a valid accounts email').max(200).or(z.literal('')),
  }).partial().optional().transform((a) => (a ? Object.fromEntries(Object.entries(a).filter(([, v]) => v)) : undefined)),
  /** Confirm creating a party that looks like an existing one. */
  confirmDuplicate: z.boolean().optional(),
});
export type PartyInput = z.input<typeof partyInput>;

/** Parties with the same name, tax number or registration number (for the "possible duplicate" check). */
async function lookAlikes(tenantId: string, p: { name: string; taxNo: string | null; registrationNo: string | null }, except?: string) {
  const conds: SQL[] = [sql`lower(${P.name}) = lower(${p.name})`];
  if (p.taxNo) conds.push(sql`upper(${P.taxNo}) = upper(${p.taxNo})`);
  if (p.registrationNo) conds.push(sql`upper(${P.registrationNo}) = upper(${p.registrationNo})`);
  const rows = await db.select({ id: P.id, code: P.code, name: P.name, kind: P.kind }).from(P).where(and(eq(P.tenantId, tenantId), or(...conds)!)).limit(5);
  return rows.filter((r) => r.id !== except);
}

export async function createParty(t: Tenant, raw: unknown, by: By, opts: { source?: string } = {}) {
  const input = partyInput.parse(raw);
  if (input.kind === 'CUSTOMER' && !optionOn(t, 'customerContracts')) throw new HttpError(400, 'Customer contracts are switched off in Administration → Contracts.');
  const same = await lookAlikes(t.id, input);
  if (same.length && !input.confirmDuplicate) throw new HttpError(409, `This looks like ${same.map((s) => `${s.name} (${s.code})`).join(', ')}. Create it anyway?`, { duplicates: same }, 'POSSIBLE_DUPLICATE');
  const { confirmDuplicate: _c, ...data } = input;
  const party = await db.transaction(async (tx) => {
    const code = await nextRunningCode(tx, { table: P, tenantCol: P.tenantId, numberCol: P.code }, t.id, PARTY_PREFIX[input.kind]);
    const [row] = await tx.insert(P).values({ ...data, tenantId: t.id, code, createdById: by.id, createdByName: by.name }).returning();
    return row;
  });
  await audit({ tenantId: t.id, actor: by.name, action: 'PARTY_CREATED', detail: { subjectId: party.id, code: party.code, name: party.name, kind: party.kind, ...(opts.source ? { source: opts.source } : {}) }, ip: by.ip });
  return party;
}

export async function getParty(tenantId: string, id: string) {
  const p = await db.query.parties.findFirst({ where: and(eq(P.tenantId, tenantId), eq(P.id, id)) });
  if (!p) throw new HttpError(404, 'Party not found');
  return p;
}

export async function updateParty(t: Tenant, id: string, raw: unknown, by: By) {
  const p = await getParty(t.id, id);
  const input = partyInput.parse({ ...raw as object, kind: p.kind });
  const same = (await lookAlikes(t.id, input, p.id));
  if (same.length && !input.confirmDuplicate && (input.name.toLowerCase() !== p.name.toLowerCase() || input.taxNo !== p.taxNo || input.registrationNo !== p.registrationNo)) {
    throw new HttpError(409, `This looks like ${same.map((s) => `${s.name} (${s.code})`).join(', ')}. Save anyway?`, { duplicates: same }, 'POSSIBLE_DUPLICATE');
  }
  const { confirmDuplicate: _c, kind: _k, ...data } = input;
  const [row] = await db.update(P).set(data).where(eq(P.id, p.id)).returning();
  const changed = (Object.keys(data) as (keyof typeof data)[]).filter((k) => JSON.stringify(data[k]) !== JSON.stringify(p[k as keyof Party]));
  if (changed.length) await audit({ tenantId: t.id, actor: by.name, action: 'PARTY_UPDATED', detail: { subjectId: p.id, code: p.code, fields: changed }, ip: by.ip });
  return row;
}

export async function setPartyArchived(t: Tenant, id: string, archived: boolean, by: By) {
  const p = await getParty(t.id, id);
  if (archived) {
    const [{ open }] = await db.select({ open: count() }).from(C).where(and(eq(C.partyId, p.id), inArray(C.status, ['DRAFT', 'ACTIVE'])));
    if (open) throw new HttpError(409, `${p.name} has ${open} draft or active contract${open > 1 ? 's' : ''}. End or move them first.`);
  }
  const [row] = await db.update(P).set({ status: archived ? 'ARCHIVED' : 'ACTIVE' }).where(eq(P.id, p.id)).returning();
  await audit({ tenantId: t.id, actor: by.name, action: archived ? 'PARTY_ARCHIVED' : 'PARTY_RESTORED', detail: { subjectId: p.id, code: p.code }, ip: by.ip });
  return row;
}

/* ---------------- link to onboarded suppliers ---------------- */

function assertLinking(t: Tenant, p: Party) {
  if (!onboardingOn(t) || !optionOn(t, 'linkSuppliers')) throw new HttpError(400, 'Linking parties to suppliers is switched off.');
  if (p.kind !== 'SUPPLIER') throw new HttpError(400, 'Only supplier parties can be linked to a supplier record.');
}

export async function linkVendor(t: Tenant, partyId: string, vendorId: string | null, by: By) {
  const p = await getParty(t.id, partyId);
  assertLinking(t, p);
  if (vendorId) {
    const v = await db.query.vendors.findFirst({ where: and(eq(V.tenantId, t.id), eq(V.id, vendorId)) });
    if (!v) throw new HttpError(404, 'Supplier not found');
    const other = await db.query.parties.findFirst({ where: and(eq(P.tenantId, t.id), eq(P.vendorId, v.id)) });
    if (other && other.id !== p.id) throw new HttpError(409, `${v.name} is already linked to ${other.name} (${other.code}).`);
  }
  const [row] = await db.update(P).set({ vendorId }).where(eq(P.id, p.id)).returning();
  await audit({ tenantId: t.id, actor: by.name, action: vendorId ? 'PARTY_LINKED' : 'PARTY_UNLINKED', detail: { subjectId: p.id, code: p.code, vendorId: vendorId ?? p.vendorId }, ip: by.ip });
  return row;
}

/** A supplier party for an onboarded supplier (the contract screen offers suppliers too). Reuses an existing link. */
export async function partyForVendor(t: Tenant, vendorId: string, by: By) {
  if (!onboardingOn(t) || !optionOn(t, 'linkSuppliers')) throw new HttpError(400, 'Linking parties to suppliers is switched off.');
  return vendorParty(t, vendorId, by);
}

/**
 * The party of an onboarded supplier, created and linked the first time (no option check: invoices from the supplier portal
 * always belong to the supplier's party).
 */
export async function vendorParty(t: Tenant, vendorId: string, by: By) {
  const linked = await db.query.parties.findFirst({ where: and(eq(P.tenantId, t.id), eq(P.vendorId, vendorId)) });
  if (linked) return linked;
  const v = await db.query.vendors.findFirst({ where: and(eq(V.tenantId, t.id), eq(V.id, vendorId)) });
  if (!v) throw new HttpError(404, 'Supplier not found');
  const b = (v.profile as Record<string, Record<string, unknown>>).basic ?? {};
  const s = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : null);
  const created = await createParty(t, {
    kind: 'SUPPLIER', name: v.name, legalName: s(b.legalName), country: t.country, email: v.contactEmail, phone: v.contactMobile,
    address: { line1: s(b.address) ?? undefined, city: s(b.district) ?? undefined, region: s(b.region) ?? undefined, postalCode: s(b.postalCode) ?? undefined },
    contacts: [{ name: `${v.contactFirstName} ${v.contactLastName}`.trim(), email: v.contactEmail, phone: v.contactMobile }], confirmDuplicate: true,
  }, by, { source: `supplier ${v.code}` });
  const [row] = await db.update(P).set({ vendorId: v.id }).where(eq(P.id, created.id)).returning();
  return row;
}

/** Send a supplier party for full onboarding: creates the supplier (invited) and links it. */
export async function onboardParty(t: Tenant, partyId: string, by: By) {
  const p = await getParty(t.id, partyId);
  assertLinking(t, p);
  if (p.vendorId) throw new HttpError(409, 'This party is already linked to a supplier.');
  const c = p.contacts.find((x) => x.email) ?? (p.email ? { name: p.name, email: p.email, phone: p.phone ?? undefined } : null);
  if (!c?.email) throw new HttpError(400, 'Add a contact with an email address first — the invitation goes to them.');
  const phone = c.phone ?? p.phone;
  if (!phone) throw new HttpError(400, 'Add the contact’s mobile number first.');
  const [first, ...rest] = c.name.split(' ');
  const { createVendor } = await import('../vendors.js');
  const v = await createVendor(t, { name: p.name, vendorType: p.country === t.country ? 'DOMESTIC' : 'IMPORT', contactFirstName: first, contactLastName: rest.join(' ') || '-', contactEmail: c.email, contactMobile: phone, notify: true }, by, { ip: by.ip, source: 'contract party' });
  await db.update(P).set({ vendorId: v.id }).where(eq(P.id, p.id));
  await audit({ tenantId: t.id, actor: by.name, action: 'PARTY_SENT_FOR_ONBOARDING', detail: { subjectId: p.id, code: p.code, vendorId: v.id }, ip: by.ip });
  return v;
}

/* ---------------- lists and detail ---------------- */

export async function listParties(t: Tenant, q: { q?: string; kind?: string; status?: string; page?: number; pageSize?: number }) {
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
  const page = Math.max(1, Math.floor(Number(q.page) || 1));
  const where: SQL[] = [eq(P.tenantId, t.id), eq(P.status, q.status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE')];
  if (q.kind === 'SUPPLIER' || q.kind === 'CUSTOMER') where.push(eq(P.kind, q.kind));
  if (q.q) where.push(or(ilike(P.name, `%${q.q}%`), ilike(P.code, `%${q.q}%`), ilike(P.taxNo, `%${q.q}%`), ilike(P.registrationNo, `%${q.q}%`))!);
  const [{ n: total }] = await db.select({ n: count() }).from(P).where(and(...where));
  const rows = await db.select().from(P).where(and(...where)).orderBy(asc(P.name), asc(P.id)).limit(pageSize).offset((page - 1) * pageSize);
  const ids = rows.map((r) => r.id);
  const stats = ids.length ? await db.select({ partyId: C.partyId, active: sql<number>`count(*) filter (where ${C.status} = 'ACTIVE')::int`, all: sql<number>`count(*)::int` }).from(C).where(inArray(C.partyId, ids)).groupBy(C.partyId) : [];
  const vendors = await vendorSummaries(t, rows.map((r) => r.vendorId).filter((x): x is string => !!x));
  return {
    total, page, pageSize,
    parties: rows.map((p) => ({ ...partyOut(p), contracts: stats.find((s) => s.partyId === p.id)?.all ?? 0, activeContracts: stats.find((s) => s.partyId === p.id)?.active ?? 0, supplier: p.vendorId ? vendors.get(p.vendorId) ?? null : null })),
  };
}

/** For pickers: active parties of one kind, name and code only. */
export async function partyOptions(t: Tenant, kind?: string) {
  return db.select({ id: P.id, code: P.code, name: P.name, kind: P.kind }).from(P)
    .where(and(eq(P.tenantId, t.id), eq(P.status, 'ACTIVE'), kind === 'SUPPLIER' || kind === 'CUSTOMER' ? eq(P.kind, kind) : undefined)).orderBy(asc(P.name)).limit(5000);
}

async function vendorSummaries(t: Tenant, ids: string[]) {
  if (!ids.length || !onboardingOn(t)) return new Map<string, { id: string; code: string; name: string; status: string; riskBand: string | null }>();
  const rows = await db.select({ id: V.id, code: V.code, name: V.name, status: V.status, riskBand: V.riskBand }).from(V).where(and(eq(V.tenantId, t.id), inArray(V.id, ids)));
  return new Map(rows.map((r) => [r.id, r]));
}

export const partyOut = (p: Party) => ({
  id: p.id, kind: p.kind, code: p.code, name: p.name, legalName: p.legalName, country: p.country, registrationNo: p.registrationNo, taxNo: p.taxNo,
  address: p.address, email: p.email, phone: p.phone, website: p.website, contacts: p.contacts, vendorId: p.vendorId, status: p.status, notes: p.notes, ap: p.ap,
  createdByName: p.createdByName, createdAt: p.createdAt, updatedAt: p.updatedAt,
});

export async function partyDetail(t: Tenant, id: string) {
  const p = await getParty(t.id, id);
  const vendors = await vendorSummaries(t, p.vendorId ? [p.vendorId] : []);
  const contracts = await db.select({ id: C.id, number: C.number, title: C.title, type: C.type, direction: C.direction, status: C.status, value: C.value, currency: C.currency, startDate: C.startDate, endDate: C.endDate })
    .from(C).where(and(eq(C.tenantId, t.id), eq(C.partyId, p.id))).orderBy(sql`${C.endDate} desc nulls first`).limit(500);
  const history = await db.select({ actor: schema.auditLogs.actor, action: schema.auditLogs.action, detail: schema.auditLogs.detail, createdAt: schema.auditLogs.createdAt }).from(schema.auditLogs)
    .where(and(eq(schema.auditLogs.tenantId, t.id), sql`${schema.auditLogs.detail}->>'subjectId' = ${p.id}`)).orderBy(sql`${schema.auditLogs.createdAt} desc`).limit(100);
  return { party: partyOut(p), supplier: p.vendorId ? vendors.get(p.vendorId) ?? null : null, canLink: onboardingOn(t) && optionOn(t, 'linkSuppliers') && p.kind === 'SUPPLIER', contracts, history };
}

/* ---------------- Excel import ---------------- */

const PARTY_COLUMNS: SheetColumn[] = [
  { header: 'Type', width: 12, required: true }, { header: 'Name', width: 32, required: true }, { header: 'Legal name', width: 32 }, { header: 'Country', width: 10, required: true },
  { header: 'Registration number', width: 22 }, { header: 'Tax number', width: 22 }, { header: 'Address', width: 36 }, { header: 'City', width: 16 }, { header: 'State / region', width: 16 },
  { header: 'Postal code', width: 12 }, { header: 'Email', width: 26 }, { header: 'Phone', width: 16 }, { header: 'Website', width: 24 },
  { header: 'Contact name', width: 22 }, { header: 'Contact email', width: 26 }, { header: 'Contact phone', width: 16 }, { header: 'Contact signs contracts', width: 12 },
];
export function partiesTemplate(country: string) {
  return sheetTemplate({
    sheet: 'Parties', columns: PARTY_COLUMNS, examplesOnOwnSheet: true, lists: { Type: ['Supplier', 'Customer'], 'Contact signs contracts': ['Yes', 'No'] },
    examples: [['Supplier', 'Precision Valves Pvt Ltd', 'Precision Valves Private Limited', country, 'U29120MH2008PTC123456', '27AABCP1234C1Z5', '12 MIDC Road', 'Pune', 'Maharashtra', '411019', 'accounts@precision.example', '9876543210', 'https://precision.example', 'Rahul Deshmukh', 'rahul@precision.example', '9876543210', 'Yes'],
      ['Customer', 'Northwind Retail LLC', '', 'AE', '', '100123456700003', 'Sheikh Zayed Road', 'Dubai', '', '', 'purchasing@northwind.example', '', '', 'Sara Khan', 'sara@northwind.example', '', 'Yes']],
    help: [
      ['Parties', 'One row per supplier or customer. Type is Supplier or Customer.'],
      ['Required', 'Type, Name and Country (two-letter code, e.g. IN, AE, SA) — the yellow columns.'],
      ['Contact', 'One contact per row here; add more on the screen afterwards.'],
      ['Duplicates', 'Rows with the same name, tax or registration number as an existing party are reported and not imported.'],
      ['Example', 'The Example sheet shows two filled-in rows. Only the Parties sheet is imported.'],
    ],
  });
}

/** Read parties from the template. `commit` creates them; otherwise only the check (what would be created, and errors). */
export async function importParties(t: Tenant, buffer: Buffer, by: By, commit: boolean) {
  const rows = await readSheet(buffer, { sheet: 'Parties', columns: PARTY_COLUMNS, maxRows: 2000 });
  const errors: RowError[] = [];
  const ok: { row: number; input: z.infer<typeof partyInput> }[] = [];
  const seen = new Set<string>();
  for (const { row, get } of rows) {
    const type = get('Type').toLowerCase();
    const contactName = get('Contact name');
    const parsed = partyInput.safeParse({
      kind: type.startsWith('cus') ? 'CUSTOMER' : type.startsWith('sup') ? 'SUPPLIER' : type, name: get('Name'), legalName: get('Legal name'), country: get('Country'),
      registrationNo: get('Registration number'), taxNo: get('Tax number'), address: { line1: get('Address'), city: get('City'), region: get('State / region'), postalCode: get('Postal code') },
      email: get('Email'), phone: get('Phone'), website: get('Website'),
      contacts: contactName ? [{ name: contactName, email: get('Contact email'), phone: get('Contact phone'), signatory: /^y/i.test(get('Contact signs contracts')) }] : [],
    });
    if (!parsed.success) { errors.push({ row, message: parsed.error.issues.map((i) => (i.path[0] === 'kind' ? 'Type must be Supplier or Customer' : i.message)).join('; ') }); continue; }
    if (parsed.data.kind === 'CUSTOMER' && !optionOn(t, 'customerContracts')) { errors.push({ row, message: 'Customer contracts are switched off' }); continue; }
    const k = parsed.data.name.toLowerCase();
    if (seen.has(k)) { errors.push({ row, message: `${parsed.data.name} appears twice in the sheet` }); continue; }
    seen.add(k);
    const same = await lookAlikes(t.id, parsed.data);
    if (same.length) { errors.push({ row, message: `Looks like an existing party: ${same.map((s) => `${s.name} (${s.code})`).join(', ')}` }); continue; }
    ok.push({ row, input: parsed.data });
  }
  if (!rows.length) errors.push({ row: 0, message: 'No parties found in the sheet.' });
  const created: { row: number; code: string; name: string }[] = [];
  if (commit) for (const r of ok) { const p = await createParty(t, { ...r.input, confirmDuplicate: true }, by, { source: 'Excel import' }); created.push({ row: r.row, code: p.code, name: p.name }); }
  return { ready: ok.map((r) => ({ row: r.row, kind: r.input.kind, name: r.input.name, country: r.input.country })), errors, created };
}
