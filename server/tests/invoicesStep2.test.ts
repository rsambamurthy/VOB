/** Invoices step 2: the configurable duplicate check, configurable algorithms and their document, forward for approval, the email inbox. */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { client, login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import { createTenant } from '../src/services/tenants.js';
import { hashPassword } from '../src/lib/password.js';
import { algorithmsMarkdown } from '../src/lib/algorithms.js';
import { numberCore, numberKey, panOf, slipKind, lookalikeKey } from '../src/services/invoices/duplicates.js';
import { isoDate, readInvoiceText } from '../src/services/invoices/reading.js';
import '../src/services/invoices/inbox.js';
import { PDF_BYTES, iso } from './contractsHelpers.js';

const WS = `apdup${Date.now() % 1e6}`;
const PW = 'Demo@12345';
const H = { 'X-Requested-With': 'fetch' };
let tenantId = '';
let admin: Awaited<ReturnType<typeof login>>, clerk: Awaited<ReturnType<typeof login>>, approver: Awaited<ReturnType<typeof login>>, buyer: Awaited<ReturnType<typeof login>>;
let kst: { id: string; code: string }, kst2: { id: string; code: string }, buyerId = '', approverId = '';
let tag = 0;

async function user(name: string, email: string, roleKey: string) {
  const role = (await db.query.roles.findFirst({ where: and(eq(schema.roles.tenantId, tenantId), eq(schema.roles.key, roleKey)) }))!;
  const [u] = await db.insert(schema.users).values({ tenantId, name, email, status: 'ACTIVE', passwordHash: await hashPassword(PW), passwordChangedAt: new Date(), lastLoginAt: new Date() }).returning();
  await db.insert(schema.userRoles).values({ userId: u.id, roleId: role.id });
  return u;
}
const line = (amount: number) => [{ description: 'Steel plates', quantity: 1, unitPrice: amount, taxRate: 0, glAccount: '5100', costCentre: '120' }];
/** A draft (checks run on save). */
async function draft(partyId: string, invoiceNumber: string, invoiceDate: string, amount: number, extra: Record<string, unknown> = {}) {
  const r = await clerk.post('/api/staff/invoices', { kind: 'INVOICE', partyId, invoiceNumber, invoiceDate, total: amount, lines: line(amount), ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}
/** Draft + PDF + submit. */
async function submitted(partyId: string, invoiceNumber: string, invoiceDate: string, amount: number, extra: Record<string, unknown> = {}) {
  const d = await draft(partyId, invoiceNumber, invoiceDate, amount, extra);
  await clerk.agent.post(`/api/staff/invoices/${d.invoice.id}/file`).set(H).attach('file', PDF_BYTES(`f${++tag}`), `${tag}.pdf`);
  const s = await clerk.post(`/api/staff/invoices/${d.invoice.id}/submit`, {});
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  return s.body;
}
const rules = (d: any) => d.invoice.checks.filter((c: any) => c.rule).map((c: any) => `${c.rule}:${c.level}`);

beforeAll(async () => {
  const { tenant } = await createTenant({ slug: WS, name: 'AP Dup Co', adminName: 'Asha Admin', adminEmail: `admin@${WS}.test`, adminPassword: PW, country: 'IN', plan: 'contracts', limits: { features: { invoices: true } } });
  tenantId = tenant.id;
  await user('Arun Clerk', `clerk@${WS}.test`, 'AP_CLERK');
  approverId = (await user('Ira Approver', `approver@${WS}.test`, 'INVOICE_APPROVER')).id;
  buyerId = (await user('Pooja Procurement', `buyer@${WS}.test`, 'INVOICE_VIEWER')).id;
  [admin, clerk, approver, buyer] = await Promise.all([login(`admin@${WS}.test`, WS, PW), login(`clerk@${WS}.test`, WS, PW), login(`approver@${WS}.test`, WS, PW), login(`buyer@${WS}.test`, WS, PW)]);
  expect((await admin.put('/api/admin/invoices', { enabled: true, bases: { po: true, contract: true, nonPo: true }, features: { bulkUpload: true, excelImport: true, touchless: false, creditNotes: true, debitNotes: true, emailInbox: true }, rules: { pushMode: 'manual' } })).status).toBe(200);
  // No approval matrix: invoices wait for one decision (forwarding is tested both ways).
  expect((await admin.put('/api/admin/invoices/approval', { levels: [] })).status).toBe(200);
  for (const [kind, code, name] of [['ACCOUNT', '5100', 'Materials'], ['COST_CENTRE', '120', 'Pune plant']]) await admin.post('/api/staff/invoices/codes', { kind, code, name });
  kst = (await admin.post('/api/staff/parties', { kind: 'SUPPLIER', name: 'Kirloskar Steel', country: 'IN', taxNo: '27AABCK1234F1Z5', email: 'sales@kirloskarsteel.test', ap: { accountsEmail: 'accounts@kirloskarsteel.test' } })).body.party;
  kst2 = (await admin.post('/api/staff/parties', { kind: 'SUPPLIER', name: 'Kirloskar Steel Chakan', country: 'IN', taxNo: '27AABCK1234F2Z4', confirmDuplicate: true })).body.party;
});
afterAll(async () => { await db.delete(schema.tenants).where(eq(schema.tenants.id, tenantId)); });

describe('helpers', () => {
  test('number key and core, slips, PAN', () => {
    expect(numberKey('kst/2026-1187')).toBe('KST20261187');
    expect(numberCore('HX/26-27/001')).toBe('1');
    expect(numberCore('KST/2026/1187')).toBe('1187');
    expect(numberCore('INV-000')).toBe('0');
    expect(numberCore('1187/2026-27')).toBe('1187');
    expect(numberCore('SFS/86461/1187')).toBe('1187');
    expect(numberCore('2026')).toBe('2026');
    expect(slipKind('1187', '1178')).toBe('swap');
    expect(slipKind('1187', '11877')).toBe('indel');
    expect(slipKind('HX2627001', 'HX2627002')).toBe('change');
    expect(slipKind('1187', '2299')).toBeNull();
    expect(lookalikeKey('INVO12')).toBe(lookalikeKey('INV012'));
    expect(panOf('27AABCK1234F1Z5')).toBe('AABCK1234F');
    expect(panOf('100234567800003')).toBe('100234567800003');
  });
  test('reading an invoice’s text', () => {
    expect(isoDate('05/11/2026')).toBe('2026-11-05');
    expect(isoDate('5-Nov-2026')).toBe('2026-11-05');
    expect(isoDate('November 5, 2026')).toBe('2026-11-05');
    expect(isoDate('31/02/2026')).toBeUndefined();
    const f = readInvoiceText(`TAX INVOICE\nInvoice No: KST/2026/1300\nInvoice Date: 05/11/2026\nSupplier GSTIN 27AABCK1234F1Z5  Buyer GSTIN 29AAACA1111A1Z1\nTaxable 50,000.00 IGST 9,000.00\nGrand Total : Rs. 59,000.00\nIRN ${'ab'.repeat(32)}`, { gstin: '29AAACA1111A1Z1' });
    expect(f).toMatchObject({ invoiceNumber: 'KST/2026/1300', invoiceDate: '2026-11-05', total: 59000, irn: 'ab'.repeat(32), gstins: ['27AABCK1234F1Z5'] });
  });
});

describe('duplicate check', () => {
  test('H1 blocks the same number; P1–P4 warn; a monthly bill is clean', async () => {
    await submitted(kst.id, 'KST/2026/1187', iso(-20), 179950);
    expect((await draft(kst.id, 'kst 2026 1187', iso(-20), 179950)).invoice.checks.find((c: any) => c.code === 'DUPLICATE')?.level).toBe('error');
    expect(rules(await draft(kst.id, '1187', iso(-19), 5000))).toContain('P1:warning');
    expect(rules(await draft(kst.id, 'KST/2026/1178', iso(-19), 179950))).toContain('P2:warning');
    expect(rules(await draft(kst.id, 'KST/2026/1201', iso(-16), 179950))).toContain('P3:warning');
    // Consecutive numbers, different amounts: normal.
    expect(rules(await draft(kst.id, 'KST/2026/1188', iso(-18), 22000))).toEqual([]);
    // Same PAN under another supplier code.
    const p4 = await draft(kst2.id, 'KST/2026/1187', iso(-20), 179950);
    expect(rules(p4)).toContain('P4:warning');
    expect(p4.invoice.checks.find((c: any) => c.rule === 'P4').message).toMatch(/KST\/2026\/1187/);
    // Monthly bill: same amount, a month apart.
    await submitted(kst.id, 'RENT/0412', iso(-60), 295000);
    expect(rules(await draft(kst.id, 'RENT/0498', iso(-29), 295000))).toEqual([]);
  });

  test('H2 same IRN and H3 same PDF, across suppliers', async () => {
    const irn = 'cd'.repeat(32);
    await submitted(kst.id, 'KST/IRN/1', iso(-10), 1000, { einvoice: { irn } });
    expect((await draft(kst2.id, 'OTHER/9', iso(-9), 777, { einvoice: { irn } })).invoice.checks.find((c: any) => c.rule === 'H2')?.level).toBe('error');
    const a = await draft(kst.id, 'KST/F/1', iso(-5), 1500);
    await clerk.agent.post(`/api/staff/invoices/${a.invoice.id}/file`).set(H).attach('file', PDF_BYTES('same-file'), 'a.pdf');
    const b = await draft(kst2.id, 'OTHER/10', iso(-5), 888);
    const r = await clerk.agent.post(`/api/staff/invoices/${b.invoice.id}/file`).set(H).attach('file', PDF_BYTES('same-file'), 'b.pdf');
    expect(r.status).toBe(200);
    const saved = (await clerk.put(`/api/staff/invoices/${b.invoice.id}`, { kind: 'INVOICE', partyId: kst2.id, invoiceNumber: 'OTHER/10', invoiceDate: iso(-5), total: 888, lines: line(888) })).body;
    expect(saved.invoice.checks.find((c: any) => c.rule === 'H3')?.level).toBe('error');
  });

  test('configurable: rules switched off or made stricter; locked rules refused; changes audited; the document follows', async () => {
    const v = (await admin.get('/api/admin/algorithms/invoiceDuplicates')).body;
    expect(v.values.params).toMatchObject({ lookbackMonths: 18, dateWindowDays: 7, amountTolerance: 1, ocrLookalikes: true });
    expect(v.rules.find((r: any) => r.key === 'H2').locked).toBeTruthy();
    expect((await admin.put('/api/admin/algorithms/invoiceDuplicates', { rules: { H2: 'warn' } })).status).toBe(400);
    expect((await admin.put('/api/admin/algorithms/invoiceDuplicates', { params: { dateWindowDays: 500 } })).status).toBe(400);
    expect((await clerk.get('/api/admin/algorithms')).status).toBe(403);
    const r = await admin.put('/api/admin/algorithms/invoiceDuplicates', { rules: { P3: 'off', H1: 'warn' }, params: { dateWindowDays: 3 } });
    expect(r.status).toBe(200);
    expect(r.body.changes).toEqual(expect.arrayContaining(['Date window: 7 → 3', 'P3 Same amount, close dates: Warn → Off', 'H1 Same number: Block → Warn']));
    expect(rules(await draft(kst.id, 'KST/2026/1202', iso(-17), 179950))).not.toContain('P3:warning');
    expect(rules(await draft(kst.id, 'KST/2026/1187', iso(-20), 179950))).toContain('H1:warning');
    const audit = await db.query.auditLogs.findFirst({ where: and(eq(schema.auditLogs.tenantId, tenantId), eq(schema.auditLogs.action, 'ALGORITHM_CHANGED')) });
    expect(JSON.stringify(audit?.detail)).toContain('Date window');
    expect((await admin.put('/api/admin/algorithms/invoiceDuplicates', { rules: { P3: 'warn', H1: 'block' }, params: { dateWindowDays: 7 } })).status).toBe(200);
    // The workspace's document, and the product document in the repository, come from the same definition.
    const md = await admin.agent.get('/api/admin/algorithms/invoiceDuplicates/document.md').set(H);
    expect(md.text).toContain('| P3 Same amount, close dates | Warn |');
    expect(fs.readFileSync(path.resolve(__dirname, '../../docs/ALGORITHMS.md'), 'utf8').trim()).toBe(algorithmsMarkdown().trim());
  });

  test('“not a duplicate” clears the pair with a note; it is not raised again', async () => {
    const s = await submitted(kst.id, 'KST/2026/1199', iso(-17), 179950);
    expect(s.invoice.status).toBe('EXCEPTION');
    expect(rules(s)).toContain('P3:warning');
    expect((await clerk.post(`/api/staff/invoices/${s.invoice.id}/not-duplicate`, {})).status).toBe(400);
    const c = await clerk.post(`/api/staff/invoices/${s.invoice.id}/not-duplicate`, { note: 'Second consignment, PO 4512' });
    expect(c.status).toBe(200);
    expect(c.body.invoice.status).toBe('SUBMITTED');
    expect(rules(c.body)).toEqual([]);
    expect(c.body.duplicateCleared[0]).toMatchObject({ number: 'KST/2026/1187', rule: 'P3', by: 'Arun Clerk', note: 'Second consignment, PO 4512' });
  });
});

describe('forward for approval', () => {
  test('waiting for one decision: forwarded to Procurement, then back to the AP decision', async () => {
    const s = await submitted(kst.id, 'KST/FWD/1', iso(-3), 4200);
    expect(s.invoice.status).toBe('SUBMITTED');
    const opts = (await clerk.get('/api/staff/invoices/forward-options')).body;
    expect(opts.users.map((u: any) => u.name)).toContain('Pooja Procurement');
    expect((await clerk.post(`/api/staff/invoices/${s.invoice.id}/forward`, { userId: buyerId, note: '' })).status).toBe(400);
    const f = await clerk.post(`/api/staff/invoices/${s.invoice.id}/forward`, { userId: buyerId, note: 'Was the rework on PO 4512 agreed?' });
    expect(f.status).toBe(200);
    expect(f.body.invoice.status).toBe('IN_APPROVAL');
    expect(f.body.flow.steps.map((x: any) => x.label)).toEqual(['Forwarded to Pooja Procurement', 'AP decision']);
    expect(f.body.flow.steps[0].forwarded).toMatchObject({ by: 'Arun Clerk', note: 'Was the rework on PO 4512 agreed?' });
    const mail = await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, `buyer@${WS}.test`) });
    expect(mail?.body).toContain('Was the rework on PO 4512 agreed?');
    // Procurement opens it (no invoice permission needed for a step they hold) and approves.
    expect((await buyer.get(`/api/staff/invoices/${s.invoice.id}`)).body.flow.canAct).toBe(true);
    expect((await buyer.post(`/api/staff/invoices/${s.invoice.id}/approval`, { action: 'APPROVE', remarks: 'Yes, agreed with the plant' })).status).toBe(200);
    const back = (await approver.get(`/api/staff/invoices/${s.invoice.id}`)).body;
    expect(back.flow.current.label).toBe('AP decision');
    expect(back.flow.canAct).toBe(true);
    expect((await approver.post(`/api/staff/invoices/${s.invoice.id}/approval`, { action: 'APPROVE', remarks: '' })).body.invoice.status).toBe('APPROVED');
  });

  test('in the matrix: the forwarded step goes in front of the pending level, which comes back afterwards', async () => {
    await admin.put('/api/admin/invoices/approval', { levels: [{ id: 'fin', label: 'Finance approval', roleKey: 'INVOICE_APPROVER' }] });
    const s = await submitted(kst.id, 'KST/FWD/2', iso(-3), 5300);
    expect(s.invoice.status).toBe('IN_APPROVAL');
    const f = await approver.post(`/api/staff/invoices/${s.invoice.id}/forward`, { userId: buyerId, note: 'Please confirm receipt' });
    expect(f.body.flow.steps.map((x: any) => [x.label, x.status])).toEqual([['Forwarded to Pooja Procurement', 'PENDING'], ['Finance approval', 'WAITING']]);
    expect((await buyer.post(`/api/staff/invoices/${s.invoice.id}/approval`, { action: 'APPROVE', remarks: 'Received' })).status).toBe(200);
    const d = (await approver.get(`/api/staff/invoices/${s.invoice.id}`)).body;
    expect(d.flow.current.label).toBe('Finance approval');
    // Forwarded to a role; a rejection there ends it.
    const role = (await db.query.roles.findFirst({ where: and(eq(schema.roles.tenantId, tenantId), eq(schema.roles.key, 'INVOICE_VIEWER')) }))!;
    await approver.post(`/api/staff/invoices/${s.invoice.id}/forward`, { roleId: role.id, note: 'Anyone in procurement?' });
    expect((await buyer.post(`/api/staff/invoices/${s.invoice.id}/approval`, { action: 'REJECT', remarks: 'Not ours' })).body.invoice.status).toBe('REJECTED');
    await admin.put('/api/admin/invoices/approval', { levels: [] });
  });
});

describe('email inbox', () => {
  let address = '';
  const SECRET = 'test-inbound-secret-0123456789';
  async function invoicePdf(lines: string[]) {
    const { default: PDFDocument } = await import('pdfkit');
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    lines.forEach((l) => doc.text(l));
    doc.end();
    await new Promise((r) => doc.on('end', r));
    return Buffer.concat(chunks);
  }
  const mime = (from: string, to: string, subject: string, files: { name: string; type: string; data: Buffer }[], id = `<${Date.now()}.${Math.random()}@mail.test>`) => [
    `From: Accounts <${from}>`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: ${id}`, 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b1"', '',
    '--b1', 'Content-Type: text/plain; charset=utf-8', '', 'Please find our invoice attached.', '',
    ...files.flatMap((f) => ['--b1', `Content-Type: ${f.type}; name="${f.name}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${f.name}"`, '', f.data.toString('base64'), '']),
    '--b1--', '',
  ].join('\r\n');
  const post = (body: string, secret = SECRET) => client().agent.post(`/api/inbound/email/${secret}`).set('Content-Type', 'message/rfc822').send(body);

  test('the address, the algorithm settings and the switch', async () => {
    const v = (await admin.put('/api/admin/invoices/inbox', {})).body;
    expect(v.address).toMatch(new RegExp(`^invoices-${WS}-[a-f0-9]{10}@in\\.vendorgate\\.test$`));
    address = v.address;
    expect((await admin.get('/api/admin/algorithms')).body.algorithms.map((a: any) => a.key)).toEqual(expect.arrayContaining(['invoiceDuplicates', 'invoiceInbox']));
    expect((await admin.put('/api/admin/invoices/inbox', { imap: { host: 'imap.example.test', user: 'ap@example.test' } })).status).toBe(400);
    const withBox = (await admin.put('/api/admin/invoices/inbox', { imap: { host: 'imap.example.test', user: 'ap@example.test', password: 'app-password' } })).body;
    expect(withBox.imap).toMatchObject({ host: 'imap.example.test', passwordSet: true });
    expect(JSON.stringify(withBox)).not.toContain('app-password');
    await admin.put('/api/admin/invoices/inbox', { imap: null });
  });

  test('a supplier emails an invoice: draft for that supplier, facts read from the PDF; the same email twice is one; a wrong secret is refused', async () => {
    const pdf = await invoicePdf(['TAX INVOICE', 'Invoice No: KST/2026/1300', 'Invoice Date: 05/11/2026', 'GSTIN 27AABCK1234F1Z5', 'Grand Total: Rs. 59,000.00']);
    const body = mime('accounts@kirloskarsteel.test', address, 'Invoice KST/2026/1300', [{ name: 'KST-1300.pdf', type: 'application/pdf', data: pdf }, { name: 'logo.png', type: 'image/png', data: Buffer.alloc(2000) }], '<one@mail.test>');
    expect((await post(body, 'wrong-secret-wrong-secret-xx')).status).toBe(401);
    const r = await post(body);
    expect(r.body).toMatchObject({ handled: true, status: 'PROCESSED', drafts: 1 });
    expect((await post(body)).body).toMatchObject({ handled: true, drafts: 1 });
    const inbox = (await clerk.get('/api/staff/invoices/inbox')).body.rows;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ fromAddress: 'accounts@kirloskarsteel.test', status: 'PROCESSED', party: { code: kst.code } });
    expect(inbox[0].attachments.map((a: any) => a.result)).toEqual(['Draft created', 'Skipped — not an invoice file']);
    const d = (await clerk.get(`/api/staff/invoices/${inbox[0].invoiceIds[0]}`)).body;
    expect(d.invoice).toMatchObject({ status: 'DRAFT', source: 'EMAIL', invoiceNumber: 'KST/2026/1300', invoiceDate: '2026-11-05', total: 59000, partyId: kst.id });
    expect(d.mail.subject).toBe('Invoice KST/2026/1300');
    expect(d.file).toBe('KST-1300.pdf');
  });

  test('the same PDF in another email is not made twice; unknown senders follow the setting; not ours is ignored', async () => {
    const pdf = await invoicePdf(['Invoice No: XYZ-77', 'Grand Total 1,000.00']);
    const r1 = await post(mime('billing@unknown-vendor.test', address, 'Bill', [{ name: 'xyz.pdf', type: 'application/pdf', data: pdf }]));
    expect(r1.body).toMatchObject({ status: 'PROCESSED', drafts: 1 });
    const d = (await clerk.get(`/api/staff/invoices/${(await db.query.invoiceMails.findFirst({ where: eq(schema.invoiceMails.subject, 'Bill') }))!.invoiceIds[0]}`)).body;
    expect(d.invoice.partyId).toBeNull();
    const r2 = await post(mime('billing@unknown-vendor.test', address, 'Bill again', [{ name: 'xyz-copy.pdf', type: 'application/pdf', data: pdf }]));
    expect(r2.body).toMatchObject({ status: 'DUPLICATE', drafts: 0 });
    await admin.put('/api/admin/algorithms/invoiceInbox', { params: { unknownSenders: false } });
    const r3 = await post(mime('someone@else.test', address, 'Spam', [{ name: 'other.pdf', type: 'application/pdf', data: await invoicePdf(['hello']) }]));
    expect(r3.body).toMatchObject({ status: 'IGNORED', drafts: 0 });
    await admin.put('/api/admin/algorithms/invoiceInbox', { params: { unknownSenders: true } });
    expect((await post(mime('a@b.test', 'invoices-nobody-0123456789@in.vendorgate.test', 'x', []))).body).toMatchObject({ handled: false });
    // Postmark JSON with an image scan.
    const pm = await client().agent.post(`/api/inbound/email/${SECRET}`).send({ MessageID: 'pm-1', FromFull: { Email: 'sales@kirloskarsteel.test', Name: 'KST' }, ToFull: [{ Email: address }], Subject: 'Scan',
      Attachments: [{ Name: 'scan.png', ContentType: 'image/png', Content: Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(60 * 1024)]).toString('base64') }] });
    expect(pm.body).toMatchObject({ handled: true });
  });

  test('switched off: recorded and ignored', async () => {
    await admin.put('/api/admin/invoices', { enabled: true, bases: { po: true, contract: true, nonPo: true }, features: { bulkUpload: true, excelImport: true, touchless: false, creditNotes: true, debitNotes: true, emailInbox: false }, rules: { pushMode: 'manual' } });
    const r = await post(mime('accounts@kirloskarsteel.test', address, 'Off', [{ name: 'q.pdf', type: 'application/pdf', data: await invoicePdf(['Invoice No: Q-1']) }]));
    expect(r.body).toMatchObject({ status: 'IGNORED', drafts: 0 });
  });
});

describe('the add-on’s invoices stay out of the supplier portal and Purchasing’s own list', () => {
  test('drafts, notes and non-PO invoices are not listed there', async () => {
    const acmeAdmin = await login('admin@acme.test');
    const list = (await acmeAdmin.get('/api/invoices?page=1')).body.rows ?? [];
    expect(list.every((r: any) => r.status !== 'DRAFT' && r.kind === 'INVOICE' && r.poId)).toBe(true);
  });
});
