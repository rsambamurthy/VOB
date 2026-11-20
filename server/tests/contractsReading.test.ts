/** Contracts step 4: reading uploaded contracts — masking before any AI, local rules, suggestions applied. */
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import type { Tenant } from '../src/db/schema.js';
import { maskText, textOf } from '../src/services/contracts/reading.js';
import PizZip from 'pizzip';
import { localReader, setContractReader, type ContractReader } from '../src/integrations/ai/contractReader.js';

let acme: Tenant;
let original: Pick<Tenant, 'settings' | 'limits' | 'plan'>;
const LINES = [
  'ANNUAL MAINTENANCE CONTRACT',
  'This Agreement is made on 15th March 2026 between Acme Industries Limited, Plot 14 Chakan MIDC, Pune (GSTIN 27AAACA1234B1Z2) and Coolair Services Private Limited (PAN AABCC1234F), contact ravi.kulkarni@coolair.example, +91 98200 12345.',
  '1. Term. This Agreement commences on 1 April 2026 and continues until 31 March 2027. It renews automatically for further periods of twelve (12) months unless either Party gives thirty (30) days’ prior written notice.',
  '2. Price. The total consideration is INR 25,45,000 (Twenty-five lakh forty-five thousand), payable quarterly to account 50200012345678 at HDFC0001234.',
  '3. Governing law. This Agreement is governed by the laws of India and the courts at Pune have jurisdiction.',
  '4. Scope. Preventive and breakdown maintenance of 14 HVAC units, with service visits every month and a response within four hours for breakdowns, as described in the schedule.',
];
const docx = async () => Buffer.from(await Packer.toBuffer(new Document({ sections: [{ children: LINES.map((l) => new Paragraph({ children: [new TextRun(l)] })) }] })));

beforeAll(async () => {
  acme = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
  original = { settings: acme.settings, limits: acme.limits, plan: acme.plan };
  await db.update(schema.tenants).set({ limits: { features: { contracts: true, ai: true } } }).where(eq(schema.tenants.id, acme.id));
  const admin = await login('admin@acme.test');
  expect((await admin.put('/api/admin/contracts', { enabled: true, types: { service: true, nda: true }, features: { internalApproval: false, aiExtraction: true } })).status).toBe(200);
});
afterAll(async () => { await db.update(schema.tenants).set(original).where(eq(schema.tenants.id, acme.id)); });
afterEach(() => setContractReader(localReader));

test('masking: names, ids, emails, phones, accounts, dates and amounts never reach the reader', () => {
  const m = maskText(LINES.join('\n'), new Set(['Coolair Services Private Limited', 'Acme Industries Limited', 'Ravi Kulkarni']));
  for (const secret of ['Coolair', 'Acme', '27AAACA1234B1Z2', 'AABCC1234F', 'ravi.kulkarni@coolair.example', '98200 12345', '50200012345678', 'HDFC0001234', '25,45,000', '1 April 2026', '31 March 2027', '15th March 2026'])
    expect(m.masked).not.toContain(secret);
  expect(Object.values(m.dates).sort()).toEqual(['2026-03-15', '2026-04-01', '2027-03-31']);
  expect(Object.values(m.amounts)).toEqual([{ value: 2545000, currency: 'INR' }]);
  expect(m.masked).toContain('thirty (30) days’ prior written notice');
});

test('read an uploaded Word contract: suggestions with evidence, then apply them to the draft', async () => {
  const admin = await login('admin@acme.test');
  const party = (await admin.post('/api/staff/parties', { kind: 'SUPPLIER', name: 'Coolair Reading Services', legalName: 'Coolair Services Private Limited', country: 'IN', taxNo: '27AABCC9876F1Z5', contacts: [{ name: 'Ravi Kulkarni', email: 'ravi.kulkarni@coolair.example' }] })).body.party;
  const c = (await admin.post('/api/staff/contracts', { title: 'HVAC AMC (their paper)', direction: 'BUY', type: 'nda', partyId: party.id })).body;
  const up = await admin.agent.post(`/api/staff/contracts/${c.contract.id}/files`).set('X-Requested-With', 'fetch').field('kind', 'DRAFT').attach('file', await docx(), { filename: 'their-amc.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const fileId = up.body.files[0].id;

  // A fake AI reader: it must only ever see masked text.
  let seen = '';
  const fake: ContractReader = { name: 'anthropic', live: true, async read(masked, types) { seen = masked; return { ...(await localReader.read(masked, types)), notes: ['Thirty days is short for an AMC.'] }; } };
  setContractReader(fake);
  const r = await admin.post(`/api/staff/contracts/${c.contract.id}/files/${fileId}/read`);
  expect(r.status).toBe(200);
  for (const secret of ['Coolair', 'Ravi', '27AAACA1234B1Z2', 'ravi.kulkarni', '25,45,000', 'Acme Industries']) expect(seen).not.toContain(secret);
  const reading = r.body.reading.readings[0];
  expect(reading).toMatchObject({ reader: 'anthropic', notes: ['Thirty days is short for an AMC.'] });
  expect(reading.sentToAi).toBe(seen);
  const by = Object.fromEntries(reading.suggestions.map((s: any) => [s.field, s.value]));
  expect(by).toMatchObject({ startDate: '2026-04-01', endDate: '2027-03-31', signedDate: '2026-03-15', value: 2545000, noticeDays: 30, autoRenew: true, renewalTermMonths: 12, type: 'service', jurisdiction: 'IN' });
  expect(reading.suggestions.find((s: any) => s.field === 'startDate').evidence).toContain('commences on 1 April 2026');

  const applied = await admin.post(`/api/staff/contracts/${c.contract.id}/readings/${reading.id}/apply`, { fields: ['startDate', 'endDate', 'value', 'noticeDays', 'autoRenew', 'renewalTermMonths', 'type', 'jurisdiction'] });
  expect(applied.status).toBe(200);
  expect(applied.body.contract).toMatchObject({ type: 'service', startDate: '2026-04-01', endDate: '2027-03-31', value: 2545000, noticeDays: 30, autoRenew: true, renewalTermMonths: 12 });
  expect(applied.body.reading.readings[0].appliedFields).toContain('value');
  // History names the fields in plain English.
  expect(applied.body.history.find((h: any) => h.action === 'CONTRACT_UPDATED').detail.fields).toEqual(expect.arrayContaining(['Contract type', 'Value', 'End date', 'Renews automatically']));
  // Without the AI option: the same rules run locally, nothing is sent.
  await admin.put('/api/admin/contracts', { enabled: true, types: { service: true, nda: true }, features: { internalApproval: false, aiExtraction: false } });
  seen = '';
  const local = (await admin.post(`/api/staff/contracts/${c.contract.id}/files/${fileId}/read`)).body.reading.readings[0];
  expect(local).toMatchObject({ reader: 'local', sentToAi: null });
  expect(seen).toBe('');
});

test('contract reports: under contract, pipeline, time to sign, Excel', async () => {
  const admin = await login('admin@acme.test');
  const r = (await admin.get('/api/staff/contracts/reports')).body;
  expect(r).toHaveProperty('byDirection');
  expect(r.pipeline).toHaveProperty('DRAFT');
  expect(r.obligations).toHaveProperty('open');
  const x = await admin.get('/api/staff/contracts/reports.xlsx');
  expect(x.status).toBe(200);
  expect(x.headers['content-type']).toContain('spreadsheetml');
});

test('files that are not really Word, or unpack to far too much (zip bombs), are refused cleanly', async () => {
  const W = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  await expect(textOf(Buffer.from('MZ not a zip'), W)).rejects.toThrow(/not a Word/);
  const z = new PizZip(); z.file('word/document.xml', 'A'.repeat(25_000_000));
  await expect(textOf(z.generate({ type: 'nodebuffer', compression: 'DEFLATE' }), W)).rejects.toThrow(/too large/);
  expect(await textOf(Buffer.from('%PDF-1.4 broken'), 'application/pdf')).toBe('');
});
