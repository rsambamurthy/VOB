/**
 * Questionnaires: set up under Administration → Questionnaires (config.manage); answered in the supplier portal
 * and by a buyer filling in for the supplier — both use answerRoutes() below, so they behave the same; and sent
 * to a supplier by a buyer from the vendor page. Rules in services/questionnaires.ts.
 */
import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { ah, HttpError } from '../lib/http.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { upload } from '../lib/upload.js';
import { attachFile, listQuestionnaires, questionnaireSchema, saveAnswers, saveQuestionnaire, setQuestionnaireStatus, submitAnswers } from '../services/questionnaires.js';
import { isEditableStatus } from '../lib/onboardingStatus.js';
import type { Vendor } from '../db/schema.js';

export const questionnairesRouter = Router();

questionnairesRouter.get('/', requireStaff('config.manage'), ah(async (req, res) => { res.json(await listQuestionnaires(staffCtx(req).tenant.id)); }));
/** Active questionnaires to choose from when sending one to a supplier. */
questionnairesRouter.get('/active', requireStaff('vendors.edit'), ah(async (req, res) => {
  res.json((await listQuestionnaires(staffCtx(req).tenant.id)).filter((q) => q.status === 'ACTIVE').map((q) => ({ id: q.id, title: q.title, status: q.status })));
}));
questionnairesRouter.post('/', requireStaff('config.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  res.status(201).json(await saveQuestionnaire(s.tenant.id, null, questionnaireSchema.parse(req.body), { name: s.user.name, ip: req.ip }));
}));
questionnairesRouter.put('/:id', requireStaff('config.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  res.json(await saveQuestionnaire(s.tenant.id, req.params.id, questionnaireSchema.parse(req.body), { name: s.user.name, ip: req.ip }));
}));
for (const [path, status] of [['archive', 'ARCHIVED'], ['restore', 'ACTIVE']] as const) {
  questionnairesRouter.post(`/:id/${path}`, requireStaff('config.manage'), ah(async (req, res) => {
    const s = staffCtx(req);
    await setQuestionnaireStatus(s.tenant.id, req.params.id, status, { name: s.user.name, ip: req.ip });
    res.json({ ok: true });
  }));
}

/**
 * Save / submit answers and attach files — mounted in the supplier portal and in the buyer's fill-in, which
 * differ only in how they find the supplier, who is acting, and what they send back.
 */
export function answerRoutes(router: Router, opts: {
  vendor: (req: Request) => Promise<Vendor>;
  actor: (req: Request, v: Vendor) => { name: string; userId?: string; onBehalf?: boolean; ip?: string };
  respond: (req: Request, v: Vendor) => Promise<unknown>;
  guard?: RequestHandler;
}) {
  const g = opts.guard ? [opts.guard] : [];
  const editable = async (req: Request) => {
    const v = await opts.vendor(req);
    // During onboarding, and afterwards for questionnaires a buyer has sent.
    if (!isEditableStatus(v.status) && v.status !== 'APPROVED') throw new HttpError(409, 'Your registration has been submitted and can no longer be edited');
    return v;
  };
  const answers = z.object({ answers: z.record(z.unknown()).default({}) });
  router.put('/questionnaires/:qid', ...g, ah(async (req, res) => {
    const v = await editable(req);
    await saveAnswers(v, req.params.qid, answers.parse(req.body).answers);
    res.json(await opts.respond(req, v));
  }));
  router.post('/questionnaires/:qid/submit', ...g, ah(async (req, res) => {
    const v = await editable(req);
    await submitAnswers(v, req.params.qid, answers.parse(req.body).answers, opts.actor(req, v));
    res.json(await opts.respond(req, v));
  }));
  router.post('/questionnaires/:qid/file', ...g, upload.single('file'), ah(async (req, res) => {
    const v = await editable(req);
    if (!req.file) throw new HttpError(400, 'No file uploaded');
    res.status(201).json(await attachFile(v, req.params.qid, req.file, opts.actor(req, v).userId));
  }));
}
