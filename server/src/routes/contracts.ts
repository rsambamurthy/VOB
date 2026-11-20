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
import { clauseGroups, getClause, listClauses, listTemplates, resetClause, saveClause, saveTemplate, saveWordTemplate, setClauseArchived, setTemplateArchived, templateDetail, templateFile } from '../services/contracts/templates.js';
import { MERGE_FIELDS } from '../services/contracts/fields.js';
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
