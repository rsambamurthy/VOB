/**
 * Agreements: set up under Administration → Agreements (config.manage), and the two downloads both staff and
 * suppliers use — an agreement's PDF and an acceptance certificate. Accepting is in the portal
 * (routes/vendorPortal.ts) and, from a signed copy, in the buyer's fill-in (routes/assist.ts); the rules are
 * all in services/agreements.ts.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { upload } from '../lib/upload.js';
import { acceptanceCertificate, createAgreement, getAcceptance, listAgreements, publishVersion, updateAgreement, versionFile, type VersionInput } from '../services/agreements.js';

export const agreementsRouter = Router();

const TYPES = ['DOMESTIC', 'IMPORT', 'GOVERNMENT'] as const;
const flag = z.preprocess((v) => v === true || v === 'true' || v === '1' || v === 'on', z.boolean());
const types = z.preprocess((v) => (Array.isArray(v) ? v : typeof v === 'string' && v ? v.split(',') : []), z.array(z.enum(TYPES)));
const versionSchema = z.object({
  kind: z.enum(['TEXT', 'PDF']),
  body: z.string().max(100_000).optional(),
  bodyAr: z.string().max(100_000).optional(),
  changeNote: z.string().max(500).optional(),
  reaccept: flag.default(false),
});
const settingsSchema = z.object({
  title: z.string().trim().min(3, 'Give the agreement a name').max(150),
  titleAr: z.string().trim().max(150).optional(),
  vendorTypes: types.default([]),
  required: flag.default(true),
});
const versionInput = (req: Request): VersionInput => ({ ...versionSchema.parse(req.body), file: req.file ? { buffer: req.file.buffer, originalname: req.file.originalname } : undefined });

/* ---------- Administration → Agreements ---------- */

agreementsRouter.get('/', requireStaff('config.manage'), ah(async (req, res) => {
  res.json(await listAgreements(staffCtx(req).tenant.id));
}));

agreementsRouter.post('/', requireStaff('config.manage'), upload.single('file'), ah(async (req, res) => {
  const s = staffCtx(req);
  const ag = await createAgreement(s.tenant, settingsSchema.parse(req.body), versionInput(req), { name: s.user.name, ip: req.ip });
  res.status(201).json(ag);
}));

agreementsRouter.put('/:id', requireStaff('config.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const patch = settingsSchema.partial().extend({ sortOrder: z.number().int().optional() }).parse(req.body);
  await updateAgreement(s.tenant.id, req.params.id, { ...patch, ...(patch.titleAr !== undefined ? { titleAr: patch.titleAr || null } : {}) }, { name: s.user.name, ip: req.ip });
  res.json({ ok: true });
}));

agreementsRouter.post('/:id/versions', requireStaff('config.manage'), upload.single('file'), ah(async (req, res) => {
  const s = staffCtx(req);
  res.status(201).json(await publishVersion(s.tenant, req.params.id, versionInput(req), { name: s.user.name, ip: req.ip }));
}));

agreementsRouter.post('/:id/archive', requireStaff('config.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  await updateAgreement(s.tenant.id, req.params.id, { status: 'ARCHIVED' }, { name: s.user.name, ip: req.ip });
  res.json({ ok: true });
}));

agreementsRouter.post('/:id/restore', requireStaff('config.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  await updateAgreement(s.tenant.id, req.params.id, { status: 'ACTIVE' }, { name: s.user.name, ip: req.ip });
  res.json({ ok: true });
}));

/* ---------- Downloads for staff and suppliers (session cookie, so plain links work) ---------- */

/** Staff with vendors.view (or config.manage) see their workspace's; a supplier only its own workspace's agreements and acceptances. */
function who(req: Request) {
  if (req.staff && !req.staff.mfaPending && (req.staff.permissions.has('vendors.view') || req.staff.permissions.has('config.manage'))) return { tenantId: req.staff.tenant.id, tenant: req.staff.tenant };
  if (req.vendor) return { tenantId: req.vendor.tenant.id, tenant: req.vendor.tenant, vendorId: req.vendor.vendorId };
  throw new HttpError(401, 'Please sign in');
}
const sendPdf = (res: import('express').Response, bytes: Buffer, fileName: string, inline = true) => {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(fileName)}"`);
  res.end(bytes);
};

agreementsRouter.get('/versions/:versionId/file', ah(async (req, res) => {
  const { tenantId } = who(req);
  const { bytes, fileName } = await versionFile(tenantId, req.params.versionId);
  sendPdf(res, bytes, fileName);
}));

agreementsRouter.get('/acceptances/:id/certificate.pdf', ah(async (req, res) => {
  const w = who(req);
  const acc = await getAcceptance(w.tenantId, req.params.id, w.vendorId);
  const ag = await db.query.agreements.findFirst({ where: and(eq(schema.agreements.id, acc.agreementId), eq(schema.agreements.tenantId, w.tenantId)) });
  sendPdf(res, await acceptanceCertificate(acc, w.tenant), `Acceptance - ${ag?.title ?? 'agreement'} v${acc.version}.pdf`, false);
}));
