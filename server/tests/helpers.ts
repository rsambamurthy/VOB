import request from 'supertest';
import { desc, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, schema } from '../src/lib/db.js';
import { DEMO_PASSWORD } from '../src/db/seed.js';

export const app = createApp();
export { DEMO_PASSWORD };

/** A cookie-keeping client that always sends the CSRF header. */
export function client() {
  const agent = request.agent(app);
  const h = { 'X-Requested-With': 'fetch' };
  return {
    agent,
    get: (url: string) => agent.get(url).set(h),
    post: (url: string, body?: object) => agent.post(url).set(h).send(body ?? {}),
    put: (url: string, body?: object) => agent.put(url).set(h).send(body ?? {}),
    patch: (url: string, body?: object) => agent.patch(url).set(h).send(body ?? {}),
    del: (url: string) => agent.delete(url).set(h),
    upload: (url: string, docType: string, content = '%PDF-1.4\n%%EOF', name = 'doc.pdf', type = 'application/pdf') =>
      agent.post(url).set(h).field('docType', docType).attach('file', Buffer.from(content), { filename: name, contentType: type }),
  };
}

export async function login(email: string, workspace = 'acme', password = DEMO_PASSWORD) {
  const c = client();
  const r = await c.post('/api/auth/login', { workspace, email, password });
  if (r.status !== 200) throw new Error(`login ${email} failed: ${r.status} ${JSON.stringify(r.body)}`);
  return c;
}

/** Latest email link sent to an address (the dev outbox stands in for a mailbox). */
export async function lastLinkTo(to: string) {
  const m = await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, to), orderBy: desc(schema.emailOutbox.createdAt) });
  return m?.link ?? undefined;
}

export const pathOf = (link: string) => new URL(link).pathname;
export const tokenOf = (link: string) => new URL(link).pathname.split('/').pop()!;
