import { Router } from 'express';
import { asc, desc } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { env } from '../lib/env.js';
import { formSchema, documentRequirements, vendorTypes, onboardingGuide } from '../config/formSchema.js';
import { workflowLevels, roleLabels } from '../config/workflow.js';

export const metaRouter = Router();

metaRouter.get('/', ah(async (_req, res) => {
  // Staff list is exposed only for the prototype's login picker.
  const { users: u } = schema;
  const users = await db.select({ name: u.name, email: u.email, role: u.role }).from(u).orderBy(asc(u.role));
  res.json({ formSchema, documentRequirements, vendorTypes, onboardingGuide, workflowLevels, roleLabels, users });
}));

/** Prototype mailbox — lets you see invites, OTPs and notifications without an email provider. */
metaRouter.get('/outbox', ah(async (_req, res) => {
  if (!env.devShowOtp) throw new HttpError(404, 'Mailbox is disabled (DEV_SHOW_OTP=false)');
  res.json(await db.select().from(schema.emailOutbox).orderBy(desc(schema.emailOutbox.createdAt)).limit(100));
}));
