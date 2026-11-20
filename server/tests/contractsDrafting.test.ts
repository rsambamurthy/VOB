/** Contracts step 1: clause library, templates (library and Word), drafting with fallbacks, documents and internal approval. */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import PizZip from 'pizzip';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import type { Tenant } from '../src/db/schema.js';
import { amountInWords } from '../src/services/contracts/fields.js';
import { readBytes } from '../src/integrations/storage/index.js';
import { pdfAvailable } from '../src/integrations/office/index.js';

let acme: Tenant;
let original: Pick<Tenant, 'settings' | 'limits' | 'plan'>;
const PDF = '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF';
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const docText = async (fileId: string) => {
  const f = (await db.query.contractFiles.findFirst({ where: eq(schema.contractFiles.id, fileId) }))!;
  return new PizZip(await readBytes(f)).file('word/document.xml')!.asText().replace(/<[^>]+>/g, '');
};
const wordFile = async (lines: string[]) => Buffer.from(await Packer.toBuffer(new Document({ sections: [{ children: lines.map((l) => new Paragraph({ children: [new TextRun(l)] })) }] })));

beforeAll(async () => {
  acme = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
  original = { settings: acme.settings, limits: acme.limits, plan: acme.plan };
  await db.update(schema.tenants).set({ limits: { features: { contracts: true } } }).where(eq(schema.tenants.id, acme.id));
  const admin = await login('admin@acme.test');
  const r = await admin.put('/api/admin/contracts', { enabled: true, types: { service: true, nda: true, msa: true } });
  expect(r.status).toBe(200);
});
afterAll(async () => { await db.update(schema.tenants).set(original).where(eq(schema.tenants.id, acme.id)); });

test('amounts in words: lakh and crore for rupees, millions otherwise', () => {
  expect(amountInWords(2_545_000, 'INR')).toBe('Twenty-five lakh forty-five thousand');
  expect(amountInWords(12_500_000, 'INR')).toBe('One crore twenty-five lakh');
  expect(amountInWords(950_000, 'AED')).toBe('Nine hundred and fifty thousand');
});

describe('clause library and templates', () => {
  test('the India + GCC library is there; clauses are checked; built-ins can be reset; templates need known clauses', async () => {
    const admin = await login('admin@acme.test');
    const lib = (await admin.get('/api/staff/contract-library/clauses')).body;
    const gov = lib.clauses.filter((c: any) => c.group === 'governing-law');
    expect(gov.map((c: any) => c.jurisdiction).sort()).toEqual(['AE', 'IN', 'SA']);
    expect(lib.clauses.find((c: any) => c.group === 'disputes' && c.jurisdiction === 'IN').body).toContain('Arbitration and Conciliation Act, 1996');
    const pay = lib.clauses.find((c: any) => c.group === 'price-payment');
    expect(pay.fallbacks.map((f: any) => f.key)).toEqual(['days45', 'days60', 'advance']);

    const bad = await admin.put(`/api/staff/contract-library/clauses/${pay.id}`, { title: pay.title, category: pay.category, body: 'Pay {{contract.value}} to {{bank.account}} promptly.', fallbacks: pay.fallbacks });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('{{bank.account}}');
    const edited = await admin.put(`/api/staff/contract-library/clauses/${pay.id}`, { title: pay.title, category: pay.category, body: `${pay.body} Interest is not payable on late payments.`, fallbacks: pay.fallbacks });
    expect(edited.status).toBe(200);
    expect((await admin.get('/api/staff/contract-library/clauses')).body.clauses.find((c: any) => c.id === pay.id).changed).toBe(true);
    expect((await admin.post(`/api/staff/contract-library/clauses/${pay.id}/reset`)).body.clause.body).toBe(pay.body);

    const own = await admin.post('/api/staff/contract-library/clauses', { title: 'Site safety', category: 'Commercial', body: 'The {{party.role}} shall follow the site safety rules of {{us.legalName}}.' });
    expect(own.status).toBe(201);
    expect(own.body.clause.group).toBe('site-safety');

    const tpls = (await admin.get('/api/staff/contract-library/templates')).body.templates;
    expect(tpls.map((t: any) => t.name)).toEqual(expect.arrayContaining(['Mutual non-disclosure agreement', 'Service / maintenance agreement (AMC)', 'Supply / rate contract']));
    expect((await admin.post('/api/staff/contract-library/templates', { name: 'Odd', types: ['service'], sections: [{ group: 'no-such-clause', required: true }] })).body.error).toMatch(/aren’t in the library/);
    // Templates need contracts.templates: a Viewer-like user without it can't edit.
    const fin = await login('finance@acme.test');
    expect((await fin.post('/api/staff/contract-library/templates', { name: 'Mine', types: ['service'], sections: [{ group: 'scope', required: true }] })).status).toBe(403);
  });

  test('Word templates: fields checked when uploaded, clause loop allowed, the file must be a real .docx', async () => {
    const admin = await login('admin@acme.test');
    const up = (data: object, buf: Buffer, name = 'nda.docx') => admin.agent.post('/api/staff/contract-library/templates/word').set('X-Requested-With', 'fetch')
      .field('data', JSON.stringify(data)).attach('file', buf, { filename: name, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const meta = { name: 'Our NDA (Word)', types: ['nda'], direction: 'BOTH', sections: [{ group: 'confidentiality', required: true }, { group: 'governing-law', required: true }] };
    const wrong = await up(meta, await wordFile(['Between {{us.legalName}} and {{party.name}}', 'GST: {{party.gstin}}']));
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toContain('{{party.gstin}}');
    expect((await up(meta, Buffer.from(PDF), 'fake.docx')).status).toBe(400);
    const ok = await up(meta, await wordFile(['NON-DISCLOSURE AGREEMENT {{contract.number}}', 'Between {{us.legalName}} and {{party.legalName}} of {{party.country}}', '{{#clauses}}', '{{number}}. {{title}}', '{{body}}', '{{/clauses}}', 'Signed at {{us.city}}']));
    expect(ok.status).toBe(201);
    expect(ok.body.template.fields).toEqual(expect.arrayContaining(['contract.number', 'party.legalName', '#clauses', 'body']));
  });
});

test('a Word draft can be uploaded to a contract, but only real .docx files', async () => {
  const admin = await login('admin@acme.test');
  const party = (await admin.post('/api/staff/parties', { kind: 'SUPPLIER', name: 'Word Upload Supplier', country: 'IN' })).body.party;
  const c = (await admin.post('/api/staff/contracts', { title: 'Their paper', direction: 'BUY', type: 'msa', partyId: party.id })).body.contract;
  const send = (buf: Buffer, name: string) => admin.agent.post(`/api/staff/contracts/${c.id}/files`).set('X-Requested-With', 'fetch').field('kind', 'DRAFT').attach('file', buf, { filename: name, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  expect((await send(await wordFile(['Their draft']), 'their-draft.docx')).status).toBe(201);
  expect((await send(Buffer.from('PK\u0003\u0004 not really word'), 'fake.docx')).status).toBe(400);
});

describe('drafting and approval', () => {
  test('draft from the library template, fallbacks and edits, Word and PDF, approval by Legal and Finance, then signed', async () => {
    const admin = await login('admin@acme.test');
    const party = (await admin.post('/api/staff/parties', { kind: 'SUPPLIER', name: 'Coolair Services', legalName: 'Coolair Services Private Limited', country: 'IN', taxNo: '27AABCC1234F1Z5', address: { line1: '12 MIDC Road', city: 'Pune' },
      contacts: [{ name: 'Ravi Kulkarni', role: 'Director', email: 'ravi@coolair.example', signatory: true }] })).body.party;
    const created = await admin.post('/api/staff/contracts', { title: 'AMC — HVAC, Pune plant', direction: 'BUY', type: 'service', partyId: party.id, value: 2545000, currency: 'INR', startDate: iso(10), endDate: iso(375), description: 'Preventive and breakdown maintenance of 14 HVAC units.' });
    expect(created.status).toBe(201);
    const id = created.body.contract.id;
    const tpl = created.body.drafting.templates.find((t: any) => t.name === 'Service / maintenance agreement (AMC)');
    expect(tpl).toBeTruthy();
    expect(created.body.drafting.templates.some((t: any) => t.name === 'Our NDA (Word)')).toBe(false);

    let d = (await admin.post(`/api/staff/contracts/${id}/draft`, { templateId: tpl.id })).body;
    expect(d.contract.status).toBe('DRAFT');
    expect(d.drafting.jurisdiction).toBe('IN');
    const groups = d.drafting.draft.clauses.map((c: any) => c.group);
    expect(groups).toEqual(expect.arrayContaining(['scope', 'taxes', 'stamp-duty', 'governing-law', 'disputes']));
    expect(groups).not.toContain('language');
    expect(d.drafting.draft.clauses.find((c: any) => c.group === 'governing-law').body).toContain('laws of India');

    const choices = d.drafting.draft.clauses.filter((c: any) => c.group !== 'service-levels').map((c: any) => ({ group: c.group, variant: c.group === 'price-payment' ? 'days45' : c.group === 'liability' ? 'custom' : 'standard',
      body: c.group === 'liability' ? 'Each Party’s total liability is limited to {{contract.value}}.' : undefined }));
    expect((await admin.put(`/api/staff/contracts/${id}/draft`, { clauses: choices.filter((c: any) => c.group !== 'scope') })).body.error).toMatch(/Scope.*required/);
    expect((await admin.put(`/api/staff/contracts/${id}/draft`, { clauses: choices.map((c: any) => (c.group === 'liability' ? { ...c, body: 'Liability is {{contract.cap}}.' } : c)) })).body.error).toContain('{{contract.cap}}');
    d = (await admin.put(`/api/staff/contracts/${id}/draft`, { clauses: choices })).body;
    expect(d.drafting.draft).toMatchObject({ nonStandard: true, fallback: true, upToDate: false });
    expect(d.drafting.draft.clauses.find((c: any) => c.group === 'price-payment').body).toContain('forty-five (45) days');

    expect((await admin.post(`/api/staff/contracts/${id}/submit`)).body.error).toMatch(/Make the document first/);
    const made = await admin.post(`/api/staff/contracts/${id}/document`);
    expect(made.status).toBe(200);
    expect(made.body.result.missing.map((m: any) => m.key)).toContain('us.city');
    const gen = made.body.files.filter((f: any) => f.generated);
    expect(gen.map((f: any) => f.fileName.split('.').pop()).sort()).toEqual(pdfAvailable() ? ['docx', 'pdf'] : ['docx']);
    const text = await docText(gen.find((f: any) => f.fileName.endsWith('.docx')).id);
    expect(text).toContain('Coolair Services Private Limited');
    expect(text).toContain('INR 25,45,000.00 (INR Twenty-five lakh forty-five thousand only)');
    expect(text).toContain('forty-five (45) days');
    expect(text).toContain('Ravi Kulkarni');
    expect(made.body.drafting.draft.upToDate).toBe(true);
    // Changing the contract puts the document out of date.
    expect((await admin.patch(`/api/staff/contracts/${id}`, { reference: 'HVAC/26/07' })).body.drafting.draft.upToDate).toBe(false);
    await admin.post(`/api/staff/contracts/${id}/document`);

    // Mark as signed needs approval first.
    expect((await admin.post(`/api/staff/contracts/${id}/signed`, { signedDate: iso(0) })).body.error).toMatch(/approval first/);
    const sub = await admin.post(`/api/staff/contracts/${id}/submit`);
    expect(sub.body.result).toMatchObject({ status: 'IN_APPROVAL', levels: ['Legal review', 'Finance approval'] });
    expect((await admin.patch(`/api/staff/contracts/${id}`, { description: 'x' })).status).toBe(409);
    // The person who drafted it can't approve, even as an administrator.
    expect((await admin.post(`/api/staff/contracts/${id}/decision`, { action: 'APPROVE' })).status).toBe(403);
    const legal = await login('legal@acme.test');
    const sentBack = await legal.post(`/api/staff/contracts/${id}/decision`, { action: 'SEND_BACK', remarks: 'Liability cap must exclude data breaches.' });
    expect(sentBack.body.contract.status).toBe('DRAFT');
    await admin.post(`/api/staff/contracts/${id}/submit`);
    expect((await legal.post(`/api/staff/contracts/${id}/decision`, { action: 'APPROVE' })).body.contract.status).toBe('IN_APPROVAL');
    const fin = await login('finance@acme.test');
    expect((await fin.post(`/api/staff/contracts/${id}/decision`, { action: 'APPROVE' })).body.contract.status).toBe('APPROVED');

    expect((await admin.patch(`/api/staff/contracts/${id}`, { value: 3000000 })).body.error).toMatch(/Reopen it as a draft/);
    await admin.agent.post(`/api/staff/contracts/${id}/files`).set('X-Requested-With', 'fetch').field('kind', 'SIGNED').attach('file', Buffer.from(PDF), { filename: 'signed.pdf', contentType: 'application/pdf' });
    const signed = await admin.post(`/api/staff/contracts/${id}/signed`, { signedDate: iso(0) });
    expect(signed.body.contract.status).toBe('ACTIVE');
    const hist = signed.body.history.map((h: any) => h.action);
    expect(hist).toEqual(expect.arrayContaining(['CONTRACT_DRAFT_STARTED', 'CONTRACT_DRAFT_SAVED', 'CONTRACT_DOCUMENT_MADE', 'CONTRACT_SUBMITTED', 'CONTRACT_SIGNED']));
  });

  test('Word template in the UAE: governing law follows the jurisdiction; standard wording needs no approval', async () => {
    const admin = await login('admin@acme.test');
    const party = (await admin.post('/api/staff/parties', { kind: 'SUPPLIER', name: 'Gulf Analytics FZ-LLC', country: 'AE' })).body.party;
    const c = (await admin.post('/api/staff/contracts', { title: 'NDA — data project', direction: 'BUY', type: 'nda', partyId: party.id, startDate: iso(1), endDate: iso(700) })).body;
    const word = c.drafting.templates.find((t: any) => t.name === 'Our NDA (Word)');
    expect(word.kind).toBe('WORD');
    const d = (await admin.post(`/api/staff/contracts/${c.contract.id}/draft`, { templateId: word.id, jurisdiction: 'AE' })).body;
    expect(d.drafting.draft.clauses.map((x: any) => x.group)).toEqual(['confidentiality', 'governing-law']);
    const made = (await admin.post(`/api/staff/contracts/${c.contract.id}/document`)).body;
    expect(made.error).toBeUndefined();
    const text = await docText(made.files.find((f: any) => f.generated && f.fileName.endsWith('.docx')).id);
    expect(text).toContain('Gulf Analytics FZ-LLC of United Arab Emirates');
    expect(text).toContain('2. Governing law');
    expect(text).toContain('federal laws of the United Arab Emirates');
    expect(text).not.toContain('{{');
    // Standard wording, no value: no level applies, approved straight away.
    expect((await admin.post(`/api/staff/contracts/${c.contract.id}/submit`)).body.result).toMatchObject({ status: 'APPROVED', levels: [] });
    expect((await admin.post(`/api/staff/contracts/${c.contract.id}/reopen`)).body.contract.status).toBe('DRAFT');
  });

  test('approval levels and company details in Administration → Contracts', async () => {
    const admin = await login('admin@acme.test');
    const cfg = (await admin.get('/api/admin/contracts')).body;
    expect(cfg.approval.levels.map((l: any) => l.id)).toEqual(['legal', 'finance', 'senior']);
    expect(cfg.approval.catalog.map((c: any) => c.id)).toContain('contract.nonStandard');
    expect((await admin.put('/api/admin/contracts/approval', { levels: [{ id: 'x', label: 'Board', roleKey: 'NOPE' }] })).status).toBe(400);
    const ok = await admin.put('/api/admin/contracts/approval', { levels: [{ id: 'legal', label: 'Legal review', roleKey: 'LEGAL' }] });
    expect(ok.body.approval.levels).toHaveLength(1);
    const co = await admin.put('/api/admin/contracts/company', { legalName: 'Acme Industries Limited', city: 'Pune', signatoryName: 'Anita Rao', signatoryRole: 'Director' });
    expect(co.body.company).toMatchObject({ city: 'Pune' });
    // Saving the main settings keeps the approval flow and company details.
    const again = await admin.put('/api/admin/contracts', { enabled: true, types: { service: true, nda: true, msa: true } });
    expect(again.body.approval.levels).toHaveLength(1);
    expect(again.body.company.legalName).toBe('Acme Industries Limited');
  });
});
