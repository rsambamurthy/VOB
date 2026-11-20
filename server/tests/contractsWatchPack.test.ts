/** Contract watch (step 2): decision packs, the rule-based recommendation, the summary (rules or AI from masked facts), drafts, outcomes. */
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { login } from './helpers.js';
import { activeContract, iso, po } from './contractsHelpers.js';
import { db, schema } from '../src/lib/db.js';
import type { Tenant } from '../src/db/schema.js';
import { importPurchaseOrders } from '../src/services/orders/importer.js';
import { runWatchFor } from '../src/services/contracts/watch.js';
import { rulesWriter, setWatchWriter, type PackFacts, type WatchWriter } from '../src/integrations/ai/watchWriter.js';

let acme: Tenant;
let original: Pick<Tenant, 'settings' | 'limits' | 'plan'>;
const tenant = async () => (await db.query.tenants.findFirst({ where: eq(schema.tenants.id, acme.id) }))!;
const S = schema.contractSuggestions;
const find = async (contractId: string, kind: string) => (await db.select().from(S).where(and(eq(S.contractId, contractId), eq(S.kind, kind))))[0];
const settings = (features: Record<string, boolean>) => ({ enabled: true, types: { service: true, supply: true }, features: { internalApproval: false, obligations: true, renewalAlerts: true, priceCompliance: true, watch: true, ...features }, rules: { priceTolerance: 0 } });

beforeAll(async () => {
  acme = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
  original = { settings: acme.settings, limits: acme.limits, plan: acme.plan };
  await db.update(schema.tenants).set({ limits: { features: { contracts: true, collab: true, ai: true } } }).where(eq(schema.tenants.id, acme.id));
  const r = await (await login('admin@acme.test')).put('/api/admin/contracts', settings({ watchSummary: true }));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
});
afterAll(async () => { await db.update(schema.tenants).set(original).where(eq(schema.tenants.id, acme.id)); });
afterEach(() => setWatchWriter(rulesWriter));

test('renewal pack: prices above the contract and late obligations → renegotiate; rules summary; drafts with real names', async () => {
  const k = await activeContract('Pack Pumps', { endDate: iso(60), noticeDays: 30, autoRenew: true, renewalTermMonths: 12, reference: 'PP/2025/17' }, [{ name: 'Leela Menon', email: 'leela@packpumps.example', signatory: true }]);
  await k.admin.put(`/api/staff/contracts/${k.id}/prices`, { prices: [{ itemCode: 'PP-9', description: 'Pump seal kit', price: 500 }] });
  await importPurchaseOrders(await tenant(), [po(k.vendorCode, 'P1', [{ item: 'PP-9', qty: 20, price: 650 }])], 'api', 'test');
  await db.insert(schema.contractObligations).values({ tenantId: acme.id, contractId: k.id, title: 'Quarterly pump inspection report', kind: 'REPORT', side: 'PARTY', dueDate: iso(-12), createdByName: 'test' });
  await runWatchFor(await tenant());
  const decide = await find(k.id, 'DECIDE');

  const r = (await k.admin.post(`/api/staff/contracts/suggestions/${decide.id}/pack`)).body;
  expect(r.pack).toMatchObject({ recommendation: 'RENEGOTIATE', contract: { number: k.number, autoRenew: true, daysToNotice: 30 }, prices: { linesAbove: 1, excess: 3000 }, obligations: { overdueTheirs: 1 }, orders: { count: 1 } });
  expect(r.pack.reasons.join(' ')).toMatch(/above the contract price \(INR 3,000.00 over\)/);
  expect(r).toMatchObject({ summaryBy: 'rules', sentToAi: null });
  expect(r.summary).toMatch(/^VendorGate suggests you renegotiate before renewing\./);
  expect(r.drafts.map((d: any) => d.key)).toEqual(['renegotiate', 'nonRenewal']);
  // Stored with the suggestion for the list and the card.
  expect((await k.admin.get(`/api/staff/contracts/${k.id}`)).body.watch.open.find((s: any) => s.id === decide.id).summary).toMatch(/renegotiate/);

  const notice = (await k.admin.post(`/api/staff/contracts/suggestions/${decide.id}/drafts/nonRenewal`)).body;
  expect(notice).toMatchObject({ to: 'leela@packpumps.example', subject: `Notice of non-renewal — ${k.number}` });
  expect(notice.body).toMatch(/^Dear Leela Menon,/);
  expect(notice.body).toContain('your reference PP/2025/17');
  expect(notice.body).toContain('at least 30 days before that date');
  expect(notice.body).toMatch(/Check the agreement's notice clause/);
  expect((await k.admin.post(`/api/staff/contracts/suggestions/${decide.id}/drafts/chase`)).status).toBe(400);
  const chase = (await k.admin.post(`/api/staff/contracts/suggestions/${(await find(k.id, 'OVERDUE')).id}/drafts/chase`)).body;
  expect(chase.body).toContain('- Quarterly pump inspection report — due');
  const query = (await k.admin.post(`/api/staff/contracts/suggestions/${(await find(k.id, 'PRICE')).id}/drafts/priceQuery`)).body;
  expect(query.body).toContain('PO W-P1, item PP-9: INR 650.00 against the agreed INR 500.00 (quantity 20)');
  expect((await k.admin.get(`/api/staff/contracts/${k.id}`)).body.history.some((h: any) => h.action === 'CONTRACT_WATCH_DRAFTED')).toBe(true);

  // Permissions: no contracts permission, no pack; drafts need manage.
  const tax = await login('tax@acme.test');
  expect((await tax.post(`/api/staff/contracts/suggestions/${decide.id}/pack`)).status).toBe(403);
  expect((await tax.post(`/api/staff/contracts/suggestions/${decide.id}/drafts/nonRenewal`)).status).toBe(403);
});

test('AI summary sees only general facts — never names, numbers or amounts; tokens put back; a leak keeps it with the rules', async () => {
  const k = await activeContract('Pack Valves Co', { endDate: iso(50), noticeDays: 20, value: '2400000' });
  await importPurchaseOrders(await tenant(), [po(k.vendorCode, 'V1', [{ item: 'VX', qty: 10, price: 1000 }])], 'api', 'test');
  await runWatchFor(await tenant());
  const decide = await find(k.id, 'DECIDE');
  let seen: PackFacts | undefined;
  const fake: WatchWriter = { name: 'anthropic', live: true, async write(f) { seen = f; return { summary: 'Renew [CONTRACT] with [PARTY]; it is in steady use.', points: ['Ask [PARTY] to hold the prices.'] }; } };
  setWatchWriter(fake);
  const r = (await k.admin.post(`/api/staff/contracts/suggestions/${decide.id}/pack`)).body;
  expect(r.summaryBy).toBe('anthropic');
  expect(r.summary).toBe(`Renew ${k.number} with Pack Valves Co; it is in steady use.`);
  expect(r.points).toEqual(['Ask Pack Valves Co to hold the prices.']);
  const sent = JSON.stringify(seen);
  expect(r.sentToAi).toBe(sent);
  for (const secret of ['Pack Valves', k.number, 'Pack Valves Co contract', '2400000', '24,00,000', '10000', 'Acme', 'admin@acme.test']) expect(sent).not.toContain(secret);
  expect(seen!.facts).toMatchObject({ valueSize: 'medium', noticeIn: 'within a month', ordersLast12Months: '1–5', weBuy: true });

  // A party whose name appears in the facts (here the contract type "Supply / rate contract"): nothing is sent.
  await db.update(schema.parties).set({ name: 'Supply' }).where(eq(schema.parties.id, k.partyId));
  seen = undefined;
  const again = (await k.admin.post(`/api/staff/contracts/suggestions/${decide.id}/pack`)).body;
  expect(seen).toBeUndefined();
  expect(again).toMatchObject({ summaryBy: 'rules', sentToAi: null });

  // Option off: rules only, nothing sent.
  await db.update(schema.parties).set({ name: 'Pack Valves Co' }).where(eq(schema.parties.id, k.partyId));
  await k.admin.put('/api/admin/contracts', settings({ watchSummary: false }));
  expect((await k.admin.post(`/api/staff/contracts/suggestions/${decide.id}/pack`)).body.summaryBy).toBe('rules');
  expect(seen).toBeUndefined();
  await k.admin.put('/api/admin/contracts', settings({ watchSummary: true }));
});

test('recommendations: end an unused contract, renew a clean one; outcomes in the report', async () => {
  const unused = await activeContract('Pack Idle Tools', { endDate: iso(40), noticeDays: 10, startDate: iso(-400) });
  await importPurchaseOrders(await tenant(), [po(unused.vendorCode, 'T1', [{ item: 'T', qty: 1, price: 10 }], iso(-300))], 'api', 'test');
  const clean = await activeContract('Pack Clean Gaskets', { endDate: iso(40), noticeDays: 10 });
  await importPurchaseOrders(await tenant(), [po(clean.vendorCode, 'G1', [{ item: 'G', qty: 1, price: 10 }])], 'api', 'test');
  await runWatchFor(await tenant());
  const u = (await unused.admin.post(`/api/staff/contracts/suggestions/${(await find(unused.id, 'DECIDE')).id}/pack`)).body.pack;
  expect(u.recommendation).toBe('END');
  expect(u.reasons[0]).toMatch(/^No orders since/);
  const c = (await clean.admin.post(`/api/staff/contracts/suggestions/${(await find(clean.id, 'DECIDE')).id}/pack`)).body.pack;
  expect(c.recommendation).toBe('RENEW');

  const before = (await clean.admin.get('/api/staff/contracts/reports')).body.watch.outcomes;
  await unused.admin.post(`/api/staff/contracts/suggestions/${(await find(unused.id, 'DECIDE')).id}`, { decision: 'USE', action: 'end' });
  // Reports are cached for a minute: read the figures directly.
  const { watchOutcomes } = await import('../src/services/contracts/decisionPack.js');
  const after = await watchOutcomes(await tenant());
  expect(after.ended).toBe(before.ended + 1);
  expect(after.endedValue).toBe(before.endedValue + 100000);
  expect(after.beforeNotice).toBe(before.beforeNotice + 1);
  expect(after.beforeNoticePct).not.toBeNull();
});
