/**
 * Demo data: two workspaces (to show tenant isolation) with users in every role and vendors
 * in different stages. Used by `npm run db:reset`. All demo users share DEMO_PASSWORD.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db, pool, schema } from '../lib/db.js';
import { env } from '../lib/env.js';
import { gstinCheckChar } from '../lib/validators.js';
import { hashPassword } from '../lib/password.js';
import { DEFAULT_ROLES } from '../lib/permissions.js';
import type { Role, Tenant, User } from './schema.js';
import { seedInitialConfig } from '../services/config.js';
import { indiaTemplate } from '../countries/in/template.js';

const defaultConfig = indiaTemplate();
import type { OnboardingConfig } from '../config/types.js';

export const DEMO_PASSWORD = 'Demo@12345';
const { tenants, users, roles, userRoles, vendors, approvalSteps, auditLogs, emailOutbox, documents } = schema;

/** Writes a tiny placeholder PDF per document so seeded vendors look complete. */
function placeholderDocs(tenantId: string, vendorId: string, types: string[]) {
  fs.mkdirSync(env.uploadDir, { recursive: true });
  return types.map((docType) => {
    const storagePath = `seed-${crypto.randomUUID()}.pdf`;
    const body = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n% demo ${docType}`;
    fs.writeFileSync(path.join(env.uploadDir, storagePath), body);
    return { tenantId, vendorId, docType, fileName: `${docType.toLowerCase()}.pdf`, mimeType: 'application/pdf', size: body.length, storagePath };
  });
}
const FULL_DOCS = ['PAN_CARD', 'GST_CERT', 'CANCELLED_CHEQUE', 'INCORPORATION_CERT', 'MSME_CERT', 'FINANCIALS'];
const token = () => crypto.randomBytes(24).toString('base64url');
const gstin = (state: string, pan: string) => { const b = `${state}${pan}1Z`; return b + gstinCheckChar(b); };
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

async function makeTenant(slug: string, name: string, branding: Tenant['branding'], extraRoles: { key: string; name: string; description: string; permissions: string[] }[] = [], config: OnboardingConfig = defaultConfig) {
  const [t] = await db.insert(tenants).values({ slug, name, branding, settings: {} }).returning();
  const rs = await db.insert(roles).values([...DEFAULT_ROLES, ...extraRoles].map((r) => ({ tenantId: t.id, key: r.key, name: r.name, description: r.description, permissions: r.permissions, isSystem: r.key === 'ADMIN' }))).returning();
  await seedInitialConfig(t.id, config);
  return { tenant: t, role: (k: string) => rs.find((r) => r.key === k)! };
}

async function makeUser(t: Tenant, name: string, email: string, rs: Role[], hash: string, status: 'ACTIVE' | 'INVITED' = 'ACTIVE'): Promise<User> {
  const [u] = await db.insert(users).values({ tenantId: t.id, name, email, status, passwordHash: status === 'ACTIVE' ? hash : null, passwordChangedAt: new Date() }).returning();
  if (rs.length) await db.insert(userRoles).values(rs.map((r) => ({ userId: u.id, roleId: r.id })));
  return u;
}

function fullProfile(name: string, pan: string, state: '27' | '29', city: string, pin: string) {
  const slug = name.split(' ')[0].toLowerCase();
  const st = state === '27' ? 'MH' : 'KA';
  return {
    basic: {
      vendorName: name, tradingName: name.split(' ')[0], entityType: 'Company (Pvt / Public Ltd)', supplierCountry: 'India',
      address: 'Plot 14, MIDC Industrial Area', region: state === '27' ? 'Maharashtra' : 'Karnataka', district: city, postalCode: pin,
      websiteUrl: `www.${slug}.in`, yearEstablished: '2012', msmeRegistered: 'Yes', udyamNumber: `UDYAM-${st}-01-0012345`, msmeCategory: 'Small',
      contactName: 'Rahul Deshmukh', contactEmail: `accounts@${slug}.in`, contactMobile: '9876543210', accountsEmail: `ap@${slug}.in`,
      supplyCategory: 'Goods', itemsSupplied: 'Industrial valves and fittings', paymentTerms: 'Net 45',
    },
    bank: { bankCountry: 'India', bankName: 'HDFC Bank', accountHolderName: name, accountNumber: '50200012345671', bankBranch: `${city} Main`, ifsc: 'HDFC0001234', upiId: `${slug}@hdfcbank`, bankCity: city },
    tax: { hasGst: 'Yes', gstin: gstin(state, pan), gstClassification: 'Regular', pan, tan: 'PNEA12345B', cin: `U29120${st}2012PTC123456`, concessionalTds: 'No' },
    risk: { fiscalYearEnd: 'March', currency: 'INR', turnoverYear: 'FY 2024-25', annualTurnover: '185000000', netWorth: '42000000', sourceOfInfo: 'Audited financial statements', hasRating: 'Yes', ratingAgency: 'CRISIL', rating: 'BBB+', bankruptcy5y: 'No', litigation: 'No' },
  };
}

export async function seed() {
  const hash = await hashPassword(DEMO_PASSWORD);

  /* ---- Workspace 1: acme ---- */
  // Acme demonstrates a rule-based level: an extra Compliance Review only for import (foreign) vendors.
  const acmeConfig = structuredClone(defaultConfig);
  acmeConfig.workflow.levels.splice(1, 0, {
    id: 'compliance', label: 'Compliance Review', roleKey: 'COMPLIANCE', slaHours: 72,
    rule: { match: 'all', conditions: [{ field: 'vendor.vendorType', op: 'eq', value: 'IMPORT' }] },
  });
  const { tenant: acme, role } = await makeTenant('acme', 'Acme Industries Ltd', { productName: 'VendorGate', primaryColor: '#6d1a73' },
    [{ key: 'COMPLIANCE', name: 'Compliance Officer', description: 'Extra checks for foreign vendors', permissions: ['vendors.view'] }], acmeConfig);
  const admin = await makeUser(acme, 'Anita Rao', 'admin@acme.test', [role('ADMIN')], hash);
  await makeUser(acme, 'Deepak Menon', 'vendoradmin@acme.test', [role('VENDOR_ADMIN')], hash);
  const tax = await makeUser(acme, 'Suresh Iyer', 'tax@acme.test', [role('TAX_MANAGER')], hash);
  const fin = await makeUser(acme, 'Meera Nair', 'finance@acme.test', [role('FINANCE_MANAGER')], hash);
  const mdm = await makeUser(acme, 'Vikram Shah', 'mdm@acme.test', [role('MDM_MANAGER')], hash);
  await makeUser(acme, 'Farah Khan', 'farah@acme.test', [role('VIEWER')], hash, 'INVITED');
  await makeUser(acme, 'Joseph Mathew', 'compliance@acme.test', [role('COMPLIANCE')], hash);
  // A second Master Data Manager, so a change one of them proposes can be approved by the other.
  await makeUser(acme, 'Kiran Patel', 'mdm2@acme.test', [role('MDM_MANAGER')], hash);

  const [approved] = await db.insert(vendors).values({
    tenantId: acme.id, code: 'VND-00001', name: 'Precision Valves Pvt Ltd', vendorType: 'DOMESTIC', contactFirstName: 'Rahul', contactLastName: 'Deshmukh',
    contactEmail: 'accounts@precision.in', contactMobile: '9876543210', status: 'APPROVED', reviewCycle: 1, inviteToken: token(),
    profile: fullProfile('Precision Valves Pvt Ltd', 'AABCP1234K', '27', 'Pune', '411019'), createdById: admin.id,
    createdAt: daysAgo(12), submittedAt: daysAgo(9), decidedAt: daysAgo(6),
  }).returning();
  await db.insert(approvalSteps).values([
    { tenantId: acme.id, vendorId: approved.id, cycle: 1, level: 1, roleId: role('TAX_MANAGER').id, label: 'Tax Review', status: 'APPROVED', remarks: 'GSTIN and PAN verified', actedById: tax.id, activatedAt: daysAgo(9), actedAt: daysAgo(8) },
    { tenantId: acme.id, vendorId: approved.id, cycle: 1, level: 2, roleId: role('FINANCE_MANAGER').id, label: 'Finance & Risk Review', status: 'APPROVED', remarks: 'CRISIL BBB+, acceptable', actedById: fin.id, activatedAt: daysAgo(8), actedAt: daysAgo(7) },
    { tenantId: acme.id, vendorId: approved.id, cycle: 1, level: 3, roleId: role('MDM_MANAGER').id, label: 'Master Data Approval', status: 'APPROVED', actedById: mdm.id, activatedAt: daysAgo(7), actedAt: daysAgo(6) },
  ]);

  const [review] = await db.insert(vendors).values({
    tenantId: acme.id, code: 'VND-00002', name: 'Kaveri Steel Traders Pvt Ltd', vendorType: 'DOMESTIC', contactFirstName: 'Lakshmi', contactLastName: 'Gowda',
    contactEmail: 'accounts@kaveri.in', contactMobile: '9845012345', status: 'UNDER_REVIEW', reviewCycle: 1, inviteToken: token(),
    profile: fullProfile('Kaveri Steel Traders Pvt Ltd', 'AAECK5678M', '29', 'Bengaluru', '560058'), createdById: admin.id,
    createdAt: daysAgo(5), submittedAt: daysAgo(2),
  }).returning();
  await db.insert(approvalSteps).values([
    { tenantId: acme.id, vendorId: review.id, cycle: 1, level: 1, roleId: role('TAX_MANAGER').id, label: 'Tax Review', status: 'APPROVED', remarks: 'OK', actedById: tax.id, activatedAt: daysAgo(2), actedAt: daysAgo(1) },
    { tenantId: acme.id, vendorId: review.id, cycle: 1, level: 2, roleId: role('FINANCE_MANAGER').id, label: 'Finance & Risk Review', status: 'PENDING', slaHours: 48, activatedAt: daysAgo(1), dueAt: new Date(Date.now() + 86_400_000) },
    { tenantId: acme.id, vendorId: review.id, cycle: 1, level: 3, roleId: role('MDM_MANAGER').id, label: 'Master Data Approval', status: 'WAITING', slaHours: 24 },
  ]);

  const [invited] = await db.insert(vendors).values({
    tenantId: acme.id, code: 'VND-00003', name: 'Layman Industries', vendorType: 'DOMESTIC', contactFirstName: 'George', contactLastName: 'Layman',
    contactEmail: 'george@layman.test', contactMobile: '9786543210', status: 'INVITED', inviteToken: token(), createdById: admin.id,
    profile: { basic: { vendorName: 'Layman Industries', supplierCountry: 'India', contactName: 'George Layman', contactEmail: 'george@layman.test', contactMobile: '9786543210' }, bank: { bankCountry: 'India' } },
  }).returning();

  const [foreign] = await db.insert(vendors).values({
    tenantId: acme.id, code: 'VND-00004', name: 'Deloitte GmbH', vendorType: 'IMPORT', contactFirstName: 'Katrin', contactLastName: 'Weber',
    contactEmail: 'k.weber@deloitte.test', contactMobile: '+49 40 320800', status: 'IN_PROGRESS', inviteToken: token(), createdById: admin.id,
    profile: {
      basic: { vendorName: 'Deloitte GmbH', supplierCountry: 'Germany', address: 'Dammtorstrasse 12', region: 'Hamburg', district: 'Hamburg', postalCode: '20354', contactName: 'Katrin Weber', contactEmail: 'k.weber@deloitte.test', contactMobile: '+49 40 320800' },
      bank: { bankCountry: 'Germany', bankName: 'Commerzbank AG', accountHolderName: 'Deloitte GmbH', accountNumber: '0212895000', bankBranch: 'Düsseldorf', swift: 'COBADEFF', iban: 'DE61300800000212895000' },
    },
  }).returning();

  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  // Precision's audited financials expire in 20 days, and its yearly re-check is due — so it shows up under "Needs attention".
  await db.insert(documents).values([
    ...placeholderDocs(acme.id, approved.id, FULL_DOCS).map((d) => (d.docType === 'FINANCIALS' ? { ...d, expiresOn: inDays(20) } : d)),
    ...placeholderDocs(acme.id, review.id, FULL_DOCS).map((d) => (d.docType === 'FINANCIALS' ? { ...d, expiresOn: inDays(300) } : d)),
  ]);
  await db.update(vendors).set({ nextReviewAt: daysAgo(1), reviewStatus: 'OK', lastReviewAt: daysAgo(6) }).where(eq(vendors.id, approved.id));
  for (const v of [approved, review, invited, foreign]) {
    await db.insert(auditLogs).values({ tenantId: acme.id, vendorId: v.id, actor: admin.name, action: 'VENDOR_CREATED', createdAt: v.createdAt });
  }
  await db.insert(emailOutbox).values({
    tenantId: acme.id, to: invited.contactEmail, subject: 'Acme Industries Ltd: invitation to register as a vendor',
    body: 'Dear George,\n\nAcme Industries Ltd has invited you to register Layman Industries as a vendor. Open the link below and sign in with the one-time code sent to this email address.',
    link: `${env.appBaseUrl}/onboard/${invited.inviteToken}`,
  });

  /* ---- Workspace 2: globex (proves isolation) ---- */
  const g = await makeTenant('globex', 'Globex Manufacturing', { productName: 'Globex Supplier Hub', primaryColor: '#0f5c8c' });
  const gAdmin = await makeUser(g.tenant, 'Rohan Batra', 'admin@globex.test', [g.role('ADMIN')], hash);
  await db.insert(vendors).values({
    tenantId: g.tenant.id, code: 'VND-00001', name: 'Globex Only Supplier Pvt Ltd', vendorType: 'DOMESTIC', contactFirstName: 'Nina', contactLastName: 'Pillai',
    contactEmail: 'nina@supplier.test', contactMobile: '9811111111', status: 'INVITED', inviteToken: token(), createdById: gAdmin.id,
    profile: { basic: { vendorName: 'Globex Only Supplier Pvt Ltd', supplierCountry: 'India' }, bank: { bankCountry: 'India' } },
  });

  // Platform console (/platform): the SaaS operator. 2FA is set up at first sign-in.
  await db.insert(schema.platformAdmins).values({ email: 'owner@vendorgate.test', name: 'Platform Owner', status: 'ACTIVE', passwordHash: hash });
  console.log(`\nDemo workspaces ready. Password for every demo user: ${DEMO_PASSWORD}`);
  console.log('  Platform console /platform: owner@vendorgate.test (sets up 2FA at first sign-in)');
  console.log('  Workspace "acme":   admin@acme.test, vendoradmin@acme.test, tax@acme.test, finance@acme.test, mdm@acme.test, mdm2@acme.test, compliance@acme.test');
  console.log('  Workspace "globex": admin@globex.test\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  seed().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
}
