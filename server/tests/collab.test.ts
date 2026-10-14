import { beforeAll, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { client, login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import { decodeSignedQr, einvoiceChecks, termDays } from '../src/services/collab/invoices.js';
import { toSapBusinessPartner } from '../src/integrations/erp/sap.js';
import { toDynamicsVendor, iso3, clearDynamicsTokens } from '../src/integrations/erp/dynamics.js';
import { send, setErpFetch, type Connection } from '../src/integrations/erp/drivers.js';
import { remindOverdueShipments } from '../src/services/collab/shipments.js';

const lastMail = (to: string) => db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, to), orderBy: desc(schema.emailOutbox.createdAt) });

let acme: typeof schema.tenants.$inferSelect;
let vendor: typeof schema.vendors.$inferSelect;
let apiKey = '';
let poId = '';
let lines: Record<number, string> = {};
const GSTIN = '27AAPFU0939F1ZV';

const api = (method: 'post' | 'get' | 'put', path: string) => client().agent[method](`/api/v1${path}`).set('Authorization', `Bearer ${apiKey}`);

let supplierClient: ReturnType<typeof client> | undefined;
async function supplier() {
  if (supplierClient) return supplierClient;
  const c = client();
  supplierClient = c;
  const r = await c.post('/api/vendor-auth/email/request', { workspace: 'acme', email: 'ops@helix.test' });
  await c.post('/api/vendor-auth/email/verify', { workspace: 'acme', email: 'ops@helix.test', code: r.body.devOtp });
  return c;
}

const jwt = (data: object) => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ data: JSON.stringify(data), iss: 'NIC' })).toString('base64url')}.sig`;

beforeAll(async () => {
  acme = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
  await db.delete(schema.erpConnections).where(eq(schema.erpConnections.tenantId, acme.id));
  const admin = await db.query.users.findFirst({ where: eq(schema.users.email, 'admin@acme.test') });
  [vendor] = await db.insert(schema.vendors).values({ tenantId: acme.id, code: 'VND-COL-1', name: 'Helix Polymers Pvt Ltd', vendorType: 'DOMESTIC', contactFirstName: 'Ravi', contactLastName: 'Iyer', contactEmail: 'ops@helix.test',
    contactMobile: '9800000001', status: 'APPROVED', inviteToken: crypto.randomBytes(16).toString('hex'), createdById: admin!.id, consentAt: new Date(), consentVersion: 1,
    profile: { basic: { vendorName: 'Helix Polymers Pvt Ltd', supplierCountry: 'India', district: 'Pune', postalCode: '411001', address: 'Plot 4, MIDC' }, tax: { gstin: GSTIN, pan: 'AAPFU0939F' }, bank: { accountNumber: '50100200300', ifsc: 'HDFC0000123', accountHolderName: 'Helix Polymers' } } as any }).returning();
  await db.insert(schema.supplierCodes).values({ tenantId: acme.id, vendorId: vendor.id, code: 'SUP-COL-1' });
  const a = await login('admin@acme.test');
  apiKey = (await a.post('/api/purchasing/api-keys', { name: 'Collab tests' })).body.key;
  const r = await api('post', '/purchase-orders').send({
    erpId: 'COL-1', poNumber: 'PO-COL-1', supplierCode: 'SUP-COL-1', buyer: { name: 'Priya Shah', email: 'priya@acme.test' }, currency: 'INR', poDate: '2026-09-01', paymentTerms: 'Net 30',
    lines: [
      { erpId: 'COL-1-1', lineNo: 1, itemCode: 'RM-9', description: 'Resin', uom: 'KG', quantity: 100, unitPrice: 50, tolerancePct: 5, taxRate: 18 },
      { erpId: 'COL-1-2', lineNo: 2, itemCode: 'RM-10', description: 'Pigment', uom: 'KG', quantity: 10, unitPrice: 200, taxRate: 18 },
      { erpId: 'COL-1-3', lineNo: 3, description: 'Installation', quantity: 1, unitPrice: 1000, taxRate: 18, lineType: 'SERVICE' },
    ],
  });
  expect(r.body.created).toBe(1);
  const po = (await db.query.purchaseOrders.findFirst({ where: and(eq(schema.purchaseOrders.tenantId, acme.id), eq(schema.purchaseOrders.erpId, 'COL-1')) }))!;
  poId = po.id;
  lines = Object.fromEntries((await db.select().from(schema.poLines).where(eq(schema.poLines.poId, poId))).map((l) => [l.lineNo, l.id]));
  const s = await supplier();
  expect((await s.post(`/api/vendor/orders/${poId}/accept`, {})).status).toBe(200);
  // A webhook connector in test mode records exactly what would be sent.
  expect((await a.put('/api/admin/erp', { kind: 'webhook', testMode: true, autoPush: false, config: { url: 'https://hooks.example.com/vg' }, secrets: {} })).status).toBe(200);
});

describe('shipment notices (ASN)', () => {
  let asnId = '';
  test('only accepted goods lines, within ordered quantity + tolerance', async () => {
    const s = await supplier();
    const d = await s.get(`/api/vendor/collab/orders/${poId}`);
    expect(d.status).toBe(200);
    expect(d.body.shippable.map((l: any) => l.lineNo)).toEqual([1, 2]); // the service line can't be shipped
    expect(d.body.shippable[0].available).toBe(105);
    const over = await s.post(`/api/vendor/collab/orders/${poId}/shipments`, { shipDate: '2026-10-01', lines: [{ lineId: lines[1], quantity: 106 }] });
    expect(over.status).toBe(400);
    expect(over.body.error).toContain('at most 105');
    expect((await s.post(`/api/vendor/collab/orders/${poId}/shipments`, { shipDate: '2026-10-01', ewayBill: '1234', lines: [{ lineId: lines[1], quantity: 10 }] })).status).toBe(400);
    const ok = await s.post(`/api/vendor/collab/orders/${poId}/shipments`, { shipDate: '2026-10-01', expectedDate: '2026-10-04', carrier: 'Blue Dart', trackingNo: 'BD123', ewayBill: '3410 1234 5678', vehicleNo: 'mh12ab1234',
      lines: [{ lineId: lines[1], quantity: 60, batchNo: 'B-77' }, { lineId: lines[2], quantity: 10 }] });
    expect(ok.status).toBe(201);
    expect(ok.body.number).toMatch(/^ASN-\d{4}-\d{6}$/);
    expect(ok.body.vehicleNo).toBe('MH12AB1234');
    asnId = ok.body.id;
    const after = await s.get(`/api/vendor/collab/orders/${poId}`);
    expect(after.body.shippable[0].available).toBe(45);
    expect(after.body.shippable[1].available).toBe(0);
    const msg = await db.query.poMessages.findFirst({ where: and(eq(schema.poMessages.poId, poId), eq(schema.poMessages.kind, 'ASN')) });
    expect(msg?.status).toBe('TEST');
    const body = (msg?.payload as any).request.body;
    expect(body.event).toBe('shipment.created');
    expect(body.shipment.lines).toEqual(expect.arrayContaining([expect.objectContaining({ poLineErpId: 'COL-1-1', quantity: 60, batchNo: 'B-77' })]));
    const mail = await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, 'priya@acme.test'), orderBy: desc(schema.emailOutbox.createdAt) });
    expect(mail?.subject).toContain('PO-COL-1');
  });

  test('receipts from the ERP are matched to the notice; received notices can’t be cancelled', async () => {
    const r = await api('post', '/receipts').send({ receipts: [
      { erpId: 'RCV-1', poNumber: 'PO-COL-1', lineErpId: 'COL-1-1', receiptNumber: 'GRN-1', receiptDate: '2026-10-04', quantity: 40 },
      { erpId: 'RCV-2', poNumber: 'PO-COL-1', lineNo: 9, receiptNumber: 'GRN-2', quantity: 1 },
    ] });
    expect(r.body.recorded).toBe(1);
    expect(r.body.errors[0]).toContain('line not found');
    let ship = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, asnId) });
    expect(ship?.status).toBe('PARTLY_RECEIVED');
    let mail = await lastMail('ops@helix.test');
    expect(mail?.subject).toBe(`Partly received: shipment ${ship!.number} (PO-COL-1)`);
    expect(mail?.body).toContain('40 of 60 KG received');
    const line1 = await db.query.poLines.findFirst({ where: eq(schema.poLines.id, lines[1]) });
    expect(Number(line1?.receivedQty)).toBe(40);
    const s = await supplier();
    expect((await s.post(`/api/vendor/collab/shipments/${asnId}/cancel`, { reason: 'Wrong truck' })).status).toBe(409);
    await api('post', '/receipts').send([{ erpId: 'RCV-3', poNumber: 'PO-COL-1', lineErpId: 'COL-1-1', receiptNumber: 'GRN-3', quantity: 20 }, { erpId: 'RCV-4', poNumber: 'PO-COL-1', lineErpId: 'COL-1-2', receiptNumber: 'GRN-3', quantity: 10 }]);
    ship = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, asnId) });
    expect(ship?.status).toBe('RECEIVED');
    mail = await lastMail('ops@helix.test');
    expect(mail?.subject).toBe(`Received: shipment ${ship!.number} (PO-COL-1)`);
    expect(mail?.body).toContain('You can now invoice');
    const polled = await api('get', `/shipments?since=${encodeURIComponent('2020-01-01T00:00:00Z')}`);
    expect(polled.body.find((x: any) => x.number === ship!.number)?.lines).toHaveLength(2);
  });

  test('one reminder to buyer and supplier when the expected delivery date has passed', async () => {
    const s = await supplier();
    const n = await s.post(`/api/vendor/collab/orders/${poId}/shipments`, { shipDate: '2026-10-05', expectedDate: '2026-10-08', carrier: 'VRL', lines: [{ lineId: lines[1], quantity: 5 }] });
    expect(n.status).toBe(201);
    expect(await remindOverdueShipments(new Date('2026-10-08T12:00:00Z'))).toBe(0); // not late yet
    expect(await remindOverdueShipments(new Date('2026-10-11T04:00:00Z'))).toBe(1);
    expect((await lastMail('priya@acme.test'))?.subject).toBe(`Overdue delivery: ${n.body.number} (PO-COL-1)`);
    expect((await lastMail('priya@acme.test'))?.body).toContain('3 days ago');
    expect((await lastMail('ops@helix.test'))?.subject).toBe(`Delivery overdue: shipment ${n.body.number} (PO-COL-1)`);
    expect(await remindOverdueShipments(new Date('2026-10-12T04:00:00Z'))).toBe(0); // only once
    expect((await s.post(`/api/vendor/collab/shipments/${n.body.id}/cancel`, { reason: 'Re-sending' })).status).toBe(200);
  });

  test('a notice not yet received can be cancelled, and the quantity is free again', async () => {
    const s = await supplier();
    const n = await s.post(`/api/vendor/collab/orders/${poId}/shipments`, { shipDate: '2026-10-05', lines: [{ lineId: lines[1], quantity: 40 }] });
    expect(n.status).toBe(201);
    expect((await s.post(`/api/vendor/collab/shipments/${n.body.id}/cancel`, { reason: 'Truck broke down' })).status).toBe(200);
    expect((await s.get(`/api/vendor/collab/orders/${poId}`)).body.shippable[0].available).toBe(45);
    const cancel = await db.query.poMessages.findFirst({ where: and(eq(schema.poMessages.poId, poId), eq(schema.poMessages.kind, 'ASN_CANCEL')) });
    expect((cancel?.payload as any).request.body.event).toBe('shipment.cancelled');
  });
});

describe('supplier invoices', () => {
  let invId = '';
  const inv = (over: Record<string, unknown> = {}) => ({ invoiceNumber: 'HX/26-27/001', invoiceDate: '2026-10-06', total: 5900, lines: [{ lineId: lines[1], quantity: 60, unitPrice: 50, taxRate: 18 }, { lineId: lines[2], quantity: 10, unitPrice: 200, taxRate: 18 }], ...over });

  test('errors stop the invoice: over-billing, wrong total, wrong currency', async () => {
    const s = await supplier();
    const big = await s.post(`/api/vendor/collab/orders/${poId}/invoices`, inv({ lines: [{ lineId: lines[1], quantity: 120, unitPrice: 50, taxRate: 18 }], total: 7080 }));
    expect(big.status).toBe(422);
    expect(big.body.error).toContain('only 105');
    const sum = await s.post(`/api/vendor/collab/orders/${poId}/invoices`, inv({ total: 6000 }));
    expect(sum.status).toBe(422);
    expect(sum.body.error).toContain('doesn’t add up');
    expect((await s.post(`/api/vendor/collab/orders/${poId}/invoices`, inv({ currency: 'USD' }))).status).toBe(422);
  });

  test('a clean match waits as SUBMITTED; approval bills the lines and sends the invoice to the ERP', async () => {
    const s = await supplier();
    const pre = await s.post(`/api/vendor/collab/orders/${poId}/invoices/check`, inv());
    expect(pre.body.total).toBe(5900 + 0);
    const file = await s.agent.post('/api/vendor/collab/invoice-files').set('X-Requested-With', 'fetch').attach('file', Buffer.from('%PDF-1.4\n%%EOF'), { filename: 'inv.pdf', contentType: 'application/pdf' });
    expect(file.status).toBe(201);
    const r = await s.post(`/api/vendor/collab/orders/${poId}/invoices`, inv({ documentId: file.body.id, total: 5900 }));
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('SUBMITTED');
    invId = r.body.id;
    expect((await s.post(`/api/vendor/collab/orders/${poId}/invoices`, inv({ invoiceNumber: 'hx/26-27/001' }))).body.error).toContain('already been submitted');
    // The attachment isn't an onboarding document.
    const admin = await login('admin@acme.test');
    expect((await admin.get(`/api/staff/vendors/${vendor.id}`)).body.vendor.documents.find((d: any) => d.id === file.body.id)).toBeUndefined();
    const q = await admin.get('/api/invoices?status=REVIEW');
    expect(q.body.rows.map((x: any) => x.id)).toContain(invId);
    expect(q.body.canDecide).toBe(true);
    const viewer = await login('tax@acme.test');
    expect((await viewer.post(`/api/invoices/${invId}/decide`, { decision: 'APPROVE' })).status).toBe(403);
    expect((await admin.post(`/api/invoices/${invId}/decide`, { decision: 'APPROVE' })).body.status).toBe('APPROVED');
    const line1 = await db.query.poLines.findFirst({ where: eq(schema.poLines.id, lines[1]) });
    expect(Number(line1?.billedQty)).toBe(60);
    const row = await db.query.supplierInvoices.findFirst({ where: eq(schema.supplierInvoices.id, invId) });
    expect(row?.dueDate).toBe('2026-11-05');
    const msg = await db.query.poMessages.findFirst({ where: and(eq(schema.poMessages.poId, poId), eq(schema.poMessages.kind, 'INVOICE')) });
    expect((msg?.payload as any).request.body).toMatchObject({ event: 'invoice.approved', invoice: { invoiceNumber: 'HX/26-27/001', total: 5900 } });
    const d = await (await supplier()).get(`/api/vendor/collab/orders/${poId}`);
    expect(d.body.invoiceable.find((l: any) => l.lineNo === 1)).toMatchObject({ billed: 60, available: 45, availableReceived: 0 });
  });

  test('exceptions: price above tolerance, goods not received, QR mismatch; approving one needs a note', async () => {
    const s = await supplier();
    const qr = jwt({ SellerGstin: '29AAAAA0000A1Z5', DocNo: 'HX/26-27/002', Irn: 'a'.repeat(64), TotInvVal: 649 });
    const r = await s.post(`/api/vendor/collab/orders/${poId}/invoices`, { invoiceNumber: 'HX/26-27/002', invoiceDate: '2026-10-07', total: 649.5,
      lines: [{ lineId: lines[1], quantity: 10, unitPrice: 55, taxRate: 18 }], einvoice: { irn: 'A'.repeat(64), signedQr: qr } });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('EXCEPTION');
    const codes = r.body.checks.map((c: any) => c.code);
    expect(codes).toEqual(expect.arrayContaining(['PRICE_OVER', 'QTY_NOT_RECEIVED', 'QR_MISMATCH']));
    const admin = await login('admin@acme.test');
    expect((await admin.post(`/api/invoices/${r.body.id}/decide`, { decision: 'APPROVE' })).status).toBe(400);
    expect((await admin.post(`/api/invoices/${r.body.id}/decide`, { decision: 'REJECT' })).status).toBe(400);
    expect((await admin.post(`/api/invoices/${r.body.id}/decide`, { decision: 'REJECT', note: 'Price is 50 per the PO' })).body.status).toBe('REJECTED');
    const mail = await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, 'ops@helix.test'), orderBy: desc(schema.emailOutbox.createdAt) });
    expect(mail?.body).toContain('Price is 50 per the PO');
    // A rejected number can be used again for the corrected invoice; the service line needs no receipt.
    const again = await s.post(`/api/vendor/collab/orders/${poId}/invoices`, { invoiceNumber: 'HX/26-27/002', invoiceDate: '2026-10-07', total: 1180, lines: [{ lineId: lines[3], quantity: 1, unitPrice: 1000, taxRate: 18 }] });
    expect(again.body.status).toBe('SUBMITTED');
    expect((await s.post(`/api/vendor/collab/invoices/${again.body.id}/cancel`, {})).body.status).toBe('CANCELLED');
  });

  test('payments from the ERP settle invoices and send a remittance advice', async () => {
    const r = await api('post', '/payments').send({ payments: [
      { erpId: 'PAY-1', supplierCode: 'SUP-COL-1', reference: 'UTR998877', paymentDate: '2026-10-20', method: 'NEFT', currency: 'INR', amount: 3000, invoices: [{ invoiceNumber: 'HX/26-27/001', amount: 3000, withheld: 50 }] },
      { erpId: 'PAY-X', supplierCode: 'NOPE', reference: 'X', paymentDate: '2026-10-20', currency: 'INR', amount: 1, invoices: [{ invoiceNumber: 'A', amount: 1 }] },
    ] });
    expect(r.body).toMatchObject({ created: 1, failed: 1 });
    let row = await db.query.supplierInvoices.findFirst({ where: eq(schema.supplierInvoices.id, invId) });
    expect(row?.status).toBe('PARTLY_PAID');
    expect(Number(row?.paidAmount)).toBe(3050);
    expect((await api('post', '/payments').send({ erpId: 'PAY-1', supplierCode: 'SUP-COL-1', reference: 'UTR998877', paymentDate: '2026-10-20', currency: 'INR', amount: 3000, invoices: [{ invoiceNumber: 'HX/26-27/001', amount: 3000 }] })).body.unchanged).toBe(1);
    // The vendor code (or ERP vendor id) works too, as it does for purchase orders.
    await api('post', '/payments').send({ erpId: 'PAY-2', supplierCode: vendor.code, reference: 'UTR998878', paymentDate: '2026-10-25', currency: 'INR', amount: 2850, invoices: [{ invoiceNumber: 'HX/26-27/001', amount: 2850 }] });
    row = await db.query.supplierInvoices.findFirst({ where: eq(schema.supplierInvoices.id, invId) });
    expect(row?.status).toBe('PAID');
    const mail = await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, 'ops@helix.test'), orderBy: desc(schema.emailOutbox.createdAt) });
    expect(mail?.subject).toContain('Payment advice');
    const s = await supplier();
    expect((await s.get('/api/vendor/collab/payments')).body.rows).toHaveLength(2);
    const d = await s.get(`/api/vendor/collab/invoices/${invId}`);
    expect(d.body.payments.map((p: any) => p.amount).sort()).toEqual([2850, 3000]);
    expect(d.body.invoice.decidedBy).toBeNull();
    const ap = await api('get', `/invoices?since=${encodeURIComponent('2020-01-01T00:00:00Z')}&status=PAID`);
    expect(ap.body.find((x: any) => x.id === invId)?.lines).toHaveLength(2);
    expect((await api('put', `/invoices/${invId}`).send({ erpInvoiceId: 'AP-77' })).body.erpInvoiceId).toBe('AP-77');
  });
});

describe('matching helpers', () => {
  test('signed QR payload, e-invoice checks, payment terms', () => {
    const q = jwt({ SellerGstin: GSTIN, DocNo: 'INV-1', Irn: 'b'.repeat(64), TotInvVal: 100, BuyerGstin: '27AAACA0000A1Z5' });
    expect(decodeSignedQr(q)).toMatchObject({ DocNo: 'INV-1' });
    expect(decodeSignedQr('nope')).toBeNull();
    expect(einvoiceChecks({ irn: 'b'.repeat(64), signedQr: q }, { supplierGstin: GSTIN, invoiceNumber: 'inv-1', total: 100.4, required: false })[0].code).toBe('QR_OK');
    expect(einvoiceChecks({ irn: 'xyz' }, { supplierGstin: GSTIN, invoiceNumber: 'INV-1', total: 100, required: false })[0].code).toBe('IRN_FORMAT');
    expect(einvoiceChecks(null, { supplierGstin: GSTIN, invoiceNumber: 'INV-1', total: 100, required: true })[0].code).toBe('EINVOICE_MISSING');
    expect(termDays('Net 45')).toBe(45);
    expect(termDays('Immediate')).toBeNull();
  });
});

describe('SAP S/4HANA and Dynamics 365 connectors', () => {
  const conn = (kind: 'sap' | 'dynamics', testMode = false): Connection => ({ kind, testMode, autoPush: true,
    config: kind === 'sap' ? { url: 'https://s4.example.com', username: 'VG_COMM', companyCode: '1010', purchasingOrg: '1010', grouping: 'BP02' } : { url: 'https://contoso.operations.dynamics.com', tenantId: 'tid', clientId: 'cid', dataAreaId: 'inmf', vendorGroup: 'DOM' },
    secrets: kind === 'sap' ? { password: 'pw' } : { clientSecret: 'cs' } });

  test('payload shapes', () => {
    const bp = toSapBusinessPartner(vendor, conn('sap')) as any;
    expect(bp).toMatchObject({ BusinessPartnerCategory: '2', BusinessPartnerGrouping: 'BP02', OrganizationBPName1: 'Helix Polymers Pvt Ltd', SearchTerm1: 'VND-COL-1' });
    expect(bp.to_BusinessPartnerRole.results).toEqual([{ BusinessPartnerRole: 'FLVN00' }, { BusinessPartnerRole: 'FLVN01' }]);
    expect(bp.to_BusinessPartnerTax.results).toEqual([{ BPTaxType: 'IN3', BPTaxNumber: GSTIN }]);
    expect(bp.to_BusinessPartnerBank.results[0]).toMatchObject({ BankCountryKey: 'IN', BankNumber: 'HDFC0000123', BankAccount: '50100200300' });
    expect(bp.to_Supplier.to_SupplierCompany.results).toEqual([{ CompanyCode: '1010' }]);
    const dv = toDynamicsVendor(vendor, conn('dynamics'));
    expect(dv).toMatchObject({ dataAreaId: 'inmf', VendorAccountNumber: 'VND-COL-1', VendorGroupId: 'DOM', AddressCountryRegionId: 'IND', TaxExemptNumber: GSTIN, OnHoldStatus: 'No' });
    expect(iso3('SA')).toBe('SAU');
  });

  test('SAP: CSRF token fetch, then a deep insert; the BP number comes back as the ERP id', async () => {
    const calls: { method: string; url: string; headers: any }[] = [];
    setErpFetch((async (url: string, init: any) => {
      calls.push({ method: init.method, url, headers: init.headers });
      if (init.method === 'GET') return new Response('', { status: 200, headers: [['x-csrf-token', 'tok123'], ['set-cookie', 'SAP_SESSIONID=abc; path=/']] });
      return new Response(JSON.stringify({ d: { BusinessPartner: '1000123' } }), { status: 201 });
    }) as any);
    try {
      const r = await send(conn('sap'), vendor, 'CREATE', { syncId: 's1', tenantSlug: 'acme' });
      expect(r.erpVendorId).toBe('1000123');
      expect(calls[0].headers['x-csrf-token']).toBe('Fetch');
      expect(calls[1]).toMatchObject({ method: 'POST', url: 'https://s4.example.com/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner' });
      expect(calls[1].headers).toMatchObject({ 'x-csrf-token': 'tok123', Cookie: 'SAP_SESSIONID=abc' });
      calls.length = 0;
      await send(conn('sap'), { ...vendor, erpVendorId: '1000123' }, 'BLOCK', { syncId: 's2', tenantSlug: 'acme' });
      expect(calls[1]).toMatchObject({ method: 'PATCH', url: "https://s4.example.com/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_Supplier('1000123')" });
    } finally { setErpFetch(); }
  });

  test('Dynamics: client-credentials token (cached), VendorsV2 then the bank account', async () => {
    clearDynamicsTokens();
    const calls: { method: string; url: string; body: string }[] = [];
    setErpFetch((async (url: string, init: any) => {
      calls.push({ method: init.method, url, body: init.body });
      if (url.includes('login.microsoftonline.com')) return new Response(JSON.stringify({ access_token: 'AT', expires_in: 3600 }), { status: 200 });
      if (url.includes('VendorsV2')) return new Response(JSON.stringify({ VendorAccountNumber: 'VND-COL-1' }), { status: 201 });
      return new Response('{}', { status: 201 });
    }) as any);
    try {
      const r = await send(conn('dynamics'), vendor, 'CREATE', { syncId: 's3', tenantSlug: 'acme' });
      expect(r.erpVendorId).toBe('VND-COL-1');
      expect(calls.map((c) => c.url)).toEqual(['https://login.microsoftonline.com/tid/oauth2/v2.0/token', 'https://contoso.operations.dynamics.com/data/VendorsV2?cross-company=true', 'https://contoso.operations.dynamics.com/data/VendorBankAccounts?cross-company=true']);
      expect(calls[0].body).toContain('scope=https%3A%2F%2Fcontoso.operations.dynamics.com%2F.default');
      calls.length = 0;
      await send(conn('dynamics'), { ...vendor, erpVendorId: 'VND-COL-1' }, 'BLOCK', { syncId: 's4', tenantSlug: 'acme' });
      expect(calls).toHaveLength(1); // token reused
      expect(calls[0]).toMatchObject({ method: 'PATCH', url: "https://contoso.operations.dynamics.com/data/VendorsV2(dataAreaId='inmf',VendorAccountNumber='VND-COL-1')?cross-company=true" });
      expect(JSON.parse(calls[0].body)).toEqual({ OnHoldStatus: 'All' });
    } finally { setErpFetch(); }
  });

  test('connection settings: SAP and Dynamics need their credentials before going live', async () => {
    const admin = await login('admin@acme.test');
    expect((await admin.put('/api/admin/erp', { kind: 'sap', testMode: false, autoPush: true, config: { url: 'https://s4.example.com' }, secrets: {} })).status).toBe(400);
    expect((await admin.put('/api/admin/erp', { kind: 'dynamics', testMode: true, autoPush: true, config: { url: 'https://contoso.operations.dynamics.com', dataAreaId: 'inmf', messageUrl: 'https://flow.example.com/vg' }, secrets: {} })).body.kind).toBe('dynamics');
    await db.delete(schema.erpConnections).where(eq(schema.erpConnections.tenantId, acme.id));
  });
});
