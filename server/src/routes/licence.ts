/** Administration → Licence (on-prem): see the licence and install a new one. */
import { Router } from 'express';
import { z } from 'zod';
import { ah, HttpError } from '../lib/http.js';
import { env } from '../lib/env.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { licenceStatus } from '../lib/licence.js';
import { installLicence } from '../services/licence.js';
import { db, schema } from '../lib/db.js';
import { and, count, eq, isNull, ne } from 'drizzle-orm';

export const licenceRouter = Router();
licenceRouter.use((_req, _res, next) => next(env.onPrem ? undefined : new HttpError(404, 'Licences are only used in on-premises installations')));

licenceRouter.get('/', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const [users] = await db.select({ n: count() }).from(schema.users).where(and(eq(schema.users.tenantId, s.tenant.id), ne(schema.users.status, 'DISABLED')));
  const [vendors] = await db.select({ n: count() }).from(schema.vendors).where(and(eq(schema.vendors.tenantId, s.tenant.id), isNull(schema.vendors.erasedAt)));
  res.json({ ...licenceStatus(), usage: { users: Number(users.n), vendors: Number(vendors.n) }, version: env.version });
}));

licenceRouter.post('/', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { token } = z.object({ token: z.string().trim().min(20, 'Paste the licence, or choose the licence file').max(10_000) }).parse(req.body);
  res.json(await installLicence(token, { name: s.user.name, tenantId: s.tenant.id, ip: req.ip }));
}));
