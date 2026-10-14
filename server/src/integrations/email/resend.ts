/**
 * Resend extras: delivery / bounce / complaint webhooks (signed with Svix) and own sending domains (Domains API).
 */
import crypto from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../../lib/db.js';
import { env } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../lib/audit.js';
import { HttpError } from '../../lib/http.js';

/* ---------- Webhooks ---------- */

/** Svix signature check: v1 = base64(HMAC-SHA256(secret, "id.timestamp.body")); timestamps older than 5 minutes are refused. */
export function verifySvix(headers: Record<string, string | string[] | undefined>, body: string, secret: string, now = Date.now()) {
  const id = String(headers['svix-id'] ?? ''), ts = String(headers['svix-timestamp'] ?? ''), sig = String(headers['svix-signature'] ?? '');
  if (!id || !ts || !sig) return false;
  if (Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return sig.split(' ').some((part) => { const [, v] = part.split(','); return !!v && v.length === expected.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected)); });
}

interface ResendEvent { type: string; created_at?: string; data: { email_id?: string; to?: string[]; bounce?: { type?: string; subType?: string; message?: string } } }

export async function suppress(address: string, reason: 'BOUNCE' | 'COMPLAINT', detail: string, tenantId: string | null) {
  const a = address.trim().toLowerCase();
  await db.insert(schema.emailSuppressions).values({ address: a, reason, detail: detail.slice(0, 300), tenantId }).onConflictDoNothing();
  // Flag every supplier whose contact is this address, so staff can ask for a new one.
  await db.update(schema.vendors).set({ emailBouncedAt: new Date(), emailBounceReason: reason === 'COMPLAINT' ? 'Marked our email as spam' : detail.slice(0, 200) || 'Email bounced' })
    .where(sql`lower(${schema.vendors.contactEmail}) = ${a}`);
}

export async function handleResendEvent(e: ResendEvent) {
  const msgId = e.data?.email_id;
  const row = msgId ? await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.providerMessageId, msgId) }) : undefined;
  const to = row?.to ?? e.data?.to?.[0];
  const at = e.created_at ? new Date(e.created_at) : new Date();
  switch (e.type) {
    case 'email.delivered':
      if (row) await db.update(schema.emailOutbox).set({ deliveredAt: at }).where(eq(schema.emailOutbox.id, row.id));
      return 'delivered';
    case 'email.bounced': {
      const permanent = !e.data.bounce?.type || /permanent|hard/i.test(e.data.bounce.type);
      if (row) await db.update(schema.emailOutbox).set({ bouncedAt: at, bounceType: permanent ? 'PERMANENT' : 'TRANSIENT', error: (e.data.bounce?.message ?? 'Bounced').slice(0, 500) }).where(eq(schema.emailOutbox.id, row.id));
      if (permanent && to) {
        await suppress(to, 'BOUNCE', e.data.bounce?.message ?? 'Address does not accept email', row?.tenantId ?? null);
        if (row?.tenantId) await audit({ tenantId: row.tenantId, actor: 'Email provider', action: 'EMAIL_BOUNCED', detail: { to: to.replace(/^(.).*(@.*)$/, '$1***$2'), subject: row.subject } });
      }
      return permanent ? 'bounced' : 'soft-bounce';
    }
    case 'email.complained':
      if (row) await db.update(schema.emailOutbox).set({ complainedAt: at }).where(eq(schema.emailOutbox.id, row.id));
      if (to) {
        await suppress(to, 'COMPLAINT', 'Recipient marked the email as spam', row?.tenantId ?? null);
        if (row?.tenantId) await audit({ tenantId: row.tenantId, actor: 'Email provider', action: 'EMAIL_COMPLAINT', detail: { to: to.replace(/^(.).*(@.*)$/, '$1***$2'), subject: row.subject } });
      }
      return 'complained';
    default:
      return 'ignored';
  }
}

/** Remove an address from the suppression list (e.g. the supplier fixed their mailbox) and clear the vendor flag. */
export async function unsuppress(address: string, tenantId: string) {
  const a = address.trim().toLowerCase();
  await db.delete(schema.emailSuppressions).where(eq(schema.emailSuppressions.address, a));
  await db.update(schema.vendors).set({ emailBouncedAt: null, emailBounceReason: null }).where(and(eq(schema.vendors.tenantId, tenantId), sql`lower(${schema.vendors.contactEmail}) = ${a}`));
}

/* ---------- Own sending domains (Resend Domains API) ---------- */

type Record_ = { type: string; name: string; value: string; priority?: number; status?: string };
export interface DomainState { providerId: string; name: string; status: 'pending' | 'verified' | 'failed'; records: Record_[] }

let fetchImpl: typeof fetch = (...a) => fetch(...a);
/** Tests. */
export function setResendFetch(f: typeof fetch) { fetchImpl = f; }

async function call(path: string, init: RequestInit = {}) {
  const key = env.int.RESEND_API_KEY;
  if (env.int.EMAIL_PROVIDER !== 'resend' || !key) throw new HttpError(409, 'Own sending domains need the Resend email provider (EMAIL_PROVIDER=resend)');
  const res = await fetchImpl(`https://api.resend.com${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
  const body = await res.json().catch(() => ({})) as Record<string, any>;
  if (!res.ok) { logger.warn({ path, status: res.status, body }, 'resend domains call failed'); throw new HttpError(502, `Email provider: ${body.message ?? `HTTP ${res.status}`}`); }
  return body;
}
const toState = (b: Record<string, any>): DomainState => ({
  providerId: String(b.id), name: String(b.name),
  status: b.status === 'verified' ? 'verified' : b.status === 'failed' ? 'failed' : 'pending',
  records: (b.records ?? []).map((r: Record<string, any>) => ({ type: String(r.type ?? r.record), name: String(r.name), value: String(r.value), priority: r.priority ?? undefined, status: r.status ?? undefined })),
});

export const createDomain = async (name: string) => toState(await call('/domains', { method: 'POST', body: JSON.stringify({ name }) }));
export async function checkDomain(providerId: string) {
  await call(`/domains/${encodeURIComponent(providerId)}/verify`, { method: 'POST' }).catch(() => {});
  return toState(await call(`/domains/${encodeURIComponent(providerId)}`));
}
export const deleteDomain = async (providerId: string) => { await call(`/domains/${encodeURIComponent(providerId)}`, { method: 'DELETE' }); };
