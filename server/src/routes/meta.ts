import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { env } from '../lib/env.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { formSchema, documentRequirements, vendorTypes, onboardingGuide } from '../config/formSchema.js';
import { workflowLevels } from '../config/workflow.js';

export const metaRouter = Router();

/** Onboarding form definition. (Phase 2: becomes per-tenant configuration.) */
metaRouter.get('/', ah(async (_req, res) => {
  res.json({ formSchema, documentRequirements, vendorTypes, onboardingGuide, workflowLevels: workflowLevels.map(({ label }) => ({ label })) });
}));

/** Dev-only mailbox, scoped to the signed-in user's workspace. Disabled when DEV_SHOW_OTP=false. */
metaRouter.get('/outbox', requireStaff(), ah(async (req, res) => {
  if (!env.devShowOtp) throw new HttpError(404, 'Mailbox is disabled');
  const { tenant } = staffCtx(req);
  res.json(await db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.tenantId, tenant.id)).orderBy(desc(schema.emailOutbox.createdAt)).limit(100));
}));
