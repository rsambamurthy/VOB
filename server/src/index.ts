import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import multer from 'multer';
import { env } from './lib/env.js';
import { authenticate } from './lib/auth.js';
import { HttpError } from './lib/http.js';
import { authRouter } from './routes/auth.js';
import { metaRouter } from './routes/meta.js';
import { staffRouter } from './routes/staff.js';
import { vendorRouter } from './routes/vendorPortal.js';
import { documentsRouter } from './routes/documents.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(authenticate);

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);
app.use('/api/meta', metaRouter);
app.use('/api/staff', staffRouter);
app.use('/api/vendor', vendorRouter);
app.use('/api/documents', documentsRouter);
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

// In production the API also serves the built web app.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) return res.status(400).json({ error: err.issues[0]?.message ?? 'Invalid input', details: err.issues });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, details: err.details });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 5 MB' : err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(env.port, () => console.log(`API listening on http://localhost:${env.port}`));
