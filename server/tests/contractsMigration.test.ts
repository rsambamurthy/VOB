/** Contracts migration: master agreements in the Excel import, bulk signed copies (files and .zip), the inbox, bulk reading and its review, obligations from Excel, the checklist. */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import PizZip from 'pizzip';
import { login } from './helpers.js';
import { iso, PDF_BYTES, wordFile } from './contractsHelpers.js';
import { db, schema } from '../src/lib/db.js';
import type { Tenant } from '../src/db/schema.js';
import { matchName, unpack, ZIP_LIMITS } from '../src/services/contracts/migration.js';

let acme: Tenant;
let original: Pick<Tenant, 'settings' | 'limits' | 'plan'>;
const H = { 'X-Requested-With': 'fetch' };
const TERMS = ['MAINTENANCE AGREEMENT', 'This Agreement is made on 2 January 2026 between the Company and the Contractor for the upkeep of the chillers at the Pune plant.',
  '1. Term. This Agreement commences on 1 February 2026 and continues until 31 January 2028. It renews automatically for further periods of twelve (12) months unless either Party gives forty-five (45) days prior written notice.',
  '2. Price. The total consideration is INR 9,60,000 payable monthly.', '3. Governing law. This Agreement is governed by the laws of India.'];

async function sheet(name: string, headers: string[], rows: (string | number)[][]) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet(name);
  ws.addRow(headers); rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const CONTRACT_HEADERS = ['Party type', 'Party', 'Party country', 'Contract type', 'Title', 'Their reference', 'Value', 'Currency', 'Start date', 'End date', 'Signed date', 'Renews automatically', 'Renewal months', 'Notice days', 'Owner email', 'Category', 'Description', 'Master agreement'];

beforeAll(async () => {
  acme = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
  original = { settings: acme.settings, limits: acme.limits, plan: acme.plan };
  await db.update(schema.tenants).set({ limits: { features: { contracts: true } } }).where(eq(schema.tenants.id, acme.id));
  const r = await (await login('admin@acme.test')).put('/api/admin/contracts', { enabled: true, types: { msa: true, sow: true, service: true, supply: true }, features: { internalApproval: false, obligations: true, excelImport: true, watch: true } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
});
afterAll(async () => { await db.update(schema.tenants).set(original).where(eq(schema.tenants.id, acme.id)); });

test('Excel import: statements of work linked to a master agreement — in the same sheet or already in VendorGate', async () => {
  const admin = await login('admin@acme.test');
  const rows = [
    ['Supplier', 'Migra Tech Services', 'IN', 'Master agreement (MSA)', 'Migra MSA', 'MG/MSA/01', '', 'INR', '2025-01-01', '2027-12-31', '2024-12-20', 'No', '', 60, '', '', '', ''],
    ['Supplier', 'Migra Tech Services', 'IN', 'Statement of work / work order', 'Migra SOW 1', 'MG/SOW/01', 400000, 'INR', '2025-02-01', '2026-01-31', '2025-01-25', 'No', '', '', '', '', '', 'MG/MSA/01'],
    ['Supplier', 'Migra Tech Services', 'IN', 'Statement of work / work order', 'Bad SOW', 'MG/SOW/02', '', 'INR', '2025-02-01', '', '2025-01-25', 'No', '', '', '', '', '', 'MG/SOW/01'],
    ['Supplier', 'Migra Tech Services', 'IN', 'Statement of work / work order', 'Lost SOW', '', '', 'INR', '2025-02-01', '', '2025-01-25', 'No', '', '', '', '', '', 'NOPE-123'],
  ];
  const file = await sheet('Contracts', CONTRACT_HEADERS, rows);
  const check = (await admin.agent.post('/api/staff/contracts/import?createParties=1').set(H).attach('file', file, 'contracts.xlsx')).body;
  expect(check.errors.map((e: any) => [e.row, e.message])).toEqual([[4, expect.stringMatching(/is not a master agreement/)], [5, expect.stringMatching(/Master agreement “NOPE-123” not found/)]]);
  const ok = await sheet('Contracts', CONTRACT_HEADERS, rows.slice(0, 2));
  const done = (await admin.agent.post('/api/staff/contracts/import?createParties=1&commit=1').set(H).attach('file', ok, 'contracts.xlsx')).body;
  expect(done.created).toHaveLength(2);
  const sow = (await db.query.contracts.findFirst({ where: eq(schema.contracts.reference, 'MG/SOW/01') }))!;
  const msa = (await db.query.contracts.findFirst({ where: eq(schema.contracts.reference, 'MG/MSA/01') }))!;
  expect(sow.parentId).toBe(msa.id);
  // Later sheets can point at it by its VendorGate number.
  const later = await sheet('Contracts', CONTRACT_HEADERS, [['Supplier', 'Migra Tech Services', 'IN', 'Statement of work / work order', 'Migra SOW 2', 'MG/SOW/02', '', 'INR', '2025-03-01', '', '2025-02-25', 'No', '', '', '', '', '', msa.number]]);
  await admin.agent.post('/api/staff/contracts/import?commit=1').set(H).attach('file', later, 'contracts.xlsx');
  expect((await db.query.contracts.findFirst({ where: eq(schema.contracts.reference, 'MG/SOW/02') }))!.parentId).toBe(msa.id);
});

test('file names: contract number first, then a reference; several matches go to the inbox', () => {
  const cs = [{ id: '1', number: 'SVC-2026-0001', title: 'a', reference: 'PP/2025/17', status: 'ACTIVE' }, { id: '2', number: 'SVC-2026-0012', title: 'b', reference: null, status: 'ACTIVE' }, { id: '3', number: 'RC-2026-0003', title: 'c', reference: 'ab', status: 'ACTIVE' }, { id: '4', number: 'RC-2026-0004', title: 'd', reference: 'PP/2025/17', status: 'ACTIVE' }];
  expect(matchName('SVC 2026 0012 signed copy.pdf', cs).match?.id).toBe('2');
  expect(matchName('svc-2026-0001.pdf', cs).match?.id).toBe('1');
  const both = matchName('Contract PP-2025-17 scanned.pdf', cs);
  expect(both.match).toBeUndefined();
  expect(both.candidates.map((c) => c.id)).toEqual(['1', '4']);
  expect(matchName('ab.pdf', cs).candidates).toEqual([]); // references under 4 characters are ignored
});

test('bulk signed copies: check first, then attach; .zip unpacked with limits; the rest to the inbox; duplicates skipped', async () => {
  const admin = await login('admin@acme.test');
  const party = (await admin.post('/api/staff/parties', { kind: 'SUPPLIER', name: 'Bulk Files Co', country: 'IN' })).body.party;
  const mk = async (title: string, reference: string | null) => (await admin.post('/api/staff/contracts', { title, direction: 'BUY', type: 'service', partyId: party.id, reference, startDate: iso(-100), endDate: iso(200) })).body.contract;
  const a = await mk('Bulk A', null), b = await mk('Bulk B', 'BF/REF/0099');
  const zip = new PizZip();
  zip.file(`scans/${b.number} countersigned.pdf`, PDF_BYTES('b'));
  zip.file('scans/readme.txt', 'not a contract');
  zip.file('__MACOSX/scans/._x.pdf', 'junk');
  const zbuf = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
  const send = (commit: boolean) => admin.agent.post(`/api/staff/contracts/migration/files?kind=SIGNED${commit ? '&commit=1' : ''}`).set(H)
    .attach('files', PDF_BYTES('a'), `${a.number}_signed.pdf`).attach('files', zbuf, 'scans.zip').attach('files', PDF_BYTES('x'), 'unknown supplier letter.pdf')
    .attach('files', Buffer.from('MZ not a pdf'), `${a.number} fake.pdf`);
  const check = (await send(false)).body;
  expect(check).toMatchObject({ attach: 3, inbox: 1, committed: false });
  expect(check.skipped).toEqual(['readme.txt (not a Word, PDF or image file)']);
  expect((await db.select().from(schema.contractFiles).where(eq(schema.contractFiles.contractId, a.id)))).toHaveLength(0);

  const done = (await send(true)).body;
  expect(done).toMatchObject({ attach: 2, errors: 1, inbox: 1, committed: true });
  expect(done.plan.find((p: any) => p.file.includes('fake')).note).toMatch(/contents don’t match/);
  expect((await db.select().from(schema.contractFiles).where(and(eq(schema.contractFiles.contractId, b.id), eq(schema.contractFiles.kind, 'SIGNED'))))).toHaveLength(1);
  // The same files again: already there.
  expect((await send(false)).body).toMatchObject({ duplicate: 2 });

  const inbox = (await admin.get('/api/staff/contracts/migration/inbox')).body.files;
  const letter = inbox.find((f: any) => f.fileName === 'unknown supplier letter.pdf');
  expect(letter.reason).toMatch(/No contract number or reference/);
  expect((await admin.post(`/api/staff/contracts/migration/inbox/${letter.id}/attach`, { contractId: a.id, kind: 'OTHER' })).body.contractId).toBe(a.id);
  expect((await admin.get('/api/staff/contracts/migration/inbox')).body.files.some((f: any) => f.id === letter.id)).toBe(false);

  // Zip limits.
  const big = new PizZip();
  for (let i = 0; i <= ZIP_LIMITS.files; i++) big.file(`f${i}.pdf`, 'x');
  expect(() => unpack([{ buffer: big.generate({ type: 'nodebuffer' }), originalname: 'many.zip' }])).toThrow(/at most 500/);
  expect(() => unpack([{ buffer: Buffer.from('PK not really'), originalname: 'bad.zip' }])).toThrow(/not a .zip/);

  // Permissions and other workspaces.
  expect((await (await login('tax@acme.test')).agent.post('/api/staff/contracts/migration/files').set(H).attach('files', PDF_BYTES(), 'x.pdf')).status).toBe(403);
  const globex = await login('admin@globex.test', 'globex');
  expect((await globex.post(`/api/staff/contracts/migration/inbox/${inbox[0].id}/attach`, { contractId: a.id })).status).toBeGreaterThanOrEqual(400);
});

test('a new contract from an inbox file is read; bulk reading fills in what imported contracts are missing (only blanks on active ones)', async () => {
  const admin = await login('admin@acme.test');
  const party = (await admin.post('/api/staff/parties', { kind: 'SUPPLIER', name: 'Chiller Care', country: 'IN' })).body.party;
  const word = await wordFile(TERMS);
  await admin.agent.post('/api/staff/contracts/migration/files?commit=1').set(H).attach('files', word, 'chiller care agreement.docx');
  const f = (await admin.get('/api/staff/contracts/migration/inbox')).body.files.find((x: any) => x.fileName === 'chiller care agreement.docx');
  const made = (await admin.post(`/api/staff/contracts/migration/inbox/${f.id}/contract`, { direction: 'BUY', type: 'service', partyId: party.id })).body;
  expect(made).toMatchObject({ read: 'read', number: expect.stringMatching(/^SVC-/) });
  const d = (await admin.get(`/api/staff/contracts/${made.contractId}`)).body;
  expect(d.contract).toMatchObject({ status: 'DRAFT', title: 'chiller care agreement' });
  expect(d.files[0]).toMatchObject({ kind: 'SIGNED' });
  expect(d.reading.readings[0].suggestions.map((s: any) => s.field)).toEqual(expect.arrayContaining(['startDate', 'endDate', 'value', 'noticeDays']));

  // An active contract imported with no end date or value, and its Word file: bulk reading, then the review queue.
  const act = (await admin.post('/api/staff/contracts', { title: 'Chiller AMC (imported)', direction: 'BUY', type: 'service', partyId: party.id, startDate: '2026-02-01', signedDate: '2026-01-02', signed: true })).body.contract;
  await db.update(schema.contracts).set({ status: 'ACTIVE', endDate: null, value: null, source: 'IMPORT' }).where(eq(schema.contracts.id, act.id));
  await admin.agent.post(`/api/staff/contracts/${act.id}/files`).set(H).field('kind', 'SIGNED').attach('file', word, { filename: 'amc.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  let r = (await admin.post('/api/staff/contracts/migration/read')).body;
  expect(r.read).toBeGreaterThanOrEqual(1);
  while (r.remaining) r = (await admin.post('/api/staff/contracts/migration/read')).body;
  const status = (await admin.get('/api/staff/contracts/migration')).body;
  const item = status.review.find((x: any) => x.contractId === act.id);
  // Only blanks (end date, value) and the editable terms — never the start date of an active contract.
  expect(item.fields.map((x: any) => x.field).sort()).toEqual(['autoRenew', 'endDate', 'noticeDays', 'renewalTermMonths', 'value']);
  expect((await admin.post(`/api/staff/contracts/migration/review/${act.id}`, { readingId: item.readingId, fields: item.fields.map((x: any) => x.field) })).status).toBe(200);
  const after = (await admin.get(`/api/staff/contracts/${act.id}`)).body.contract;
  expect(after).toMatchObject({ endDate: '2028-01-31', value: 960000, noticeDays: 45, autoRenew: true });
  // Once set, the end date of an active contract changes only through an amendment.
  expect((await admin.patch(`/api/staff/contracts/${act.id}`, { endDate: '2029-01-31' })).status).toBe(409);
  expect((await admin.get('/api/staff/contracts/migration')).body.review.some((x: any) => x.contractId === act.id)).toBe(false);
});

test('obligations from Excel, and the checklist', async () => {
  const admin = await login('admin@acme.test');
  const c = (await db.query.contracts.findFirst({ where: eq(schema.contracts.reference, 'MG/SOW/01') }))!;
  await db.update(schema.contracts).set({ status: 'ACTIVE', endDate: iso(300) }).where(eq(schema.contracts.id, c.id));
  const headers = ['Contract', 'What', 'Kind', 'Who does it', 'Due date', 'Repeats', 'Amount', 'Remind days before', 'Owner email', 'Note'];
  const bad = await sheet('Obligations', headers, [['MG/SOW/01', 'Monthly status report', 'Report or certificate', 'Them', iso(20), 'Every month', '', 5, '', ''], ['NOPE', 'x', 'Report', 'Them', iso(20), '', '', '', '', ''], [c.number, 'Pay', 'Bonus', 'Us', iso(20), '', '', '', '', '']]);
  const check = (await admin.agent.post('/api/staff/contracts/obligations/import').set(H).attach('file', bad, 'o.xlsx')).body;
  expect(check.errors.map((e: any) => e.message)).toEqual(['Contract “NOPE” not found', 'Unknown kind “Bonus”']);
  expect((await admin.agent.post('/api/staff/contracts/obligations/import?commit=1').set(H).attach('file', bad, 'o.xlsx')).body.created).toEqual([]); // nothing until every row is right
  const good = await sheet('Obligations', headers, [['MG/SOW/01', 'Monthly status report', 'Report or certificate', 'Them', iso(20), 'Every month', '', 5, '', ''], [c.number, 'Milestone payment', 'PAYMENT', 'Us', iso(40), '', '1,20,000', '', 'admin@acme.test', 'On acceptance']]);
  expect((await admin.agent.post('/api/staff/contracts/obligations/import?commit=1').set(H).attach('file', good, 'o.xlsx')).body.created).toHaveLength(2);
  const obs = await db.select().from(schema.contractObligations).where(eq(schema.contractObligations.contractId, c.id));
  expect(obs.map((o) => [o.title, o.side, o.recurrence, o.amount])).toEqual(expect.arrayContaining([['Monthly status report', 'PARTY', 'MONTHLY', null], ['Milestone payment', 'US', 'NONE', '120000.00']]));
  expect((await admin.get('/api/staff/contracts/obligations/import-template.xlsx')).headers['content-type']).toContain('spreadsheetml');

  const s = (await admin.get('/api/staff/contracts/migration')).body;
  expect(s.checks.noSignedCopy.contracts.some((x: any) => x.id === c.id)).toBe(true);
  expect(s.checks.draftsSigned.count).toBeGreaterThanOrEqual(1);
  expect(s.totals).toMatchObject({ obligations: expect.any(Number), inbox: expect.any(Number), unread: expect.any(Number) });
});
