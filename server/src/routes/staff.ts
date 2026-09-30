/** Buyer-side vendor management. Every query is scoped by the signed-in user's tenant. */
import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { and, asc, count, desc, eq, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import type { VendorStatus } from '../db/schema.js';
import { ah, HttpError } from '../lib/http.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mailer.js';
import { env } from '../lib/env.js';
import { buildChecklist, visibleDocRequirements, type Profile } from '../lib/profileEngine.js';
import { decide } from '../services/workflowEngine.js';
import { toOracleSupplier } from '../lib/erpMapper.js';
import { validators } from '../lib/validators.js';

const { vendors, approvalSteps, documents, auditLogs } = schema;
export const staffRouter = Router();

const findVendor = (tenantId: string, id: string) => db.query.vendors.findFirst({ where: and(eq(vendors.tenantId, tenantId), eq(vendors.id, id)) });

async function nextVendorCode(tenantId: string) {
  const [{ max }] = await db.select({ max: sql<number>`coalesce(max(substring(${vendors.code} from 5)::int), 0)` }).from(vendors).where(eq(vendors.tenantId, tenantId));
  return `VND-${String(Number(max) + 1).padStart(5, '0')}`;
}

async function sendInvite(tenantName: string, v: { tenantId: string; name: string; contactEmail: string; contactFirstName: string; inviteToken: string }) {
  const link = `${env.appBaseUrl}/onboard/${v.inviteToken}`;
  await sendMail({ tenantId: v.tenantId, to: v.contactEmail, subject: `${tenantName}: invitation to register as a vendor`,
    body: `Dear ${v.contactFirstName},\n\n${tenantName} has invited you to register ${v.name} as a vendor. Open the link below and sign in with the one-time code sent to this email address.`, link });
  return link;
}

staffRouter.get('/vendors', requireStaff('vendors.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { q, status, mine } = req.query as Record<string, string | undefined>;
  const filters: SQL[] = [eq(vendors.tenantId, s.tenant.id)];
  if (status) filters.push(eq(vendors.status, status as VendorStatus));
  if (q) filters.push(or(ilike(vendors.name, `%${q}%`), ilike(vendors.code, `%${q}%`), ilike(vendors.contactEmail, `%${q}%`))!);
  const myRoleIds = [...s.roleIds];
  const pendingForMe = myRoleIds.length
    ? await db.selectDistinct({ id: approvalSteps.vendorId }).from(approvalSteps)
      .where(and(eq(approvalSteps.tenantId, s.tenant.id), eq(approvalSteps.status, 'PENDING'), inArray(approvalSteps.roleId, myRoleIds)))
    : [];
  if (mine === 'true') {
    if (!pendingForMe.length) return res.json({ vendors: [], counts: {}, myQueue: 0 });
    filters.push(inArray(vendors.id, pendingForMe.map((p) => p.id)));
  }
  const rows = await db.query.vendors.findMany({
    where: and(...filters), orderBy: desc(vendors.updatedAt), limit: 500,
    columns: { profile: false, inviteToken: false },
    with: { steps: { where: eq(approvalSteps.status, 'PENDING'), columns: { label: true, roleId: true } }, createdBy: { columns: { name: true } } },
  });
  const counts = await db.select({ status: vendors.status, n: count() }).from(vendors).where(eq(vendors.tenantId, s.tenant.id)).groupBy(vendors.status);
  res.json({
    vendors: rows.map(({ steps, ...v }) => ({ ...v, pendingStep: steps[0] ? { label: steps[0].label, mine: s.roleIds.has(steps[0].roleId) } : null })),
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    myQueue: pendingForMe.length,
  });
}));

const createSchema = z.object({
  name: z.string().trim().min(2, 'Vendor name is required').max(200),
  vendorType: z.enum(['DOMESTIC', 'IMPORT', 'GOVERNMENT']),
  contactFirstName: z.string().trim().min(1, 'First name is required').max(100),
  contactLastName: z.string().trim().min(1, 'Last name is required').max(100),
  contactEmail: z.string().trim().email('Enter a valid email'),
  contactMobile: z.string().trim().refine((v) => !validators.phone(v), 'Enter a valid mobile number'),
  notify: z.boolean().default(true),
});

staffRouter.post('/vendors', requireStaff('vendors.create'), ah(async (req, res) => {
  const s = staffCtx(req);
  const input = createSchema.parse(req.body);
  const dup = await db.query.vendors.findFirst({ where: and(eq(vendors.tenantId, s.tenant.id), sql`lower(${vendors.name}) = lower(${input.name})`, ne(vendors.status, 'REJECTED')) });
  if (dup) throw new HttpError(409, `A vendor named "${dup.name}" already exists (${dup.code})`);
  const { notify, ...data } = input;
  const email = data.contactEmail.toLowerCase();
  const [vendor] = await db.insert(vendors).values({
    ...data, tenantId: s.tenant.id, contactEmail: email,
    code: await nextVendorCode(s.tenant.id),
    inviteToken: crypto.randomBytes(24).toString('base64url'),
    createdById: s.user.id,
    profile: {
      basic: { vendorName: data.name, supplierCountry: data.vendorType === 'IMPORT' ? '' : 'India', contactName: `${data.contactFirstName} ${data.contactLastName}`, contactEmail: email, contactMobile: data.contactMobile },
      bank: { bankCountry: data.vendorType === 'IMPORT' ? '' : 'India' },
    },
  }).returning();
  await audit({ tenantId: s.tenant.id, vendorId: vendor.id, actor: s.user.name, action: 'VENDOR_CREATED', detail: { vendorType: data.vendorType }, ip: req.ip });
  if (notify) {
    await sendInvite(s.tenant.name, vendor);
    await audit({ tenantId: s.tenant.id, vendorId: vendor.id, actor: s.user.name, action: 'INVITE_SENT', detail: { to: vendor.contactEmail }, ip: req.ip });
  }
  res.status(201).json({ vendor: { id: vendor.id, code: vendor.code } });
}));

staffRouter.post('/vendors/:id/invite', requireStaff('vendors.create'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await findVendor(s.tenant.id, req.params.id);
  if (!v) throw new HttpError(404, 'Vendor not found');
  if (!['INVITED', 'IN_PROGRESS', 'SENT_BACK'].includes(v.status)) throw new HttpError(409, 'Vendor has already submitted');
  await sendInvite(s.tenant.name, v);
  await audit({ tenantId: s.tenant.id, vendorId: v.id, actor: s.user.name, action: 'INVITE_SENT', detail: { to: v.contactEmail }, ip: req.ip });
  res.json({ ok: true });
}));

staffRouter.get('/vendors/:id', requireStaff('vendors.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await db.query.vendors.findFirst({
    where: and(eq(vendors.tenantId, s.tenant.id), eq(vendors.id, req.params.id)),
    with: {
      documents: { orderBy: desc(documents.uploadedAt) },
      steps: { orderBy: [desc(approvalSteps.cycle), asc(approvalSteps.level)], with: { actedBy: { columns: { name: true } }, role: { columns: { name: true } } } },
      audit: { orderBy: desc(auditLogs.createdAt), limit: 200 },
      createdBy: { columns: { name: true } },
    },
  });
  if (!v) throw new HttpError(404, 'Vendor not found');
  const profile = v.profile as Profile;
  const pending = v.steps.find((st) => st.status === 'PENDING' && st.cycle === v.reviewCycle);
  const { inviteToken, ...rest } = v;
  const canInvite = s.permissions.has('vendors.create');
  res.json({
    vendor: { ...rest, steps: rest.steps.map(({ role, ...st }) => ({ ...st, roleName: role?.name })), inviteLink: canInvite && env.devShowOtp ? `${env.appBaseUrl}/onboard/${inviteToken}` : undefined },
    checklist: buildChecklist(profile, v.documents.map((d) => d.docType)),
    docRequirements: visibleDocRequirements(profile),
    canAct: !!pending && s.roleIds.has(pending.roleId),
    canInvite,
    canExport: s.permissions.has('vendors.export'),
  });
}));

staffRouter.post('/vendors/:id/decision', requireStaff(), ah(async (req, res) => {
  const s = staffCtx(req);
  const { action, remarks } = z.object({ action: z.enum(['APPROVE', 'SEND_BACK', 'REJECT']), remarks: z.string().max(2000).default('') }).parse(req.body);
  res.json(await decide(s.tenant.id, req.params.id, { id: s.user.id, name: s.user.name, roleIds: s.roleIds }, action, remarks, req.ip));
}));

staffRouter.get('/vendors/:id/erp-export', requireStaff('vendors.export'), ah(async (req, res) => {
  const s = staffCtx(req);
  const v = await findVendor(s.tenant.id, req.params.id);
  if (!v) throw new HttpError(404, 'Vendor not found');
  if (v.status !== 'APPROVED') throw new HttpError(409, 'Only approved vendors can be exported to the ERP');
  await audit({ tenantId: s.tenant.id, vendorId: v.id, actor: s.user.name, action: 'ERP_EXPORTED', ip: req.ip });
  res.json(toOracleSupplier(v, { orgId: typeof req.query.orgId === 'string' ? req.query.orgId : undefined }));
}));
