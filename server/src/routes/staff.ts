import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { and, asc, count, desc, eq, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import type { VendorStatus } from '../db/schema.js';

const { vendors, approvalSteps, documents, auditLogs } = schema;
const findVendor = (id: string) => db.query.vendors.findFirst({ where: eq(vendors.id, id) });
import { ah, HttpError } from '../lib/http.js';
import { requireStaff, staff } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';
import { env } from '../lib/env.js';
import { buildChecklist, visibleDocRequirements, type Profile } from '../lib/profileEngine.js';
import { decide } from '../lib/workflowEngine.js';
import { toOracleSupplier } from '../lib/erpMapper.js';
import { validators } from '../lib/validators.js';

export const staffRouter = Router();
staffRouter.use(requireStaff());

async function nextVendorCode() {
  // Max existing number + 1 (unique constraint on code guards against races).
  const [{ max }] = await db.select({ max: sql<number>`coalesce(max(substring(${vendors.code} from 5)::int), 0)` }).from(vendors);
  return `VND-${String(Number(max) + 1).padStart(5, '0')}`;
}

async function sendInvite(v: { id: string; name: string; contactEmail: string; contactFirstName: string; inviteToken: string }) {
  const link = `${env.appBaseUrl}/onboard/${v.inviteToken}`;
  await sendMail(v.contactEmail, 'Invitation to register as a vendor',
    `Dear ${v.contactFirstName},\n\nYou have been invited to register ${v.name} as a vendor. Open the link below and sign in with the one-time code sent to this email address.`, link);
  return link;
}

staffRouter.get('/vendors', ah(async (req, res) => {
  const me = staff(req);
  const { q, status, mine } = req.query as Record<string, string | undefined>;
  const filters: SQL[] = [];
  if (status) filters.push(eq(vendors.status, status as VendorStatus));
  if (q) filters.push(or(ilike(vendors.name, `%${q}%`), ilike(vendors.code, `%${q}%`), ilike(vendors.contactEmail, `%${q}%`))!);
  if (mine === 'true') {
    // Resolve the queue first: raw column refs inside relational queries get re-aliased by Drizzle.
    const pending = await db.selectDistinct({ id: approvalSteps.vendorId }).from(approvalSteps)
      .where(and(eq(approvalSteps.status, 'PENDING'), eq(approvalSteps.role, me.role)));
    if (!pending.length) return res.json({ vendors: [], counts: {}, myQueue: 0 });
    filters.push(inArray(vendors.id, pending.map((p) => p.id)));
  }
  const rows = await db.query.vendors.findMany({
    where: filters.length ? and(...filters) : undefined,
    orderBy: desc(vendors.updatedAt),
    columns: { profile: false, inviteToken: false },
    with: { steps: { where: eq(approvalSteps.status, 'PENDING'), columns: { label: true, role: true } }, createdBy: { columns: { name: true } } },
  });
  const counts = await db.select({ status: vendors.status, n: count() }).from(vendors).groupBy(vendors.status);
  const [{ myQueue }] = await db.select({ myQueue: count() }).from(approvalSteps).where(and(eq(approvalSteps.status, 'PENDING'), eq(approvalSteps.role, me.role)));
  res.json({
    vendors: rows.map(({ steps, ...v }) => ({ ...v, pendingStep: steps[0] ?? null })),
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    myQueue,
  });
}));

const createSchema = z.object({
  name: z.string().min(2, 'Vendor name is required'),
  vendorType: z.enum(['DOMESTIC', 'IMPORT', 'GOVERNMENT']),
  contactFirstName: z.string().min(1, 'First name is required'),
  contactLastName: z.string().min(1, 'Last name is required'),
  contactEmail: z.string().email('Enter a valid email'),
  contactMobile: z.string().refine((v) => !validators.phone(v), 'Enter a valid mobile number'),
  notify: z.boolean().default(true),
});

staffRouter.post('/vendors', requireStaff('ADMIN'), ah(async (req, res) => {
  const me = staff(req);
  const input = createSchema.parse(req.body);
  const dup = await db.query.vendors.findFirst({ where: and(sql`lower(${vendors.name}) = lower(${input.name})`, ne(vendors.status, 'REJECTED')) });
  if (dup) throw new HttpError(409, `A vendor named "${dup.name}" already exists (${dup.code})`);
  const { notify, ...data } = input;
  const [vendor] = await db.insert(vendors).values({
      ...data,
      contactEmail: data.contactEmail.toLowerCase(),
      code: await nextVendorCode(),
      inviteToken: crypto.randomBytes(24).toString('base64url'),
      createdById: me.userId,
      profile: {
        basic: {
          vendorName: data.name,
          supplierCountry: data.vendorType === 'IMPORT' ? '' : 'India',
          contactName: `${data.contactFirstName} ${data.contactLastName}`,
          contactEmail: data.contactEmail.toLowerCase(),
          contactMobile: data.contactMobile,
        },
        bank: { bankCountry: data.vendorType === 'IMPORT' ? '' : 'India' },
      },
  }).returning();
  await audit(vendor.id, me.name, 'VENDOR_CREATED', { vendorType: data.vendorType });
  let inviteLink: string | undefined;
  if (notify) {
    inviteLink = await sendInvite(vendor);
    await audit(vendor.id, me.name, 'INVITE_SENT', { to: vendor.contactEmail });
  }
  res.status(201).json({ vendor, inviteLink });
}));

staffRouter.post('/vendors/:id/invite', requireStaff('ADMIN'), ah(async (req, res) => {
  const me = staff(req);
  const v = await findVendor(req.params.id);
  if (!v) throw new HttpError(404, 'Vendor not found');
  if (!['INVITED', 'IN_PROGRESS', 'SENT_BACK'].includes(v.status)) throw new HttpError(409, 'Vendor has already submitted');
  const inviteLink = await sendInvite(v);
  await audit(v.id, me.name, 'INVITE_SENT', { to: v.contactEmail });
  res.json({ inviteLink });
}));

staffRouter.get('/vendors/:id', ah(async (req, res) => {
  const v = await db.query.vendors.findFirst({
    where: eq(vendors.id, req.params.id),
    with: {
      documents: { orderBy: desc(documents.uploadedAt) },
      steps: { orderBy: [desc(approvalSteps.cycle), asc(approvalSteps.level)], with: { actedBy: { columns: { name: true } } } },
      audit: { orderBy: desc(auditLogs.createdAt) },
      createdBy: { columns: { name: true } },
    },
  });
  if (!v) throw new HttpError(404, 'Vendor not found');
  const profile = v.profile as Profile;
  const checklist = buildChecklist(profile, v.documents.map((d) => d.docType));
  const me = staff(req);
  const pending = v.steps.find((s) => s.status === 'PENDING' && s.cycle === v.reviewCycle);
  const { inviteToken, ...rest } = v;
  res.json({
    vendor: { ...rest, inviteLink: me.role === 'ADMIN' ? `${env.appBaseUrl}/onboard/${inviteToken}` : undefined },
    checklist, docRequirements: visibleDocRequirements(profile),
    canAct: !!pending && pending.role === me.role,
  });
}));

staffRouter.post('/vendors/:id/decision', ah(async (req, res) => {
  const me = staff(req);
  const { action, remarks } = z.object({ action: z.enum(['APPROVE', 'SEND_BACK', 'REJECT']), remarks: z.string().default('') }).parse(req.body);
  const result = await decide(req.params.id, { id: me.userId, name: me.name, role: me.role, email: me.email }, action, remarks);
  res.json(result);
}));

staffRouter.get('/vendors/:id/erp-export', ah(async (req, res) => {
  const v = await findVendor(req.params.id);
  if (!v) throw new HttpError(404, 'Vendor not found');
  if (v.status !== 'APPROVED') throw new HttpError(409, 'Only approved vendors can be exported to the ERP');
  res.json(toOracleSupplier(v, { orgId: typeof req.query.orgId === 'string' ? req.query.orgId : undefined }));
}));
