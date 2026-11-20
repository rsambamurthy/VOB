/**
 * Contracts (supplier and customer).
 *   /api/admin/contracts   Administration → Contracts: switch, contract types, options, rule defaults and locks
 *   /api/staff/contracts   the repository — 404 unless Contracts is on (services/contracts/config.ts)
 *   /api/staff/parties     suppliers and customers
 */
import { Router, type Request, type Response } from 'express';
import { eq } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { effectiveLimits } from '../lib/plans.js';
import { excelUpload, upload } from '../lib/upload.js';
import { localeFor, homeCountries } from '../countries/registry.js';
import { onboardingOn } from '../lib/modules.js';
import { sendStoredFile } from '../integrations/storage/index.js';
import { assertContractsOn, checkContractsSettings, contractsConfig } from '../services/contracts/config.js';
import { addFile, contractDetail, contractsTemplate, createContract, deleteDraft, DIRECTION_LABEL, FILE_KINDS, getFile, importContracts, listContracts, markSigned, ownerOptions, parentOptions, removeFile, STATUS_LABEL, terminateContract, updateContract } from '../services/contracts/contracts.js';
import { createParty, importParties, linkVendor, listParties, onboardParty, partiesTemplate, partyDetail, partyForVendor, partyOptions, setPartyArchived, updateParty } from '../services/contracts/parties.js';

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
  res.json({ ...contractsConfig(tenant), plan: effectiveLimits(tenant).label, onboarding: onboardingOn(tenant) });
}));
contractsAdminRouter.put('/', requireStaff('tenant.settings'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { settings, changes } = checkContractsSettings(s.tenant, req.body ?? {});
  const tenant = { ...s.tenant, settings: { ...s.tenant.settings, contracts: settings } };
  await db.update(schema.tenants).set({ settings: tenant.settings }).where(eq(schema.tenants.id, s.tenant.id));
  if (changes.length) await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'CONTRACTS_SETTINGS_CHANGED', detail: { changes }, ip: req.ip });
  res.json({ ...contractsConfig(tenant), plan: effectiveLimits(tenant).label, onboarding: onboardingOn(tenant), changes });
}));

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
  res.status(201).json(await contractDetail(s.tenant, c.id));
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
contractsRouter.get('/:id', requireStaff('contracts.view'), ah(async (req, res) => { res.json(await contractDetail(staffCtx(req).tenant, req.params.id)); }));
contractsRouter.patch('/:id', requireStaff('contracts.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  await updateContract(s.tenant, req.params.id, req.body ?? {}, by(req));
  res.json(await contractDetail(s.tenant, req.params.id));
}));
contractsRouter.delete('/:id', requireStaff('contracts.manage'), ah(async (req, res) => { await deleteDraft(staffCtx(req).tenant, req.params.id, by(req)); res.json({ ok: true }); }));
contractsRouter.post('/:id/signed', requireStaff('contracts.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  await markSigned(s.tenant, req.params.id, req.body ?? {}, by(req));
  res.json(await contractDetail(s.tenant, req.params.id));
}));
contractsRouter.post('/:id/terminate', requireStaff('contracts.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  await terminateContract(s.tenant, req.params.id, req.body ?? {}, by(req));
  res.json(await contractDetail(s.tenant, req.params.id));
}));
contractsRouter.post('/:id/files', requireStaff('contracts.manage'), upload.single('file'), ah(async (req, res) => {
  const s = staffCtx(req);
  if (!req.file) throw new HttpError(400, 'Choose a file to upload');
  await addFile(s.tenant, req.params.id, String(req.body?.kind ?? ''), req.file, by(req));
  res.status(201).json(await contractDetail(s.tenant, req.params.id));
}));
contractsRouter.delete('/:id/files/:fileId', requireStaff('contracts.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  await removeFile(s.tenant, req.params.id, req.params.fileId, by(req));
  res.json(await contractDetail(s.tenant, req.params.id));
}));

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
