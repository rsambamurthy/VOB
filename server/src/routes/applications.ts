/**
 * Self-registration. Public: /api/apply/:slug (the "Become a supplier" page, no sign-in). Staff:
 * /api/staff/applications (screen: accept or decline — vendors.create) and /api/staff/registration-links
 * (set up links and their QR codes — config.manage). Rules in services/applications.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import QRCode from 'qrcode';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { sensitiveLimiter } from '../lib/rateLimits.js';
import { acceptApplication, apply, applyUrl, createLink, declineApplication, listApplications, listLinks, pendingCount, publicPage, resendCode, updateLink, verify } from '../services/applications.js';

/* ---------- Public page ---------- */

export const applyRouter = Router();

applyRouter.get('/:slug', ah(async (req, res) => { res.json(await publicPage(req.params.slug)); }));
applyRouter.post('/:slug', sensitiveLimiter, ah(async (req, res) => {
  res.status(201).json(await apply(req.params.slug, req.body, { ip: req.ip, userAgent: req.get('user-agent') }));
}));
applyRouter.post('/:slug/:id/verify', sensitiveLimiter, ah(async (req, res) => {
  const { code } = z.object({ code: z.string().trim().min(4).max(10) }).parse(req.body);
  res.json(await verify(req.params.slug, req.params.id, code));
}));
applyRouter.post('/:slug/:id/resend', sensitiveLimiter, ah(async (req, res) => { res.json(await resendCode(req.params.slug, req.params.id)); }));

/* ---------- Screening applications ---------- */

export const applicationsRouter = Router();
const actor = (req: Parameters<typeof staffCtx>[0]) => { const s = staffCtx(req); return { id: s.user.id, name: s.user.name, ip: req.ip }; };

applicationsRouter.get('/', requireStaff('vendors.create'), ah(async (req, res) => {
  const status = z.enum(['PENDING', 'ACCEPTED', 'DECLINED']).catch('PENDING').parse(req.query.status);
  res.json(await listApplications(staffCtx(req).tenant, status));
}));
applicationsRouter.get('/count', requireStaff('vendors.create'), ah(async (req, res) => { res.json({ pending: await pendingCount(staffCtx(req).tenant.id) }); }));
applicationsRouter.post('/:id/accept', requireStaff('vendors.create'), ah(async (req, res) => {
  const o = z.object({ name: z.string().trim().max(200).optional(), vendorType: z.enum(['DOMESTIC', 'IMPORT', 'GOVERNMENT']).optional() }).parse(req.body);
  const v = await acceptApplication(staffCtx(req).tenant, req.params.id, o, actor(req));
  res.json({ vendor: { id: v.id, code: v.code, name: v.name } });
}));
applicationsRouter.post('/:id/decline', requireStaff('vendors.create'), ah(async (req, res) => {
  const { reason, notify } = z.object({ reason: z.string().trim().max(1000).default(''), notify: z.boolean().default(true) }).parse(req.body);
  await declineApplication(staffCtx(req).tenant, req.params.id, reason, notify, actor(req));
  res.json({ ok: true });
}));

/* ---------- Registration links ---------- */

export const registrationLinksRouter = Router();
const linkSchema = z.object({
  name: z.string().trim().min(2, 'Give the link a name').max(100),
  vendorType: z.enum(['DOMESTIC', 'IMPORT', 'GOVERNMENT']).nullable().optional(),
  intro: z.string().trim().max(1000).nullable().optional(),
  notifyEmails: z.string().trim().max(500).nullable().optional().refine((v) => !v || v.split(/[,;\s]+/).filter(Boolean).every((e) => z.string().email().safeParse(e).success), 'Enter email addresses separated by commas'),
});

registrationLinksRouter.get('/', requireStaff('config.manage'), ah(async (req, res) => { res.json(await listLinks(staffCtx(req).tenant.id)); }));
registrationLinksRouter.post('/', requireStaff('config.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const l = await createLink(s.tenant.id, linkSchema.parse(req.body), { name: s.user.name, ip: req.ip });
  res.status(201).json({ ...l, url: applyUrl(l.slug) });
}));
registrationLinksRouter.put('/:id', requireStaff('config.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const patch = linkSchema.partial().extend({ active: z.boolean().optional() }).parse(req.body);
  res.json(await updateLink(s.tenant.id, req.params.id, patch, { name: s.user.name, ip: req.ip }));
}));
/** QR code of the link, to print on a stand, brochure or invoice (PNG, or SVG with ?format=svg). */
registrationLinksRouter.get('/:id/qr', requireStaff('config.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const l = await db.query.registrationLinks.findFirst({ where: and(eq(schema.registrationLinks.tenantId, s.tenant.id), eq(schema.registrationLinks.id, req.params.id)) });
  if (!l) throw new HttpError(404, 'Link not found');
  const name = `Become a supplier - ${l.name}`.replace(/[^\w .-]/g, '');
  if (req.query.format === 'svg') {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.svg"`);
    return res.send(await QRCode.toString(applyUrl(l.slug), { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }));
  }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${name}.png"`);
  res.send(await QRCode.toBuffer(applyUrl(l.slug), { width: 600, margin: 2, errorCorrectionLevel: 'M' }));
}));
