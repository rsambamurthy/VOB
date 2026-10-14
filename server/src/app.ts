import { sql } from 'drizzle-orm';
import { db } from './lib/db.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
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
import { csrfGuard, loadSessions, supportReadOnly } from './auth/session.js';
import { loadPlatformSession } from './platform/session.js';
import { platformRouter } from './platform/routes.js';
import { signupRouter } from './platform/signup.js';
import { ordersRouter } from './routes/orders.js';
import { supplierOrdersRouter } from './routes/supplierOrders.js';
import { staffCollabRouter, supplierCollabRouter } from './routes/collab.js';
import { erpApiRouter } from './routes/erpApi.js';
import { staffAuthRouter } from './routes/staffAuth.js';
import { vendorAuthRouter } from './routes/vendorAuth.js';
import { metaRouter } from './routes/meta.js';
import { reportsRouter } from './routes/reports.js';
import { staffRouter } from './routes/staff.js';
import { adminRouter } from './routes/admin.js';
import { vendorRouter } from './routes/vendorPortal.js';
import { documentsRouter } from './routes/documents.js';
import { configRouter } from './routes/config.js';

import { handleResendEvent, verifySvix } from './integrations/email/resend.js';
import { handleRazorpayEvent, verifyRazorpaySignature } from './services/billing.js';
import { billingRouter } from './routes/billing.js';
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
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:', 'https:'],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': env.isProd ? [] : null,
      },
    },
  }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => !req.url?.startsWith('/api') || req.url === '/api/health' } }));
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
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Used by Railway / load balancers: 200 only when the database answers.
  app.get('/api/health', async (_req, res) => {
    try { await db.execute(sql`select 1`); res.json({ ok: true }); }
    catch { res.status(503).json({ ok: false, error: 'database unavailable' }); }
  });
  app.use('/api', apiLimiter, csrfGuard, loadSessions, supportReadOnly, loadPlatformSession);
  app.use('/api/platform', platformRouter);
  app.use('/api/signup', signupRouter);
  app.use('/api/auth', staffAuthRouter);
  app.use('/api/vendor-auth', vendorAuthRouter);
  app.use('/api/meta', metaRouter);
  app.use('/api/staff', staffRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/help', helpRouter);
  app.use('/api/admin/billing', billingRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/v1', erpApiRouter);
  app.use('/api/vendor/orders', supplierOrdersRouter);
  app.use('/api/vendor/collab', supplierCollabRouter);
  app.use('/api/vendor', vendorRouter);
  app.use('/api', ordersRouter);
  app.use('/api', staffCollabRouter);
  app.use('/api/documents', documentsRouter);
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
    const lang = req.get('x-lang') === 'ar' && /^\/api\/(vendor|vendor-auth|help|documents)(\/|$)/.test(req.originalUrl) ? 'ar' : 'en';
    const tx = (s: string) => translateMessage(s, lang);
    const txDetails = (d: unknown) => (lang === 'en' || !Array.isArray(d) ? d : d.map((x) => (x && typeof x === 'object' ? { ...x, ...('message' in x && typeof x.message === 'string' ? { message: tx(x.message) } : {}), ...('label' in x && typeof x.label === 'string' ? { label: tx(x.label) } : {}) } : x)));
    if (err instanceof ZodError) return res.status(400).json({ error: tx(err.issues[0]?.message ?? 'Invalid input'), details: txDetails(err.issues) });
    if (err instanceof HttpError) return res.status(err.status).json({ error: tx(err.message), details: txDetails(err.details), code: err.code });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: tx(err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 5 MB' : err.message) });
    req.log?.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'Something went wrong' });
  });
  return app;
}
