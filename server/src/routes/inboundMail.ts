/**
 * Inbound email webhook (Invoices add-on email inbox): POST /api/inbound/email/<INBOUND_EMAIL_SECRET>.
 * Accepts raw MIME (message/rfc822 or text/plain), multipart (Mailgun / SendGrid, raw `email` / `body-mime` field or parsed
 * fields + files) and JSON (Postmark). The message goes to the workspace named in its invoices-<workspace>-<token>@ address.
 * Always answers 200 for messages that aren't ours (so providers don't retry forever); 401 for a wrong secret.
 */
import crypto from 'node:crypto';
import express, { Router } from 'express';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { inboundMailUpload } from '../lib/upload.js';
import { ingestMail, mailFromRequest, tenantForAddress } from '../services/invoices/inbox.js';

export const inboundMailRouter = Router();
const secretOk = (given: string) => {
  const want = env.int.INBOUND_EMAIL_SECRET;
  if (!want) return false;
  const a = Buffer.from(given), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
inboundMailRouter.post('/:secret',
  (req, res, next) => (secretOk(req.params.secret) ? next() : res.status(401).json({ error: 'Not allowed' })),
  express.raw({ type: ['message/rfc822', 'text/plain', 'application/octet-stream'], limit: '40mb' }),
  express.json({ limit: '40mb' }),
  express.urlencoded({ extended: false, limit: '40mb' }),
  (req, res, next) => (req.is('multipart/form-data') ? inboundMailUpload.any()(req, res, next) : next()),
  async (req, res) => {
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body : undefined;
      const mail = await mailFromRequest(raw ? {} : req.body, (req.files as Express.Multer.File[] | undefined) ?? [], raw);
      const t = await tenantForAddress(mail.to);
      if (!t) { logger.info({ to: mail.to.slice(0, 3) }, 'inbound email for no workspace'); return res.json({ ok: true, handled: false }); }
      const row = await ingestMail(t, mail, 'WEBHOOK');
      res.json({ ok: true, handled: true, status: row?.status, drafts: row?.invoiceIds.length ?? 0 });
    } catch (e) {
      logger.warn({ err: String(e) }, 'inbound email failed');
      res.status(400).json({ error: 'Could not read the message' });
    }
  });
