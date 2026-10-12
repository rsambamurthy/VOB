/**
 * OPTIONAL demo data: adds a year of realistic onboarding history to a workspace so the
 * dashboard and reports have something to show. Adds only — never changes or deletes.
 * Run: npm run db:demo-history            (workspace "acme")
 *      npm run db:demo-history -- globex  (another workspace)
 */
import crypto from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, pool, schema } from '../lib/db.js';
import { env } from '../lib/env.js';
import { gstinCheckChar } from '../lib/validators.js';
import { getConfig } from '../services/config.js';

const { tenants, vendors, approvalSteps, roles, userRoles, users, auditLogs } = schema;
if (env.isProd) throw new Error('Demo history is for development only');

const slug = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'acme';
const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
if (!tenant) { console.error(`No workspace "${slug}"`); process.exit(1); }
const already = await db.query.auditLogs.findFirst({ where: and(eq(auditLogs.tenantId, tenant.id), eq(auditLogs.action, 'DEMO_HISTORY_LOADED')) });
if (already) { console.log(`Demo history was already added to "${slug}" — nothing to do.`); await pool.end(); process.exit(0); }

// Deterministic pseudo-random numbers, so every run looks the same.
let seed = 20261004;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const between = (a: number, b: number) => a + rnd() * (b - a);
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const HOUR = 3_600_000, DAY = 86_400_000;

const NAMES = ['Shakti Castings', 'Nilgiri Packaging', 'Deccan Fasteners', 'Coromandel Chemicals', 'Sahyadri Polymers', 'Ganga Logistics', 'Vindhya Steel Traders', 'Malabar Spices Export',
  'Konkan Engineering Works', 'Aravalli Electricals', 'Kaveri Tools', 'Narmada Industrial Gases', 'Thar Solar Systems', 'Brahmaputra Textiles', 'Godavari Agro Products', 'Satpura Cables',
  'Western Ghats IT Services', 'Chola Auto Components', 'Mysore Printing Press', 'Hampi Office Supplies', 'Sundarbans Marine Services', 'Lakshadweep Freight', 'Ajanta Labs', 'Ellora Interiors',
  'Kanchi Weaves', 'Madurai Hydraulics', 'Pune Precision Gears', 'Surat Synthetics', 'Indore Bearings', 'Nagpur Facility Services', 'Kochi Port Handling', 'Vizag Valves', 'Ludhiana Forgings',
  'Rajkot Pumps', 'Coimbatore Motors', 'Jamshedpur Alloys', 'Gulf Machinery FZE', 'Singapore Marine Pte', 'Delhi Jal Board Supplies'];
const STATES = [['Maharashtra', 'Pune', '27'], ['Tamil Nadu', 'Chennai', '33'], ['Karnataka', 'Bengaluru', '29'], ['Gujarat', 'Ahmedabad', '24'], ['Telangana', 'Hyderabad', '36'], ['Delhi', 'New Delhi', '07'], ['Kerala', 'Kochi', '32']];
const BANKS = [['HDFC Bank', 'HDFC'], ['ICICI Bank', 'ICIC'], ['State Bank of India', 'SBIN'], ['Axis Bank', 'UTIB'], ['Kotak Mahindra Bank', 'KKBK']];

const cfg = await getConfig(tenant.id);
const tenantRoles = await db.select().from(roles).where(eq(roles.tenantId, tenant.id));
const holders = async (roleKey: string) => {
  const r = tenantRoles.find((x) => x.key === roleKey);
  if (!r) return [];
  return (await db.select({ id: users.id }).from(userRoles).innerJoin(users, eq(users.id, userRoles.userId)).where(and(eq(userRoles.roleId, r.id), eq(users.status, 'ACTIVE')))).map((u) => u.id);
};
const admin = (await holders('ADMIN'))[0];
const [{ max }] = await db.select({ max: sql<number>`coalesce(max(substring(${vendors.code} from 5)::int), 0)` }).from(vendors).where(eq(vendors.tenantId, tenant.id));
let next = Number(max);
const levels = cfg.workflow.levels.filter((l) => !l.rule); // the levels every domestic vendor goes through

const now = Date.now();
let made = 0;
for (const name of NAMES) {
  const created = new Date(now - between(4, 360) * DAY);
  const ageDays = (now - created.getTime()) / DAY;
  const foreign = /FZE|Pte/.test(name);
  const govt = /Jal Board/.test(name);
  const [state, city, sc] = pick(STATES);
  const pan = `AA${String.fromCharCode(65 + Math.floor(rnd() * 26))}C${String.fromCharCode(65 + Math.floor(rnd() * 26))}${String(1000 + Math.floor(rnd() * 8999))}${String.fromCharCode(65 + Math.floor(rnd() * 26))}`;
  const g = `${sc}${pan}1Z`;
  const [bankName, bankCode] = pick(BANKS);
  // Older vendors are mostly decided; recent ones are still moving.
  const roll = rnd();
  const outcome = ageDays < 12 ? pick(['INVITED', 'IN_PROGRESS', 'IN_PROGRESS', 'UNDER_REVIEW', 'SENT_BACK']) : roll < 0.8 ? 'APPROVED' : roll < 0.9 ? 'REJECTED' : pick(['IN_PROGRESS', 'SENT_BACK', 'UNDER_REVIEW']);
  const submitted = outcome === 'INVITED' || outcome === 'IN_PROGRESS' ? null : new Date(created.getTime() + between(1, Math.min(14, ageDays - 1)) * DAY);
  const code = `VND-${String(++next).padStart(5, '0')}`;
  const first = pick(['Arun', 'Priya', 'Karthik', 'Meena', 'Rohit', 'Sneha', 'Vikas', 'Anjali', 'Suresh', 'Divya']);
  const last = pick(['Iyer', 'Shah', 'Reddy', 'Nair', 'Gupta', 'Kulkarni', 'Menon', 'Das', 'Patel', 'Rao']);
  const email = `${first.toLowerCase()}@${name.toLowerCase().replace(/[^a-z]+/g, '')}.demo`;

  // Walk the approval levels with realistic (sometimes late) decision times.
  const steps: (typeof approvalSteps.$inferInsert)[] = [];
  let at = submitted?.getTime() ?? 0, decided: Date | null = null;
  if (submitted && outcome !== 'SENT_BACK') {
    for (const [i, l] of levels.entries()) {
      const role = tenantRoles.find((r) => r.key === l.roleKey);
      if (!role) continue;
      const by = pick(await holders(l.roleKey)) ?? admin;
      const activatedAt = new Date(at);
      const dueAt = l.slaHours ? new Date(at + l.slaHours * HOUR) : null;
      const isLast = i === levels.length - 1;
      const pendingHere = outcome === 'UNDER_REVIEW' && (i === Math.min(levels.length - 1, Math.floor(rnd() * levels.length)) || now - at < 2 * DAY);
      if (pendingHere) { steps.push({ tenantId: tenant.id, vendorId: '', cycle: 1, level: i + 1, roleId: role.id, label: l.label, status: 'PENDING', slaHours: l.slaHours ?? null, activatedAt, dueAt }); break; }
      const took = between(3, (l.slaHours ?? 48) * (rnd() < 0.2 ? 2.2 : 0.9)) * HOUR; // ~1 in 5 decisions run late
      at = Math.min(at + took, now - HOUR);
      const reject = outcome === 'REJECTED' && isLast;
      steps.push({ tenantId: tenant.id, vendorId: '', cycle: 1, level: i + 1, roleId: role.id, label: l.label, status: reject ? 'REJECTED' : 'APPROVED', slaHours: l.slaHours ?? null, activatedAt, dueAt, actedAt: new Date(at), actedById: by, remarks: reject ? 'Litigation history not acceptable' : null });
      if (isLast) decided = new Date(at);
    }
  }
  const status = outcome === 'UNDER_REVIEW' && !steps.some((s) => s.status === 'PENDING') ? 'APPROVED' : outcome;
  if (status === 'APPROVED' && !decided) decided = new Date(at);
  const [v] = await db.insert(vendors).values({
    tenantId: tenant.id, code, name, vendorType: foreign ? 'IMPORT' : govt ? 'GOVERNMENT' : 'DOMESTIC', status: status as any,
    contactFirstName: first, contactLastName: last, contactEmail: email, contactMobile: `98${String(10000000 + Math.floor(rnd() * 89999999))}`,
    inviteToken: crypto.randomBytes(24).toString('base64url'), createdById: admin, createdAt: created,
    updatedAt: new Date(decided?.getTime() ?? submitted?.getTime() ?? created.getTime() + between(0, ageDays) * DAY * 0.5),
    submittedAt: submitted, decidedAt: status === 'APPROVED' || status === 'REJECTED' ? decided : null,
    nextReviewAt: status === 'APPROVED' && decided ? new Date(decided.getTime() + 365 * DAY) : null, reviewStatus: status === 'APPROVED' ? 'OK' : null,
    profile: {
      basic: { vendorName: name, supplierCountry: foreign ? (name.includes('FZE') ? 'United Arab Emirates' : 'Singapore') : 'India', entityType: 'Company (Pvt / Public Ltd)', address: `${Math.floor(between(1, 300))} Industrial Area`, region: foreign ? '' : state, district: foreign ? '' : city, postalCode: foreign ? '' : String(400001 + Math.floor(rnd() * 300000)), contactName: `${first} ${last}`, contactEmail: email, msmeRegistered: rnd() < 0.4 ? 'Yes' : 'No', supplyCategory: pick(['Goods', 'Services', 'Both']) },
      bank: foreign ? { bankCountry: name.includes('FZE') ? 'United Arab Emirates' : 'Singapore', bankName: 'Emirates NBD', accountHolderName: name, accountNumber: String(1e11 + Math.floor(rnd() * 8e11)), swift: 'EBILAEAD' }
        : { bankCountry: 'India', bankName, accountHolderName: name, accountNumber: String(5e11 + Math.floor(rnd() * 4e11)), bankBranch: city, ifsc: `${bankCode}0${String(Math.floor(rnd() * 999999)).padStart(6, '0')}` },
      tax: foreign ? { foreignTin: `TIN${Math.floor(rnd() * 1e8)}` } : { hasGst: 'Yes', gstin: g + gstinCheckChar(g), gstClassification: 'Regular', pan },
    },
  }).returning();
  if (steps.length) await db.insert(approvalSteps).values(steps.map((s) => ({ ...s, vendorId: v.id })));
  made++;
}
await db.insert(auditLogs).values({ tenantId: tenant.id, actor: 'system', action: 'DEMO_HISTORY_LOADED', detail: { vendors: made } });
console.log(`Added ${made} demo vendors with a year of history to "${slug}". Open Dashboard to see them.`);
await pool.end();
