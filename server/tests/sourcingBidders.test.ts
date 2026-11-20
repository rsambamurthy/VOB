/** Sourcing step 2: choosing bidders, outside bidders, invitations, accept/decline with terms and declaration, clarifications. */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { lastLinkTo, login, portalAs } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import type { Tenant } from '../src/db/schema.js';

let acme: Tenant;
let original: Pick<Tenant, 'settings' | 'limits'>;
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const portal = portalAs;
const lastMail = (to: string) => db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, to), orderBy: desc(schema.emailOutbox.createdAt) });

let eventId = '';
let precisionId = '';
let termsVersion = 0;

beforeAll(async () => {
  acme = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;
  original = { settings: acme.settings, limits: acme.limits };
  await db.update(schema.tenants).set({ limits: { features: { sourcing: true } } }).where(eq(schema.tenants.id, acme.id));
  const admin = await login('admin@acme.test');
  await admin.put('/api/admin/sourcing', { enabled: true, formats: { rfq: true, reverse: true } });
  await admin.put('/api/admin/sourcing/approval', { levels: [] }); // approved straight away in these tests
  const ag = (await admin.post('/api/agreements', { title: 'RFQ terms', purpose: 'sourcing', kind: 'TEXT', body: 'Prices are firm for 90 days and include delivery to the plant.' })).body;
  termsVersion = 1;
  precisionId = (await db.query.vendors.findFirst({ where: and(eq(schema.vendors.tenantId, acme.id), eq(schema.vendors.name, 'Precision Valves Pvt Ltd')) }))!.id;
  const buyer = await login('buyer@acme.test');
  const e = (await buyer.post('/api/staff/sourcing/events', { title: 'Gate valves 2026', format: 'rfq', estimatedValue: 800000, category: 'Goods', bidDeadline: inHours(96), termsAgreementId: ag.id })).body.event;
  await buyer.put(`/api/staff/sourcing/events/${e.id}/items`, { lots: [{ title: 'Valves', lines: [{ description: 'Gate valve DN50', quantity: 40, unit: 'Nos', targetPrice: 5200 }], reservePrice: 190000 }] });
  eventId = e.id;
});
afterAll(async () => { await db.update(schema.tenants).set(original).where(eq(schema.tenants.id, acme.id)); });

describe('sourcing bidders', () => {
  test('suggestions: approved suppliers, same category first; only approved suppliers can be picked', async () => {
    const buyer = await login('buyer@acme.test');
    const s = (await buyer.get(`/api/staff/sourcing/events/${eventId}/suggestions`)).body.suppliers;
    expect(s[0]).toMatchObject({ categoryMatch: true });
    expect(s.find((x: any) => x.id === precisionId)).toMatchObject({ name: 'Precision Valves Pvt Ltd', category: 'Goods', invited: false });
    const notApproved = await db.query.vendors.findFirst({ where: and(eq(schema.vendors.tenantId, acme.id), eq(schema.vendors.status, 'UNDER_REVIEW')) });
    expect((await buyer.post(`/api/staff/sourcing/events/${eventId}/bidders`, { vendorIds: [notApproved!.id] })).body.error).toMatch(/isn’t an approved supplier/);
    const r = await buyer.post(`/api/staff/sourcing/events/${eventId}/bidders`, { vendorIds: [precisionId, precisionId] });
    expect(r.body.added).toBe(1);
    expect(r.body.bidders).toEqual([expect.objectContaining({ alias: 'Bidder 1', status: 'INVITED', sentAt: null, outside: false })]);
    expect((await buyer.get(`/api/staff/sourcing/events/${eventId}/suggestions`)).body.suppliers.find((x: any) => x.id === precisionId).invited).toBe(true);
  });

  test('outside bidders are created as bidder-only suppliers; existing companies are refused', async () => {
    const buyer = await login('buyer@acme.test');
    expect((await buyer.post(`/api/staff/sourcing/events/${eventId}/outside-bidders`, { name: 'Precision Valves Pvt Ltd', vendorType: 'DOMESTIC', contactFirstName: 'A', contactLastName: 'B', contactEmail: 'x@y.test', contactMobile: '9800033344' })).body.error).toMatch(/already in VendorGate/);
    const r = await buyer.post(`/api/staff/sourcing/events/${eventId}/outside-bidders`, { name: 'Gulf Flow Controls FZE', vendorType: 'IMPORT', contactFirstName: 'Omar', contactLastName: 'Saeed', contactEmail: 'omar@gulfflow.test', contactMobile: '+971 50 123 4567' });
    expect(r.status).toBe(201);
    const b = r.body.bidders.find((x: any) => x.outside);
    expect(b).toMatchObject({ alias: 'Bidder 2', vendor: { name: 'Gulf Flow Controls FZE', bidderOnly: true, registered: false } });
    // No onboarding invitation was sent.
    expect(await lastLinkTo('omar@gulfflow.test')).toBeUndefined();
  });

  test('invitations go once the event is approved; the event becomes Published', async () => {
    const buyer = await login('buyer@acme.test');
    expect((await buyer.post(`/api/staff/sourcing/events/${eventId}/invitations`)).body.error).toMatch(/once the event is approved/);
    expect((await buyer.post(`/api/staff/sourcing/events/${eventId}/submit`)).body.status).toBe('APPROVED');
    const r = await buyer.post(`/api/staff/sourcing/events/${eventId}/invitations`);
    expect(r.body).toMatchObject({ sent: 2, event: { status: 'PUBLISHED' } });
    const mail = await lastMail('omar@gulfflow.test');
    expect(mail!.subject).toMatch(/invitation to request for quotation RFQ-/);
    expect(mail!.body).toContain('Bids close on');
    expect(mail!.link).toContain('/onboard/');
    expect((await buyer.post(`/api/staff/sourcing/events/${eventId}/invitations`)).body.error).toMatch(/Everyone on the list has been invited/);
  });

  test('the bidder sees the event without the buyer’s estimate, targets or other bidders; accepts with terms and declaration', async () => {
    const c = await portal(precisionId);
    expect((await c.get('/api/vendor')).body.sourcing).toMatchObject({ invitations: 1, bidderOnly: false });
    const list = (await c.get('/api/vendor/events')).body.events;
    expect(list).toEqual([expect.objectContaining({ id: eventId, myStatus: 'INVITED', open: true })]);
    const d = await c.get(`/api/vendor/events/${eventId}`);
    const text = JSON.stringify(d.body);
    expect(text).not.toMatch(/800000|5200|190000|Gulf Flow|estimatedValue|reservePrice|targetPrice/);
    expect(d.body.terms).toMatchObject({ title: 'RFQ terms', version: termsVersion });
    expect(d.body.me).toMatchObject({ alias: 'Bidder 1', status: 'INVITED' });

    expect((await c.post(`/api/vendor/events/${eventId}/response`, { accept: true, noConflict: true })).body.error).toMatch(/accept the event terms/);
    expect((await c.post(`/api/vendor/events/${eventId}/response`, { accept: true, termsVersion })).body.error).toMatch(/conflict of interest/);
    const ok = await c.post(`/api/vendor/events/${eventId}/response`, { accept: true, termsVersion, noConflict: true });
    expect(ok.body.me).toMatchObject({ status: 'ACCEPTED', declaration: { acceptedTermsVersion: 1, noConflict: true } });
    expect((await lastMail('buyer@acme.test'))!.subject).toMatch(/Precision Valves Pvt Ltd accepted RFQ-/);
    // Arabic error messages for suppliers.
    const ar = await c.agent.post(`/api/vendor/events/${eventId}/response`).set('X-Requested-With', 'fetch').set('X-Lang', 'ar').send({ accept: false });
    expect(ar.body.error).toBe('أخبروا المشتري بسبب الاعتذار.');
  });

  test('outside bidder registers first, then accepts; duplicates are shown to the buyer', async () => {
    const omar = (await db.query.vendors.findFirst({ where: eq(schema.vendors.contactEmail, 'omar@gulfflow.test') }))!;
    const c = await portal(omar.id);
    expect((await c.get('/api/vendor')).body.sourcing).toMatchObject({ bidderOnly: true, registered: false });
    expect((await c.post(`/api/vendor/events/${eventId}/response`, { accept: true, termsVersion, noConflict: true })).body.error).toMatch(/bidder registration first/);
    expect((await c.post('/api/vendor/bidder-registration', { supplies: '' })).status).toBe(400);
    expect((await c.post('/api/vendor/bidder-registration', { website: 'https://gulfflow.test', supplies: 'Industrial valves and actuators' })).status).toBe(200);
    expect((await c.get('/api/vendor/events')).body.bidder).toMatchObject({ bidderOnly: true, registered: true });
    expect((await c.post(`/api/vendor/events/${eventId}/response`, { accept: true, termsVersion, conflictNote: 'Our director is related to a buyer at Acme.' })).body.me.status).toBe('ACCEPTED');
    expect((await lastMail('buyer@acme.test'))!.body).toContain('possible conflict of interest');
    const staff = (await (await login('buyer@acme.test')).get(`/api/staff/sourcing/events/${eventId}`)).body;
    expect(staff.bidders.find((b: any) => b.outside)).toMatchObject({ status: 'ACCEPTED', vendor: { registered: true }, declaration: { conflictNote: 'Our director is related to a buyer at Acme.' } });
    const v = (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, omar.id) }))!;
    expect((v.profile as any).basic.itemsSupplied).toBe('Industrial valves and actuators');
  });

  test('clarifications: a question is private until answered, then everyone sees it without who asked', async () => {
    const precision = await portal(precisionId);
    const omar = await portal((await db.query.vendors.findFirst({ where: eq(schema.vendors.contactEmail, 'omar@gulfflow.test') }))!.id);
    expect((await precision.post(`/api/vendor/events/${eventId}/questions`, { question: 'Is PN16 rating acceptable?' })).status).toBe(201);
    expect((await lastMail('buyer@acme.test'))!.subject).toMatch(/Question on RFQ-.* from Precision Valves/);
    expect((await omar.get(`/api/vendor/events/${eventId}`)).body.questions).toEqual([]);
    expect((await precision.get(`/api/vendor/events/${eventId}`)).body.questions).toEqual([expect.objectContaining({ question: 'Is PN16 rating acceptable?', answer: null, mine: true })]);

    const buyer = await login('buyer@acme.test');
    const q = (await buyer.get(`/api/staff/sourcing/events/${eventId}`)).body.questions[0];
    expect(q.askedBy).toBe('Precision Valves Pvt Ltd (Bidder 1)');
    const r = await buyer.post(`/api/staff/sourcing/events/${eventId}/clarifications`, { questionId: q.id, answer: 'PN16 is the minimum; PN25 is also accepted.' });
    expect(r.body.told).toBe(2);
    expect((await lastMail('omar@gulfflow.test'))!.subject).toMatch(/new clarification/);
    const seen = (await omar.get(`/api/vendor/events/${eventId}`)).body.questions;
    expect(seen).toEqual([expect.objectContaining({ question: 'Is PN16 rating acceptable?', answer: 'PN16 is the minimum; PN25 is also accepted.', mine: false })]);
    expect(JSON.stringify(seen)).not.toContain('Precision');
    await buyer.post(`/api/staff/sourcing/events/${eventId}/clarifications`, { answer: 'Site visit on Monday at 10:00.' });
    expect((await omar.get(`/api/vendor/events/${eventId}`)).body.questions).toHaveLength(2);
  });

  test('decline, and withdrawing an invitation', async () => {
    const omarId = (await db.query.vendors.findFirst({ where: eq(schema.vendors.contactEmail, 'omar@gulfflow.test') }))!.id;
    const omar = await portal(omarId);
    expect((await omar.post(`/api/vendor/events/${eventId}/response`, { accept: false, declineReason: 'No capacity this quarter' })).body.me.status).toBe('DECLINED');
    const buyer = await login('buyer@acme.test');
    const b = (await buyer.get(`/api/staff/sourcing/events/${eventId}`)).body.bidders.find((x: any) => x.outside);
    expect(b).toMatchObject({ status: 'DECLINED', declineReason: 'No capacity this quarter' });
    expect((await buyer.del(`/api/staff/sourcing/events/${eventId}/bidders/${b.id}`)).body.bidders.find((x: any) => x.id === b.id).status).toBe('REMOVED');
    expect((await lastMail('omar@gulfflow.test'))!.subject).toMatch(/withdrawn/);
    expect((await omar.get('/api/vendor/events')).body.events).toEqual([]);
    expect((await omar.get(`/api/vendor/events/${eventId}`)).status).toBe(404);
  });

  test('another supplier can’t open the event; Sourcing off hides it from the portal', async () => {
    const other = (await db.query.vendors.findFirst({ where: and(eq(schema.vendors.tenantId, acme.id), eq(schema.vendors.status, 'UNDER_REVIEW')) }))!;
    const c = await portal(other.id);
    expect((await c.get(`/api/vendor/events/${eventId}`)).status).toBe(404);
    const admin = await login('admin@acme.test');
    await admin.put('/api/admin/sourcing', { enabled: false, formats: { rfq: true } });
    const p = await portal(precisionId);
    expect((await p.get('/api/vendor/events')).status).toBe(404);
    expect((await p.get('/api/vendor')).body.sourcing).toBeNull();
  });
});
