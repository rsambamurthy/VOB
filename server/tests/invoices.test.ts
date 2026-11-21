/** Invoices add-on (accounts payable): plans, settings, code lists, AP invoices with and without a PO, the approval matrix,
 *  touchless, push to the ERP (Oracle shape), import results, credit and debit notes, payments by party, reports. */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { client, login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import { createTenant } from '../src/services/tenants.js';
import { hashPassword } from '../src/lib/password.js';
import { oracleCodes } from '../src/services/invoices/codes.js';
import { buildInvoiceMessage, oracleInvoice } from '../src/services/invoices/erp.js';
import { concatenatedAccount } from '../src/services/invoices/config.js';
import { gstTypeCheck } from '../src/services/invoices/checks.js';
import { PDF_BYTES, iso } from './contractsHelpers.js';

const WS = `apinv${Date.now() % 1e6}`;
const PW = 'Demo@12345';
let tenantId = '';
let admin: Awaited<ReturnType<typeof login>>, clerk: Awaited<ReturnType<typeof login>>, approver: Awaited<ReturnType<typeof login>>, owner: Awaited<ReturnType<typeof login>>;
let party: { id: string; code: string }, ownerId = '', apiKey = '';
const api = (method: 'post' | 'get' | 'put', path: string) => client().agent[method](`/api/v1${path}`).set('Authorization', `Bearer ${apiKey}`);
const H = { 'X-Requested-With': 'fetch' };
const binary = (res: any, cb: (e: Error | null, b: Buffer) => void) => { const c: Buffer[] = []; res.on('data', (x: Buffer) => c.push(x)); res.on('end', () => cb(null, Buffer.concat(c))); };

async function user(name: string, email: string, roleKey: string) {
  const role = (await db.query.roles.findFirst({ where: and(eq(schema.roles.tenantId, tenantId), eq(schema.roles.key, roleKey)) }))!;
  const [u] = await db.insert(schema.users).values({ tenantId, name, email, status: 'ACTIVE', passwordHash: await hashPassword(PW), passwordChangedAt: new Date(), lastLoginAt: new Date() }).returning();
  await db.insert(schema.userRoles).values({ userId: u.id, roleId: role.id });
  return u;
}
const settings = (over: Record<string, unknown> = {}, rules: Record<string, unknown> = {}) => ({ enabled: true, bases: { po: true, contract: true, nonPo: true },
  features: { bulkUpload: true, excelImport: true, touchless: false, creditNotes: true, debitNotes: true, ...over }, rules: { pushMode: 'manual', debitNoteEmail: 'ask', ...rules } });

beforeAll(async () => {
  const { tenant } = await createTenant({ slug: WS, name: 'AP Test Co', adminName: 'Asha Admin', adminEmail: `admin@${WS}.test`, adminPassword: PW, country: 'IN', plan: 'contracts', limits: { features: { invoices: true } } });
  tenantId = tenant.id;
  await user('Arun Clerk', `clerk@${WS}.test`, 'AP_CLERK');
  await user('Ira Approver', `approver@${WS}.test`, 'INVOICE_APPROVER');
  ownerId = (await user('Omar Owner', `owner@${WS}.test`, 'INVOICE_VIEWER')).id;
  [admin, clerk, approver, owner] = await Promise.all([login(`admin@${WS}.test`, WS, PW), login(`clerk@${WS}.test`, WS, PW), login(`approver@${WS}.test`, WS, PW), login(`owner@${WS}.test`, WS, PW)]);
  await db.insert(schema.erpConnections).values({ tenantId, kind: 'oracle', testMode: true, autoPush: true, config: { url: 'https://ebs.example/rest', invoiceUrl: 'https://ebs.example/rest/ap/invoices' } });
});
afterAll(async () => { await db.delete(schema.tenants).where(eq(schema.tenants.id, tenantId)); });

describe('plan and settings', () => {
  test('an add-on: off until switched on; the Contracts plan gets AP roles, parties and the ERP screen', async () => {
    expect((await clerk.get('/api/staff/invoices')).status).toBe(404);
    const me = (await admin.get('/api/auth/me')).body;
    expect(me.permissions).toEqual(expect.arrayContaining(['invoices.view', 'invoices.capture', 'invoices.manage']));
    expect(me.invoices).toMatchObject({ on: false });
    const roles = (await admin.get('/api/admin/roles')).body.roles.map((r: any) => r.key);
    expect(roles).toEqual(expect.arrayContaining(['AP_CLERK', 'INVOICE_APPROVER', 'INVOICE_VIEWER', 'CONTRACT_MANAGER']));
    const r = await admin.put('/api/admin/invoices', settings());
    expect(r.status).toBe(200);
    expect(r.body.changes).toContain('Invoices on');
    expect((await admin.get('/api/auth/me')).body.invoices).toMatchObject({ on: true, pushMode: 'manual', debitNotes: true });
    expect((await admin.get('/api/admin/erp')).status).toBe(200); // no onboarding, but invoices need the ERP connection
    expect((await clerk.get('/api/staff/invoices')).status).toBe(200);
    // Parties serve contracts and invoices; the AP clerk may create suppliers.
    const p = await clerk.post('/api/staff/parties', { kind: 'SUPPLIER', name: 'Pune Industrial Estates', country: 'IN', taxNo: '27AAECP4410D1Z6', ap: { erpSupplierCode: 'V1001', erpSiteCode: 'PUNE', paymentTerms: 'Net 45', accountsEmail: 'accounts@pie.example' } });
    expect(p.status).toBe(201);
    expect(p.body.party.ap).toMatchObject({ erpSupplierCode: 'V1001', paymentTerms: 'Net 45' });
    party = p.body.party;
    // Rules that need purchase orders aren't offered on this plan.
    expect(r.body.rules.map((x: any) => x.key)).toEqual(expect.arrayContaining(['pushMode', 'debitNoteEmail', 'costCentre']));
  });

  test('the approval matrix: levels can go to the cost-centre owner; unknown assignees are refused', async () => {
    const levels = [
      { id: 'budget', label: 'Budget owner', roleKey: 'INVOICE_APPROVER', assignee: 'costCentreOwner', rule: { match: 'all', conditions: [{ field: 'invoice.basis', op: 'eq', value: 'Non-PO' }] } },
      { id: 'finance', label: 'Finance approval', roleKey: 'INVOICE_APPROVER', rule: { match: 'all', conditions: [{ field: 'invoice.amount', op: 'gt', value: 100000 }] } },
    ];
    expect((await admin.put('/api/admin/invoices/approval', { levels: [{ ...levels[0], assignee: 'ceo' }] })).status).toBe(400);
    const r = await admin.put('/api/admin/invoices/approval', { levels });
    expect(r.status).toBe(200);
    expect(r.body.approval.assignees).toEqual([expect.objectContaining({ key: 'costCentreOwner' })]);
    expect((await admin.put('/api/admin/invoices/erp', { accountFormat: '{entity}.{costCentre}.{account}' })).body.accountFormat).toBe('{entity}.{costCentre}.{account}');
  });
});

describe('code lists', () => {
  test('Oracle rows map to code lists; a full refresh closes codes the ERP no longer sends; owners kept in VendorGate', async () => {
    const lists = oracleCodes({
      ACCOUNTS: [{ FLEX_VALUE: '5100', DESCRIPTION: 'Rent expense', ENABLED_FLAG: 'Y' }, { FLEX_VALUE: '5200', DESCRIPTION: 'Old', ENABLED_FLAG: 'Y', END_DATE_ACTIVE: '2020-01-01' }],
      COST_CENTRES: [{ FLEX_VALUE: '110', DESCRIPTION: 'Plant 1' }, { FLEX_VALUE: '120', DESCRIPTION: 'Warehouse' }],
      CODE_COMBINATIONS: [{ CONCATENATED_SEGMENTS: '81.120.5100', ENABLED_FLAG: 'Y', CODE_COMBINATION_ID: 9001 }],
      OPERATING_UNITS: [{ ORGANIZATION_ID: 81, NAME: 'Pune OU' }],
      TASKS: [{ TASK_NUMBER: '1.1', TASK_NAME: 'Civil', PROJECT_NUMBER: 'PRJ-1' }],
    });
    expect(lists.ACCOUNT).toEqual([expect.objectContaining({ code: '5100', enabled: true }), expect.objectContaining({ code: '5200', enabled: false })]);
    expect(lists.TASK?.[0]).toMatchObject({ code: '1.1', parent: 'PRJ-1' });
    // Through the ERP API (another way the ERP keeps them up to date).
    expect((await admin.post('/api/purchasing/api-keys', { name: 'x' })).status).toBeGreaterThanOrEqual(403); // purchasing is onboarding-only…
    apiKey = (await admin.post('/api/admin/api-keys', { name: 'AP tests' })).body.key; // …the ERP still gets a key
    expect(apiKey).toMatch(/^vg_/);
    for (const kind of ['ACCOUNT', 'COST_CENTRE', 'COMBINATION', 'ENTITY'] as const) {
      const map = { ACCOUNT: 'ACCOUNT', COST_CENTRE: 'COST_CENTRE', COMBINATION: 'COMBINATION', ENTITY: 'ENTITY' } as const;
      const r = await api('post', '/invoice-codes').send({ kind: map[kind], full: true, codes: lists[kind]!.map((c) => ({ code: c.code, name: c.name, enabled: c.enabled })) });
      expect(r.status).toBe(200);
    }
    const again = await api('post', '/invoice-codes').send({ kind: 'COST_CENTRE', full: true, codes: [{ code: '120', name: 'Warehouse' }] });
    expect(again.body).toMatchObject({ received: 1, closed: 1 });
    const cc = (await admin.get('/api/staff/invoices/codes?kind=COST_CENTRE&closed=1')).body;
    expect(cc.rows.find((r: any) => r.code === '110')).toMatchObject({ enabled: false });
    const wh = cc.rows.find((r: any) => r.code === '120');
    expect((await admin.patch(`/api/staff/invoices/codes/${wh.id}`, { name: 'Renamed' })).status).toBe(400); // ERP codes change in the ERP
    expect((await admin.patch(`/api/staff/invoices/codes/${wh.id}`, { ownerId })).body.ownerId).toBe(ownerId);
    expect((await clerk.patch(`/api/staff/invoices/codes/${wh.id}`, { usable: false })).status).toBe(403);
    expect(concatenatedAccount({ settings: { invoices: { erp: { accountFormat: '{entity}.{costCentre}.{account}' } } } } as never, { entity: '81', costCentre: '120', account: '5100' })).toBe('81.120.5100');
    expect(gstTypeCheck('29ABCDE1234F1Z5', '27AAAAA0000A1Z5', 'CGST_SGST')[0]?.code).toBe('GST_TYPE');
  });
});

describe('an invoice without a PO', () => {
  let id = '';
  test('drafted by AP, coded, checked; the PDF is needed; submitted into the matrix (budget owner = cost-centre owner)', async () => {
    const line = { description: 'Warehouse rent — November', quantity: 1, unitPrice: 250000, taxRate: 18, glAccount: '5100', costCentre: '999' };
    const d = await clerk.post('/api/staff/invoices', { partyId: party.id, invoiceNumber: 'PIE/26-27/0412', invoiceDate: iso(-3), total: 295000, entityCode: '81', taxType: 'CGST_SGST', lines: [line] });
    expect(d.status).toBe(201);
    id = d.body.invoice.id;
    expect(d.body.invoice).toMatchObject({ status: 'DRAFT', basis: 'nonPo', currency: 'INR', dueDate: iso(42) }); // Net 45 from the party
    expect(d.body.invoice.checks.map((c: any) => c.code)).toContain('CODE_UNKNOWN');
    expect((await clerk.post(`/api/staff/invoices/${id}/submit`)).status).toBe(400); // no PDF yet
    await clerk.agent.post(`/api/staff/invoices/${id}/file`).set(H).attach('file', PDF_BYTES('rent'), 'rent-nov.pdf');
    const bad = await clerk.post(`/api/staff/invoices/${id}/submit`);
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatch(/Cost centre 999 isn’t in the code list/);
    await clerk.put(`/api/staff/invoices/${id}`, { partyId: party.id, invoiceNumber: 'PIE/26-27/0412', invoiceDate: iso(-3), total: 295000, entityCode: '81', taxType: 'CGST_SGST', lines: [{ ...line, costCentre: '120' }] });
    const ok = await clerk.post(`/api/staff/invoices/${id}/submit`);
    expect(ok.status).toBe(200);
    expect(ok.body.invoice.status).toBe('IN_APPROVAL');
    expect(ok.body.flow.steps.map((s: any) => [s.label, s.assigneeName])).toEqual([['Budget owner', 'Omar Owner'], ['Finance approval', null]]);
    // The approver role can't act on the owner's step; the clerk who entered it can't approve.
    expect((await approver.post(`/api/staff/invoices/${id}/approval`, { action: 'APPROVE' })).status).toBe(403);
    expect((await owner.post(`/api/staff/invoices/${id}/approval`, { action: 'APPROVE' })).body.flow.current.label).toBe('Finance approval');
    const done = await approver.post(`/api/staff/invoices/${id}/approval`, { action: 'APPROVE' });
    expect(done.body.invoice).toMatchObject({ status: 'APPROVED', erpStatus: 'READY' }); // manual push
    expect(done.body.can.push).toBe(true);
  });

  test('manual push sends it to Oracle (Payables Open Interface shape); import results come back', async () => {
    const r = await clerk.post('/api/staff/invoices/push', { ids: [id] });
    expect(r.body.sent).toBe(1);
    const msg = await db.query.poMessages.findFirst({ where: and(eq(schema.poMessages.tenantId, tenantId), eq(schema.poMessages.kind, 'INVOICE')), orderBy: desc(schema.poMessages.createdAt) });
    expect(msg?.status).toBe('TEST');
    expect((msg?.payload as any).request.body).toMatchObject({ INVOICE_NUM: 'PIE/26-27/0412', INVOICE_TYPE_LOOKUP_CODE: 'STANDARD', VENDOR_NUM: 'V1001', VENDOR_SITE_CODE: 'PUNE', ORG_ID: '81', SOURCE: 'VENDORGATE', ATTRIBUTE1: id,
      LINES: [expect.objectContaining({ LINE_TYPE_LOOKUP_CODE: 'ITEM', AMOUNT: 250000, DIST_CODE_CONCATENATED: '81.120.5100' }), expect.objectContaining({ LINE_TYPE_LOOKUP_CODE: 'TAX', AMOUNT: 45000 })] });
    expect((await clerk.post('/api/staff/invoices/push', { ids: [id] })).status).toBe(409);
    const rej = await api('post', '/invoices/results').send({ invoiceNumber: 'PIE/26-27/0412', supplierCode: 'V1001', status: 'REJECTED', reasons: ['INVALID DISTRIBUTION ACCT'] });
    expect(rej.body).toMatchObject({ updated: 1 });
    let view = (await clerk.get(`/api/staff/invoices/${id}`)).body;
    expect(view.invoice).toMatchObject({ erpStatus: 'FAILED', erpError: 'INVALID DISTRIBUTION ACCT' });
    expect(view.can.push).toBe(true);
    await clerk.post('/api/staff/invoices/push', { ids: [id] });
    await api('post', '/invoices/results').send({ id, status: 'IMPORTED', erpInvoiceId: 'AP-77821', holds: [{ code: 'QTY REC', reason: 'Quantity received' }] });
    view = (await clerk.get(`/api/staff/invoices/${id}`)).body;
    expect(view.invoice).toMatchObject({ erpStatus: 'IMPORTED', erpInvoiceId: 'AP-77821', erpHolds: [{ code: 'QTY REC' }] });
  });

  test('a debit note: numbered, against an approved invoice, never more than it; PDF; emailed when AP chooses', async () => {
    const over = await clerk.post('/api/staff/invoices', { kind: 'DEBIT', partyId: party.id, relatedInvoiceId: id, invoiceDate: iso(0), total: 400000, description: 'Too much', lines: [{ description: 'x', quantity: 1, unitPrice: 400000, glAccount: '5100', costCentre: '120' }] });
    expect(over.body.invoice.checks.map((c: any) => c.code)).toContain('NOTE_OVER');
    await clerk.post(`/api/staff/invoices/${over.body.invoice.id}/cancel`);
    const dn = await clerk.post('/api/staff/invoices', { kind: 'DEBIT', partyId: party.id, relatedInvoiceId: id, invoiceDate: iso(0), total: 11800, description: 'Two days without power at the warehouse', lines: [{ description: 'Rent abatement — 2 days', quantity: 1, unitPrice: 10000, taxRate: 18, glAccount: '5100', costCentre: '120' }] });
    expect(dn.body.invoice.invoiceNumber).toMatch(/^DN-\d{4}-\d{4}$/);
    const dnId = dn.body.invoice.id;
    expect((await clerk.post(`/api/staff/invoices/${dnId}/submit`)).body.invoice.status).toBe('IN_APPROVAL'); // a debit note needs no PDF
    await owner.post(`/api/staff/invoices/${dnId}/approval`, { action: 'APPROVE' });
    const approved = (await approver.get(`/api/staff/invoices/${dnId}`)).body;
    expect(approved.invoice.status).toBe('APPROVED');
    expect(approved.debitNoteTo).toBe('accounts@pie.example');
    const pdf = await clerk.agent.get(`/api/staff/invoices/${dnId}/file`).set(H).buffer(true).parse(binary);
    expect(pdf.status).toBe(200);
    expect(pdf.body.toString('latin1').slice(0, 5)).toBe('%PDF-');
    expect((await clerk.post(`/api/staff/invoices/${dnId}/email`)).status).toBe(403); // AP Clerk: no invoices.manage
    const sent = await approver.post(`/api/staff/invoices/${dnId}/email`);
    expect(sent.body.invoice.emailedAt).toBeTruthy();
    const mail = await db.query.emailOutbox.findFirst({ where: and(eq(schema.emailOutbox.tenantId, tenantId), eq(schema.emailOutbox.to, 'accounts@pie.example')), orderBy: desc(schema.emailOutbox.createdAt) });
    expect(mail?.attachments).toEqual([expect.objectContaining({ contentType: 'application/pdf', ref: `debitNote:${dnId}` })]);
    expect((await clerk.get(`/api/staff/invoices/${id}`)).body.invoice.netPayable).toBe(295000 - 11800);
    // Oracle gets it as a DEBIT memo with negative amounts.
    const m = await buildInvoiceMessage(dnId);
    expect(oracleInvoice(m!)).toMatchObject({ INVOICE_TYPE_LOOKUP_CODE: 'DEBIT', INVOICE_AMOUNT: -11800, DESCRIPTION: expect.stringContaining('For invoice PIE/26-27/0412') });
  });

  test('payments by the supplier’s ERP code settle the invoice net of notes', async () => {
    const r = await api('post', '/payments').send({ erpId: `PAY-${WS}`, supplierCode: 'V1001', reference: 'CHQ 4411', paymentDate: iso(0), currency: 'INR', amount: 283200, invoices: [{ invoiceNumber: 'PIE/26-27/0412', amount: 283200 }] });
    expect(r.body).toMatchObject({ created: 1, failed: 0 });
    expect((await clerk.get(`/api/staff/invoices/${id}`)).body.invoice).toMatchObject({ status: 'PAID', paidAmount: 283200 });
    expect((await clerk.get('/api/staff/invoices/payments')).body.rows[0]).toMatchObject({ reference: 'CHQ 4411', vendorName: 'Pune Industrial Estates' });
  });
});

describe('contract invoices, touchless and the rules around them', () => {
  test('contract prices, value and term are checked; a clean one goes through touchless and is pushed automatically', async () => {
    await admin.put('/api/admin/contracts', { enabled: true, types: { supply: true, service: true } });
    const c = await admin.post('/api/staff/contracts', { title: 'Steel rate contract', direction: 'BUY', type: 'supply', partyId: party.id, value: 500000, currency: 'INR', startDate: iso(-100), endDate: iso(200) });
    await db.update(schema.contracts).set({ status: 'ACTIVE', signedDate: iso(-100) }).where(eq(schema.contracts.id, c.body.contract.id));
    await db.insert(schema.contractPrices).values({ tenantId, contractId: c.body.contract.id, itemCode: 'STL-PL10', description: 'MS plate 10 mm', price: '60000' });
    await admin.put('/api/admin/invoices', settings({ touchless: true }, { touchlessBasis: 'poContract', touchlessUpTo: 200000, pushMode: 'automatic' }));
    await admin.put('/api/admin/invoices/approval', { levels: [{ id: 'finance', label: 'Finance approval', roleKey: 'INVOICE_APPROVER', rule: { match: 'all', conditions: [{ field: 'invoice.amount', op: 'gt', value: 1000000 }] } }] });
    const base = { partyId: party.id, contractId: c.body.contract.id, invoiceDate: iso(-1), entityCode: '81' };
    const pricey = await clerk.post('/api/staff/invoices', { ...base, invoiceNumber: 'KST-1', total: 72000, lines: [{ itemCode: 'STL-PL10', description: 'Plate', quantity: 1, unitPrice: 72000, glAccount: '5100', costCentre: '120' }] });
    expect(pricey.body.invoice.checks.map((x: any) => x.code)).toContain('CONTRACT_PRICE');
    await clerk.agent.post(`/api/staff/invoices/${pricey.body.invoice.id}/file`).set(H).attach('file', PDF_BYTES('kst1'), 'kst1.pdf');
    const ex = await clerk.post(`/api/staff/invoices/${pricey.body.invoice.id}/submit`);
    expect(ex.body.invoice.status).toBe('EXCEPTION'); // warnings: no touchless, no level applies → one decision
    expect((await clerk.post(`/api/staff/invoices/${pricey.body.invoice.id}/decide`, { decision: 'APPROVE' })).status).toBe(403);
    expect((await approver.post(`/api/staff/invoices/${pricey.body.invoice.id}/decide`, { decision: 'APPROVE' })).status).toBe(400); // needs a note
    expect((await approver.post(`/api/staff/invoices/${pricey.body.invoice.id}/decide`, { decision: 'REJECT', note: 'Price above contract' })).body.invoice.status).toBe('REJECTED');
    const clean = await clerk.post('/api/staff/invoices', { ...base, invoiceNumber: 'KST-2', total: 120000, lines: [{ itemCode: 'STL-PL10', description: 'Plate', quantity: 2, unitPrice: 60000, glAccount: '5100', costCentre: '120' }] });
    await clerk.agent.post(`/api/staff/invoices/${clean.body.invoice.id}/file`).set(H).attach('file', PDF_BYTES('kst2'), 'kst2.pdf');
    const tl = await clerk.post(`/api/staff/invoices/${clean.body.invoice.id}/submit`);
    expect(tl.body.invoice).toMatchObject({ status: 'APPROVED', erpStatus: 'SENT' });
    expect(tl.body.invoice.decidedBy).toBe('VendorGate (touchless)');
    const big = await clerk.post('/api/staff/invoices', { ...base, invoiceNumber: 'KST-3', invoiceDate: iso(-1), total: 480000, lines: [{ itemCode: 'STL-PL10', description: 'Plate', quantity: 8, unitPrice: 60000, glAccount: '5100', costCentre: '120' }] });
    expect(big.body.invoice.checks.map((x: any) => x.code)).toContain('CONTRACT_VALUE'); // 120 000 + 480 000 > 500 000
    const late = await clerk.post('/api/staff/invoices', { ...base, invoiceNumber: 'KST-4', invoiceDate: iso(-150), total: 60000, lines: [{ itemCode: 'STL-PL10', description: 'Plate', quantity: 1, unitPrice: 60000, glAccount: '5100', costCentre: '120' }] });
    expect(late.body.invoice.checks.map((x: any) => x.code)).toContain('CONTRACT_TERM');
    const dup = await clerk.post('/api/staff/invoices', { ...base, invoiceNumber: 'kst-2', total: 60000, lines: [{ description: 'Plate', quantity: 1, unitPrice: 60000, glAccount: '5100', costCentre: '120' }] });
    expect(dup.body.invoice.checks.map((x: any) => x.code)).toContain('DUPLICATE');
  });

  test('lists, tabs, reports and Excel import', async () => {
    const list = (await clerk.get('/api/staff/invoices?status=REJECTED')).body;
    expect(list.rows.map((r: any) => r.invoiceNumber)).toEqual(['KST-1']);
    expect(list.counts).toMatchObject({ paid: 1, rejected: 1 });
    const rep = (await clerk.get('/api/staff/invoices/reports')).body;
    expect(rep.touchless).toMatchObject({ touchless: 1 });
    expect(rep.exceptions.map((e: any) => e.code)).toContain('CONTRACT_PRICE');
    expect((await clerk.agent.get('/api/staff/invoices/reports.xlsx').set(H)).status).toBe(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await clerk.agent.get('/api/staff/invoices/import-template.xlsx').set(H).buffer(true).parse(binary)).body);
    const ws = wb.getWorksheet('Invoices')!;
    ws.addRow([party.code, 'PIE/26-27/0500', iso(-2), 'INR', '', '', 'Maintenance', '', 1, 1000, 18, '5100', '120', '', '', 2360]);
    ws.addRow([party.code, 'PIE/26-27/0500', iso(-2), 'INR', '', '', 'Cleaning', '', 2, 500, 18, '5100', '120', '', '', 2360]);
    ws.addRow(['NOPE', 'X-1', iso(-2), 'INR', '', '', 'x', '', 1, 1, 0, '5100', '120', '', '', 1]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const check = await clerk.agent.post('/api/staff/invoices/import').set(H).attach('file', buf, 'inv.xlsx');
    expect(check.body.errors[0].message).toMatch(/Supplier “NOPE” not found/);
    ws.spliceRows(ws.rowCount, 1);
    const ok = await clerk.agent.post('/api/staff/invoices/import?commit=1').set(H).attach('file', Buffer.from(await wb.xlsx.writeBuffer()), 'inv.xlsx');
    expect(ok.body.created).toHaveLength(1);
    const draft = (await clerk.get(`/api/staff/invoices/${ok.body.created[0].id}`)).body;
    expect(draft.lines).toHaveLength(2);
    expect(draft.invoice).toMatchObject({ status: 'DRAFT', total: 2360 });
    expect(draft.invoice.source).toBe('EXCEL');
  });

  test('bulk upload: a .zip of PDFs → drafts; the PO number in the file name links the order; the same file twice is skipped', async () => {
    await db.insert(schema.purchaseOrders).values({ tenantId, erpId: 'BLK-1', poNumber: 'PO-77812', supplierCode: 'SUP-X', currency: 'INR', source: 'API' } as never);
    const { default: PizZip } = await import('pizzip');
    const zip = new PizZip();
    zip.file('PO-77812 invoice.pdf', PDF_BYTES('bulk-1'));
    zip.file('scan-unknown.pdf', PDF_BYTES('bulk-2'));
    zip.file('__MACOSX/._x.pdf', 'junk');
    const buf = zip.generate({ type: 'nodebuffer' });
    const check = await clerk.agent.post('/api/staff/invoices/bulk').set(H).attach('files', buf, 'batch.zip');
    expect(check.status).toBe(200);
    expect(check.body.files).toEqual(expect.arrayContaining([{ fileName: 'PO-77812 invoice.pdf', poNumber: 'PO-77812' }, { fileName: 'scan-unknown.pdf', poNumber: null }]));
    expect(check.body.created).toHaveLength(0);
    const ok = await clerk.agent.post('/api/staff/invoices/bulk?commit=1').set(H).attach('files', buf, 'batch.zip');
    expect(ok.body.created).toHaveLength(2);
    const linked = (await clerk.get(`/api/staff/invoices/${ok.body.created.find((x: any) => x.poNumber).id}`)).body;
    expect(linked.invoice).toMatchObject({ status: 'DRAFT', source: 'BULK' });
    expect(linked.invoice.poId).toBeTruthy();
    const again = await clerk.agent.post('/api/staff/invoices/bulk?commit=1').set(H).attach('files', buf, 'batch.zip');
    expect(again.body.created).toHaveLength(0);
    expect(again.body.duplicates).toHaveLength(2);
    // Viewers can't upload; switched off it is refused.
    expect((await owner.agent.post('/api/staff/invoices/bulk').set(H).attach('files', buf, 'batch.zip')).status).toBe(403);
    await admin.put('/api/admin/invoices', settings({ bulkUpload: false }));
    expect((await clerk.agent.post('/api/staff/invoices/bulk').set(H).attach('files', buf, 'batch.zip')).status).toBe(400);
    await admin.put('/api/admin/invoices', settings());
  });

  test('another workspace can’t see these invoices', async () => {
    const other = await login('admin@acme.test');
    const list = (await clerk.get('/api/staff/invoices')).body.rows;
    expect((await other.get(`/api/staff/invoices/${list[0].id}`)).status).toBeGreaterThanOrEqual(403);
  });
});
