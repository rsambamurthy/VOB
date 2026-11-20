/**
 * Contracts (supplier and customer).
 *   /api/admin/contracts   Administration → Contracts: switch, contract types, options, rule defaults and locks
 *   /api/staff/contracts   the repository — 404 unless Contracts is on (services/contracts/config.ts)
 *   /api/staff/parties     suppliers and customers
 *   /api/staff/contract-library   templates and the clause library (permission contracts.templates)
 */
import { Router, type Request, type Response } from 'express';
import { eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { env } from '../lib/env.js';
import { effectiveLimits } from '../lib/plans.js';
import { contractUpload, excelUpload } from '../lib/upload.js';
import { z } from 'zod';
import { localeFor, homeCountries } from '../countries/registry.js';
import { onboardingOn } from '../lib/modules.js';
import { sendStoredFile } from '../integrations/storage/index.js';
import { assertContractsOn, checkContractsSettings, companyDetails, companySchema, contractApprovalCatalog, contractApprovalLevels, contractsConfig } from '../services/contracts/config.js';
import { decideFlow, flowView } from '../services/approvalFlow.js';
import { approvalSetupFor, saveFlowLevels } from './approvalAdmin.js';
import { generateDocument, reopenDraft, saveDraft, startDraft, submitForApproval } from '../services/contracts/drafting.js';
import { decideComment, shareForReview, staffComment } from '../services/contracts/negotiation.js';
import { cancelSignature, esignSettings, refreshFor, sendForSignature, startSigning } from '../services/contracts/signing.js';
import { esignView, providerOf, sealCredentials, openCredentials, cfgOf } from '../integrations/esign/index.js';
import { clauseGroups, getClause, listClauses, listTemplates, resetClause, saveClause, saveTemplate, saveWordTemplate, setClauseArchived, setTemplateArchived, templateDetail, templateFile } from '../services/contracts/templates.js';
import { MERGE_FIELDS } from '../services/contracts/fields.js';
import { addObligation, createAmendment, deleteObligation, importPrices, listObligations, pricesTemplate, resendToErp, savePrices, setObligationStatus, updateObligation } from '../services/contracts/manage.js';
import { pdfAvailable } from '../integrations/office/index.js';
import type { Permission } from '../lib/permissions.js';
import { addFile, contractDetail, contractsTemplate, createContract, deleteDraft, DIRECTION_LABEL, FILE_KINDS, getFile, importContracts, listContracts, markSigned, ownerOptions, parentOptions, removeFile, STATUS_LABEL, terminateContract, updateContract } from '../services/contracts/contracts.js';
import { createParty, importParties, linkVendor, listParties, onboardParty, partiesTemplate, partyDetail, partyForVendor, partyOptions, setPartyArchived, updateParty } from '../services/contracts/parties.js';

const detail = (req: Request, id: string) => { const s = staffCtx(req); return contractDetail(s.tenant, id, s.user.id); };
/** People without contracts.view may still open a contract they are asked to approve (the email links to it). */
async function canOpen(req: Request, id: string) {
  const s = staffCtx(req);
  if (s.permissions.has('contracts.view' as Permission)) return;
  const v = await flowView(s.tenant.id, 'contract', id, s.user.id);
  if (!v.canAct) throw new HttpError(403, 'You don’t have permission to open contracts.');
}
const by = (req: Request) => { const s = staffCtx(req); return { id: s.user.id, name: s.user.name, ip: req.ip }; };
const sendXlsx = async (res: Response, name: string, buf: ArrayBuffer | Buffer) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(Buffer.from(buf as ArrayBuffer));
};

/* ---------------- Administration → Contracts ---------------- */

export const contractsAdminRouter = Router();
contractsAdminRouter.get('/', requireStaff('tenant.settings'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  res.json(await adminView(tenant));
}));
contractsAdminRouter.put('/', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { settings, changes } = checkContractsSettings(s.tenant, req.body ?? {});
  const tenant = { ...s.tenant, settings: { ...s.tenant.settings, contracts: settings } };
  await db.update(schema.tenants).set({ settings: tenant.settings }).where(eq(schema.tenants.id, s.tenant.id));
  if (changes.length) await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'CONTRACTS_SETTINGS_CHANGED', detail: { changes }, ip: req.ip });
  res.json({ ...(await adminView(tenant)), changes });
}));
/** Internal approval levels (the same editor as Sourcing's approval flows). */
contractsAdminRouter.put('/approval', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { tenant } = await saveFlowLevels(s.tenant, req.body?.levels, { catalog: contractApprovalCatalog(), settingsKey: 'contracts', field: 'approval', auditAction: 'CONTRACTS_APPROVAL_FLOW_CHANGED', actor: s.user.name, ip: req.ip });
  res.json({ approval: await approvalSetupFor(tenant.id, contractApprovalLevels(tenant), contractApprovalCatalog()) });
}));
/** E-signature provider: which one, sandbox or live, credentials (secrets kept when left empty; never sent back). */
contractsAdminRouter.put('/esign', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const body = z.object({ provider: z.string().nullable(), sandbox: z.boolean().default(true), values: z.record(z.string().max(8000)).default({}) }).parse(req.body);
  const prev = esignSettings(s.tenant);
  let esign = {};
  if (body.provider) {
    const p = providerOf(body.provider);
    if (!p) throw new HttpError(400, 'Choose a provider from the list.');
    const old = prev.provider === p.key ? openCredentials(prev) : {};
    const values: Record<string, string> = {};
    for (const f of p.fields) {
      const v = (body.values[f.key] ?? '').trim();
      values[f.key] = v || (f.secret ? old[f.key] ?? '' : '');
      if (!values[f.key] && !f.optional) throw new HttpError(400, `Fill in ${f.label}.`);
      if (f.options && values[f.key] && !(values[f.key] in f.options)) throw new HttpError(400, `Choose ${f.label} from the list.`);
    }
    esign = { provider: p.key, sandbox: body.sandbox, credentials: sealCredentials(values) };
  }
  const settings = { ...s.tenant.settings, contracts: { ...(s.tenant.settings.contracts ?? {}), esign } };
  await db.update(schema.tenants).set({ settings }).where(eq(schema.tenants.id, s.tenant.id));
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'CONTRACTS_ESIGN_CHANGED', detail: { provider: body.provider, sandbox: body.sandbox }, ip: req.ip });
  res.json(await adminView({ ...s.tenant, settings }));
}));
/** Try the saved credentials. */
contractsAdminRouter.post('/esign/check', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = esignSettings(staffCtx(req).tenant);
  const p = s.provider ? providerOf(s.provider) : null;
  if (!p) throw new HttpError(400, 'Choose and save a provider first.');
  try { res.json({ ok: true, message: await p.check(cfgOf(s)) }); } catch (e) { res.json({ ok: false, message: (e as Error).message }); }
}));
/** Our company details printed on contracts (us.* merge fields). Empty values fall back to the billing details. */
contractsAdminRouter.put('/company', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const company = companySchema.parse(req.body ?? {});
  const settings = { ...s.tenant.settings, contracts: { ...(s.tenant.settings.contracts ?? {}), company } };
  await db.update(schema.tenants).set({ settings }).where(eq(schema.tenants.id, s.tenant.id));
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'CONTRACTS_COMPANY_CHANGED', detail: { fields: Object.keys(company) }, ip: req.ip });
  res.json(await adminView({ ...s.tenant, settings }));
}));

async function adminView(tenant: Parameters<typeof contractsConfig>[0]) {
  return { ...contractsConfig(tenant), plan: effectiveLimits(tenant).label, onboarding: onboardingOn(tenant),
    approval: await approvalSetupFor(tenant.id, contractApprovalLevels(tenant), contractApprovalCatalog()),
    esign: { ...esignView(esignSettings(tenant)), webhookBase: `${env.appBaseUrl}/api/esign/webhook/${tenant.id}/` },
    company: (tenant.settings.contracts as { company?: object } | undefined)?.company ?? {}, companyDefaults: companyDetails({ ...tenant, settings: { ...tenant.settings, contracts: { ...(tenant.settings.contracts ?? {}), company: {} } } }) };
}

/* ---------------- the module ---------------- */

export const contractsRouter = Router();
contractsRouter.use(requireStaff(), (req, _res, next) => { try { assertContractsOn(staffCtx(req).tenant); next(); } catch (e) { next(e); } });

/** What the screens need: types, options and rules, owners, labels, countries, the workspace currency. */
contractsRouter.get('/setup', requireStaff('contracts.view'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  res.json({ config: contractsConfig(tenant), owners: await ownerOptions(tenant), statuses: STATUS_LABEL, directions: DIRECTION_LABEL, fileKinds: FILE_KINDS,
    currency: localeFor(tenant.country).currency, country: tenant.country, countries: homeCountries().map((c) => ({ code: c.code, name: c.name })), onboarding: onboardingOn(tenant) });
}));

contractsRouter.get('/', requireStaff('contracts.view'), ah(async (req, res) => { res.json(await listContracts(staffCtx(req).tenant, req.query)); }));
contractsRouter.post('/', requireStaff('contracts.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const c = await createContract(s.tenant, req.body, by(req), { signed: req.body?.signed === true });
  res.status(201).json(await detail(req, c.id));
}));
contractsRouter.get('/import-template.xlsx', requireStaff('contracts.manage'), ah(async (req, res) => { await sendXlsx(res, 'contracts-import.xlsx', await contractsTemplate(staffCtx(req).tenant)); }));
/** Check an import (nothing saved) or, with ?commit=1, create the contracts. */
contractsRouter.post('/import', requireStaff('contracts.manage'), excelUpload.single('file'), ah(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose the Excel file to upload');
  res.json(await importContracts(staffCtx(req).tenant, req.file.buffer, by(req), { commit: req.query.commit === '1', createParties: req.query.createParties === '1' }));
}));
/** Contracts → Obligations: across all contracts. */
contractsRouter.get('/obligations', requireStaff('contracts.view'), ah(async (req, res) => {
  const s = staffCtx(req);
  res.json(await listObligations(s.tenant, { ...(req.query as Record<string, string>), userId: s.user.id }));
}));
contractsRouter.get('/reports', requireStaff('contracts.view'), ah(async (req, res) => { res.json(await (await import('../services/contracts/reports.js')).contractReport(staffCtx(req).tenant)); }));
contractsRouter.get('/reports.xlsx', requireStaff('contracts.view'), ah(async (req, res) => { await sendXlsx(res, 'contract-report.xlsx', await (await import('../services/contracts/reports.js')).contractReportXlsx(staffCtx(req).tenant)); }));
/* Contract watch: what needs a decision (services/contracts/watch.ts). */
const watch = () => import('../services/contracts/watch.js');
contractsRouter.get('/watch', requireStaff('contracts.view'), ah(async (req, res) => { const s = staffCtx(req); res.json(await (await watch()).listSuggestions(s.tenant, req.query as Record<string, string>, s.user.id)); }));
contractsRouter.get('/watch/count', requireStaff('contracts.view'), ah(async (req, res) => { res.json(await (await watch()).openCount(staffCtx(req).tenant)); }));
contractsRouter.post('/watch/run', requireStaff('contracts.manage'), ah(async (req, res) => {
  const t = staffCtx(req).tenant; const w = await watch();
  if (!w.watchOn(t)) throw new HttpError(409, 'Contract watch is switched off in Administration → Contracts.');
  res.json(await w.runWatchFor(t));
}));
contractsRouter.post('/suggestions/:sid', requireStaff('contracts.manage'), ah(async (req, res) => { res.json({ suggestion: await (await watch()).decideSuggestion(staffCtx(req).tenant, req.params.sid, req.body, by(req)) }); }));
contractsRouter.get('/prices-template.xlsx', requireStaff('contracts.manage'), ah(async (_req, res) => { await sendXlsx(res, 'contract-prices.xlsx', await pricesTemplate()); }));
contractsRouter.get('/parents', requireStaff('contracts.view'), ah(async (req, res) => {
  res.json({ contracts: await parentOptions(staffCtx(req).tenant, String(req.query.partyId ?? '')) });
}));
contractsRouter.get('/files/:fileId', requireStaff('contracts.view'), ah(async (req, res) => { await sendStoredFile(res, await getFile(staffCtx(req).tenant.id, req.params.fileId)); }));
contractsRouter.get('/:id', ah(async (req, res) => { await canOpen(req, req.params.id); res.json(await detail(req, req.params.id)); }));
contractsRouter.patch('/:id', requireStaff('contracts.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  await updateContract(s.tenant, req.params.id, req.body ?? {}, by(req));
  res.json(await detail(req, req.params.id));
}));
contractsRouter.delete('/:id', requireStaff('contracts.manage'), ah(async (req, res) => { await deleteDraft(staffCtx(req).tenant, req.params.id, by(req)); res.json({ ok: true }); }));
contractsRouter.post('/:id/signed', requireStaff('contracts.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  await markSigned(s.tenant, req.params.id, req.body ?? {}, by(req));
  res.json(await detail(req, req.params.id));
}));
contractsRouter.post('/:id/terminate', requireStaff('contracts.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  await terminateContract(s.tenant, req.params.id, req.body ?? {}, by(req));
  res.json(await detail(req, req.params.id));
}));
contractsRouter.post('/:id/files', requireStaff('contracts.manage'), contractUpload.single('file'), ah(async (req, res) => {
  const s = staffCtx(req);
  if (!req.file) throw new HttpError(400, 'Choose a file to upload');
  await addFile(s.tenant, req.params.id, String(req.body?.kind ?? ''), req.file, by(req));
  res.status(201).json(await detail(req, req.params.id));
}));
contractsRouter.delete('/:id/files/:fileId', requireStaff('contracts.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  await removeFile(s.tenant, req.params.id, req.params.fileId, by(req));
  res.json(await detail(req, req.params.id));
}));

/* ---------- drafting from a template, and internal approval ---------- */

const act = (fn: (t: Parameters<typeof startDraft>[0], id: string, body: unknown, b: ReturnType<typeof by>) => Promise<unknown>) => ah(async (req, res) => {
  const s = staffCtx(req);
  const r = await fn(s.tenant, req.params.id, req.body ?? {}, by(req));
  res.json({ result: r && typeof r === 'object' && !('id' in r) ? r : undefined, ...(await detail(req, req.params.id)) });
});
contractsRouter.post('/:id/draft', requireStaff('contracts.manage'), act(startDraft));
contractsRouter.put('/:id/draft', requireStaff('contracts.manage'), act(saveDraft));
contractsRouter.post('/:id/document', requireStaff('contracts.manage'), act((t, id, _b, who) => generateDocument(t, id, who)));
contractsRouter.post('/:id/submit', requireStaff('contracts.manage'), act((t, id, _b, who) => submitForApproval(t, id, who)));
contractsRouter.post('/:id/reopen', requireStaff('contracts.manage'), act((t, id, _b, who) => reopenDraft(t, id, who)));
/** Approve, send back or reject (whoever holds the current step's role; never the contract's owner or drafter). */
contractsRouter.post('/:id/decision', ah(async (req, res) => {
  const s = staffCtx(req);
  const { action, remarks } = z.object({ action: z.enum(['APPROVE', 'SEND_BACK', 'REJECT']), remarks: z.string().max(2000).default('') }).parse(req.body);
  await decideFlow(s.tenant.id, 'contract', req.params.id, { id: s.user.id, name: s.user.name }, action, remarks, req.ip);
  // An approver without contracts.view can't open it again once they have decided.
  res.json(s.permissions.has('contracts.view' as Permission) ? await detail(req, req.params.id) : { decided: true });
}));

/* ---------- review by the other party, and signature ---------- */

contractsRouter.post('/:id/share', requireStaff('contracts.manage'), act(shareForReview));
contractsRouter.post('/:id/comments', requireStaff('contracts.manage'), act(staffComment));
contractsRouter.put('/:id/comments/:commentId', requireStaff('contracts.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  await decideComment(s.tenant, req.params.id, req.params.commentId, req.body ?? {}, by(req));
  res.json(await detail(req, req.params.id));
}));
contractsRouter.post('/:id/signature', requireStaff('contracts.manage'), act(sendForSignature));
contractsRouter.post('/:id/signature/refresh', requireStaff('contracts.manage'), act((t, id) => refreshFor(t, id)));
contractsRouter.post('/:id/signature/cancel', requireStaff('contracts.manage'), act(cancelSignature));
/** Our signer signs (link providers): only the person named as the signer, by their email. */
contractsRouter.post('/:id/signature/start', ah(async (req, res) => {
  const s = staffCtx(req);
  res.json({ url: await startSigning(s.tenant, req.params.id, s.user.email, `/staff/contracts/${req.params.id}`) });
}));

/* ---------- managing signed contracts ---------- */

/** A new amendment (a draft contract under this one); answers the amendment. */
contractsRouter.post('/:id/amendments', requireStaff('contracts.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const a = await createAmendment(s.tenant, req.params.id, req.body ?? {}, by(req));
  res.status(201).json(await detail(req, a.id));
}));
contractsRouter.post('/:id/obligations', requireStaff('contracts.manage'), act(addObligation));
contractsRouter.put('/:id/obligations/:oid', requireStaff('contracts.manage'), ah(async (req, res) => {
  await updateObligation(staffCtx(req).tenant, req.params.id, req.params.oid, req.body ?? {}, by(req)); res.json(await detail(req, req.params.id));
}));
contractsRouter.post('/:id/obligations/:oid/status', requireStaff('contracts.manage'), ah(async (req, res) => {
  await setObligationStatus(staffCtx(req).tenant, req.params.id, req.params.oid, req.body ?? {}, by(req)); res.json(await detail(req, req.params.id));
}));
contractsRouter.delete('/:id/obligations/:oid', requireStaff('contracts.manage'), ah(async (req, res) => {
  await deleteObligation(staffCtx(req).tenant, req.params.id, req.params.oid, by(req)); res.json(await detail(req, req.params.id));
}));
contractsRouter.put('/:id/prices', requireStaff('contracts.manage'), act(savePrices));
contractsRouter.post('/:id/prices/import', requireStaff('contracts.manage'), excelUpload.single('file'), ah(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose the Excel file to upload');
  res.json(await importPrices(staffCtx(req).tenant, req.params.id, req.file.buffer, by(req), req.query.commit === '1'));
}));
/** Read an uploaded contract for its key terms (masked before any AI sees it). */
contractsRouter.post('/:id/files/:fileId/read', requireStaff('contracts.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const r = await (await import('../services/contracts/reading.js')).readContract(s.tenant, req.params.id, req.params.fileId, by(req));
  res.json({ readingId: r.id, ...(await detail(req, req.params.id)) });
}));
contractsRouter.post('/:id/readings/:rid/apply', requireStaff('contracts.manage'), ah(async (req, res) => {
  await (await import('../services/contracts/reading.js')).applyReading(staffCtx(req).tenant, req.params.id, req.params.rid, req.body ?? {}, by(req));
  res.json(await detail(req, req.params.id));
}));
contractsRouter.post('/:id/erp', requireStaff('contracts.manage'), act((t, id, _b, who) => resendToErp(t, id, who)));

/* ---------------- templates and the clause library ---------------- */

export const contractLibraryRouter = Router();
contractLibraryRouter.use(requireStaff(), (req, _res, next) => { try { assertContractsOn(staffCtx(req).tenant); next(); } catch (e) { next(e); } });
const lib = (perm: Permission = 'contracts.view') => requireStaff(perm);
contractLibraryRouter.get('/fields', lib(), ah(async (_req, res) => { res.json({ fields: MERGE_FIELDS, pdf: pdfAvailable() }); }));
contractLibraryRouter.get('/clauses', lib(), ah(async (req, res) => { res.json(await listClauses(staffCtx(req).tenant, req.query as Record<string, string>)); }));
contractLibraryRouter.get('/clauses/groups', lib(), ah(async (req, res) => { res.json({ groups: await clauseGroups(staffCtx(req).tenant) }); }));
contractLibraryRouter.get('/clauses/:id', lib(), ah(async (req, res) => { res.json({ clause: await getClause(staffCtx(req).tenant, req.params.id) }); }));
contractLibraryRouter.post('/clauses', lib('contracts.templates'), ah(async (req, res) => { res.status(201).json({ clause: await saveClause(staffCtx(req).tenant, null, req.body, by(req)) }); }));
contractLibraryRouter.put('/clauses/:id', lib('contracts.templates'), ah(async (req, res) => { res.json({ clause: await saveClause(staffCtx(req).tenant, req.params.id, req.body, by(req)) }); }));
contractLibraryRouter.post('/clauses/:id/reset', lib('contracts.templates'), ah(async (req, res) => { res.json({ clause: await resetClause(staffCtx(req).tenant, req.params.id, by(req)) }); }));
contractLibraryRouter.post('/clauses/:id/archive', lib('contracts.templates'), ah(async (req, res) => { res.json({ clause: await setClauseArchived(staffCtx(req).tenant, req.params.id, req.body?.archived !== false, by(req)) }); }));
contractLibraryRouter.get('/templates', lib(), ah(async (req, res) => { res.json(await listTemplates(staffCtx(req).tenant, req.query as Record<string, string>)); }));
contractLibraryRouter.get('/templates/:id', lib(), ah(async (req, res) => { res.json(await templateDetail(staffCtx(req).tenant, req.params.id)); }));
contractLibraryRouter.get('/templates/:id/file', lib(), ah(async (req, res) => { await sendStoredFile(res, await templateFile(staffCtx(req).tenant, req.params.id)); }));
contractLibraryRouter.post('/templates', lib('contracts.templates'), ah(async (req, res) => { res.status(201).json({ template: await saveTemplate(staffCtx(req).tenant, null, req.body, by(req)) }); }));
contractLibraryRouter.put('/templates/:id', lib('contracts.templates'), ah(async (req, res) => { res.json({ template: await saveTemplate(staffCtx(req).tenant, req.params.id, req.body, by(req)) }); }));
/** Word templates: multipart with `file` (.docx) and `data` (JSON: name, types, direction, sections). */
contractLibraryRouter.post('/templates/word', lib('contracts.templates'), contractUpload.single('file'), ah(async (req, res) => {
  res.status(201).json({ template: await saveWordTemplate(staffCtx(req).tenant, null, req.body?.data ?? '{}', req.file, by(req)) });
}));
contractLibraryRouter.put('/templates/:id/word', lib('contracts.templates'), contractUpload.single('file'), ah(async (req, res) => {
  res.json({ template: await saveWordTemplate(staffCtx(req).tenant, req.params.id, req.body?.data ?? '{}', req.file, by(req)) });
}));
contractLibraryRouter.post('/templates/:id/archive', lib('contracts.templates'), ah(async (req, res) => { res.json({ template: await setTemplateArchived(staffCtx(req).tenant, req.params.id, req.body?.archived !== false, by(req)) }); }));

/* ---------------- parties ---------------- */

export const partiesRouter = Router();
partiesRouter.use(requireStaff(), (req, _res, next) => { try { assertContractsOn(staffCtx(req).tenant); next(); } catch (e) { next(e); } });
partiesRouter.get('/', requireStaff('contracts.view'), ah(async (req, res) => { res.json(await listParties(staffCtx(req).tenant, req.query as Record<string, string>)); }));
partiesRouter.get('/options', requireStaff('contracts.view'), ah(async (req, res) => { res.json({ parties: await partyOptions(staffCtx(req).tenant, String(req.query.kind ?? '')) }); }));
partiesRouter.post('/', requireStaff('contracts.manage'), ah(async (req, res) => { res.status(201).json({ party: await createParty(staffCtx(req).tenant, req.body, by(req)) }); }));
/** The supplier party for an onboarded supplier (created and linked the first time). */
partiesRouter.post('/from-supplier', requireStaff('contracts.manage'), ah(async (req, res) => {
  res.json({ party: await partyForVendor(staffCtx(req).tenant, String(req.body?.vendorId ?? ''), by(req)) });
}));
partiesRouter.get('/import-template.xlsx', requireStaff('contracts.manage'), ah(async (req, res) => { await sendXlsx(res, 'parties-import.xlsx', await partiesTemplate(staffCtx(req).tenant.country)); }));
partiesRouter.post('/import', requireStaff('contracts.manage'), excelUpload.single('file'), ah(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose the Excel file to upload');
  res.json(await importParties(staffCtx(req).tenant, req.file.buffer, by(req), req.query.commit === '1'));
}));
partiesRouter.get('/:id', requireStaff('contracts.view'), ah(async (req, res) => { res.json(await partyDetail(staffCtx(req).tenant, req.params.id)); }));
partiesRouter.patch('/:id', requireStaff('contracts.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  await updateParty(s.tenant, req.params.id, req.body ?? {}, by(req));
  res.json(await partyDetail(s.tenant, req.params.id));
}));
partiesRouter.post('/:id/archive', requireStaff('contracts.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  await setPartyArchived(s.tenant, req.params.id, req.body?.archived !== false, by(req));
  res.json(await partyDetail(s.tenant, req.params.id));
}));
partiesRouter.post('/:id/link', requireStaff('contracts.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  await linkVendor(s.tenant, req.params.id, req.body?.vendorId ? String(req.body.vendorId) : null, by(req));
  res.json(await partyDetail(s.tenant, req.params.id));
}));
partiesRouter.post('/:id/onboard', requireStaff('contracts.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  if (!s.permissions.has('vendors.create')) throw new HttpError(403, 'You need permission to create suppliers to send a party for onboarding.');
  await onboardParty(s.tenant, req.params.id, by(req));
  res.json(await partyDetail(s.tenant, req.params.id));
}));
