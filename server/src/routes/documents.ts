import { Router } from 'express';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { env } from '../lib/env.js';

export const documentsRouter = Router();

/** Staff can open any document; a vendor only its own. Token may be passed as ?token= for <a href>. */
documentsRouter.get('/:id', ah(async (req, res) => {
  const p = req.principal;
  if (!p) throw new HttpError(401, 'Login required');
  const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, req.params.id) });
  if (!doc || (p.kind === 'vendor' && p.vendorId !== doc.vendorId)) throw new HttpError(404, 'Document not found');
  res.setHeader('Content-Type', doc.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.fileName)}"`);
  res.sendFile(path.resolve(env.uploadDir, doc.storagePath));
}));
