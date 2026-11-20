/** Shared set-up for the sourcing tests: an approved event with bidders who accepted. */
import { expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { login, portalAs } from './helpers.js';
import { db, schema } from '../src/lib/db.js';

export const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
export const closeBidding = (eventId: string) => db.update(schema.sourcingEvents).set({ bidDeadline: new Date(Date.now() - 60_000) }).where(eq(schema.sourcingEvents.id, eventId));
export const lastMail = (to: string) => db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, to), orderBy: (m, { desc }) => desc(m.createdAt) });

/** An approved event; `names` become outside bidders, `suppliers` (vendor ids) approved suppliers; all accept. */
export async function eventWithBidders(body: Record<string, unknown>, lots: unknown[], names: string[], suppliers: string[] = []) {
  const buyer = await login('buyer@acme.test');
  const e = (await buyer.post('/api/staff/sourcing/events', body)).body.event;
  expect((await buyer.put(`/api/staff/sourcing/events/${e.id}/items`, { lots })).status).toBe(200);
  const sub = await buyer.post(`/api/staff/sourcing/events/${e.id}/submit`);
  expect(sub.body.status, JSON.stringify(sub.body)).toBe('APPROVED');
  const portals: Record<string, Awaited<ReturnType<typeof portalAs>>> = {};
  const emails: Record<string, string> = {};
  for (const n of names) {
    const email = `${n.toLowerCase()}+${Date.now()}@bid.test`;
    const r = await buyer.post(`/api/staff/sourcing/events/${e.id}/outside-bidders`, { name: `${n} ${Date.now()}`, vendorType: 'IMPORT', contactFirstName: n, contactLastName: 'Test', contactEmail: email, contactMobile: '+44 7700 900123' });
    portals[n] = await portalAs(r.body.bidders[r.body.bidders.length - 1].vendor.id);
    emails[n] = email;
  }
  if (suppliers.length) await buyer.post(`/api/staff/sourcing/events/${e.id}/bidders`, { vendorIds: suppliers });
  for (const id of suppliers) {
    const v = (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) }))!;
    portals[v.name] = await portalAs(id);
    emails[v.name] = v.contactEmail;
  }
  await buyer.post(`/api/staff/sourcing/events/${e.id}/invitations`);
  for (const [n, c] of Object.entries(portals)) {
    if (names.includes(n)) await c.post('/api/vendor/bidder-registration', { supplies: 'Goods' });
    expect((await c.post(`/api/vendor/events/${e.id}/response`, { accept: true, noConflict: true })).body.me.status).toBe('ACCEPTED');
  }
  return { e, buyer, portals, emails };
}
