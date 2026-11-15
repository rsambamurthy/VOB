/** Supplier guide routes — mounted in the supplier portal and in the buyer's fill-in (same rules, services/guide.ts). */
import { type Request, type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import { ah } from '../lib/http.js';
import type { Tenant, Vendor } from '../db/schema.js';
import type { schema } from '../lib/db.js';
import type { Lang } from '../i18n/index.js';
import { askGuide, supplierGuide } from '../services/guide.js';

type VendorWithDocs = Vendor & { documents: (typeof schema.documents.$inferSelect)[] };

export function guideRoutes(router: Router, opts: {
  vendor: (req: Request) => Promise<VendorWithDocs>;
  tenant: (req: Request) => Tenant;
  lang: (req: Request, v: Vendor) => Lang;
  who: (req: Request, v: Vendor) => string;
  forStaff?: boolean;
  guard?: RequestHandler;
}) {
  const g = opts.guard ? [opts.guard] : [];
  router.get('/guide', ...g, ah(async (req, res) => {
    const v = await opts.vendor(req);
    res.json(await supplierGuide(opts.tenant(req), v, { lang: opts.lang(req, v), forStaff: opts.forStaff }));
  }));
  router.post('/guide/ask', ...g, ah(async (req, res) => {
    const input = z.object({
      question: z.string().trim().min(3, 'Type a question').max(500),
      articles: z.array(z.object({ id: z.string().max(80), title: z.string().max(200), summary: z.string().max(400).optional(), body: z.string().max(20000) })).max(8).default([]),
    }).parse(req.body);
    const v = await opts.vendor(req);
    res.json(await askGuide(opts.tenant(req), v, { ...input, who: opts.who(req, v), lang: opts.lang(req, v), forStaff: opts.forStaff }));
  }));
}
