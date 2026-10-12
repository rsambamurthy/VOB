import { beforeAll, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { client, login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import { runAutoAccept } from '../src/services/orders/acceptance.js';
import { oracleToCanonical } from '../src/services/orders/oracle.js';

let acme: typeof schema.tenants.$inferSelect;
let supplier: typeof schema.vendors.$inferSelect; // approved vendor owned by this test file
let other: typeof schema.vendors.$inferSelect;
let apiKey = '';

async function makeVendor(code: string, name: string, email: string) {
  const admin = await db.query.users.findFirst({ where: eq(schema.users.email, 'admin@acme.test') });
  const [v] = await db.insert(schema.vendors).values({ tenantId: acme.id, code, name, vendorType: 'DOMESTIC', contactFirstName: 'Asha', contactLastName: 'Rao', contactEmail: email,
    contactMobile: '9800000000', status: 'APPROVED', inviteToken: crypto.randomBytes(16).toString('hex'), createdById: admin!.id, consentAt: new Date(), consentVersion: 1 }).returning();
  return v;
}

const api = (path: string) => client().agent.post(`/api/v1${path}`).set('Authorization', `Bearer ${apiKey}`);
const apiGet = (path: string) => client().agent.get(`/api/v1${path}`).set('Authorization', `Bearer ${apiKey}`);

async function supplierLogin(email: string, vendorId?: string) {
  const c = client();
  const r = await c.post('/api/vendor-auth/email/request', { workspace: 'acme', email });
  expect(r.status).toBe(200);
  const v = await c.post('/api/vendor-auth/email/verify', { workspace: 'acme', email, code: r.body.devOtp, ...(vendorId ? { vendorId } : {}) });
  return { c, verify: v };
}

const canonical = (over: Record<string, unknown> = {}) => ({
  erpId: 'API-1', poNumber: 'PO-API-1', revision: 0, supplierCode: 'SUP-ORD-1', entity: { code: 'IN01', name: 'Acme India' }, buyingGroup: { code: 'RAW', name: 'Raw materials' },
  buyer: { name: 'Priya Shah', email: 'priya@acme.test' }, currency: 'INR', poDate: '2026-10-01', paymentTerms: 'Net 45',
  lines: [
    { erpId: 'API-1-1', lineNo: 1, itemCode: 'RM-1', description: 'Cellulose', uom: 'KG', quantity: 500, unitPrice: 182.5, site: { code: 'PUN1', name: 'Pune Plant' }, needByDate: '2026-10-20' },
    { erpId: 'API-1-2', lineNo: 2, itemCode: 'PK-1', description: 'Bottles', uom: 'EA', quantity: 12000, unitPrice: 6.4, site: { code: 'PUN1' }, needByDate: '2026-10-25' },
  ],
  ...over,
});

beforeAll(async () => {
  acme = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
  await db.delete(schema.erpConnections).where(eq(schema.erpConnections.tenantId, acme.id));
  supplier = await makeVendor('VND-ORD-1', 'Orbit Chemicals Pvt Ltd', 'sales@orbit.test');
  other = await makeVendor('VND-ORD-2', 'Nova Packaging Ltd', 'hello@nova.test');
});

describe('purchase orders: import', () => {
  test('API keys: created once, required, revocable; staff without permission are refused', async () => {
    const admin = await login('admin@acme.test');
    const k = await admin.post('/api/purchasing/api-keys', { name: 'Oracle middleware' });
    expect(k.status).toBe(201);
    apiKey = k.body.key;
    expect(apiKey).toMatch(/^vg_/);
    expect((await client().agent.post('/api/v1/purchase-orders').send({})).status).toBe(401);
    expect((await client().agent.post('/api/v1/purchase-orders').set('Authorization', 'Bearer vg_nope').send({})).status).toBe(401);
    const tax = await login('tax@acme.test');
    expect((await tax.get('/api/orders')).status).toBe(403);
  });

  test('canonical JSON via the API; unknown supplier code is kept and can be mapped later', async () => {
    const r = await api('/purchase-orders').send(canonical());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 1, unmappedSuppliers: 1, failed: 0 });
    const po = (await db.query.purchaseOrders.findFirst({ where: and(eq(schema.purchaseOrders.tenantId, acme.id), eq(schema.purchaseOrders.erpId, 'API-1')) }))!;
    expect(po.vendorId).toBeNull();
    expect(po.acceptance).toBe('PENDING');
    expect(po.acceptDueAt).toBeNull(); // new buying groups never auto-accept until set up
    expect(Number(po.total)).toBe(500 * 182.5 + 12000 * 6.4);

    const admin = await login('admin@acme.test');
    expect((await admin.get('/api/orders/unmapped')).body.map((x: any) => x.supplierCode)).toContain('SUP-ORD-1');
    const m = await admin.post('/api/orders/map-supplier', { code: 'SUP-ORD-1', vendorId: supplier.id });
    expect(m.body.attached).toBe(1);
    const notified = await db.query.emailOutbox.findFirst({ where: and(eq(schema.emailOutbox.to, 'sales@orbit.test')), orderBy: (o, { desc }) => desc(o.createdAt) });
    expect(notified?.subject).toContain('PO-API-1');
    expect(notified?.link).toContain('/s/acme?next=');
    // re-sending the same content changes nothing
    expect((await api('/purchase-orders').send(canonical())).body.unchanged).toBe(1);
  });

  test('Oracle EBS shape (?format=oracle) maps headers, lines, shipments and receipts', async () => {
    const oracle = { PO_HEADER_ID: '880001', SEGMENT1: '4500880001', REVISION_NUM: 0, VENDOR_NUM: 'VND-ORD-1', VENDOR_ID: '5501', VENDOR_SITE_CODE: 'MAIN', ORG_ID: '204', OPERATING_UNIT: 'Vision Operations',
      AGENT_NAME: 'Stock, Pat', CURRENCY_CODE: 'INR', APPROVED_DATE: '2026-10-05T10:00:00', TERMS: 'Net 30', FOB_LOOKUP_CODE: 'FCA', CLOSED_CODE: 'OPEN', CANCEL_FLAG: 'N',
      LINES: [{ PO_LINE_ID: '77001', LINE_NUM: 1, ITEM_NUMBER: 'AS54888', ITEM_DESCRIPTION: 'Sentinel Standard Desktop', UNIT_MEAS_LOOKUP_CODE: 'Each', QUANTITY: 10, UNIT_PRICE: 1199, CATEGORY: 'COMPUTER.PC',
        SHIPMENTS: [{ LINE_LOCATION_ID: '9901', SHIP_TO_ORGANIZATION_CODE: 'M1', SHIP_TO_ORGANIZATION_NAME: 'Seattle Manufacturing', NEED_BY_DATE: '2026-11-01', QUANTITY: 6, QUANTITY_RECEIVED: 2, QTY_RCV_TOLERANCE: 5 },
          { LINE_LOCATION_ID: '9902', SHIP_TO_ORGANIZATION_CODE: 'M1', NEED_BY_DATE: '2026-11-15', QUANTITY: 4, QUANTITY_RECEIVED: 1 }] }],
      RECEIPTS: [{ TRANSACTION_ID: 'R1', RECEIPT_NUM: '7001', TRANSACTION_DATE: '2026-10-10', PO_LINE_ID: '77001', QUANTITY: 3 }] };
    const c = oracleToCanonical(oracle);
    expect(c).toMatchObject({ erpId: '880001', poNumber: '4500880001', supplierCode: 'VND-ORD-1', supplierAltCodes: ['5501'], entity: { code: '204' }, buyingGroup: { code: 'COMPUTER' } });
    expect(c.lines[0]).toMatchObject({ receivedQty: 3, needByDate: '2026-11-01', site: { code: 'M1' }, tolerancePct: 5, lineType: 'GOODS' });
    const r = await api('/purchase-orders?format=oracle').send([oracle]);
    expect(r.body.created).toBe(1);
    const po = (await db.query.purchaseOrders.findFirst({ where: eq(schema.purchaseOrders.erpId, '880001') }))!;
    expect(po.vendorId).toBe(supplier.id); // matched on the vendor code
    expect(po.source).toBe('oracle');
    expect((await db.select().from(schema.poReceipts).where(eq(schema.poReceipts.poId, po.id))).length).toBe(1);
  });

  test('invalid POs are reported, valid ones in the same batch still import', async () => {
    const r = await api('/purchase-orders').send({ purchaseOrders: [canonical({ erpId: 'API-BAD', poNumber: 'PO-BAD', lines: [] }), canonical({ erpId: 'API-2', poNumber: 'PO-API-2', supplierCode: 'VND-ORD-2' })] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ created: 1, failed: 1 });
    expect(r.body.errors[0]).toContain('PO-BAD');
  });

  test('CSV import groups rows into POs', async () => {
    const admin = await login('admin@acme.test');
    const tpl = await admin.get('/api/orders/import-template.csv');
    expect(tpl.text).toContain('PO_NUMBER,ERP_PO_ID');
    const csv = 'PO_NUMBER,SUPPLIER_CODE,LINE_NO,DESCRIPTION,QUANTITY,UNIT_PRICE,BUYING_GROUP\r\nCSV-1,VND-ORD-2,1,"Carton, printed",1000,3.15,PACK\r\nCSV-1,VND-ORD-2,2,Labels,5000,0.4,PACK\r\n';
    const r = await admin.post('/api/orders/import-csv', { csv });
    expect(r.body).toMatchObject({ created: 1, failed: 0 });
    const po = (await db.query.purchaseOrders.findFirst({ where: eq(schema.purchaseOrders.poNumber, 'CSV-1') }))!;
    expect((await db.select().from(schema.poLines).where(eq(schema.poLines.poId, po.id))).map((l) => l.description).sort()).toEqual(['Carton, printed', 'Labels']);
    expect((await admin.post('/api/orders/import-csv', { csv: 'A,B\r\n1,2' })).status).toBe(400);
  });
});

describe('purchase orders: supplier acceptance', () => {
  test('supplier signs in by email and sees only their own orders', async () => {
    const { c, verify } = await supplierLogin('sales@orbit.test');
    expect(verify.body.ok).toBe(true);
    const list = await c.get('/api/vendor/orders');
    expect(list.status).toBe(200);
    expect(list.body.rows.map((r: any) => r.poNumber).sort()).toEqual(['4500880001', 'PO-API-1']);
    expect(list.body.rows[0].supplierCode).toBeUndefined();
    const novaPo = (await db.query.purchaseOrders.findFirst({ where: eq(schema.purchaseOrders.poNumber, 'PO-API-2') }))!;
    expect((await c.get(`/api/vendor/orders/${novaPo.id}`)).status).toBe(404);
    expect((await c.post(`/api/vendor/orders/${novaPo.id}/accept`, {})).status).toBe(404);
    // unknown email: same answer, no code
    const r = await client().post('/api/vendor-auth/email/request', { workspace: 'acme', email: 'nobody@nowhere.test' });
    expect(r.body).toEqual({ ok: true });
  });

  test('line acceptance → PARTIAL, then the rest → ACCEPTED; acknowledgement recorded and buyer told', async () => {
    const { c } = await supplierLogin('sales@orbit.test');
    const po = (await db.query.purchaseOrders.findFirst({ where: eq(schema.purchaseOrders.erpId, 'API-1') }))!;
    const d = (await c.get(`/api/vendor/orders/${po.id}`)).body;
    const [l1] = d.lines;
    expect((await c.post(`/api/vendor/orders/${po.id}/accept`, { lineIds: [l1.id], note: 'Will ship from Pune' })).body.acceptance).toBe('PARTIAL');
    expect((await c.post(`/api/vendor/orders/${po.id}/accept`, { lineIds: [l1.id] })).status).toBe(409); // already accepted
    expect((await c.post(`/api/vendor/orders/${po.id}/accept`, {})).body.acceptance).toBe('ACCEPTED');
    const lines = await db.select().from(schema.poLines).where(eq(schema.poLines.poId, po.id));
    expect(lines.every((l) => l.acceptance === 'ACCEPTED')).toBe(true);
    expect(lines.find((l) => l.lineNo === 1)?.acceptedBy).toContain('Asha Rao, Orbit Chemicals');
    const msgs = await db.select().from(schema.poMessages).where(eq(schema.poMessages.poId, po.id));
    expect(msgs).toHaveLength(2);
    expect(msgs.every((m) => m.status === 'NO_CONNECTOR')).toBe(true); // no ERP connection: recorded, not sent
    const mail = await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, 'priya@acme.test'), orderBy: (o, { desc }) => desc(o.createdAt) });
    expect(mail?.subject).toBe('Accepted: PO-API-1');
  });

  test('with Oracle in test mode the acknowledgement payload is built and recorded', async () => {
    const admin = await login('admin@acme.test');
    expect((await admin.put('/api/admin/erp', { kind: 'oracle', testMode: true, autoPush: false, config: { url: 'https://ebs.example.com/suppliers', ackUrl: 'https://ebs.example.com/po/ack', poPullUrl: 'https://ebs.example.com/po' }, secrets: {} })).status).toBe(200);
    expect((await admin.post('/api/orders/pull', {})).status).toBe(409); // test mode: nothing is pulled
    const { c } = await supplierLogin('sales@orbit.test');
    const po = (await db.query.purchaseOrders.findFirst({ where: eq(schema.purchaseOrders.erpId, '880001') }))!;
    await c.post(`/api/vendor/orders/${po.id}/accept`, {});
    const [m] = await db.select().from(schema.poMessages).where(eq(schema.poMessages.poId, po.id));
    expect(m.status).toBe('TEST');
    expect(m.target).toBe('https://ebs.example.com/po/ack');
    expect((m.payload as any).request.body).toMatchObject({ PO_HEADER_ID: '880001', SEGMENT1: '4500880001', ORG_ID: '204', ACCEPTED_FLAG: 'Y', ACCEPTANCE_TYPE: 'ACCEPTED', LINES: [{ PO_LINE_ID: '77001', LINE_NUM: 1 }] });
    const detail = (await admin.get(`/api/orders/${po.id}`)).body;
    expect(detail.messages[0].status).toBe('TEST');
    expect(detail.history.map((h: any) => h.action)).toContain('PO_ACCEPTED');
  });

  test('a revision that changes a line re-opens only that line', async () => {
    const changed = canonical({ revision: 1 });
    (changed.lines as any[])[0].quantity = 650;
    const r = await api('/purchase-orders').send(changed);
    expect(r.body.updated).toBe(1);
    const po = (await db.query.purchaseOrders.findFirst({ where: eq(schema.purchaseOrders.erpId, 'API-1') }))!;
    expect(po.acceptance).toBe('PARTIAL');
    expect(po.revision).toBe(1);
    const lines = await db.select().from(schema.poLines).where(eq(schema.poLines.poId, po.id));
    expect(lines.find((l) => l.lineNo === 1)?.acceptance).toBe('PENDING');
    expect(lines.find((l) => l.lineNo === 2)?.acceptance).toBe('ACCEPTED');
    const mail = await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, 'sales@orbit.test'), orderBy: (o, { desc }) => desc(o.createdAt) });
    expect(mail?.subject).toContain('revised');
  });

  test('auto-accept after the buying group’s waiting period; the buyer can record acceptance for the supplier', async () => {
    const admin = await login('admin@acme.test');
    const setup = (await admin.get('/api/purchasing/setup')).body;
    const raw = setup.groups.find((g: any) => g.code === 'RAW');
    const u = await admin.patch(`/api/purchasing/groups/${raw.id}`, { autoAcceptDays: 6 });
    expect(u.body.retimed).toBeGreaterThan(0);
    const po = (await db.query.purchaseOrders.findFirst({ where: eq(schema.purchaseOrders.erpId, 'API-1') }))!;
    expect(po.acceptDueAt).not.toBeNull();
    await db.update(schema.purchaseOrders).set({ acceptDueAt: new Date(Date.now() - 60_000) }).where(eq(schema.purchaseOrders.id, po.id));
    expect(await runAutoAccept()).toBeGreaterThanOrEqual(1);
    const after = (await db.query.purchaseOrders.findFirst({ where: eq(schema.purchaseOrders.id, po.id) }))!;
    expect(after.acceptance).toBe('ACCEPTED'); // one line by the supplier, one automatically
    expect((await db.select().from(schema.poLines).where(eq(schema.poLines.poId, po.id))).find((l) => l.lineNo === 1)?.acceptance).toBe('AUTO_ACCEPTED');

    const nova = (await db.query.purchaseOrders.findFirst({ where: eq(schema.purchaseOrders.poNumber, 'PO-API-2') }))!;
    expect((await admin.post(`/api/orders/${nova.id}/accept`, { note: 'x' })).status).toBe(400);
    expect((await admin.post(`/api/orders/${nova.id}/accept`, { note: 'Confirmed by phone with Mr Iyer' })).body.acceptance).toBe('ACCEPTED');
  });

  test('extra supplier contacts can sign in; one email serving two suppliers chooses; disabling removes access', async () => {
    const admin = await login('admin@acme.test');
    const add = await admin.post(`/api/purchasing/vendors/${supplier.id}/contacts`, { name: 'Ravi Kumar', email: 'ravi@shared.test' });
    expect(add.status).toBe(201);
    await admin.post(`/api/purchasing/vendors/${other.id}/contacts`, { name: 'Ravi Kumar', email: 'ravi@shared.test' });
    const first = await supplierLogin('ravi@shared.test');
    expect(first.verify.body.choose.map((x: any) => x.name).sort()).toEqual(['Nova Packaging Ltd', 'Orbit Chemicals Pvt Ltd']);
    const req2 = await first.c.post('/api/vendor-auth/email/request', { workspace: 'acme', email: 'ravi@shared.test' });
    const pick = await first.c.post('/api/vendor-auth/email/verify', { workspace: 'acme', email: 'ravi@shared.test', code: req2.body.devOtp, vendorId: other.id });
    expect(pick.body.ok).toBe(true);
    expect((await first.c.get('/api/vendor/orders')).body.rows.every((r: any) => ['PO-API-2', 'CSV-1'].includes(r.poNumber))).toBe(true);

    const access = (await admin.get(`/api/purchasing/vendors/${other.id}/access`)).body;
    const contact = access.contacts.find((x: any) => x.email === 'ravi@shared.test');
    await admin.patch(`/api/purchasing/vendors/${other.id}/contacts/${contact.id}`, { active: false });
    expect((await first.c.get('/api/vendor/orders')).status).toBe(401); // signed out at once
  });

  test('ERP can read acceptance back; revoked key stops working; plan without the feature is refused', async () => {
    const st = await apiGet('/purchase-orders/PO-API-1');
    expect(st.body).toMatchObject({ acceptance: 'ACCEPTED', revision: 1 });
    const acks = await apiGet(`/acknowledgements?since=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}`);
    expect(acks.body.length).toBeGreaterThanOrEqual(3);
    const admin = await login('admin@acme.test');
    const keys = (await admin.get('/api/purchasing/api-keys')).body;
    await admin.del(`/api/purchasing/api-keys/${keys[0].id}`);
    expect((await apiGet('/purchase-orders/PO-API-1')).status).toBe(401);
    await db.update(schema.tenants).set({ limits: { features: { collab: false } } }).where(eq(schema.tenants.id, acme.id));
    const r = await admin.get('/api/orders');
    expect(r.body.code).toBe('PLAN_LIMIT');
    expect((await admin.get('/api/admin/users')).status).toBe(200); // other areas unaffected
    await db.update(schema.tenants).set({ limits: {} }).where(eq(schema.tenants.id, acme.id));
  });

  test('sample purchase orders for demos (test mode only)', async () => {
    const admin = await login('admin@acme.test');
    const r = await admin.post('/api/orders/samples');
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(6);
    const list = (await admin.get('/api/orders?acceptance=WAITING')).body;
    expect(list.counts.waiting).toBeGreaterThanOrEqual(6);
    await admin.put('/api/admin/erp', { kind: 'oracle', testMode: false, autoPush: false, config: { url: 'https://ebs.example.com/suppliers' }, secrets: {} });
    expect((await admin.post('/api/orders/samples')).status).toBe(409);
    await db.delete(schema.erpConnections).where(eq(schema.erpConnections.tenantId, acme.id));
  });
});
