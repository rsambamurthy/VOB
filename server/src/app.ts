import { sql } from 'drizzle-orm';
import { db } from './lib/db.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { moduleGuard } from './lib/modules.js';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import multer from 'multer';
import { env } from './lib/env.js';
import { logger } from './lib/logger.js';
import { HttpError } from './lib/http.js';
import { apiLimiter } from './lib/rateLimits.js';
import { csrfGuard, licenceGuard, loadSessions, supportReadOnly } from './auth/session.js';
import { licenceRouter } from './routes/licence.js';
import { loadPlatformSession } from './platform/session.js';
import { platformRouter } from './platform/routes.js';
import { signupRouter } from './platform/signup.js';
import { ordersRouter } from './routes/orders.js';
import { supplierOrdersRouter } from './routes/supplierOrders.js';
import { staffCollabRouter, supplierCollabRouter } from './routes/collab.js';
import { erpApiRouter } from './routes/erpApi.js';
import { staffAuthRouter } from './routes/staffAuth.js';
import { ssoRouter } from './routes/sso.js';
import { scimRouter } from './routes/scim.js';
import { scorecardsRouter } from './routes/scorecards.js';
import { assistRouter } from './routes/assist.js';
import { vendorImportRouter } from './routes/vendorImport.js';
import { vendorAuthRouter } from './routes/vendorAuth.js';
import { metaRouter } from './routes/meta.js';
import { reportsRouter } from './routes/reports.js';
import { staffRouter } from './routes/staff.js';
import { adminRouter } from './routes/admin.js';
import { vendorRouter } from './routes/vendorPortal.js';
import { documentsRouter } from './routes/documents.js';
import { agreementsRouter } from './routes/agreements.js';
import { questionnairesRouter } from './routes/questionnaires.js';
import { riskRouter } from './routes/risk.js';
import { actionsRouter } from './routes/correctiveActions.js';
import { esignRouter, reviewRouter } from './routes/contractReview.js';
import { contractLibraryRouter, contractsAdminRouter, contractsRouter, partiesRouter } from './routes/contracts.js';
import { invoicesAdminRouter, invoicesRouter } from './routes/invoices.js';
import { apiKeysRouter } from './routes/apiKeys.js';
import { invoicesOn } from './services/invoices/config.js';
import { hasFeature } from './services/limits.js';
import { sourcingAdminRouter, sourcingRouter } from './routes/sourcing.js';
import { applicationsRouter, applyRouter, registrationLinksRouter } from './routes/applications.js';
import { configRouter } from './routes/config.js';

import { handleResendEvent, verifySvix } from './integrations/email/resend.js';
import { handleRazorpayEvent, verifyRazorpaySignature } from './services/billing.js';
import { billingRouter } from './routes/billing.js';
import { askRouter } from './routes/ask.js';
import { helpRouter } from './routes/help.js';
import { translateMessage } from './i18n/index.js';

export function createApp() {
  const app = express();
  if (env.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'font-src': ["'self'", 'data:'],
        'img-src': ["'self'", 'data:', 'https:'],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': env.isProd ? [] : null,
      },
    },
  }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => !req.url?.startsWith('/api') || req.url === '/api/health' } }));
  // E-signature provider webhooks and signers coming back from the provider: raw body, before JSON parsing and CSRF.
  app.use('/api/esign', esignRouter);
  // Email provider webhooks (bounces, complaints, deliveries): raw body for the signature check, before JSON parsing and CSRF.
  app.post('/api/webhooks/resend', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
    const secret = env.int.RESEND_WEBHOOK_SECRET;
    if (!secret) return res.status(404).json({ error: 'Not configured' });
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!verifySvix(req.headers, body, secret)) return res.status(401).json({ error: 'Bad signature' });
    try { res.json({ ok: true, result: await handleResendEvent(JSON.parse(body)) }); }
    catch (e) { logger.warn({ err: String(e) }, 'resend webhook failed'); res.status(400).json({ error: 'Could not process event' }); }
  });
  app.post('/api/webhooks/razorpay', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
    const secret = env.int.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return res.status(404).json({ error: 'Not configured' });
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    if (!verifyRazorpaySignature(body, String(req.headers['x-razorpay-signature'] ?? ''), secret)) return res.status(401).json({ error: 'Bad signature' });
    try { res.json({ ok: true, result: await handleRazorpayEvent(JSON.parse(body)) }); }
    catch (e) { logger.warn({ err: String(e) }, 'razorpay webhook failed'); res.status(400).json({ error: 'Could not process event' }); }
  });
  // NUL characters can't be stored in Postgres text; drop them from JSON bodies and query strings instead of failing with a 500.
  const noNul = (v: unknown): unknown => (typeof v === 'string' ? v.replace(/\u0000/g, '') : Array.isArray(v) ? v.map(noNul) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, noNul(x)])) : v);
  app.use(express.json({ limit: '1mb', reviver: (_k, v) => (typeof v === 'string' ? v.replace(/\u0000/g, '') : v) }));
  app.use((req, _res, next) => { if (req.url.includes('%00')) Object.defineProperty(req, 'query', { value: noNul(req.query), writable: true, configurable: true }); next(); });
  app.use(cookieParser());

  // Used by Railway / load balancers: 200 only when the database answers.
  app.get('/api/health', async (_req, res) => {
    try { await db.execute(sql`select 1`); res.json({ ok: true, version: env.version, mode: env.onPrem ? 'onprem' : 'cloud' }); }
    catch { res.status(503).json({ ok: false, error: 'database unavailable' }); }
  });
  // API answers carry personal and commercial data: never stored by browsers or shared caches. (Files set their own.)
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', apiLimiter, csrfGuard, loadSessions, supportReadOnly, licenceGuard, loadPlatformSession, moduleGuard);
  // On-prem: one customer's installation — no platform console, self-service sign-up or subscription billing.
  if (env.onPrem) for (const path of ['/api/platform', '/api/signup', '/api/admin/billing']) app.use(path, (_req, _res, next) => next(new HttpError(404, 'Not available in this installation', undefined, 'NOT_ONPREM')));
  app.use('/api/admin/licence', licenceRouter);
  app.use('/api/platform', platformRouter);
  app.use('/api/signup', signupRouter);
  app.use('/api/auth/sso', ssoRouter);
  app.use('/api/scim/v2', scimRouter);
  app.use('/api/auth', staffAuthRouter);
  app.use('/api/vendor-auth', vendorAuthRouter);
  app.use('/api/apply', applyRouter);
  app.use('/api/meta', metaRouter);
  app.use('/api/staff/vendors/:id/assist', assistRouter);
  app.use('/api/staff/vendor-import', vendorImportRouter);
  app.use('/api/staff/applications', applicationsRouter);
  app.use('/api/staff/risk', riskRouter);
  app.use('/api/staff/actions', actionsRouter);
  app.use('/api/staff/sourcing', sourcingRouter);
  app.use('/api/staff/contracts', contractsRouter);
  app.use('/api/staff/parties', partiesRouter);
  app.use('/api/staff/invoices', invoicesRouter);
  app.use('/api/staff/contract-library', contractLibraryRouter);
  app.use('/api/review', reviewRouter);
  app.use('/api/staff/registration-links', registrationLinksRouter);
  app.use('/api/staff', staffRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/scorecards', scorecardsRouter);
  app.use('/api/help', helpRouter);
  app.use('/api/ask', askRouter);
  app.use('/api/admin/billing', billingRouter);
  app.use('/api/admin/sourcing', sourcingAdminRouter);
  app.use('/api/admin/contracts', contractsAdminRouter);
  app.use('/api/admin/invoices', invoicesAdminRouter);
  // API keys for the ERP: Purchasing setup has them too; here for workspaces whose ERP talks to VendorGate for invoices.
  app.use('/api/admin/api-keys', (req, _res, next) => { const t = req.staff?.tenant; if (t && !hasFeature(t, 'collab') && !invoicesOn(t)) return next(new HttpError(404, 'Not found')); next(); }, apiKeysRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/v1', erpApiRouter);
  app.use('/api/vendor/orders', supplierOrdersRouter);
  app.use('/api/vendor/collab', supplierCollabRouter);
  app.use('/api/vendor', vendorRouter);
  app.use('/api', ordersRouter);
  app.use('/api', staffCollabRouter);
  app.use('/api/documents', documentsRouter);
  app.use('/api/agreements', agreementsRouter);
  app.use('/api/questionnaires', questionnairesRouter);
  app.use('/api', configRouter);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found', undefined, 'NO_ROUTE')));

  // In production the API also serves the built web app.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(webDist) && !env.isTest) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    // Supplier screens in Arabic send X-Lang: ar; their error messages come back in Arabic.
    const lang = req.get('x-lang') === 'ar' && /^\/api\/(vendor|vendor-auth|help|documents|agreements|apply)(\/|$)/.test(req.originalUrl) ? 'ar' : 'en';
    const tx = (s: string) => translateMessage(s, lang);
    const txDetails = (d: unknown) => (lang === 'en' || !Array.isArray(d) ? d : d.map((x) => (x && typeof x === 'object' ? { ...x, ...('message' in x && typeof x.message === 'string' ? { message: tx(x.message) } : {}), ...('label' in x && typeof x.label === 'string' ? { label: tx(x.label) } : {}) } : x)));
    // At most 20 problems back: a huge invalid body must not turn into a huge error response.
    if (err instanceof ZodError) return res.status(400).json({ error: tx(err.issues[0]?.message ?? 'Invalid input'), details: txDetails(err.issues.slice(0, 20)) });
    if (err instanceof HttpError) return res.status(err.status).json({ error: tx(err.message), details: txDetails(err.details), code: err.code });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: tx(err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 5 MB' : err.message) });
    // Request bodies that are too large or not valid JSON are the caller's mistake, not a server error.
    const bodyErr = err as { type?: string; status?: number };
    // An update with no fields to change (e.g. an empty PATCH) is a bad request.
    if (err instanceof Error && err.message === 'No values to set') return res.status(400).json({ error: tx('Nothing to change.') });
    if (bodyErr?.type === 'entity.too.large') return res.status(413).json({ error: tx('The request is too large.') });
    // A malformed address (e.g. /vendors/%ff) can't be decoded: Express marks it 400.
    if (err instanceof URIError || (bodyErr?.status === 400 && /decode param/i.test((err as Error)?.message ?? ''))) return res.status(400).json({ error: tx('The address is not valid.') });
    if (bodyErr?.type === 'entity.parse.failed' || bodyErr?.type === 'encoding.unsupported' || bodyErr?.type === 'charset.unsupported') return res.status(400).json({ error: tx('The request could not be read.') });
    req.log?.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'Something went wrong' });
  });
  return app;
}
