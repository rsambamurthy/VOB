import { Router } from 'express';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { env } from '../lib/env.js';

export const documentsRouter = Router();

/**
 * Staff (with vendors.view) can open any document in their workspace; a vendor only its own.
 * Authentication is by session cookie, so plain <a href> links work.
 */
documentsRouter.get('/:id', ah(async (req, res) => {
  const { documents } = schema;
  let where;
  if (req.staff && !req.staff.mfaPending && req.staff.permissions.has('vendors.view')) {
    where = and(eq(documents.id, req.params.id), eq(documents.tenantId, req.staff.tenant.id));
  } else if (req.vendor) {
    where = and(eq(documents.id, req.params.id), eq(documents.tenantId, req.vendor.tenant.id), eq(documents.vendorId, req.vendor.vendorId));
  } else {
    throw new HttpError(401, 'Please sign in');
  }
  const doc = await db.query.documents.findFirst({ where });
  if (!doc) throw new HttpError(404, 'Document not found');
  res.setHeader('Content-Type', doc.mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.fileName)}"`);
  res.sendFile(path.resolve(env.uploadDir, doc.storagePath));
}));
