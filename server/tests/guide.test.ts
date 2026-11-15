/** The supplier guide: next step, check before submitting, send-back to-do, questions — privacy mode for the AI parts. */
import { afterEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/lib/db.js';
import { invitedSupplier, login, submittedVendor } from './helpers.js';
import { setGuideWriter, rulesGuideWriter, splitRemarks, tabFor } from '../src/integrations/ai/guideWriter.js';
import { mockAnswerer, setHelpAnswerer } from '../src/integrations/ai/helpAnswer.js';
import { pseudonymise, reidentify } from '../src/services/aiPrivacy.js';
import { translateMessage } from '../src/i18n/index.js';

afterEach(() => { setGuideWriter(rulesGuideWriter); setHelpAnswerer(mockAnswerer); });

describe('supplier guide', () => {
  test('next step: the first missing item, in tab order, with the tab to go to', async () => {
    const { v } = await invitedSupplier('Guided Gears Ltd', 'guide1@guide.test');
    const g = (await v.get('/api/vendor/guide')).body;
    expect(g).toMatchObject({ editable: true, ready: false, nextKind: 'missing' });
    expect(g.next.tab).toBeTruthy();
    expect(g.remaining).toBeGreaterThan(3);
    expect(g.sendBack).toBeNull();
  });

  test('check before submitting: what approvers would ask about, in the supplier’s words', async () => {
    let vendorSession: any;
    await submittedVendor('Checked Castings Ltd', 'guide2@guide.test', { beforeSubmit: async (v) => {
      vendorSession = v;
      // PIN code from Tamil Nadu with a Maharashtra address: approvers would ask.
      await v.put('/api/vendor/profile/basic', { ...(await v.get('/api/vendor')).body.vendor.profile.basic, postalCode: '600041' });
      const g = (await v.get('/api/vendor/guide')).body;
      expect(g.ready).toBe(true);
      expect(g.beforeSubmit.approverWouldAsk.map((i: any) => i.text)).toContain('Your PIN code belongs to a different state from the one in your address. Check both.');
      expect(g.nextKind).toBe('check');
      expect(g.next.tab).toBe('basic');
    } });
    // After submitting, nothing to edit: no guide panel.
    expect((await vendorSession.get('/api/vendor/guide')).body.editable).toBe(false);
  });

  test('supplier wording has Arabic', () => {
    expect(translateMessage('Your PIN code belongs to a different state from the one in your address. Check both.', 'ar')).toMatch(/الرمز البريدي/);
    expect(translateMessage('GSTIN hasn\'t been verified yet. Use Verify next to it.', 'ar')).toMatch(/لم يتم التحقق من GSTIN/);
  });

  test('send-back remarks become a to-do list linked to tabs — by rules, or by AI with the supplier’s values replaced by placeholders', async () => {
    expect(splitRemarks('1. Upload a clear cancelled cheque\n2. Correct the GSTIN')).toEqual(['Upload a clear cancelled cheque', 'Correct the GSTIN']);
    expect(splitRemarks('Bank letter is blurred. Please correct the PAN; it does not match.')).toEqual(['Bank letter is blurred.', 'Please correct the PAN; it does not match.']);
    expect(tabFor('Correct the GSTIN', [{ key: 'tax', label: 'Tax Details', fields: ['GSTIN', 'PAN'] }, { key: 'bank', label: 'Bank Details', fields: ['IFSC'] }])).toBe('tax');

    const { id, v } = await submittedVendor('Sendback Steel Ltd', 'guide3@guide.test');
    const vendor = (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) }))!;
    const gstin = (vendor.profile as any).tax.gstin;
    const seen: any[] = [];
    setGuideWriter({ name: 'anthropic', live: true, async todo(input) { seen.push(input); return [{ text: 'Correct GSTIN [VALUE-1] — it belongs to another company.', tab: 'tax' }, { text: 'Upload a clear cancelled cheque.', tab: 'documents' }]; } });
    const tax = await login('tax@acme.test');
    expect((await tax.post(`/api/staff/vendors/${id}/decision`, { action: 'SEND_BACK', remarks: `1. GSTIN ${gstin} belongs to another company — correct it.\n2. The cancelled cheque for Sendback Steel Ltd is unreadable.` })).status).toBe(200);
    const g = (await v.get('/api/vendor/guide')).body;
    expect(seen).toHaveLength(1);
    const sent = JSON.stringify(seen[0]);
    expect(sent).not.toContain(gstin);
    expect(sent).not.toContain('Sendback Steel');
    expect(seen[0].remarks).toContain('[VALUE-1]');
    expect(g.sendBack).toMatchObject({ by: 'ai' });
    expect(g.sendBack.items[0]).toEqual({ text: `Correct GSTIN ${gstin} — it belongs to another company.`, tab: 'tax' }); // value put back here
    expect(g).toMatchObject({ nextKind: 'sendBack', next: { tab: 'tax' } });
    // Made once and kept.
    await v.get('/api/vendor/guide');
    expect(seen).toHaveLength(1);
  });

  test('send-back by rules when the AI is off for the workspace', async () => {
    const { id, v } = await submittedVendor('Rules Rollers Ltd', 'guide4@guide.test');
    const t = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
    const seen: any[] = [];
    setGuideWriter({ name: 'anthropic', live: true, async todo(input) { seen.push(input); return []; } });
    await db.update(schema.tenants).set({ settings: { ...t.settings, aiGuide: false } }).where(eq(schema.tenants.id, t.id));
    try {
      await (await login('tax@acme.test')).post(`/api/staff/vendors/${id}/decision`, { action: 'SEND_BACK', remarks: 'Upload the bank letter on letterhead.\nCorrect the PAN.' });
      const g = (await v.get('/api/vendor/guide')).body;
      expect(seen).toHaveLength(0);
      expect(g.sendBack.by).toBe('rules');
      expect(g.sendBack.items.map((i: any) => i.text)).toEqual(['Upload the bank letter on letterhead.', 'Correct the PAN.']);
      expect(g.sendBack.items[1].tab).toBe('tax');
    } finally {
      const fresh = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
      await db.update(schema.tenants).set({ settings: { ...fresh.settings, aiGuide: undefined } }).where(eq(schema.tenants.id, t.id));
    }
  });

  test('ask: answered from help and a value-free description of the registration; own values in the question are replaced', async () => {
    const { id, v } = await invitedSupplier('Questioning Quarries Ltd', 'guide5@guide.test');
    await v.put('/api/vendor/profile/tax', { hasGst: 'Yes', gstin: '27AAFCQ1234Q1Z5', pan: 'AAFCQ1234Q' });
    const seen: any[] = [];
    setHelpAnswerer({ name: 'anthropic', live: true, async answer(question, articles) { seen.push({ question, articles }); return { answered: true, answer: `Your GSTIN [VALUE-1] goes under Tax Details.`, sources: ['this-registration', 'supplier-fill'] }; } });
    const r = await v.post('/api/vendor/guide/ask', { question: 'Where do I enter 27AAFCQ1234Q1Z5 for Questioning Quarries Ltd?', articles: [{ id: 'supplier-fill', title: 'Filling in', body: 'Work through each tab.' }] });
    expect(r.status).toBe(200);
    const sent = JSON.stringify(seen[0]);
    expect(sent).not.toContain('27AAFCQ1234Q1Z5');
    expect(sent).not.toContain('Questioning Quarries');
    expect(seen[0].question).toMatch(/\[VALUE-1\].*\[VALUE-2\]/);
    const reg = seen[0].articles.find((a: any) => a.id === 'this-registration');
    expect(reg.body).toMatch(/- PAN: filled in/);
    expect(reg.body).toMatch(/- GSTIN: PROBLEM: GSTIN checksum does not match/); // the rule's message, never the value
    expect(reg.body).toMatch(/: empty/);
    expect(r.body.answer).toBe('Your GSTIN 27AAFCQ1234Q1Z5 goes under Tax Details.');
    expect(r.body.sources).toEqual(['supplier-fill']);
    void id;
  });

  test('the buyer filling in gets the same guide, in staff wording', async () => {
    const { id } = await invitedSupplier('Assisted Anvils Ltd', 'guide6@guide.test');
    const admin = await login('admin@acme.test');
    const g = (await admin.get(`/api/staff/vendors/${id}/assist/guide`)).body;
    expect(g).toMatchObject({ editable: true, nextKind: 'missing' });
    expect((await (await login('tax@acme.test')).get(`/api/staff/vendors/${id}/assist/guide`)).status).toBe(403); // needs "invite vendors"
  });

  test('pseudonymise and put back', () => {
    const { text, tokens } = pseudonymise('Pay ACME STEEL LTD at account 50100012345 (acme steel ltd).', new Set(['acme steel ltd', '50100012345']));
    expect(text).toBe('Pay [VALUE-1] at account [VALUE-2] ([VALUE-1]).');
    expect(reidentify(text, tokens)).toBe('Pay ACME STEEL LTD at account 50100012345 (ACME STEEL LTD).');
  });
});
