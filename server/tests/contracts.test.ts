/** Contracts step 0: modules, configuration, parties, the repository, imports and end dates. */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import ExcelJS from 'exceljs';
import { and, eq } from 'drizzle-orm';
import { login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import type { Tenant } from '../src/db/schema.js';
import { resolveFeatures } from '../src/lib/features.js';
import { effectiveLimits } from '../src/lib/plans.js';
import { runContractEndDates } from '../src/services/contracts/contracts.js';

let acme: Tenant;
let original: Pick<Tenant, 'settings' | 'limits' | 'plan'>;
const setLimits = (limits: object, plan?: string) => db.update(schema.tenants).set({ limits, ...(plan ? { plan } : {}) }).where(eq(schema.tenants.id, acme.id));
const PDF = '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF';
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  acme = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
  original = { settings: acme.settings, limits: acme.limits, plan: acme.plan };
});
afterAll(async () => { await db.update(schema.tenants).set(original).where(eq(schema.tenants.id, acme.id)); });

describe('modules', () => {
  test('contracts is an add-on; onboarding can be switched off, and what needs it goes with it', () => {
    expect(resolveFeatures({})).toMatchObject({ onboarding: true, contracts: false });
    expect(resolveFeatures({ onboarding: false, sourcing: true, collab: true, contracts: true })).toMatchObject({ onboarding: false, sourcing: false, collab: false, contracts: true });
    expect(effectiveLimits({ plan: 'contracts', limits: {} }).features).toMatchObject({ onboarding: false, contracts: true, sourcing: false });
  });

  test('a Contracts-only workspace has no onboarding screens; Contracts is 404 until switched on', async () => {
    const admin = await login('admin@acme.test');
    expect((await admin.get('/api/staff/contracts')).status).toBe(404);
    await setLimits({}, 'contracts');
    expect((await admin.get('/api/staff/vendors')).status).toBe(404);
    expect((await admin.get('/api/reports/dashboard')).status).toBe(404);
    expect((await admin.get('/api/admin/config')).status).toBe(404);
    expect((await admin.get('/api/admin/users')).status).toBe(200);
    const me = (await admin.get('/api/auth/me')).body;
    expect(me.plan.features).toMatchObject({ onboarding: false, contracts: true });
    expect(me.contracts.on).toBe(false);
    await setLimits(original.limits as object, original.plan);
  });
});

describe('configuration', () => {
  test('switching on needs the plan; types and options as released; locked rules', async () => {
    const admin = await login('admin@acme.test');
    await setLimits({ features: { contracts: false } });
    expect((await admin.put('/api/admin/contracts', { enabled: true, types: { msa: true } })).status).toBe(403);
    await setLimits({ features: { contracts: true } });
    expect((await admin.put('/api/admin/contracts', { enabled: true, types: {} })).body.error).toMatch(/at least one contract type/);
    expect((await admin.put('/api/admin/contracts', { enabled: true, types: { msa: true }, features: { esign: true } })).body.error).toMatch(/isn’t available yet/);
    const r = await admin.put('/api/admin/contracts', { enabled: true, types: { msa: true, sow: true, nda: true, supply: true, sales: true }, rules: { expiringDays: 60 }, locked: ['noticeDays'] });
    expect(r.status).toBe(200);
    expect(r.body.changes).toEqual(expect.arrayContaining(['Contracts on', 'Show as expiring: 90 → 60', 'Notice period locked']));
    expect(r.body.types.find((k: any) => k.key === 'msa')).toMatchObject({ on: true, prefix: 'MSA' });
    expect((await admin.get('/api/auth/me')).body.contracts).toMatchObject({ on: true, directions: ['BUY', 'SELL'] });
    const roles = (await admin.get('/api/admin/roles')).body;
    expect(JSON.stringify(roles)).toContain('contracts.manage');
  });
});

describe('parties', () => {
  test('create suppliers and customers, look-alikes, link to an onboarded supplier, send one for onboarding', async () => {
    const admin = await login('admin@acme.test');
    const sup = await admin.post('/api/staff/parties', { kind: 'SUPPLIER', name: 'Kestrel Engineering', country: 'IN', taxNo: '27AAACK1234A1Z9', contacts: [{ name: 'Asha Nair', email: 'asha@kestrel.example', phone: '9811122233', signatory: true }] });
    expect(sup.status).toBe(201);
    expect(sup.body.party.code).toMatch(/^SUP-\d{5}$/);
    const dup = await admin.post('/api/staff/parties', { kind: 'SUPPLIER', name: 'kestrel engineering', country: 'IN' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('POSSIBLE_DUPLICATE');
    const cus = await admin.post('/api/staff/parties', { kind: 'CUSTOMER', name: 'Northwind Retail', country: 'AE', website: 'javascript:alert(1)' });
    expect(cus.body.error).toMatch(/website must start/);
    expect((await admin.post('/api/staff/parties', { kind: 'CUSTOMER', name: 'Northwind Retail', country: 'AE' })).body.party.code).toMatch(/^CUS-/);
    const list = (await admin.get('/api/staff/parties?kind=CUSTOMER')).body;
    expect(list.parties.map((p: any) => p.name)).toContain('Northwind Retail');

    // Link to the onboarded supplier, and a party for a supplier straight from the supplier record.
    const precision = (await db.query.vendors.findFirst({ where: and(eq(schema.vendors.tenantId, acme.id), eq(schema.vendors.name, 'Precision Valves Pvt Ltd')) }))!;
    const fromSupplier = (await admin.post('/api/staff/parties/from-supplier', { vendorId: precision.id })).body.party;
    expect(fromSupplier).toMatchObject({ kind: 'SUPPLIER', name: 'Precision Valves Pvt Ltd', vendorId: precision.id });
    expect((await admin.post('/api/staff/parties/from-supplier', { vendorId: precision.id })).body.party.id).toBe(fromSupplier.id);
    expect((await admin.post(`/api/staff/parties/${sup.body.party.id}/link`, { vendorId: precision.id })).body.error).toMatch(/already linked/);
    const onboarded = await admin.post(`/api/staff/parties/${sup.body.party.id}/onboard`);
    expect(onboarded.status).toBe(200);
    expect(onboarded.body.supplier).toMatchObject({ name: 'Kestrel Engineering', status: 'INVITED' });
    expect((await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, 'asha@kestrel.example') }))).toBeTruthy();
  });
});

describe('repository', () => {
  let supplierId = '', customerId = '';
  beforeAll(async () => {
    const p = await db.query.parties.findFirst({ where: and(eq(schema.parties.tenantId, acme.id), eq(schema.parties.name, 'Kestrel Engineering')) });
    const c = await db.query.parties.findFirst({ where: and(eq(schema.parties.tenantId, acme.id), eq(schema.parties.name, 'Northwind Retail')) });
    supplierId = p!.id; customerId = c!.id;
  });

  test('drafts, checks, numbering, statements of work under a master agreement', async () => {
    const admin = await login('admin@acme.test');
    const base = { title: 'Engineering services MSA', direction: 'BUY', type: 'msa', partyId: supplierId, value: 2500000, startDate: iso(-10), endDate: iso(355) };
    expect((await admin.post('/api/staff/contracts', { ...base, partyId: customerId })).body.error).toMatch(/needs a supplier/);
    expect((await admin.post('/api/staff/contracts', { ...base, type: 'sales' })).body.error).toMatch(/isn’t included|switched off|only for customer/);
    expect((await admin.post('/api/staff/contracts', { ...base, endDate: iso(-20) })).body.error).toMatch(/end date is before/);
    expect((await admin.post('/api/staff/contracts', { ...base, noticeDays: 10 })).body.error).toMatch(/Notice period is set by your administrator/);
    const msa = await admin.post('/api/staff/contracts', base);
    expect(msa.status).toBe(201);
    const year = new Date().getUTCFullYear();
    expect(msa.body.contract).toMatchObject({ number: `MSA-${year}-0001`, status: 'DRAFT', currency: 'INR', noticeDays: 30 });
    const sow = await admin.post('/api/staff/contracts', { ...base, title: 'Phase 1 SOW', type: 'sow', value: 400000, parentId: msa.body.contract.id });
    expect(sow.body.parent.number).toBe(msa.body.contract.number);
    expect((await admin.post('/api/staff/contracts', { ...base, title: 'Bad SOW', type: 'sow', parentId: sow.body.contract.id })).body.error).toMatch(/master agreement/);
    expect((await admin.get(`/api/staff/contracts/${msa.body.contract.id}`)).body.children).toHaveLength(1);

    // Signing needs the signed copy; then only some fields change.
    const id = msa.body.contract.id;
    expect((await admin.post(`/api/staff/contracts/${id}/signed`, { signedDate: iso(-5) })).body.error).toMatch(/signed copy/);
    const up = await admin.agent.post(`/api/staff/contracts/${id}/files`).set('X-Requested-With', 'fetch').field('kind', 'SIGNED').attach('file', Buffer.from(PDF), { filename: 'msa-signed.pdf', contentType: 'application/pdf' });
    expect(up.status).toBe(201);
    const fileId = up.body.files[0].id;
    expect((await admin.get(`/api/staff/contracts/files/${fileId}`)).headers['content-type']).toMatch(/pdf/);
    const signed = await admin.post(`/api/staff/contracts/${id}/signed`, { signedDate: iso(-5) });
    expect(signed.body.contract).toMatchObject({ status: 'ACTIVE', signedDate: iso(-5) });
    expect((await admin.patch(`/api/staff/contracts/${id}`, { value: 1 })).body.error).toMatch(/through an amendment/);
    expect((await admin.patch(`/api/staff/contracts/${id}`, { category: 'Engineering', autoRenew: true })).body.contract).toMatchObject({ category: 'Engineering', autoRenew: true });
    expect((await admin.del(`/api/staff/contracts/${id}/files/${fileId}`)).body.error).toMatch(/signed copy of a signed contract is kept/);
    expect((await admin.del(`/api/staff/contracts/${id}`)).body.error).toMatch(/Only drafts/);

    // Customer contract, and lists.
    const nda = await admin.post('/api/staff/contracts', { title: 'Mutual NDA', direction: 'SELL', type: 'nda', partyId: customerId, startDate: iso(-400), endDate: iso(30), signedDate: iso(-400), signed: true });
    expect(nda.body.contract).toMatchObject({ status: 'ACTIVE', expiring: true, daysLeft: 30 });
    const exp = (await admin.get('/api/staff/contracts?filter=expiring')).body;
    expect(exp.contracts.map((c: any) => c.number)).toEqual([nda.body.contract.number]);
    expect(exp.expiring).toBe(1);
    expect((await admin.get('/api/staff/contracts?direction=BUY&pageSize=1')).body).toMatchObject({ total: 2, pageSize: 1 });
    expect((await admin.get(`/api/staff/contracts?q=Northwind`)).body.total).toBe(1);

    // Terminate, delete a draft, history.
    expect((await admin.post(`/api/staff/contracts/${nda.body.contract.id}/terminate`, { reason: 'Project cancelled' })).body.contract.status).toBe('TERMINATED');
    expect((await admin.del(`/api/staff/contracts/${sow.body.contract.id}`)).status).toBe(200);
    const d = (await admin.get(`/api/staff/contracts/${id}`)).body;
    expect(d.history.map((h: any) => h.action)).toEqual(expect.arrayContaining(['CONTRACT_CREATED', 'CONTRACT_FILE_ADDED', 'CONTRACT_SIGNED', 'CONTRACT_UPDATED']));
    expect((await admin.post(`/api/staff/parties/${supplierId}/archive`)).body.error).toMatch(/draft or active contract/);
  });

  test('end dates: contracts expire, or roll on when they renew automatically', async () => {
    const admin = await login('admin@acme.test');
    const mk = async (title: string, autoRenew: boolean) => (await admin.post('/api/staff/contracts', { title, direction: 'BUY', type: 'supply', partyId: supplierId, value: 1000, startDate: iso(-400), endDate: iso(-2), signedDate: iso(-400), autoRenew, renewalTermMonths: 12, signed: true })).body.contract;
    const a = await mk('Lapsed rate contract', false), b = await mk('Rolling rate contract', true);
    expect(a.status).toBe('EXPIRED'); // already past its end when recorded
    await db.update(schema.contracts).set({ status: 'ACTIVE' }).where(eq(schema.contracts.id, a.id));
    await db.update(schema.contracts).set({ status: 'ACTIVE' }).where(eq(schema.contracts.id, b.id));
    const r = await runContractEndDates();
    expect(r).toMatchObject({ expired: 1, renewed: 1 });
    expect((await db.query.contracts.findFirst({ where: eq(schema.contracts.id, a.id) }))!.status).toBe('EXPIRED');
    expect((await db.query.contracts.findFirst({ where: eq(schema.contracts.id, b.id) }))!.endDate! > iso(300)).toBe(true);
  });

  test('a user without the contracts permissions sees nothing', async () => {
    const tax = await login('tax@acme.test');
    expect((await tax.get('/api/staff/contracts')).status).toBe(403);
    expect((await tax.post('/api/staff/parties', { kind: 'SUPPLIER', name: 'X Co', country: 'IN' })).status).toBe(403);
  });
});

describe('Excel imports', () => {
  async function fill(url: string, sheet: string, rows: (string | number)[][]) {
    const admin = await login('admin@acme.test');
    const tpl = await admin.agent.get(url).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (c: Buffer) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(tpl.body);
    const ws = wb.getWorksheet(sheet)!;
    rows.forEach((r, i) => r.forEach((v, j) => { ws.getCell(i + 2, j + 1).value = v; }));
    return { admin, file: Buffer.from(await wb.xlsx.writeBuffer()) };
  }

  test('parties: checked first, then created; problems reported per row', async () => {
    const { admin, file } = await fill('/api/staff/parties/import-template.xlsx', 'Parties', [
      ['Supplier', 'Orion Logistics', '', 'IN', '', 'AAACO1111A', '', 'Mumbai', '', '', '', '', '', 'Ravi', 'ravi@orion.example', '', 'Yes'],
      ['Customer', 'Northwind Retail', '', 'AE'],
      ['Partner', 'Nobody', '', 'IN'],
    ]);
    const check = await admin.agent.post('/api/staff/parties/import').set('X-Requested-With', 'fetch').attach('file', file, 'p.xlsx');
    expect(check.body.ready.map((r: any) => r.name)).toEqual(['Orion Logistics']);
    expect(check.body.errors.map((e: any) => e.message)).toEqual([expect.stringMatching(/existing party/), 'Type must be Supplier or Customer']);
    expect(check.body.created).toEqual([]);
    const done = await admin.agent.post('/api/staff/parties/import?commit=1').set('X-Requested-With', 'fetch').attach('file', file, 'p.xlsx');
    expect(done.body.created).toHaveLength(1);
    const orion = await db.query.parties.findFirst({ where: and(eq(schema.parties.tenantId, acme.id), eq(schema.parties.name, 'Orion Logistics')) });
    expect(orion!.contacts[0]).toMatchObject({ name: 'Ravi', signatory: true });
  });

  test('existing contracts: matched to parties (or created), active or expired by their dates', async () => {
    const { admin, file } = await fill('/api/staff/contracts/import-template.xlsx', 'Contracts', [
      ['Supplier', 'Orion Logistics', '', 'Supply / rate contract', 'Freight rate contract', 'OL/26/3', 1200000, 'INR', iso(-100), iso(265), iso(-101), 'Yes', 12, 30, 'buyer@acme.test', 'Logistics', ''],
      ['Customer', 'Blue Harbour Trading', 'AE', 'Non-disclosure agreement (NDA)', 'NDA — Blue Harbour', '', '', '', iso(-800), iso(-70), iso(-800), 'No', '', '', '', '', ''],
      ['Supplier', 'Orion Logistics', '', 'Lease / rental', 'Warehouse lease', '', 50000, '', iso(-10), '', iso(-10), 'No', '', '', '', '', ''],
      ['Supplier', 'Orion Logistics', '', 'Supply / rate contract', 'No dates', '', 1, '', '', '', '', 'No', '', '', 'nobody@acme.test', '', ''],
    ]);
    const check = await admin.agent.post('/api/staff/contracts/import').set('X-Requested-With', 'fetch').attach('file', file, 'c.xlsx');
    expect(check.body.errors.map((e: any) => [e.row, e.message]), JSON.stringify(check.body.errors)).toEqual([
      [3, expect.stringMatching(/not found .*Create missing parties/)],
      [4, expect.stringMatching(/Lease \/ rental is switched off/)],
      [5, expect.stringMatching(/No user with the email/)],
    ]);
    const done = await admin.agent.post('/api/staff/contracts/import?commit=1&createParties=1').set('X-Requested-With', 'fetch').attach('file', file, 'c.xlsx');
    expect(done.body.created.map((c: any) => c.title)).toEqual(['Freight rate contract', 'NDA — Blue Harbour']);
    const rows = (await admin.get('/api/staff/contracts?q=Harbour')).body.contracts;
    expect(rows[0]).toMatchObject({ status: 'EXPIRED', direction: 'SELL', party: { name: 'Blue Harbour Trading' } });
    const freight = (await admin.get('/api/staff/contracts?q=OL%2F26%2F3')).body.contracts[0];
    expect(freight).toMatchObject({ status: 'ACTIVE', reference: 'OL/26/3', autoRenew: true, owner: 'Rahul Verma' });
  });
});
