import { describe, expect, test } from 'vitest';
import { client, login, lastLinkTo, tokenOf, globexAdmin } from './helpers.js';
import { conditionHolds, ruleHolds } from '../src/lib/conditions.js';

async function vendorSession(admin: Awaited<ReturnType<typeof login>>, name: string, email: string, vendorType = 'DOMESTIC') {
  const r = await admin.post('/api/staff/vendors', { name, vendorType, contactFirstName: 'T', contactLastName: 'V', contactEmail: email, contactMobile: '9800011111' });
  expect(r.status).toBe(201);
  const token = tokenOf((await lastLinkTo(email))!);
  const v = client();
  const { devOtp } = (await v.post('/api/vendor-auth/request-otp', { token })).body;
  await v.post('/api/vendor-auth/verify-otp', { token, code: devOtp });
  return { v, id: r.body.vendor.id as string };
}

describe('condition engine', () => {
  const ctx = { profile: { risk: { annualTurnover: '60000000' }, basic: { supplierCountry: '' } }, vendor: { vendorType: 'IMPORT' } };
  test('operators', () => {
    expect(conditionHolds({ field: 'risk.annualTurnover', op: 'gt', value: 50000000 }, ctx)).toBe(true);
    expect(conditionHolds({ field: 'risk.annualTurnover', op: 'lte', value: 50000000 }, ctx)).toBe(false);
    expect(conditionHolds({ field: 'vendor.vendorType', op: 'in', value: ['IMPORT', 'GOVERNMENT'] }, ctx)).toBe(true);
    expect(conditionHolds({ field: 'basic.supplierCountry', op: 'neq', value: 'India' }, ctx)).toBe(false); // empty never matches neq
    expect(conditionHolds({ field: 'basic.supplierCountry', op: 'empty' }, ctx)).toBe(true);
    expect(ruleHolds({ match: 'any', conditions: [{ field: 'vendor.vendorType', op: 'eq', value: 'DOMESTIC' }, { field: 'risk.annualTurnover', op: 'gte', value: 1 }] }, ctx)).toBe(true);
    expect(ruleHolds({ match: 'all', conditions: [{ field: 'vendor.vendorType', op: 'eq', value: 'DOMESTIC' }, { field: 'risk.annualTurnover', op: 'gte', value: 1 }] }, ctx)).toBe(false);
  });
});

describe('configuration editor', () => {
  test('only config.manage can read or edit; tenants are isolated', async () => {
    expect((await (await login('tax@acme.test')).get('/api/admin/config')).status).toBe(403);
    const acme = (await (await login('admin@acme.test')).get('/api/admin/config')).body;
    expect(acme.published.config.workflow.levels.map((l: any) => l.id)).toContain('compliance');
    const glob = (await (await globexAdmin()).get('/api/admin/config')).body;
    expect(glob.published.config.workflow.levels.map((l: any) => l.id)).not.toContain('compliance');
  });

  test('draft → validation issues → publish → new field reaches the vendor portal and checklist', async () => {
    const admin = await login('admin@acme.test');
    const state = (await admin.get('/api/admin/config')).body;
    const config = structuredClone(state.published.config);
    const basic = config.sections.find((s: any) => s.key === 'basic');

    // 1. Broken reference + deleted core field → saved as draft, but publish refused
    const broken = structuredClone(config);
    broken.sections[0].groups[0].fields = broken.sections[0].groups[0].fields.filter((f: any) => f.key !== 'vendorName');
    broken.sections[0].groups[0].fields.push({ key: 'promo', label: 'Promo', type: 'text', showIf: { field: 'basic.nope', op: 'eq', value: 'x' } });
    const saved = await admin.put('/api/admin/config/draft', { config: broken });
    expect(saved.status).toBe(200);
    expect(saved.body.issues.map((i: any) => i.message).join(' ')).toMatch(/basic\.vendorName/);
    expect(saved.body.issues.map((i: any) => i.message).join(' ')).toMatch(/basic\.nope/);
    const refused = await admin.post('/api/admin/config/publish', {});
    expect(refused.status).toBe(422);

    // structurally invalid config rejected outright
    expect((await admin.put('/api/admin/config/draft', { config: { ...config, sections: [] } })).status).toBe(400);

    // 2. Valid change: add a required custom field in a new group, plus a document
    basic.groups.push({ key: 'esg', label: 'Sustainability', fields: [
      { key: 'iso14001', label: 'ISO 14001 certified?', type: 'radio', options: ['Yes', 'No'], required: true },
      { key: 'isoCertNo', label: 'ISO certificate number', type: 'text', required: { field: 'basic.iso14001', op: 'eq', value: 'Yes' }, showIf: { field: 'basic.iso14001', op: 'eq', value: 'Yes' } },
    ] });
    config.documents.push({ type: 'ISO_CERT', label: 'ISO 14001 certificate', required: { field: 'basic.iso14001', op: 'eq', value: 'Yes' }, showIf: { field: 'basic.iso14001', op: 'eq', value: 'Yes' }, hasExpiry: true });
    const ok = await admin.put('/api/admin/config/draft', { config });
    expect(ok.body.issues).toEqual([]);
    const pub = await admin.post('/api/admin/config/publish', { note: 'Add ESG questions' });
    expect(pub.status).toBe(200);
    expect(pub.body.diff.fieldsAdded).toEqual(['basic.iso14001', 'basic.isoCertNo']);
    expect(pub.body.diff.documentsAdded).toEqual(['ISO_CERT']);

    const { v } = await vendorSession(admin, 'Config Flow Co', 'cfg@flow.test');
    const me = (await v.get('/api/vendor')).body;
    expect(me.config.sections[0].groups.map((g: any) => g.key)).toContain('esg');
    expect(me.checklist.find((c: any) => c.id === 'basic.iso14001')?.ok).toBe(false);
    const after = await v.put('/api/vendor/profile/basic', { iso14001: 'Yes' });
    expect(after.body.checklist.find((c: any) => c.id === 'basic.isoCertNo')?.ok).toBe(false);
    expect(after.body.docRequirements.map((d: any) => d.type)).toContain('ISO_CERT');
    // a key not in the config is dropped
    await v.put('/api/vendor/profile/basic', { notAField: 'x', isoCertNo: 'EMS-123' });
    const prof = (await v.get('/api/vendor')).body.vendor.profile.basic;
    expect(prof.notAField).toBeUndefined();
    expect(prof.isoCertNo).toBe('EMS-123');

    // 3. Version history + restore
    const hist = (await admin.get('/api/admin/config')).body.versions;
    expect(hist[0]).toMatchObject({ status: 'PUBLISHED', note: 'Add ESG questions' });
    expect((await admin.post(`/api/admin/config/versions/${hist[1].version}/restore`)).status).toBe(200);
    expect((await admin.get('/api/admin/config')).body.draft).not.toBeNull();
    await admin.del('/api/admin/config/draft');
    expect((await admin.get('/api/admin/config')).body.draft).toBeNull();

    // leave the workspace as we found it for other test files
    await admin.post(`/api/admin/config/versions/${hist[1].version}/restore`);
    expect((await admin.post('/api/admin/config/publish', { note: 'revert' })).status).toBe(200);
  });

  test('roles used by the approval flow cannot be deleted; unknown role refused at publish', async () => {
    const admin = await login('admin@acme.test');
    const { roles } = (await admin.get('/api/admin/roles')).body;
    const compliance = roles.find((r: any) => r.key === 'COMPLIANCE');
    await admin.patch(`/api/admin/users/${(await admin.get('/api/admin/users')).body.find((u: any) => u.email === 'compliance@acme.test').id}`, { roleIds: [roles.find((r: any) => r.key === 'VIEWER').id] });
    expect((await admin.del(`/api/admin/roles/${compliance.id}`)).status).toBe(409);
    await admin.patch(`/api/admin/users/${(await admin.get('/api/admin/users')).body.find((u: any) => u.email === 'compliance@acme.test').id}`, { roleIds: [compliance.id] });

    const config = (await admin.get('/api/admin/config')).body.published.config;
    config.workflow.levels[0].roleKey = 'NO_SUCH_ROLE';
    const r = await admin.put('/api/admin/config/draft', { config });
    expect(r.body.issues.some((i: any) => /role that doesn/.test(i.message))).toBe(true);
    await admin.del('/api/admin/config/draft');
  });
});

describe('rule-based approval flow, SLA, reassignment, delegation', () => {
  test('import vendors get the Compliance level; domestic ones do not', async () => {
    const admin = await login('admin@acme.test');
    const { sweepOverdue, applicableLevels } = await import('../src/services/workflowEngine.js');
    const { getConfig } = await import('../src/services/config.js');
    const me = (await admin.get('/api/auth/me')).body;
    const cfg = await getConfig(me.tenant.id);
    expect(applicableLevels(cfg.workflow.levels, { vendorType: 'IMPORT', profile: {} }).map((l) => l.id)).toEqual(['tax', 'compliance', 'finance', 'mdm']);
    expect(applicableLevels(cfg.workflow.levels, { vendorType: 'DOMESTIC', profile: {} }).map((l) => l.id)).toEqual(['tax', 'finance', 'mdm']);
    void sweepOverdue;
  });

  test('reassign to a person, delegate while away, overdue escalation', async () => {
    const admin = await login('admin@acme.test');
    const kaveri = (await admin.get('/api/staff/vendors?status=UNDER_REVIEW')).body.vendors.find((v: any) => v.name.startsWith('Kaveri'));
    const detail = (await admin.get(`/api/staff/vendors/${kaveri.id}`)).body;
    expect(detail.canReassign).toBe(true);
    const step = detail.vendor.steps.find((s: any) => s.status === 'PENDING');
    expect(step.dueAt).toBeTruthy();

    // Reassign Finance step to Vikram (MDM) — Meera (finance role) can no longer act, Vikram can.
    const people = (await admin.get(`/api/staff/vendors/${kaveri.id}/assignable`)).body;
    const vikram = people.find((p: any) => p.email === 'mdm@acme.test');
    expect(people[0].holdsRole).toBe(true);
    expect((await admin.post(`/api/staff/vendors/${kaveri.id}/steps/${step.id}/assign`, { userId: vikram.id })).status).toBe(200);
    const meera = await login('finance@acme.test');
    expect((await meera.get(`/api/staff/vendors/${kaveri.id}`)).body.canAct).toBe(false);
    expect((await meera.get('/api/staff/vendors?mine=true')).body.vendors.map((v: any) => v.id)).not.toContain(kaveri.id);
    const mdm = await login('mdm@acme.test');
    expect((await mdm.get('/api/staff/vendors?mine=true')).body.vendors.map((v: any) => v.id)).toContain(kaveri.id);

    // Vikram goes on leave and delegates to Suresh (tax) → Suresh can act on it.
    const tax = await login('tax@acme.test');
    const suresh = (await tax.get('/api/auth/me')).body.user;
    const now = Date.now();
    expect((await mdm.post('/api/me/delegations', { toUserId: suresh.id, startsAt: new Date(now - 60_000), endsAt: new Date(now - 120_000) })).status).toBe(400);
    const del = await mdm.post('/api/me/delegations', { toUserId: suresh.id, startsAt: new Date(now - 60_000), endsAt: new Date(now + 86_400_000), reason: 'Annual leave' });
    expect(del.status).toBe(201);
    expect((await tax.get('/api/me/delegations')).body.covering[0].name).toBe('Vikram Shah');
    expect((await tax.get('/api/staff/vendors?mine=true')).body.vendors.map((v: any) => v.id)).toContain(kaveri.id);

    // Make the step overdue → sweep sends reminder + escalation once
    const { db, schema } = await import('../src/lib/db.js');
    const { eq } = await import('drizzle-orm');
    await db.update(schema.approvalSteps).set({ dueAt: new Date(now - 3600_000) }).where(eq(schema.approvalSteps.id, step.id));
    const listed = (await admin.get('/api/staff/vendors?status=UNDER_REVIEW')).body.vendors.find((v: any) => v.id === kaveri.id);
    expect(listed.pendingStep.overdue).toBe(true);
    expect(listed.pendingStep.assignee).toBe('Vikram Shah');
    const { sweepOverdue } = await import('../src/services/workflowEngine.js');
    expect(await sweepOverdue()).toBe(1);
    expect(await sweepOverdue()).toBe(0);
    expect(await lastLinkTo('admin@acme.test')).toContain(kaveri.id); // escalation email to approvals.manage holders

    // Suresh approves on Vikram's behalf; audit records it as a delegate action
    const r = await tax.post(`/api/staff/vendors/${kaveri.id}/decision`, { action: 'APPROVE', remarks: 'Covering for Vikram' });
    expect(r.body.nextLevel).toBe('Master Data Approval');
    const audit = (await admin.get(`/api/staff/vendors/${kaveri.id}`)).body.vendor.audit;
    expect(audit.find((a: any) => a.action === 'STEP_APPROVED')?.detail.as).toBe('delegate');

    // Ending the delegation removes the access
    await mdm.del(`/api/me/delegations/${del.body.id}`);
    expect((await tax.get('/api/staff/vendors?mine=true')).body.vendors.map((v: any) => v.id)).not.toContain(kaveri.id);

    // restore Kaveri to "waiting for Finance" for other test files
    const { and } = await import('drizzle-orm');
    await db.update(schema.approvalSteps).set({ status: 'PENDING', assigneeUserId: null, actedById: null, actedAt: null, remarks: null, remindedAt: null, dueAt: new Date(now + 86_400_000) }).where(eq(schema.approvalSteps.id, step.id));
    await db.update(schema.approvalSteps).set({ status: 'WAITING', activatedAt: null, dueAt: null }).where(and(eq(schema.approvalSteps.vendorId, kaveri.id), eq(schema.approvalSteps.level, 3)));
  });
});
