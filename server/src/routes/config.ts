/** Onboarding configuration (read for staff, edit/publish for config.manage) and out-of-office delegation. */
import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { ah, HttpError } from '../lib/http.js';
import { requireStaff, staffCtx } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import multer from 'multer';
import { configSchema, coreFieldsFor, CORE_SECTIONS, FIELD_TYPES, findIssues, OPS, VENDOR_ATTRIBUTES, vendorTypes, type OnboardingConfig } from '../config/types.js';
import { exportConfig, importConfig } from '../services/configExcel.js';
import { checkList, validatorList, keyChangeFields, SENSITIVE_FIELDS, vendorTypesFor } from '../countries/registry.js';
import * as cfg from '../services/config.js';
import { arabicDefaults, supplierLanguages } from '../i18n/index.js';

const { roles, users, delegations } = schema;
const roleKeysOf = async (tenantId: string) => (await db.select({ key: roles.key }).from(roles).where(eq(roles.tenantId, tenantId))).map((r) => r.key);
export const configRouter = Router();

const editorMeta = (country: string) => ({ fieldTypes: FIELD_TYPES, validators: validatorList(), ops: OPS, coreFields: coreFieldsFor(country), coreSections: CORE_SECTIONS, vendorAttributes: VENDOR_ATTRIBUTES, vendorTypes: vendorTypesFor(country),
  // Workspaces whose suppliers can use Arabic get Arabic inputs, with the built-in translations as hints.
  arabic: supplierLanguages({ country }).includes('ar') ? { defaults: arabicDefaults() } : null });

/** Published config for rendering vendor profiles (any staff member). */
configRouter.get('/config', requireStaff(), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  const { version, config } = await cfg.getPublished(tenant.id);
  res.json({ version, config, vendorTypes: vendorTypesFor(tenant.country), checks: checkList(tenant.country), fieldMeta: { masked: Object.keys(SENSITIVE_FIELDS), keyChange: keyChangeFields() } });
}));

/* ---------- Admin editor ---------- */

configRouter.get('/admin/config', requireStaff('config.manage'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  const [state, roleRows] = await Promise.all([cfg.editorState(tenant.id), db.select({ key: roles.key, name: roles.name }).from(roles).where(eq(roles.tenantId, tenant.id)).orderBy(asc(roles.createdAt))]);
  res.json({ ...state, roles: roleRows, meta: editorMeta(tenant.country) });
}));

configRouter.put('/admin/config/draft', requireStaff('config.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const issues = await cfg.saveDraft(s.tenant.id, req.body?.config, s.user.id);
  res.json({ ok: true, issues });
}));

configRouter.delete('/admin/config/draft', requireStaff('config.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  await cfg.discardDraft(s.tenant.id);
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'CONFIG_DRAFT_DISCARDED', ip: req.ip });
  res.json({ ok: true });
}));

/* ---------- The form as Excel: download, preview an upload, apply it to the draft ---------- */

const excelUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
async function editableConfig(tenantId: string) {
  const draft = await cfg.getDraft(tenantId);
  return draft ? (draft.config as OnboardingConfig) : (await cfg.getPublished(tenantId)).config;
}

configRouter.get('/admin/config/excel', requireStaff('config.manage'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  const wb = await exportConfig(await editableConfig(tenant.id), { workspace: tenant.slug, builtIn: coreFieldsFor(tenant.country) });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="vendorgate-form-${tenant.slug}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

/** Reads the file and says what would change; saves the draft only with ?apply=1. */
configRouter.post('/admin/config/excel', requireStaff('config.manage'), excelUpload.single('file'), ah(async (req, res) => {
  const s = staffCtx(req);
  if (!req.file) throw new HttpError(400, 'Choose the Excel file to upload');
  const base = await editableConfig(s.tenant.id);
  const r = await importConfig(req.file.buffer, base, { builtIn: coreFieldsFor(s.tenant.country) });
  if (!r.config) return res.json({ ok: false, errors: r.errors, changes: r.changes });
  const structure = configSchema.safeParse(r.config);
  if (!structure.success) {
    return res.json({ ok: false, changes: r.changes, errors: structure.error.issues.slice(0, 20).map((i) => ({ sheet: 'Form', row: 0, message: `${i.path.join(' › ')}: ${i.message}` })) });
  }
  const nothing = Object.values(r.changes!).every((x) => !x.length);
  if (req.query.apply !== '1' || nothing) return res.json({ ok: true, changes: r.changes, nothing, issues: findIssues(r.config, await roleKeysOf(s.tenant.id), coreFieldsFor(s.tenant.country)) });
  const issues = await cfg.saveDraft(s.tenant.id, r.config, s.user.id);
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'CONFIG_EXCEL_IMPORTED', detail: { file: req.file.originalname, ...Object.fromEntries(Object.entries(r.changes!).map(([k, v]) => [k, v.length])) }, ip: req.ip });
  res.json({ ok: true, applied: true, changes: r.changes, issues });
}));

configRouter.post('/admin/config/publish', requireStaff('config.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const { note } = z.object({ note: z.string().max(300).optional() }).parse(req.body ?? {});
  const r = await cfg.publishDraft(s.tenant.id, s.user.id, note);
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'CONFIG_PUBLISHED', detail: { version: r.version, note, added: r.diff.fieldsAdded.length, removed: r.diff.fieldsRemoved.length }, ip: req.ip });
  res.json(r);
}));

configRouter.get('/admin/config/versions/:version', requireStaff('config.manage'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  const row = await cfg.getVersion(tenant.id, Number(req.params.version));
  res.json({ version: row.version, status: row.status, config: row.config, note: row.note, publishedAt: row.publishedAt });
}));

configRouter.post('/admin/config/versions/:version/restore', requireStaff('config.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const issues = await cfg.restoreToDraft(s.tenant.id, Number(req.params.version), s.user.id);
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'CONFIG_VERSION_RESTORED_TO_DRAFT', detail: { version: Number(req.params.version) }, ip: req.ip });
  res.json({ ok: true, issues });
}));

/** Start a draft from the home country's default template (e.g. to undo heavy customisation). */
configRouter.post('/admin/config/reset-to-template', requireStaff('config.manage'), ah(async (req, res) => {
  const s = staffCtx(req);
  const issues = await cfg.saveDraft(s.tenant.id, cfg.templateFor(s.tenant.country), s.user.id);
  res.json({ ok: true, issues });
}));

/* ---------- Out-of-office delegation ---------- */

configRouter.get('/me/delegations', requireStaff(), ah(async (req, res) => {
  const s = staffCtx(req);
  const now = new Date();
  const mine = await db.query.delegations.findMany({ where: and(eq(delegations.tenantId, s.tenant.id), eq(delegations.fromUserId, s.user.id), gt(delegations.endsAt, now)), orderBy: asc(delegations.startsAt) });
  const covering = await db.select({ id: delegations.id, fromUserId: delegations.fromUserId, startsAt: delegations.startsAt, endsAt: delegations.endsAt, name: users.name })
    .from(delegations).innerJoin(users, eq(users.id, delegations.fromUserId))
    .where(and(eq(delegations.tenantId, s.tenant.id), eq(delegations.toUserId, s.user.id), gt(delegations.endsAt, now)));
  const colleagues = await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(and(eq(users.tenantId, s.tenant.id), eq(users.status, 'ACTIVE'))).orderBy(asc(users.name));
  const names = new Map(colleagues.map((c) => [c.id, c.name]));
  res.json({ mine: mine.map((d) => ({ ...d, toName: names.get(d.toUserId) })), covering, colleagues: colleagues.filter((c) => c.id !== s.user.id) });
}));

configRouter.post('/me/delegations', requireStaff(), ah(async (req, res) => {
  const s = staffCtx(req);
  const input = z.object({ toUserId: z.string(), startsAt: z.coerce.date(), endsAt: z.coerce.date(), reason: z.string().max(200).optional() }).parse(req.body);
  if (input.toUserId === s.user.id) throw new HttpError(400, 'Choose someone other than yourself');
  if (input.endsAt <= input.startsAt) throw new HttpError(400, 'End must be after start');
  if (input.endsAt.getTime() - input.startsAt.getTime() > 90 * 86_400_000) throw new HttpError(400, 'Delegations can last at most 90 days');
  const to = await db.query.users.findFirst({ where: and(eq(users.id, input.toUserId), eq(users.tenantId, s.tenant.id), eq(users.status, 'ACTIVE')) });
  if (!to) throw new HttpError(400, 'Choose an active colleague');
  const [row] = await db.insert(delegations).values({ tenantId: s.tenant.id, fromUserId: s.user.id, ...input }).returning();
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'DELEGATION_CREATED', detail: { to: to.name, from: input.startsAt.toISOString(), until: input.endsAt.toISOString() }, ip: req.ip });
  res.status(201).json(row);
}));

configRouter.delete('/me/delegations/:id', requireStaff(), ah(async (req, res) => {
  const s = staffCtx(req);
  const d = await db.query.delegations.findFirst({ where: and(eq(delegations.id, req.params.id), eq(delegations.tenantId, s.tenant.id)) });
  if (!d || (d.fromUserId !== s.user.id && !s.permissions.has('approvals.manage'))) throw new HttpError(404, 'Delegation not found');
  await db.delete(delegations).where(eq(delegations.id, d.id));
  await audit({ tenantId: s.tenant.id, actor: s.user.name, action: 'DELEGATION_ENDED', ip: req.ip });
  res.json({ ok: true });
}));

configRouter.get('/admin/delegations', requireStaff('approvals.manage'), ah(async (req, res) => {
  const { tenant } = staffCtx(req);
  const rows = await db.select().from(delegations).where(and(eq(delegations.tenantId, tenant.id), gt(delegations.endsAt, new Date()))).orderBy(desc(delegations.startsAt));
  res.json(rows);
}));
