/**
 * The other party's side of a contract: one set of routes, mounted twice (CLAUDE.md "reuse, never duplicate"):
 *   /api/review/session/…            people signed in with the email link + code (cookie vg_c)
 *   /api/vendor/contracts/:contractId/…  onboarded suppliers in their supplier portal
 * Plus the email-link sign-in (/api/review/link/:token…) and the e-signature callbacks (/api/esign/…).
 */
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ah, HttpError } from '../lib/http.js';
import { env } from '../lib/env.js';
import { loginLimiter, sensitiveLimiter } from '../lib/rateLimits.js';
import { contractUpload } from '../lib/upload.js';
import { sendStoredFile } from '../integrations/storage/index.js';
import { linkInfo, partyComment, partyRespond, partyUpload, reviewerSession, reviewFile, reviewView, sendCode, verifyCode, vendorContracts, assertVendorContract, type ReviewCtx } from '../services/contracts/negotiation.js';
import { finishSigning, handleWebhook, startSigning } from '../services/contracts/signing.js';
import { contractsOn } from '../services/contracts/config.js';
import { db } from '../lib/db.js';
import type { VendorCtx } from '../auth/session.js';

export const REVIEW_COOKIE = 'vg_c';

/** The shared routes; `ctx` says who is looking at which contract, `back` where the browser returns after signing. */
export function reviewRoutes(router: Router, ctx: (req: Request) => Promise<ReviewCtx>, back: (req: Request, c: ReviewCtx) => string) {
  router.get('/', ah(async (req, res) => { res.json(await reviewView(await ctx(req))); }));
  router.get('/files/:fileId', ah(async (req, res) => { await sendStoredFile(res, await reviewFile(await ctx(req), req.params.fileId)); }));
  router.post('/comments', ah(async (req, res) => { const c = await ctx(req); await partyComment(c, req.body); res.status(201).json(await reviewView(c)); }));
  router.post('/upload', contractUpload.single('file'), ah(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Choose the file to upload');
    const c = await ctx(req); await partyUpload(c, req.file, String(req.body?.note ?? '')); res.status(201).json(await reviewView(c));
  }));
  router.post('/respond', ah(async (req, res) => { const c = await ctx(req); await partyRespond(c, req.body); res.json(await reviewView(c)); }));
  router.post('/sign', ah(async (req, res) => { const c = await ctx(req); res.json({ url: await startSigning(c.tenant, c.contractId, c.actor.email, back(req, c)) }); }));
}

/* ---------- email link + code ---------- */

export const reviewRouter = Router();
const cookieOpts = { httpOnly: true, secure: env.isProd, sameSite: 'lax' as const, path: '/', maxAge: 8 * 3_600_000 };
reviewRouter.get('/link/:token', ah(async (req, res) => { res.json(await linkInfo(req.params.token)); }));
reviewRouter.post('/link/:token/code', sensitiveLimiter, ah(async (req, res) => {
  const { language } = z.object({ language: z.enum(['en', 'ar']).optional() }).parse(req.body ?? {});
  res.json(await sendCode(req.params.token, language));
}));
reviewRouter.post('/link/:token/verify', loginLimiter, ah(async (req, res) => {
  const { code } = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }).parse(req.body);
  res.cookie(REVIEW_COOKIE, await verifyCode(req.params.token, code, req.ip), cookieOpts);
  res.json({ ok: true });
}));
reviewRouter.post('/sign-out', (_req: Request, res: Response) => { res.clearCookie(REVIEW_COOKIE, { path: '/' }); res.json({ ok: true }); });
const session = Router();
reviewRoutes(session, (req) => { const tok = req.cookies?.[REVIEW_COOKIE]; if (!tok) throw new HttpError(401, 'Please open the link from your email again.'); return reviewerSession(tok); }, () => '/review');
reviewRouter.use('/session', session);

/* ---------- supplier portal ---------- */

/** Mounted in vendorPortal: the supplier's contracts list, and each contract through the shared routes. */
export function supplierContractRoutes(vendorRouter: Router, vendorCtx: (req: Request) => VendorCtx) {
  vendorRouter.get('/contracts', ah(async (req, res) => {
    const v = vendorCtx(req);
    res.json({ contracts: contractsOn(v.tenant) ? await vendorContracts(v.tenant, v.vendorId) : [] });
  }));
  const one = Router({ mergeParams: true });
  reviewRoutes(one, async (req) => {
    const v = vendorCtx(req);
    const contractId = (req.params as { contractId: string }).contractId;
    if (!contractsOn(v.tenant)) throw new HttpError(404, 'Contract not found');
    await assertVendorContract(v.tenant, v.vendorId, contractId);
    const email = v.contactEmail ?? (await db.query.vendors.findFirst({ where: (x, { eq }) => eq(x.id, v.vendorId) }))?.contactEmail ?? '';
    return { tenant: v.tenant, contractId, actor: { name: email, email: email.toLowerCase() }, vendorId: v.vendorId };
  }, (req) => `/vendor/contracts/${(req.params as { contractId: string }).contractId}`);
  vendorRouter.use('/contracts/:contractId', one);
}

/* ---------- e-signature callbacks ---------- */

export const esignRouter = Router();
/** Provider webhooks (raw body, so signatures can be checked). Always 200 for known providers, so they don't retry forever. */
esignRouter.post('/webhook/:tenantId/:provider', express.raw({ type: '*/*', limit: '2mb' }), ah(async (req, res) => {
  const r = await handleWebhook(req.params.tenantId, req.params.provider, req.headers, Buffer.isBuffer(req.body) ? req.body : Buffer.from(''));
  for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
  res.status(r.ok ? 200 : 404).json({ ok: r.ok });
}));
/** Adobe checks a webhook URL with a GET that must echo its client id. */
esignRouter.get('/webhook/:tenantId/:provider', (req: Request, res: Response) => {
  const id = req.get('x-adobesign-clientid');
  if (id) res.setHeader('X-AdobeSign-ClientId', id);
  res.json({ ok: true });
});
/** The signer's browser comes back from a link provider (UAE PASS, Test). */
esignRouter.get('/return/:sigId/:nonce', ah(async (req, res) => {
  const to = await finishSigning(req.params.sigId, req.params.nonce, Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)])));
  res.redirect(303, to.startsWith('/') ? to : '/');
}));
