/** Pre-review for approvers: VendorGate's findings on every submission; an AI summary when the workspace switches it on. */
import { afterEach, describe, expect, test } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { login, submittedVendor } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import { mockPreReviewer, recommendFromFacts, setPreReviewer } from '../src/integrations/ai/preReviewer.js';

afterEach(() => setPreReviewer(mockPreReviewer));
const acme = async () => (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;

describe('pre-review', () => {
  test('recommendation from the findings', () => {
    expect(recommendFromFacts([])).toBe('APPROVE');
    expect(recommendFromFacts([{ severity: 'info', text: 'x', source: 'checks' }])).toBe('APPROVE');
    expect(recommendFromFacts([{ severity: 'medium', text: 'x', source: 'checks' }])).toBe('REVIEW');
    expect(recommendFromFacts([{ severity: 'high', text: 'dup', source: 'checks' }])).toBe('REVIEW');
    expect(recommendFromFacts([{ severity: 'high', text: 'missing', fixable: true, source: 'checks' }])).toBe('SEND_BACK');
  });

  test('made on submit from VendorGate’s own findings; out of date when the data changes; made again on request', async () => {
    const { id } = await submittedVendor('Clean Castings Ltd', 'clean@pre.test');
    const tax = await login('tax@acme.test');
    const pr = (await tax.get(`/api/staff/vendors/${id}`)).body.preReview;
    expect(pr).toMatchObject({ status: 'READY', provider: 'checks', live: false, stale: false, aiOn: false });
    expect(pr.result.recommendation).toBe('APPROVE');
    expect(pr.result.summary).toMatch(/^Clean Castings Ltd looks ready to approve/);
    expect(pr.result.findings.every((f: any) => f.severity === 'info')).toBe(true);
    expect(pr.result.findings.map((f: any) => f.text).join(' | ')).toMatch(/GSTIN hasn't been verified yet/);
    // The supplier's data changes → shown as out of date.
    const v = (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) }))!;
    await db.update(schema.vendors).set({ profile: { ...(v.profile as any), basic: { ...(v.profile as any).basic, address: '99 New Street' } } }).where(eq(schema.vendors.id, id));
    expect((await tax.get(`/api/staff/vendors/${id}`)).body.preReview.stale).toBe(true);
    expect((await tax.post(`/api/staff/vendors/${id}/pre-review`, {})).status).toBe(429); // just made
    await db.update(schema.preReviews).set({ createdAt: new Date(Date.now() - 120_000) }).where(eq(schema.preReviews.vendorId, id));
    expect((await tax.post(`/api/staff/vendors/${id}/pre-review`, {})).status).toBe(200);
    expect((await tax.get(`/api/staff/vendors/${id}`)).body.preReview.stale).toBe(false);
  });

  test('serious findings: a duplicate bank account means review, never approve', async () => {
    const { id: firstId } = await submittedVendor('Original Gears Ltd', 'gears1@pre.test');
    const first = (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, firstId) }))!.profile as any;
    const { id } = await submittedVendor('Copy Gears Ltd', 'gears2@pre.test');
    const v = (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) }))!;
    const { withIdentity } = await import('../src/services/duplicates.js');
    await db.update(schema.vendors).set(withIdentity({ ...(v.profile as any), bank: { ...(v.profile as any).bank, accountNumber: first.bank.accountNumber, ifsc: first.bank.ifsc } })).where(eq(schema.vendors.id, id));
    const tax = await login('tax@acme.test');
    await db.update(schema.preReviews).set({ createdAt: new Date(Date.now() - 120_000) }).where(eq(schema.preReviews.vendorId, id));
    await tax.post(`/api/staff/vendors/${id}/pre-review`, {});
    const pr = (await tax.get(`/api/staff/vendors/${id}`)).body.preReview;
    expect(pr.result.recommendation).toBe('REVIEW');
    expect(pr.result.findings[0]).toMatchObject({ severity: 'high', source: 'checks' });
    expect(pr.result.findings[0].text).toMatch(/Possible duplicate of .*Original Gears Ltd \(same bank account\)/);
  });

  test('with AI switched on (privacy mode): only general facts with placeholders go to the AI; names are put back; its summary and extra points are added, never softer than the findings', async () => {
    const t = await acme();
    const seen: any[] = [];
    setPreReviewer({ name: 'anthropic', live: true, async review(input) {
      seen.push(input);
      return { summary: '[SUPPLIER] supplies forged parts.', recommendation: 'APPROVE', findings: [{ severity: 'medium', text: 'Turnover looks high for a company founded this year', tab: 'risk', source: 'ai' }], questions: ['Can [SUPPLIER] confirm its bank details on letterhead?'] };
    } });
    await db.update(schema.tenants).set({ settings: { ...t.settings, aiPreReview: true } }).where(eq(schema.tenants.id, t.id));
    try {
      const { id: aId } = await submittedVendor('Ironclad Forge Ltd', 'iron1@pre.test');
      const a = (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, aId) }))!.profile as any;
      expect(seen).toHaveLength(1);
      const v = (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, aId) }))!;
      const sent = JSON.stringify(seen[0]).toLowerCase();
      expect(seen[0].vendor).toBe('[SUPPLIER]');
      for (const x of [v.name, v.code, v.contactEmail, v.contactMobile, v.contactFirstName + ' ' + v.contactLastName, a.bank.accountNumber, a.tax.pan, a.tax.gstin, a.address?.line1, a.bank.ifsc])
        if (x) expect(sent, String(x)).not.toContain(String(x).toLowerCase());
      expect(sent).not.toContain('ironclad');
      expect(sent).toContain('[supplier]');
      expect(seen[0].digest.verifications).toBeTruthy();
      // Comparisons worked out here: only yes / no reaches the AI; amounts as ranges by default; peers compared.
      expect(seen[0].digest.consistency).toMatchObject({ 'GSTIN state matches the address state': true, 'PIN code matches the address state': true, 'PAN type matches the type of entity': true });
      expect(seen[0].digest.amounts.precision).toBe('ranges');
      expect(seen[0].digest.amounts.annualTurnover).toMatch(/million|not given/);
      expect(seen[0].digest).toHaveProperty('peers'); // null here: fewer than 5 approved suppliers to compare with
      const pr = (await (await login('tax@acme.test')).get(`/api/staff/vendors/${aId}`)).body.preReview;
      expect(pr).toMatchObject({ provider: 'anthropic', live: true, aiOn: true });
      expect(pr.result.summary).toBe('Ironclad Forge Ltd supplies forged parts.'); // name put back on our side
      expect(JSON.stringify(pr.sentToAi)).not.toContain('Ironclad');
      expect(pr.result.recommendation).toBe('REVIEW'); // the AI said APPROVE, but there's a medium finding to look at
      expect(pr.result.findings.some((f: any) => f.source === 'ai' && /Turnover/.test(f.text))).toBe(true);
      expect(pr.result.questions).toEqual(['Can Ironclad Forge Ltd confirm its bank details on letterhead?']);
      const log = (await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.vendorId, aId)).orderBy(desc(schema.auditLogs.createdAt))).find((x) => x.action === 'PRE_REVIEW_READY');
      expect(log?.detail).toMatchObject({ ai: 'yes' });
      // AI down: VendorGate's findings are still shown.
      setPreReviewer({ name: 'anthropic', live: true, async review() { throw new Error('overloaded'); } });
      await db.update(schema.preReviews).set({ createdAt: new Date(Date.now() - 120_000) }).where(eq(schema.preReviews.vendorId, aId));
      await (await login('tax@acme.test')).post(`/api/staff/vendors/${aId}/pre-review`, {});
      const again = (await (await login('tax@acme.test')).get(`/api/staff/vendors/${aId}`)).body.preReview;
      expect(again.status).toBe('READY');
      expect(again.result.summary).toMatch(/couldn't be written just now/);
      expect(again).toMatchObject({ live: false, sentToAi: null });
    } finally {
      const fresh = await acme();
      await db.update(schema.tenants).set({ settings: { ...fresh.settings, aiPreReview: false } }).where(eq(schema.tenants.id, t.id));
    }
  });

  test('privacy guard: if a real value from the record would reach the AI, nothing is sent', async () => {
    const t = await acme();
    const seen: any[] = [];
    setPreReviewer({ name: 'anthropic', live: true, async review(input) { seen.push(input); return { summary: 'x', recommendation: 'APPROVE', findings: [], questions: [] }; } });
    await db.update(schema.tenants).set({ settings: { ...t.settings, aiPreReview: true } }).where(eq(schema.tenants.id, t.id));
    try {
      const { id } = await submittedVendor('Leaky Widgets Ltd', 'leak1@pre.test');
      seen.length = 0;
      const { gather } = await import('../src/services/preReview.js');
      const v = (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id), with: { documents: true } }))!;
      // A supplier whose name also appears in the payload (here: named like its vendor type) is not sent.
      expect((await gather(t, v as any)).payload).toBeTruthy();
      expect((await gather(t, { ...v, name: v.vendorType } as any)).payload).toBeNull();
      // And generating falls back to the checks-only pre-review instead of sending.
      await db.update(schema.vendors).set({ name: v.vendorType }).where(eq(schema.vendors.id, id));
      await db.update(schema.preReviews).set({ createdAt: new Date(Date.now() - 120_000) }).where(eq(schema.preReviews.vendorId, id));
      await (await login('tax@acme.test')).post(`/api/staff/vendors/${id}/pre-review`, {});
      const pr = (await (await login('tax@acme.test')).get(`/api/staff/vendors/${id}`)).body.preReview;
      expect(seen).toHaveLength(0);
      expect(pr.status).toBe('READY');
      expect(pr.sentToAi).toBeNull();
      expect(pr.live).toBe(false);
    } finally {
      const fresh = await acme();
      await db.update(schema.tenants).set({ settings: { ...fresh.settings, aiPreReview: false } }).where(eq(schema.tenants.id, t.id));
    }
  });

  test('exact amounts when the workspace chooses them — still no names, and the guard lets the turnover through', async () => {
    const t = await acme();
    const seen: any[] = [];
    setPreReviewer({ name: 'anthropic', live: true, async review(input) { seen.push(input); return { summary: '[SUPPLIER] ok', recommendation: 'APPROVE', findings: [], questions: [] }; } });
    await db.update(schema.tenants).set({ settings: { ...t.settings, aiPreReview: true, aiPrecision: 'exact' } }).where(eq(schema.tenants.id, t.id));
    try {
      const { id } = await submittedVendor('Exacting Metals Ltd', 'exact1@pre.test', { beforeSubmit: (v) => v.put('/api/vendor/profile/risk', { annualTurnover: '42500000', currency: 'INR' }) });
      const v = (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) }))!;
      expect(seen).toHaveLength(1);
      const turnover = (v.profile as any).risk?.annualTurnover;
      if (turnover) expect(seen[0].digest.amounts.annualTurnover).toBe(`${Number(turnover).toLocaleString('en-US')} ${(v.profile as any).risk.currency ?? ''}`.trim());
      expect(JSON.stringify(seen[0]).toLowerCase()).not.toContain('exacting');
      // A form value that doesn't fit is a finding with or without the AI.
      await db.update(schema.vendors).set({ profile: { ...(v.profile as any), basic: { ...(v.profile as any).basic, region: 'Kerala' } } }).where(eq(schema.vendors.id, id));
      await db.update(schema.preReviews).set({ createdAt: new Date(Date.now() - 120_000) }).where(eq(schema.preReviews.vendorId, id));
      await (await login('tax@acme.test')).post(`/api/staff/vendors/${id}/pre-review`, {});
      const pr = (await (await login('tax@acme.test')).get(`/api/staff/vendors/${id}`)).body.preReview;
      expect(pr.result.findings.map((f: any) => f.text)).toEqual(expect.arrayContaining(['The GSTIN is registered in a different state from the address', 'The PIN code belongs to a different state from the one in the address']));
      expect(pr.sentToAi.consistency['GSTIN state matches the address state']).toBe(false);
    } finally {
      const fresh = await acme();
      await db.update(schema.tenants).set({ settings: { ...fresh.settings, aiPreReview: false, aiPrecision: undefined } }).where(eq(schema.tenants.id, t.id));
    }
  });
});
