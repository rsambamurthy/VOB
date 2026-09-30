/** Resets all data and loads demo users + vendors in different stages. Run: npm run db:seed */
import crypto from 'node:crypto';
import { db, pool, schema } from '../lib/db.js';
import { env } from '../lib/env.js';
import { gstinCheckChar } from '../lib/validators.js';
import type { Role } from './schema.js';

const { users, vendors, approvalSteps, auditLogs, emailOutbox, documents, otpCodes } = schema;
const token = () => crypto.randomBytes(24).toString('base64url');
const gstin = (state: string, pan: string) => { const b = `${state}${pan}1Z`; return b + gstinCheckChar(b); };
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);

const seedUsers: { name: string; email: string; role: Role }[] = [
  { name: 'Anita Rao', email: 'admin@buyer.test', role: 'ADMIN' },
  { name: 'Suresh Iyer', email: 'tax@buyer.test', role: 'TAX_MANAGER' },
  { name: 'Meera Nair', email: 'finance@buyer.test', role: 'FINANCE_MANAGER' },
  { name: 'Vikram Shah', email: 'mdm@buyer.test', role: 'MDM_MANAGER' },
];

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

async function main() {
  for (const t of [auditLogs, approvalSteps, documents, otpCodes, vendors, emailOutbox, users]) await db.delete(t);
  const created = await db.insert(users).values(seedUsers).returning();
  const by = (r: Role) => created.find((u) => u.role === r)!;
  const [admin, tax, finance, mdm] = [by('ADMIN'), by('TAX_MANAGER'), by('FINANCE_MANAGER'), by('MDM_MANAGER')];

  // 1. Fully approved domestic vendor — try the ERP export on this one
  const [approved] = await db.insert(vendors).values({
    code: 'VND-00001', name: 'Precision Valves Pvt Ltd', vendorType: 'DOMESTIC', contactFirstName: 'Rahul', contactLastName: 'Deshmukh',
    contactEmail: 'accounts@precision.in', contactMobile: '9876543210', status: 'APPROVED', reviewCycle: 1, inviteToken: token(),
    profile: fullProfile('Precision Valves Pvt Ltd', 'AABCP1234K', '27', 'Pune', '411019'), createdById: admin.id,
    createdAt: daysAgo(12), submittedAt: daysAgo(9), decidedAt: daysAgo(6),
  }).returning();
  await db.insert(approvalSteps).values([
    { vendorId: approved.id, cycle: 1, level: 1, role: 'TAX_MANAGER', label: 'Tax Review', status: 'APPROVED', remarks: 'GSTIN and PAN verified', actedById: tax.id, actedAt: daysAgo(8) },
    { vendorId: approved.id, cycle: 1, level: 2, role: 'FINANCE_MANAGER', label: 'Finance & Risk Review', status: 'APPROVED', remarks: 'CRISIL BBB+, acceptable', actedById: finance.id, actedAt: daysAgo(7) },
    { vendorId: approved.id, cycle: 1, level: 3, role: 'MDM_MANAGER', label: 'Master Data Approval', status: 'APPROVED', actedById: mdm.id, actedAt: daysAgo(6) },
  ]);

  // 2. Under review, waiting for Finance (sign in as Meera Nair)
  const [review] = await db.insert(vendors).values({
    code: 'VND-00002', name: 'Kaveri Steel Traders Pvt Ltd', vendorType: 'DOMESTIC', contactFirstName: 'Lakshmi', contactLastName: 'Gowda',
    contactEmail: 'accounts@kaveri.in', contactMobile: '9845012345', status: 'UNDER_REVIEW', reviewCycle: 1, inviteToken: token(),
    profile: fullProfile('Kaveri Steel Traders Pvt Ltd', 'AAECK5678M', '29', 'Bengaluru', '560058'), createdById: admin.id,
    createdAt: daysAgo(5), submittedAt: daysAgo(2),
  }).returning();
  await db.insert(approvalSteps).values([
    { vendorId: review.id, cycle: 1, level: 1, role: 'TAX_MANAGER', label: 'Tax Review', status: 'APPROVED', remarks: 'OK', actedById: tax.id, actedAt: daysAgo(1) },
    { vendorId: review.id, cycle: 1, level: 2, role: 'FINANCE_MANAGER', label: 'Finance & Risk Review', status: 'PENDING' },
    { vendorId: review.id, cycle: 1, level: 3, role: 'MDM_MANAGER', label: 'Master Data Approval', status: 'WAITING' },
  ]);

  // 3. Invited, not started — open its invite link from the Mailbox to play the vendor
  const [invited] = await db.insert(vendors).values({
    code: 'VND-00003', name: 'Layman Industries', vendorType: 'DOMESTIC', contactFirstName: 'George', contactLastName: 'Layman',
    contactEmail: 'george@layman.test', contactMobile: '9786543210', status: 'INVITED', inviteToken: token(), createdById: admin.id,
    profile: { basic: { vendorName: 'Layman Industries', supplierCountry: 'India', contactName: 'George Layman', contactEmail: 'george@layman.test', contactMobile: '9786543210' }, bank: { bankCountry: 'India' } },
  }).returning();

  // 4. Foreign vendor part-way through (bank data taken from the sample ERP record, with the BIC fixed)
  const [foreign] = await db.insert(vendors).values({
    code: 'VND-00004', name: 'Deloitte GmbH', vendorType: 'IMPORT', contactFirstName: 'Katrin', contactLastName: 'Weber',
    contactEmail: 'k.weber@deloitte.test', contactMobile: '+49 40 320800', status: 'IN_PROGRESS', inviteToken: token(), createdById: admin.id,
    profile: {
      basic: { vendorName: 'Deloitte GmbH', supplierCountry: 'Germany', address: 'Dammtorstrasse 12', region: 'Hamburg', district: 'Hamburg', postalCode: '20354', contactName: 'Katrin Weber', contactEmail: 'k.weber@deloitte.test', contactMobile: '+49 40 320800' },
      bank: { bankCountry: 'Germany', bankName: 'Commerzbank AG', accountHolderName: 'Deloitte GmbH', accountNumber: '0212895000', bankBranch: 'Düsseldorf', swift: 'COBADEFF', iban: 'DE61300800000212895000' },
    },
  }).returning();

  for (const v of [approved, review, invited, foreign]) {
    await db.insert(auditLogs).values({ vendorId: v.id, actor: admin.name, action: 'VENDOR_CREATED', createdAt: v.createdAt });
  }
  await db.insert(emailOutbox).values({
    to: invited.contactEmail, subject: 'Invitation to register as a vendor',
    body: 'Dear George,\n\nYou have been invited to register Layman Industries as a vendor. Open the link below and sign in with the one-time code sent to this email address.',
    link: `${env.appBaseUrl}/onboard/${invited.inviteToken}`,
  });
  console.log('Seeded users:', created.map((u) => `${u.email} (${u.role})`).join(', '));
}

main().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
