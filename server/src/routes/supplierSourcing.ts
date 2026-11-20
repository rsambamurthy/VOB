/** The bidder's side of sourcing in the supplier portal: my events, the event, accept/decline, questions, outside-bidder registration. */
import type { Request, Router } from 'express';
import { z } from 'zod';
import { ah, HttpError } from '../lib/http.js';
import type { Tenant, Vendor } from '../db/schema.js';
import { sourcingOn } from '../services/sourcing/config.js';
import { askQuestion, eventForBidder, myEvents, registerBidder, respond } from '../services/sourcing/bidders.js';
import { myOffers, submitOffer, uploadBidFile, withdrawOffer } from '../services/sourcing/submissions.js';
import { upload } from '../lib/upload.js';
import { bidderLive, placeBid } from '../services/sourcing/live.js';
import { subscribeLive } from '../lib/liveHub.js';
import { registrationIdFor } from '../services/applications.js';
import { getPublished } from '../services/config.js';

export function supplierSourcingRoutes(router: Router, opts: { vendor: (req: Request) => Promise<Vendor>; tenant: (req: Request) => Tenant; actor: (req: Request, v: Vendor) => { name: string; ip?: string }; lang: (req: Request, v: Vendor) => 'en' | 'ar' }) {
  const on = (req: Request) => { if (!sourcingOn(opts.tenant(req))) throw new HttpError(404, 'Not available'); };
  router.get('/events', ah(async (req, res) => {
    on(req);
    const v = await opts.vendor(req);
    const t = opts.tenant(req);
    // Outside bidders give the home country's registration number (GSTIN, CR…) in the bidder registration.
    const reg = v.bidderOnly && v.vendorType !== 'IMPORT' ? registrationIdFor(t, (await getPublished(t.id)).config) : null;
    res.json({ events: await myEvents(v), bidder: { bidderOnly: v.bidderOnly, registered: !v.bidderOnly || !!v.bidderRegisteredAt, registration: reg && { label: reg.label, placeholder: reg.placeholder } } });
  }));
  router.get('/events/:id', ah(async (req, res) => {
    on(req);
    const v = await opts.vendor(req);
    res.json(await eventForBidder(opts.tenant(req), v, req.params.id, opts.lang(req, v)));
  }));
  router.post('/events/:id/response', ah(async (req, res) => {
    on(req);
    const v = await opts.vendor(req);
    await respond(opts.tenant(req), v, req.params.id, req.body, opts.actor(req, v));
    res.json(await eventForBidder(opts.tenant(req), v, req.params.id, opts.lang(req, v)));
  }));
  router.post('/events/:id/questions', ah(async (req, res) => {
    on(req);
    const v = await opts.vendor(req);
    await askQuestion(opts.tenant(req), v, req.params.id, z.object({ question: z.string() }).parse(req.body).question, opts.actor(req, v));
    res.status(201).json(await eventForBidder(opts.tenant(req), v, req.params.id, opts.lang(req, v)));
  }));
  const envelope = z.enum(['single', 'technical', 'commercial']);
  router.get('/events/:id/offer', ah(async (req, res) => { on(req); res.json(await myOffers(await opts.vendor(req), req.params.id)); }));
  router.post('/events/:id/offer/files', upload.single('file'), ah(async (req, res) => {
    on(req);
    if (!req.file) throw new HttpError(400, 'No file uploaded');
    res.status(201).json(await uploadBidFile(await opts.vendor(req), req.params.id, req.file));
  }));
  router.post('/events/:id/offer/:envelope', ah(async (req, res) => {
    on(req);
    const v = await opts.vendor(req);
    await submitOffer(opts.tenant(req), v, req.params.id, envelope.parse(req.params.envelope), req.body, opts.actor(req, v));
    res.status(201).json(await myOffers(v, req.params.id));
  }));
  router.delete('/events/:id/offer/:envelope', ah(async (req, res) => {
    on(req);
    const v = await opts.vendor(req);
    await withdrawOffer(opts.tenant(req), v, req.params.id, envelope.parse(req.params.envelope), opts.actor(req, v));
    res.json(await myOffers(v, req.params.id));
  }));
  router.get('/events/:id/live', ah(async (req, res) => { on(req); res.json(await bidderLive(opts.tenant(req), await opts.vendor(req), req.params.id)); }));
  router.post('/events/:id/bids', ah(async (req, res) => {
    on(req);
    const v = await opts.vendor(req);
    const r = await placeBid(opts.tenant(req), v, req.params.id, req.body, opts.actor(req, v));
    res.status(201).json({ placed: r, live: await bidderLive(opts.tenant(req), v, req.params.id) });
  }));
  router.get('/events/:id/stream', ah(async (req, res) => {
    on(req);
    await bidderLive(opts.tenant(req), await opts.vendor(req), req.params.id); // only for invited bidders
    subscribeLive(`event:${req.params.id}`, res);
  }));
  router.post('/bidder-registration', ah(async (req, res) => {
    on(req);
    const v = await opts.vendor(req);
    await registerBidder(opts.tenant(req), v, req.body, opts.actor(req, v));
    res.json({ ok: true });
  }));
}
