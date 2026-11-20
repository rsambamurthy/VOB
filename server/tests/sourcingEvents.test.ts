/** Sourcing step 1: events, lots and lines (screen and Excel), templates, checks, and approval by value. */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { lastLinkTo, login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import type { Tenant } from '../src/db/schema.js';
import { itemsTemplate, readItems } from '../src/services/sourcing/events.js';
import { agreementsFor } from '../src/services/agreements.js';

let acme: Tenant;
let original: Pick<Tenant, 'settings' | 'limits'>;
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const LOTS = [
  { title: 'Steel', bidMode: 'lot', startPrice: 1_500_000, reservePrice: 1_200_000, lines: [{ itemCode: 'ST-1', description: 'MS plate 10 mm', quantity: 20, unit: 'MT' }, { description: 'MS angle', quantity: 8, unit: 'MT' }] },
  { title: 'Fasteners', bidMode: 'line', lines: [{ description: 'Hex bolt M12', quantity: 5000, unit: 'Nos', targetPrice: 14 }] },
];
const year = new Date().getUTCFullYear();

beforeAll(async () => {
  acme = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
  original = { settings: acme.settings, limits: acme.limits };
  await db.update(schema.tenants).set({ limits: { features: { sourcing: true } } }).where(eq(schema.tenants.id, acme.id));
  const admin = await login('admin@acme.test');
  expect((await admin.put('/api/admin/sourcing', { enabled: true, formats: { rfq: true, reverse: true } })).status).toBe(200);
});
afterAll(async () => { await db.update(schema.tenants).set(original).where(eq(schema.tenants.id, acme.id)); });

async function readyEvent(buyer: Awaited<ReturnType<typeof login>>, value: number, format: 'rfq' | 'reverse' = 'rfq') {
  const body = format === 'rfq' ? { title: `Steel ${value}`, format, estimatedValue: value, bidDeadline: inHours(72) } : { title: `Steel RA ${value}`, format, estimatedValue: value, liveStartsAt: inHours(48), liveEndsAt: inHours(49) };
  const e = (await buyer.post('/api/staff/sourcing/events', body)).body.event;
  expect((await buyer.put(`/api/staff/sourcing/events/${e.id}/items`, { lots: LOTS })).status).toBe(200);
  return e;
}

describe('sourcing events', () => {
  test('numbering per format and year; formats that are off are refused; only event creators can create', async () => {
    const buyer = await login('buyer@acme.test');
    const a = (await buyer.post('/api/staff/sourcing/events', { title: 'Steel plates', format: 'rfq', estimatedValue: 100000 })).body.event;
    const b = (await buyer.post('/api/staff/sourcing/events', { title: 'Steel plates again', format: 'rfq' })).body.event;
    const c = (await buyer.post('/api/staff/sourcing/events', { title: 'Cement', format: 'reverse' })).body.event;
    expect(a.number).toMatch(new RegExp(`^RFQ-${year}-\\d{4}$`));
    expect(Number(b.number.slice(-4))).toBe(Number(a.number.slice(-4)) + 1);
    expect(c.number).toMatch(new RegExp(`^RA-${year}-\\d{4}$`));
    expect((await buyer.post('/api/staff/sourcing/events', { title: 'Scrap', format: 'forward' })).body.error).toMatch(/isn’t included in your plan|isn’t available yet/);
    expect((await (await login('tax@acme.test')).post('/api/staff/sourcing/events', { title: 'Nope', format: 'rfq' })).status).toBe(403);
    // The format is fixed once created.
    expect((await buyer.patch(`/api/staff/sourcing/events/${a.id}`, { format: 'reverse' })).body.error).toMatch(/can’t be changed/);
    // A never-submitted draft can be deleted.
    expect((await buyer.del(`/api/staff/sourcing/events/${b.id}`)).status).toBe(200);
  });

  test('checks before submitting: value, dates, items, rules', async () => {
    const buyer = await login('buyer@acme.test');
    const e = (await buyer.post('/api/staff/sourcing/events', { title: 'Cement for plant 2', format: 'reverse' })).body.event;
    let d = (await buyer.get(`/api/staff/sourcing/events/${e.id}`)).body;
    expect(d.issues.map((i: any) => i.field)).toEqual(expect.arrayContaining(['estimatedValue', 'liveStartsAt', 'items']));
    const r = await buyer.post(`/api/staff/sourcing/events/${e.id}/submit`);
    expect(r.status).toBe(400);
    expect(r.body.details.issues.length).toBeGreaterThan(2);

    d = (await buyer.patch(`/api/staff/sourcing/events/${e.id}`, { estimatedValue: 400000, liveStartsAt: inHours(48), liveEndsAt: inHours(48.05), bidDeadline: inHours(50) })).body;
    expect(d.issues.map((i: any) => i.message).join(' ')).toMatch(/at least 10 minutes.*close before the auction starts/);
    // Rules: buyer choices within range.
    expect((await buyer.patch(`/api/staff/sourcing/events/${e.id}`, { ruleChoices: { extensionMinutes: 99 } })).body.error).toMatch(/at most 30/);
    expect((await buyer.patch(`/api/staff/sourcing/events/${e.id}`, { ruleChoices: { extensionMinutes: 3, visibility: 'rank_best' } })).status).toBe(200);
  });

  test('items from Excel: template, preview with errors, then saved', async () => {
    const parsed = await readItems(Buffer.from(await itemsTemplate('INR')));
    expect(parsed.errors).toEqual([]);
    expect(parsed.lots.map((l) => [l.title, l.lines.length])).toEqual([['Steel', 2], ['Fasteners', 1]]);
    expect(parsed.lots[0].lines[0]).toMatchObject({ itemCode: 'ST-101', quantity: 20, unit: 'MT', targetPrice: 61000 });

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Items');
    ws.addRow(['Lot', 'Lot title', 'Item code', 'Description', 'Quantity', 'Unit']);
    ws.addRow([1, 'Paint', 'P1', 'Enamel paint', 'lots', 'L']);
    ws.addRow([1, '', 'P2', '', 10, 'L']);
    ws.addRow(['', '', 'P3', 'Primer', 5, 'L']);
    ws.addRow([2, '', 'B1', 'Brush', 30, 'Nos']);
    const bad = await readItems(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(bad.errors.map((x) => x.row)).toEqual([2, 3, 4]);
    expect(bad.errors[0].message).toMatch(/Quantity/);
    expect(bad.lots).toEqual([expect.objectContaining({ title: 'Lot 2', lines: [expect.objectContaining({ description: 'Brush' })] })]);

    const buyer = await login('buyer@acme.test');
    const up = await buyer.agent.post('/api/staff/sourcing/items/excel').set('X-Requested-With', 'fetch').attach('file', Buffer.from(await itemsTemplate('INR')), 'items.xlsx');
    expect(up.body.lots).toHaveLength(2);
    const e = (await buyer.post('/api/staff/sourcing/events', { title: 'From Excel', format: 'rfq' })).body.event;
    const saved = await buyer.put(`/api/staff/sourcing/events/${e.id}/items?from=excel`, { lots: up.body.lots });
    expect(saved.body.lots.map((l: any) => l.lines.length)).toEqual([2, 1]);
    const log = await db.query.auditLogs.findFirst({ where: eq(schema.auditLogs.action, 'SOURCING_ITEMS_SAVED'), orderBy: desc(schema.auditLogs.createdAt) });
    expect(log!.detail).toMatchObject({ from: 'excel', lots: 2, lines: 3 });
  });

  test('approval by value: none below 10 lakh; finance above; owner can’t approve own event', async () => {
    const buyer = await login('buyer@acme.test');
    const small = await readyEvent(buyer, 500000);
    expect((await buyer.post(`/api/staff/sourcing/events/${small.id}/submit`)).body).toMatchObject({ status: 'APPROVED', levels: [] });

    const mid = await readyEvent(buyer, 5_000_000);
    const sub = await buyer.post(`/api/staff/sourcing/events/${mid.id}/submit`);
    expect(sub.body).toMatchObject({ status: 'PENDING_APPROVAL', levels: ['Finance approval'] });
    expect(sub.body.event.rules).toMatchObject({ visibility: 'rank', minStepPct: 0.5 });
    expect(await lastLinkTo('finance@acme.test')).toContain(`/staff/sourcing/events/${mid.id}`);
    // Can't edit while waiting.
    expect((await buyer.patch(`/api/staff/sourcing/events/${mid.id}`, { title: 'Changed' })).status).toBe(409);
    // Tax manager doesn't hold the role.
    expect((await (await login('tax@acme.test')).post(`/api/staff/sourcing/events/${mid.id}/decision`, { action: 'APPROVE' })).status).toBe(403);

    const fin = await login('finance@acme.test');
    expect((await fin.get('/api/staff/sourcing/approvals/count')).body.waiting).toBeGreaterThanOrEqual(1);
    const view = (await fin.get(`/api/staff/sourcing/events/${mid.id}`)).body;
    expect(view.approval).toMatchObject({ canAct: true, current: { label: 'Finance approval' } });
    expect((await fin.post(`/api/staff/sourcing/events/${mid.id}/decision`, { action: 'SEND_BACK' })).body.error).toMatch(/Remarks are required/);
    const ok = await fin.post(`/api/staff/sourcing/events/${mid.id}/decision`, { action: 'APPROVE' });
    expect(ok.body).toMatchObject({ status: 'APPROVED', event: { status: 'APPROVED' } });
    expect(await lastLinkTo('buyer@acme.test')).toContain(mid.id);

    // The owner can't approve their own event, even holding the role (admin owns it; the senior level is for admins).
    const admin = await login('admin@acme.test');
    const own = await readyEvent(admin, 50_000_000);
    await admin.post(`/api/staff/sourcing/events/${own.id}/submit`);
    await fin.post(`/api/staff/sourcing/events/${own.id}/decision`, { action: 'APPROVE' });
    expect((await admin.get(`/api/staff/sourcing/events/${own.id}`)).body.approval).toMatchObject({ canAct: false, current: { label: 'Senior management approval' } });
    expect((await admin.post(`/api/staff/sourcing/events/${own.id}/decision`, { action: 'APPROVE' })).body.error).toMatch(/can’t approve an event you own/);
  });

  test('two levels above 1 crore; send back returns a draft, a new cycle starts; reject', async () => {
    const buyer = await login('buyer@acme.test');
    const big = await readyEvent(buyer, 50_000_000, 'reverse');
    expect((await buyer.post(`/api/staff/sourcing/events/${big.id}/submit`)).body.levels).toEqual(['Finance approval', 'Senior management approval']);
    const fin = await login('finance@acme.test'), admin = await login('admin@acme.test');
    expect((await admin.post(`/api/staff/sourcing/events/${big.id}/decision`, { action: 'APPROVE' })).status).toBe(403); // not their level yet
    expect((await fin.post(`/api/staff/sourcing/events/${big.id}/decision`, { action: 'APPROVE' })).body).toMatchObject({ status: 'PENDING', nextLevel: 'Senior management approval' });
    expect((await admin.post(`/api/staff/sourcing/events/${big.id}/decision`, { action: 'SEND_BACK', remarks: 'Split steel into two lots' })).body.event.status).toBe('DRAFT');
    expect((await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, 'buyer@acme.test'), orderBy: desc(schema.emailOutbox.createdAt) }))!.body).toContain('Split steel into two lots');

    expect((await buyer.patch(`/api/staff/sourcing/events/${big.id}`, { title: 'Steel RA (split)' })).status).toBe(200);
    const again = (await buyer.post(`/api/staff/sourcing/events/${big.id}/submit`)).body;
    expect(again.approval.cycle).toBe(2);
    expect(again.approval.steps.map((s: any) => s.status)).toEqual(['PENDING', 'WAITING']);
    await fin.post(`/api/staff/sourcing/events/${big.id}/decision`, { action: 'APPROVE' });
    expect((await admin.post(`/api/staff/sourcing/events/${big.id}/decision`, { action: 'REJECT', remarks: 'Budget not released' })).body.event.status).toBe('REJECTED');
    const hist = (await buyer.get(`/api/staff/sourcing/events/${big.id}`)).body.history.map((h: any) => h.action);
    expect(hist).toEqual(expect.arrayContaining(['SOURCING_EVENT_SUBMITTED', 'FLOW_STEP_SENT_BACK', 'FLOW_STEP_REJECTED']));
  });

  test('withdraw and cancel', async () => {
    const buyer = await login('buyer@acme.test');
    const e = await readyEvent(buyer, 5_000_000);
    await buyer.post(`/api/staff/sourcing/events/${e.id}/submit`);
    expect((await buyer.post(`/api/staff/sourcing/events/${e.id}/withdraw`)).body.event.status).toBe('DRAFT');
    expect((await (await login('finance@acme.test')).post(`/api/staff/sourcing/events/${e.id}/decision`, { action: 'APPROVE' })).status).toBe(409);
    expect((await buyer.del(`/api/staff/sourcing/events/${e.id}`)).status).toBe(409); // was submitted once
    expect((await buyer.post(`/api/staff/sourcing/events/${e.id}/cancel`, { reason: '' })).status).toBe(400);
    expect((await buyer.post(`/api/staff/sourcing/events/${e.id}/cancel`, { reason: 'Requirement dropped' })).body.event).toMatchObject({ status: 'CANCELLED', cancelledReason: 'Requirement dropped' });
  });

  test('locked rules, and rules frozen when submitted', async () => {
    const admin = await login('admin@acme.test');
    await admin.put('/api/admin/sourcing', { enabled: true, formats: { rfq: true, reverse: true }, rules: { minStepPct: 1 }, locked: ['minStepPct'] });
    const buyer = await login('buyer@acme.test');
    const e = await readyEvent(buyer, 300000);
    expect((await buyer.patch(`/api/staff/sourcing/events/${e.id}`, { ruleChoices: { minStepPct: 2 } })).body.error).toMatch(/set by your administrator/);
    expect((await buyer.post(`/api/staff/sourcing/events/${e.id}/submit`)).body.event.rules.minStepPct).toBe(1);
    await admin.put('/api/admin/sourcing', { enabled: true, formats: { rfq: true, reverse: true }, rules: { minStepPct: 3 }, locked: ['minStepPct'] });
    expect((await buyer.get(`/api/staff/sourcing/events/${e.id}`)).body.event.rules.minStepPct).toBe(1);
    await admin.put('/api/admin/sourcing', { enabled: true, formats: { rfq: true, reverse: true } });
  });

  test('approval flow is configurable like the onboarding flow', async () => {
    const admin = await login('admin@acme.test');
    const setup = (await admin.get('/api/admin/sourcing')).body.approval;
    expect(setup.levels.map((l: any) => l.label)).toEqual(['Finance approval', 'Senior management approval']);
    expect(setup.catalog.map((c: any) => c.id)).toEqual(['event.estimatedValue', 'event.format', 'event.category']);
    expect((await admin.put('/api/admin/sourcing/approval', { levels: [{ id: 'x', label: 'Ghost', roleKey: 'NOPE' }] })).body.error).toMatch(/role that exists/);
    expect((await admin.put('/api/admin/sourcing/approval', { levels: [{ id: 'x', label: 'Odd', roleKey: 'ADMIN', rule: { match: 'all', conditions: [{ field: 'basic.vendorName', op: 'eq', value: 'x' }] } }] })).body.error).toMatch(/unknown field/);
    expect((await (await login('buyer@acme.test')).put('/api/admin/sourcing/approval', { levels: [] })).status).toBe(403);
    // Reverse auctions always need MDM approval; nothing else does.
    const r = await admin.put('/api/admin/sourcing/approval', { levels: [{ id: 'ra', label: 'Auction approval', roleKey: 'MDM_MANAGER', rule: { match: 'all', conditions: [{ field: 'event.format', op: 'eq', value: 'Reverse auction' }] } }] });
    expect(r.status).toBe(200);
    // Saving the other settings keeps the flow.
    await admin.put('/api/admin/sourcing', { enabled: true, formats: { rfq: true, reverse: true } });
    const buyer = await login('buyer@acme.test');
    expect((await buyer.post(`/api/staff/sourcing/events/${(await readyEvent(buyer, 90_000_000)).id}/submit`)).body.status).toBe('APPROVED');
    expect((await buyer.post(`/api/staff/sourcing/events/${(await readyEvent(buyer, 100, 'reverse')).id}/submit`)).body.levels).toEqual(['Auction approval']);
    await db.update(schema.tenants).set({ settings: { ...acme.settings, sourcing: { ...(await db.query.tenants.findFirst({ where: eq(schema.tenants.id, acme.id) }))!.settings.sourcing, approval: undefined } } }).where(eq(schema.tenants.id, acme.id));
  });

  test('templates: save as template, start a new event from it', async () => {
    const buyer = await login('buyer@acme.test');
    const e = await readyEvent(buyer, 700000);
    const tpl = (await buyer.post(`/api/staff/sourcing/events/${e.id}/copy`, { template: true })).body.event;
    expect(tpl.number).toMatch(/^TPL-/);
    expect((await buyer.get('/api/staff/sourcing/events?filter=templates')).body.events.map((x: any) => x.id)).toContain(tpl.id);
    expect((await buyer.get('/api/staff/sourcing/events')).body.events.map((x: any) => x.id)).not.toContain(tpl.id);
    expect((await buyer.post(`/api/staff/sourcing/events/${tpl.id}/submit`)).status).toBe(400);
    const fresh = (await buyer.post('/api/staff/sourcing/events', { fromTemplate: tpl.id, title: 'Steel — March' })).body.event;
    expect(fresh).toMatchObject({ title: 'Steel — March', format: 'rfq', isTemplate: false });
    expect(fresh.number).toMatch(/^RFQ-/);
    expect((await buyer.get(`/api/staff/sourcing/events/${fresh.id}`)).body.lots.map((l: any) => l.lines.length)).toEqual([2, 1]);
  });

  test('event terms are agreements used for sourcing, not asked during onboarding', async () => {
    const admin = await login('admin@acme.test');
    const ag = (await admin.post('/api/agreements', { title: 'e-Auction terms', purpose: 'sourcing', kind: 'TEXT', body: 'Bids are binding for 90 days. The lowest compliant bid wins unless stated otherwise.' })).body;
    expect(ag.purpose).toBe('sourcing');
    expect((await agreementsFor({ id: '-', tenantId: acme.id, vendorType: 'DOMESTIC', status: 'IN_PROGRESS', decidedAt: null })).map((a) => a.agreement.id)).not.toContain(ag.id);
    const buyer = await login('buyer@acme.test');
    expect((await buyer.get('/api/staff/sourcing/setup')).body.terms.map((t: any) => t.id)).toContain(ag.id);
    const e = (await buyer.post('/api/staff/sourcing/events', { title: 'With terms', format: 'rfq', termsAgreementId: ag.id, termsNote: 'Delivery to Pune plant.' })).body.event;
    expect((await buyer.get(`/api/staff/sourcing/events/${e.id}`)).body.terms).toMatchObject({ title: 'e-Auction terms' });
    const onboardingAg = await db.query.agreements.findFirst({ where: and(eq(schema.agreements.tenantId, acme.id), eq(schema.agreements.purpose, 'onboarding')) });
    if (onboardingAg) expect((await buyer.post('/api/staff/sourcing/events', { title: 'Wrong terms', format: 'rfq', termsAgreementId: onboardingAg.id })).status).toBe(400);
  });
});
