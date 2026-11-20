/** Contract watch (step 1): signals from dates, orders, prices, obligations, supplier health and owners; the suggestions queue. */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { invitedSupplier, login } from './helpers.js';
import { lastMail } from './sourcingHelpers.js';
import { db, schema } from '../src/lib/db.js';
import type { Tenant } from '../src/db/schema.js';
import { importPurchaseOrders } from '../src/services/orders/importer.js';
import { runContractReminders } from '../src/services/contracts/manage.js';
import { runWatchFor, sendDigest, syncWatch, watchSignals } from '../src/services/contracts/watch.js';

let acme: Tenant;
let original: Pick<Tenant, 'settings' | 'limits' | 'plan'>;
const iso = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
const tenant = async () => (await db.query.tenants.findFirst({ where: eq(schema.tenants.id, acme.id) }))!;
const S = schema.contractSuggestions;
const open = async (contractId: string) => db.select().from(S).where(and(eq(S.contractId, contractId)));

beforeAll(async () => {
  acme = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
  original = { settings: acme.settings, limits: acme.limits, plan: acme.plan };
  await db.update(schema.tenants).set({ limits: { features: { contracts: true, collab: true } } }).where(eq(schema.tenants.id, acme.id));
  const admin = await login('admin@acme.test');
  const r = await admin.put('/api/admin/contracts', { enabled: true, types: { service: true, supply: true }, features: { internalApproval: false, obligations: true, renewalAlerts: true, priceCompliance: true, watch: true }, rules: { priceTolerance: 0, decisionDays: 90, spendWarnPct: 80, idleMonths: 6, digestDay: 'mon' } });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
});
afterAll(async () => { await db.update(schema.tenants).set(original).where(eq(schema.tenants.id, acme.id)); });

/** An active supplier contract with an onboarded supplier, owned by the admin. */
async function activeContract(name: string, fields: Partial<typeof schema.contracts.$inferInsert>) {
  const admin = await login('admin@acme.test');
  const { id: vendorId } = await invitedSupplier(name, `${name.toLowerCase().replace(/\W+/g, '')}@watch.example`);
  const party = (await admin.post('/api/staff/parties/from-supplier', { vendorId })).body.party;
  const me = (await admin.get('/api/auth/me')).body.user;
  const c = (await admin.post('/api/staff/contracts', { title: `${name} contract`, direction: 'BUY', type: 'supply', partyId: party.id, value: 100000, currency: 'INR', startDate: iso(-300), endDate: iso(365), ownerId: me.id })).body.contract;
  await db.update(schema.contracts).set({ status: 'ACTIVE', signedDate: iso(-300), ...fields }).where(eq(schema.contracts.id, c.id));
  const vendor = (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, vendorId) }))!;
  return { id: c.id as string, number: c.number as string, vendorId, vendorCode: vendor.code, admin, me };
}
const po = (code: string, n: string, lines: { item: string; qty: number; price: number }[], poDate = iso(-10)) => ({
  erpId: `W-${n}`, poNumber: `W-${n}`, supplierCode: code, currency: 'INR', poDate,
  lines: lines.map((l, i) => ({ erpId: `W-${n}-${i + 1}`, lineNo: i + 1, itemCode: l.item, description: l.item, quantity: l.qty, unitPrice: l.price })),
});

test('renewal decision: raised inside the window, urgent near the notice date, never twice, resolved when the dates move', async () => {
  const k = await activeContract('Watch Renewals', { endDate: iso(70), noticeDays: 30, autoRenew: true, renewalTermMonths: 12 });
  const t = await tenant();
  let sig = (await watchSignals(t, iso(0), [k.id])).find((s) => s.kind === 'DECIDE')!;
  expect(sig).toMatchObject({ severity: 'NORMAL', key: iso(40), title: `Decide before it renews: ${k.number}` });
  expect(sig.reasons.join(' ')).toMatch(/renews automatically/);

  await runWatchFor(t);
  await runWatchFor(t); // a second run adds nothing
  expect((await open(k.id)).filter((s) => s.kind === 'DECIDE')).toHaveLength(1);

  // Ten days before the notice date it is urgent and the owner is emailed once.
  await db.update(schema.contracts).set({ endDate: iso(40) }).where(eq(schema.contracts.id, k.id));
  sig = (await watchSignals(t, iso(0), [k.id])).find((s) => s.kind === 'DECIDE')!;
  expect(sig.severity).toBe('URGENT');
  await runWatchFor(t);
  const mail = await lastMail('admin@acme.test');
  expect(mail?.subject).toBe(`Needs a decision: Decide before it renews: ${k.number}`);
  const sent = (await db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.subject, mail!.subject))).length;
  await runWatchFor(t);
  expect((await db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.subject, mail!.subject))).length).toBe(sent);
  // The earlier notice date's suggestion was resolved by itself; the new one is open.
  const rows = (await open(k.id)).filter((s) => s.kind === 'DECIDE');
  expect(rows.map((r) => r.status).sort()).toEqual(['OPEN', 'RESOLVED']);

  // The old renewal email is not sent as well while watch is on.
  await db.update(schema.contracts).set({ alerts: null }).where(eq(schema.contracts.id, k.id));
  await runContractReminders();
  expect((await db.query.contracts.findFirst({ where: eq(schema.contracts.id, k.id) }))!.alerts).toBeNull();
});

test('prices above the contract, spend near the value, the other party late, supplier on hold, no owner', async () => {
  const k = await activeContract('Watch Valves', {});
  await k.admin.put(`/api/staff/contracts/${k.id}/prices`, { prices: [{ itemCode: 'WV-1', description: 'Valve', price: 1000 }] });
  // An order through the normal import: above the price, and 85% of the value. The import itself triggers the watch.
  const r = await importPurchaseOrders(await tenant(), [po(k.vendorCode, 'A1', [{ item: 'WV-1', qty: 70, price: 1200 }, { item: 'OTHER', qty: 1, price: 1000 }])], 'api', 'test');
  expect(r.created).toBe(1);
  let kinds = (await open(k.id)).filter((s) => s.status === 'OPEN');
  const price = kinds.find((s) => s.kind === 'PRICE')!;
  expect(price.facts).toMatchObject({ linesAbove: 1, excess: 14000 });
  expect(kinds.find((s) => s.kind === 'SPEND')).toMatchObject({ key: '80', severity: 'NORMAL', facts: expect.objectContaining({ pct: 85 }) });

  await db.insert(schema.contractObligations).values({ tenantId: acme.id, contractId: k.id, title: 'Monthly service report', kind: 'REPORT', side: 'PARTY', dueDate: iso(-45), createdByName: 'test' });
  await db.update(schema.vendors).set({ blockedAt: new Date(), blockSource: 'MANUAL', blockedReason: 'Bank details under review' }).where(eq(schema.vendors.id, k.vendorId));
  await db.update(schema.contracts).set({ ownerId: null }).where(eq(schema.contracts.id, k.id));
  await runWatchFor(await tenant());
  kinds = (await open(k.id)).filter((s) => s.status === 'OPEN');
  expect(kinds.find((s) => s.kind === 'OVERDUE')).toMatchObject({ severity: 'URGENT', facts: expect.objectContaining({ overdue: 1 }) });
  expect(kinds.find((s) => s.kind === 'SUPPLIER')?.reasons[0]).toMatch(/on hold: Bank details under review/);
  expect(kinds.find((s) => s.kind === 'OWNER')).toBeTruthy();
  // Two urgent ones for the same person: one email listing both, not two.
  expect((await lastMail('admin@acme.test'))?.subject).toBe('Contract watch: 2 urgent decisions');

  // A second order takes spend over the value: a new, urgent spend suggestion.
  await importPurchaseOrders(await tenant(), [po(k.vendorCode, 'A2', [{ item: 'OTHER', qty: 1, price: 20000 }])], 'api', 'test');
  expect((await open(k.id)).find((s) => s.kind === 'SPEND' && s.key === '100')).toMatchObject({ severity: 'URGENT', status: 'OPEN' });

  // Fixing the owner and releasing the hold resolves those by themselves.
  await db.update(schema.contracts).set({ ownerId: k.me.id }).where(eq(schema.contracts.id, k.id));
  await db.update(schema.vendors).set({ blockedAt: null, blockSource: null, blockedReason: null }).where(eq(schema.vendors.id, k.vendorId));
  await runWatchFor(await tenant());
  const after = await open(k.id);
  expect(after.find((s) => s.kind === 'OWNER')?.status).toBe('RESOLVED');
  expect(after.find((s) => s.kind === 'SUPPLIER')?.status).toBe('RESOLVED');
});

test('unused supplier contracts are flagged; Use, Dismiss (with a reason), Snooze and Reopen; permissions; history', async () => {
  const k = await activeContract('Watch Idle', { startDate: iso(-400) });
  await importPurchaseOrders(await tenant(), [po(k.vendorCode, 'I1', [{ item: 'X', qty: 1, price: 10 }], iso(-250))], 'api', 'test');
  await runWatchFor(await tenant());
  const idle = (await open(k.id)).find((s) => s.kind === 'IDLE')!;
  expect(idle.reasons[0]).toMatch(/last purchase order/);

  const list = (await k.admin.get('/api/staff/contracts/watch?kind=IDLE')).body;
  expect(list.suggestions.some((s: any) => s.id === idle.id)).toBe(true);
  expect(list.actions.IDLE).toHaveProperty('keep');

  // Someone without the contracts permission can't decide.
  const viewer = await login('tax@acme.test'); // no contracts permission
  expect((await viewer.post(`/api/staff/contracts/suggestions/${idle.id}`, { decision: 'USE', action: 'keep' })).status).toBe(403);

  expect((await k.admin.post(`/api/staff/contracts/suggestions/${idle.id}`, { decision: 'DISMISS', note: '' })).body.error).toMatch(/Say why/);
  expect((await k.admin.post(`/api/staff/contracts/suggestions/${idle.id}`, { decision: 'USE', action: 'renew' })).body.error).toMatch(/listed actions/);
  expect((await k.admin.post(`/api/staff/contracts/suggestions/${idle.id}`, { decision: 'SNOOZE', until: iso(400) })).body.error).toMatch(/180 days/);
  expect((await k.admin.post(`/api/staff/contracts/suggestions/${idle.id}`, { decision: 'SNOOZE', until: iso(10) })).body.suggestion).toMatchObject({ status: 'SNOOZED', snoozeUntil: iso(10) });
  // Snoozed ones wake up on their date.
  await syncWatch(await tenant(), iso(11), [k.id]);
  expect((await db.query.contractSuggestions.findFirst({ where: eq(S.id, idle.id) }))!.status).toBe('OPEN');

  const used = await k.admin.post(`/api/staff/contracts/suggestions/${idle.id}`, { decision: 'USE', action: 'keep', note: 'Seasonal — orders resume in March.' });
  expect(used.body.suggestion).toMatchObject({ status: 'USED', actionLabel: 'Keep it', decidedByName: expect.any(String) });
  // Decided for this period: the nightly run doesn't raise it again.
  await runWatchFor(await tenant());
  expect((await open(k.id)).filter((s) => s.kind === 'IDLE')).toHaveLength(1);
  const d = (await k.admin.get(`/api/staff/contracts/${k.id}`)).body;
  expect(d.watch.decided[0]).toMatchObject({ actionLabel: 'Keep it', note: 'Seasonal — orders resume in March.' });
  expect(d.history.find((h: any) => h.action === 'CONTRACT_WATCH_USED').detail).toMatchObject({ did: 'Keep it' });
  expect((await k.admin.post(`/api/staff/contracts/suggestions/${idle.id}`, { decision: 'REOPEN' })).body.suggestion.status).toBe('OPEN');

  // Another workspace can't see or decide it.
  const globex = await login('admin@globex.test', 'globex');
  expect((await globex.post(`/api/staff/contracts/suggestions/${idle.id}`, { decision: 'USE', action: 'keep' })).status).toBeGreaterThanOrEqual(401);
  expect((await db.query.contractSuggestions.findFirst({ where: eq(S.id, idle.id) }))!.status).toBe('OPEN');
});

test('weekly digest once on the chosen day; watch off = no suggestions and the old renewal emails', async () => {
  const t = await tenant();
  const monday = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7)); return d.toISOString().slice(0, 10); })();
  expect(await sendDigest(t, monday)).toBeGreaterThan(0);
  expect((await lastMail('admin@acme.test'))?.subject).toMatch(/^Contract watch: \d+ waiting for you/);
  expect(await sendDigest(t, monday)).toBe(0); // once a day
  const tuesday = new Date(Date.parse(`${monday}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  expect(await sendDigest(t, tuesday)).toBe(0); // not the digest day

  const admin = await login('admin@acme.test');
  await admin.put('/api/admin/contracts', { enabled: true, types: { service: true, supply: true }, features: { internalApproval: false, obligations: true, renewalAlerts: true, priceCompliance: true, watch: false } });
  const k = await activeContract('Watch Off', { endDate: iso(20), noticeDays: 10 });
  expect(await runWatchFor(await tenant())).toMatchObject({ added: 0 });
  expect((await admin.get(`/api/staff/contracts/${k.id}`)).body.watch.on).toBe(false);
  expect((await admin.post('/api/staff/contracts/watch/run')).status).toBe(409);
  await runContractReminders();
  expect((await db.query.contracts.findFirst({ where: eq(schema.contracts.id, k.id) }))!.alerts).toMatchObject({ expiring: iso(20) });
  await admin.put('/api/admin/contracts', { enabled: true, types: { service: true, supply: true }, features: { internalApproval: false, obligations: true, renewalAlerts: true, priceCompliance: true, watch: true } });
});
