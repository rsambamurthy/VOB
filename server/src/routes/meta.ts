import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { env } from '../lib/env.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { vendorTypes } from '../config/types.js';

export const metaRouter = Router();

/** Static, tenant-independent lookups. Tenant config lives at /api/config. */
metaRouter.get('/', (_req, res) => { res.json({ vendorTypes }); });

/** Dev-only mailbox, scoped to the signed-in user's workspace. Disabled when DEV_SHOW_OTP=false. */
metaRouter.get('/outbox', requireStaff(), ah(async (req, res) => {
  if (!env.devShowOtp) throw new HttpError(404, 'Mailbox is disabled');
  const { tenant } = staffCtx(req);
  res.json(await db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.tenantId, tenant.id)).orderBy(desc(schema.emailOutbox.createdAt)).limit(100));
}));
