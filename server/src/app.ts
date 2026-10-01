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
import { csrfGuard, loadSessions } from './auth/session.js';
import { staffAuthRouter } from './routes/staffAuth.js';
import { vendorAuthRouter } from './routes/vendorAuth.js';
import { metaRouter } from './routes/meta.js';
import { staffRouter } from './routes/staff.js';
import { adminRouter } from './routes/admin.js';
import { vendorRouter } from './routes/vendorPortal.js';
import { documentsRouter } from './routes/documents.js';
import { configRouter } from './routes/config.js';

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
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', apiLimiter, csrfGuard, loadSessions);
  app.use('/api/auth', staffAuthRouter);
  app.use('/api/vendor-auth', vendorAuthRouter);
  app.use('/api/meta', metaRouter);
  app.use('/api/staff', staffRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/vendor', vendorRouter);
  app.use('/api/documents', documentsRouter);
  app.use('/api', configRouter);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  // In production the API also serves the built web app.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(webDist) && !env.isTest) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ error: err.issues[0]?.message ?? 'Invalid input', details: err.issues });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details, code: err.code });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 5 MB' : err.message });
    req.log?.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'Something went wrong' });
  });
  return app;
}
