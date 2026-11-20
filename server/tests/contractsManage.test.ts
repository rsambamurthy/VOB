/** Contracts step 3: amendments, obligations and reminders, renewal / notice alerts, prices and price checks, ERP, kept files. */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { and, desc, eq, like } from 'drizzle-orm';
import PizZip from 'pizzip';
import { invitedSupplier, login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import type { Tenant } from '../src/db/schema.js';
import { readBytes } from '../src/integrations/storage/index.js';
import { priceCheck, runContractReminders } from '../src/services/contracts/manage.js';
import { csvFor, genericEvent, oracleBody } from '../src/services/orders/outbound.js';

let acme: Tenant;
let original: Pick<Tenant, 'settings' | 'limits' | 'plan'>;
const PDF = '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF';
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const tenant = async () => (await db.query.tenants.findFirst({ where: eq(schema.tenants.id, acme.id) }))!;
const mailsTo = (to: string, subject: string) => db.select().from(schema.emailOutbox).where(and(eq(schema.emailOutbox.to, to), like(schema.emailOutbox.subject, `%${subject}%`)));

beforeAll(async () => {
  acme = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
  original = { settings: acme.settings, limits: acme.limits, plan: acme.plan };
  await db.update(schema.tenants).set({ limits: { features: { contracts: true, collab: true, erp: true } } }).where(eq(schema.tenants.id, acme.id));
  const admin = await login('admin@acme.test');
  const r = await admin.put('/api/admin/contracts', { enabled: true, types: { service: true, supply: true, nda: true }, features: { internalApproval: false, obligations: true, renewalAlerts: true, priceCompliance: true, contractToErp: true, watch: false }, rules: { priceTolerance: 5 } });
  expect(r.status).toBe(200);
});
afterAll(async () => { await db.update(schema.tenants).set(original).where(eq(schema.tenants.id, acme.id)); });

async function activeContract(admin: Awaited<ReturnType<typeof login>>, name: string, extra: object = {}, partyExtra: object = {}) {
  const party = (await admin.post('/api/staff/parties', { kind: 'SUPPLIER', name, country: 'IN', ...partyExtra })).body.party ?? partyExtra;
  const me = (await admin.get('/api/auth/me')).body.user;
  const c = await admin.post('/api/staff/contracts', { title: `Service — ${name}`, direction: 'BUY', type: 'service', partyId: party.id, value: 1200000, currency: 'INR', startDate: iso(-30), endDate: iso(335), signedDate: iso(-31), noticeDays: 30, ownerId: me.id, signed: true, ...extra });
  expect(c.status).toBe(201);
  return c.body;
}

describe('amendments', () => {
  test('an amendment is a contract under the one it changes; signing it applies the changes', async () => {
    const admin = await login('admin@acme.test');
    const c = await activeContract(admin, 'Amend Me Services');
    expect(c.manage.canAmend).toBe(true);
    expect((await admin.post(`/api/staff/contracts/${c.contract.id}/amendments`, {})).body.error).toMatch(/Say what the amendment changes/);
    const a = await admin.post(`/api/staff/contracts/${c.contract.id}/amendments`, { endDate: iso(700), value: 1500000, description: 'Two more units are added to the scope.' });
    expect(a.status).toBe(201);
    expect(a.body.contract).toMatchObject({ type: 'amendment', status: 'DRAFT', parentId: c.contract.id });
    expect(a.body.contract.number).toMatch(/^AMD-\d{4}-\d{4}$/);
    expect(a.body.manage.amends.lines).toEqual([expect.stringMatching(/^The end date is changed from .* to /), 'The total consideration is changed to INR 15,00,000.00 (INR Fifteen lakh only).', 'Two more units are added to the scope.']);
    expect((await admin.post(`/api/staff/contracts/${c.contract.id}/amendments`, { endDate: iso(800) })).body.error).toMatch(/already being prepared/);
    // Drafted from the built-in amendment template: the changes print as (a), (b), (c).
    const tpl = a.body.drafting.templates.find((x: any) => x.name === 'Amendment agreement');
    expect(tpl).toBeTruthy();
    await admin.post(`/api/staff/contracts/${a.body.contract.id}/draft`, { templateId: tpl.id });
    const made = (await admin.post(`/api/staff/contracts/${a.body.contract.id}/document`)).body;
    const docx = made.files.find((f: any) => f.generated && f.fileName.endsWith('.docx'));
    const text = new PizZip(await readBytes((await db.query.contractFiles.findFirst({ where: eq(schema.contractFiles.id, docx.id) }))!)).file('word/document.xml')!.asText().replace(/<[^>]+>/g, '');
    expect(text).toContain(`changes Service — Amend Me Services (${c.contract.number})`);
    expect(text).toContain('(b) The total consideration is changed to INR 15,00,000.00');
    // Signed → the contract changes.
    await admin.agent.post(`/api/staff/contracts/${a.body.contract.id}/files`).set('X-Requested-With', 'fetch').field('kind', 'SIGNED').attach('file', Buffer.from(PDF), { filename: 'amendment-signed.pdf', contentType: 'application/pdf' });
    const signed = await admin.post(`/api/staff/contracts/${a.body.contract.id}/signed`, { signedDate: iso(0) });
    expect(signed.body.contract.status).toBe('ACTIVE');
    const parent = (await admin.get(`/api/staff/contracts/${c.contract.id}`)).body;
    expect(parent.contract).toMatchObject({ endDate: iso(700), value: 1500000 });
    expect(parent.manage.amendments).toEqual([expect.objectContaining({ number: a.body.contract.number, status: 'ACTIVE', applied: true })]);
    expect(parent.history.map((h: any) => h.action)).toContain('CONTRACT_AMENDED');
    expect(parent.manage.canAmend).toBe(true);
  });
});

describe('obligations and alerts', () => {
  test('obligations with owners, recurrence and reminders; renewal and notice alerts go once', async () => {
    const admin = await login('admin@acme.test');
    const c = await activeContract(admin, 'Obligation Services', { endDate: iso(40), noticeDays: 30 });
    let d = (await admin.post(`/api/staff/contracts/${c.contract.id}/obligations`, { title: 'Monthly service report', kind: 'REPORT', side: 'PARTY', dueDate: iso(3), recurrence: 'MONTHLY', remindDays: 5 })).body;
    d = (await admin.post(`/api/staff/contracts/${c.contract.id}/obligations`, { title: 'Pay the advance', kind: 'PAYMENT', side: 'US', dueDate: iso(-2), amount: 200000 })).body;
    expect(d.manage.obligations.map((o: any) => [o.title, o.overdue, o.dueSoon])).toEqual([['Pay the advance', true, false], ['Monthly service report', false, true]]);
    expect((await admin.post(`/api/staff/contracts/${c.contract.id}/obligations`, { title: 'x', kind: 'NOPE', side: 'US', dueDate: iso(1) })).status).toBe(400);
    const list = (await admin.get('/api/staff/contracts/obligations?filter=overdue')).body;
    expect(list.obligations.map((o: any) => o.title)).toContain('Pay the advance');
    expect(list.overdue).toBeGreaterThanOrEqual(1);

    const r = await runContractReminders();
    expect(r.reminded).toBeGreaterThanOrEqual(2);
    expect((await mailsTo('admin@acme.test', 'Overdue: Pay the advance')).length).toBe(1);
    expect((await mailsTo('admin@acme.test', 'Due soon: Monthly service report')).length).toBe(1);
    expect((await mailsTo('admin@acme.test', `Ending soon: ${c.contract.number}`)).length).toBe(1);
    expect((await mailsTo('admin@acme.test', `: ${c.contract.number}`)).filter((m) => m.subject.startsWith('Notice due by')).length).toBe(1);
    await runContractReminders();
    expect((await mailsTo('admin@acme.test', `Ending soon: ${c.contract.number}`)).length).toBe(1);
    expect((await mailsTo('admin@acme.test', 'Overdue: Pay the advance')).length).toBe(1);

    // Done: a monthly obligation comes back next month (within the contract's term).
    const report = d.manage.obligations.find((o: any) => o.title === 'Monthly service report');
    d = (await admin.post(`/api/staff/contracts/${c.contract.id}/obligations/${report.id}/status`, { status: 'DONE' })).body;
    const reports = d.manage.obligations.filter((o: any) => o.title === 'Monthly service report');
    expect(reports.map((o: any) => o.status).sort()).toEqual(['DONE', 'OPEN']);
    expect(reports.find((o: any) => o.status === 'OPEN').dueDate > iso(25)).toBe(true);
  });
});

describe('prices, price checks and the ERP', () => {
  test('agreed prices; orders and invoices checked against them; signed supplier contracts go to the ERP', async () => {
    const { id: vendorId, admin } = await invitedSupplier('Price Check Valves', 'prices@valves.example');
    const party = (await admin.post('/api/staff/parties/from-supplier', { vendorId })).body.party;
    const c = (await admin.post('/api/staff/contracts', { title: 'Valves rate contract', direction: 'BUY', type: 'supply', partyId: party.id, value: 500000, currency: 'INR', startDate: iso(-5), endDate: iso(360) })).body;
    expect((await admin.put(`/api/staff/contracts/${c.contract.id}/prices`, { prices: [{ itemCode: 'VLV-1', description: 'a', price: 1 }, { itemCode: 'vlv-1', description: 'b', price: 2 }] })).body.error).toMatch(/twice/);
    const saved = await admin.put(`/api/staff/contracts/${c.contract.id}/prices`, { prices: [{ itemCode: 'VLV-050', description: 'Ball valve 50 mm', uom: 'NOS', price: 1000 }, { itemCode: 'VLV-080', description: 'Ball valve 80 mm', uom: 'NOS', price: 2000 }] });
    expect(saved.body.manage.prices).toHaveLength(2);
    const t = await tenant();
    // Not active yet: no check.
    expect(await priceCheck(t, vendorId, 'INR', [{ key: 'a', itemCode: 'VLV-050', unitPrice: 1200 }])).toBeNull();
    await admin.agent.post(`/api/staff/contracts/${c.contract.id}/files`).set('X-Requested-With', 'fetch').field('kind', 'SIGNED').attach('file', Buffer.from(PDF), { filename: 'rc.pdf', contentType: 'application/pdf' });
    expect((await admin.post(`/api/staff/contracts/${c.contract.id}/signed`, { signedDate: iso(0) })).body.contract.status).toBe('ACTIVE');
    const chk = await priceCheck(t, vendorId, 'INR', [{ key: 'a', itemCode: 'vlv-050', unitPrice: 1040 }, { key: 'b', itemCode: 'VLV-080', unitPrice: 2200 }, { key: 'c', itemCode: 'PIPE-1', unitPrice: 10 }]);
    expect(chk).toMatchObject({ tolerance: 5, above: 1 });
    expect(chk!.lines.map((l) => [l.key, l.status, l.contractPrice, l.diffPct])).toEqual([['a', 'OK', 1000, 4], ['b', 'ABOVE', 2000, 10], ['c', 'NO_PRICE', null, null]]);
    expect(await priceCheck(t, vendorId, 'USD', [{ key: 'a', itemCode: 'VLV-050', unitPrice: 1 }])).toBeNull();
    expect((await admin.get('/api/staff/contracts/reports')).body.prices).toHaveProperty('above');

    // Signing queued the contract for the ERP (no ERP connection here, so it is recorded but not sent).
    const m = await db.query.poMessages.findFirst({ where: eq(schema.poMessages.contractId, c.contract.id), orderBy: desc(schema.poMessages.createdAt) });
    expect(m).toMatchObject({ kind: 'CONTRACT' });
    expect(['NO_CONNECTOR', 'TEST']).toContain(m!.status); // another test file may have left the ERP in test mode
    const contract = (m!.payload as any).contract;
    expect(contract).toMatchObject({ contractNumber: c.contract.number, supplierName: 'Price Check Valves', currency: 'INR', lines: [{ lineNo: 1, itemCode: 'VLV-050', price: 1000 }, { lineNo: 2, itemCode: 'VLV-080', price: 2000 }] });
    const data = { kind: 'CONTRACT' as const, slug: 'acme', entityCode: null, contract, lines: [] };
    expect(genericEvent(data)).toMatchObject({ event: 'contract.activated', contract: { contractNumber: c.contract.number } });
    expect(oracleBody(data)).toMatchObject({ HEADER: { DOCUMENT_TYPE_CODE: 'BLANKET', AMOUNT_AGREED: 500000 }, LINES: [{ LINE_NUM: 1, ITEM: 'VLV-050', UNIT_PRICE: 1000 }, { LINE_NUM: 2 }] });
    expect(csvFor(data).csv.trim().split(/\r?\n/)).toHaveLength(3);
    const view = (await admin.get(`/api/staff/contracts/${c.contract.id}`)).body;
    expect(view.manage.erpMessages[0]).toMatchObject({ kind: 'CONTRACT', status: 'NO_CONNECTOR' });
  });

  test('files sent to the other party are kept', async () => {
    const admin = await login('admin@acme.test');
    await admin.put('/api/admin/contracts', { enabled: true, types: { service: true, supply: true, nda: true }, features: { internalApproval: false, obligations: true, renewalAlerts: true, priceCompliance: true, contractToErp: true, counterpartyPortal: true }, rules: { priceTolerance: 5 } });
    const party = (await admin.post('/api/staff/parties', { kind: 'SUPPLIER', name: 'Kept Files Ltd', country: 'IN', contacts: [{ name: 'Kim', email: 'kim@kept.example' }] })).body.party;
    const c = (await admin.post('/api/staff/contracts', { title: 'Kept NDA', direction: 'BUY', type: 'nda', partyId: party.id, startDate: iso(1), endDate: iso(300) })).body;
    const up = await admin.agent.post(`/api/staff/contracts/${c.contract.id}/files`).set('X-Requested-With', 'fetch').field('kind', 'DRAFT').attach('file', Buffer.from(PDF), { filename: 'draft.pdf', contentType: 'application/pdf' });
    const file = up.body.files[0];
    await admin.post(`/api/staff/contracts/${c.contract.id}/share`, { people: [{ name: 'Kim', email: 'kim@kept.example' }] });
    expect((await admin.del(`/api/staff/contracts/${c.contract.id}/files/${file.id}`)).body.error).toMatch(/sent to the other party/);
  });
});
