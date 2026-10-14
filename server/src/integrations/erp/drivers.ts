/**
 * ERP connectors. Each builds exactly what it would send (stored on the sync row, minus secrets)
 * and, unless the workspace is in test mode, sends it.
 *
 *  oracle  — POST the Oracle EBS supplier payload (ERPVendorsData) to a REST endpoint
 *            (e.g. an Integrated SOA Gateway / middleware service), Basic auth.
 *  webhook — POST a signed JSON event to any URL. Signature: HMAC-SHA256 over "<timestamp>.<body>".
 *  csv     — one CSV file per event, kept for download or uploaded over SFTP.
 */
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import type { Vendor } from '../../db/schema.js';
import { env } from '../../lib/env.js';
import { CSV_COLUMNS, toCsv, toCsvRow, toGenericVendor, toOracleSupplier } from '../../lib/erpMapper.js';
import { sapSend, sapTest } from './sap.js';
import { dynamicsSend, dynamicsTest } from './dynamics.js';

export type ErpKind = 'none' | 'oracle' | 'webhook' | 'csv' | 'sap' | 'dynamics';
export type ErpEvent = 'CREATE' | 'UPDATE' | 'BLOCK' | 'UNBLOCK' | 'MANUAL';

export interface Connection {
  kind: ErpKind; testMode: boolean; autoPush: boolean;
  config: Record<string, string>;
  secrets: Record<string, string>;
}
export interface SendResult {
  target: string;
  request: { body?: unknown; csv?: string; fileName?: string; headers?: Record<string, string> };
  httpStatus?: number; response?: string; erpVendorId?: string | null;
}

/** Which secret fields each connector takes (stored encrypted, never returned to the browser). */
export const SECRET_FIELDS: Record<ErpKind, string[]> = { none: [], oracle: ['password'], webhook: ['signingSecret'], csv: ['password'], sap: ['password'], dynamics: ['clientSecret'] };

export const WEBHOOK_EVENTS: Record<ErpEvent, string> = { CREATE: 'vendor.approved', UPDATE: 'vendor.updated', BLOCK: 'vendor.blocked', UNBLOCK: 'vendor.unblocked', MANUAL: 'vendor.synced' };

export class ErpError extends Error {
  constructor(message: string, public httpStatus?: number, public response?: string) { super(message); }
}

/* ---------- outbound safety ---------- */

function privateIp(ip: string) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:127.') || x.startsWith('::ffff:10.') || x.startsWith('::ffff:192.168.');
}

/** In production, only https and only public addresses (unless ERP_ALLOW_PRIVATE_HOSTS=true for on-prem ERPs). */
export async function assertSafeTarget(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ErpError('The ERP URL is not a valid address'); }
  if (!['https:', 'http:'].includes(u.protocol)) throw new ErpError('The ERP URL must start with https://');
  if (!env.isProd) return u;
  if (u.protocol !== 'https:') throw new ErpError('The ERP URL must use https:// in production');
  if (env.int.ERP_ALLOW_PRIVATE_HOSTS === 'true') return u;
  const addrs = net.isIP(u.hostname) ? [u.hostname] : (await dns.lookup(u.hostname, { all: true })).map((a) => a.address);
  if (addrs.some(privateIp)) throw new ErpError('The ERP URL points to a private network address. Set ERP_ALLOW_PRIVATE_HOSTS=true if your ERP is on-premises.');
  return u;
}

export const post = (url: string, body: string, headers: Record<string, string>) => request('POST', url, body, headers);

let fetchImpl: typeof fetch = (...a) => fetch(...a);
/** Tests: replace the network. */
export function setErpFetch(f?: typeof fetch) { fetchImpl = f ?? ((...a) => fetch(...a)); }

export async function request(method: string, url: string, body: string | undefined, headers: Record<string, string>) {
  await assertSafeTarget(url);
  let res: Response;
  try {
    res = await fetchImpl(url, { method, body, headers, redirect: 'manual', signal: AbortSignal.timeout(env.int.ERP_TIMEOUT_MS) });
  } catch (e: any) {
    throw new ErpError(e?.name === 'TimeoutError' ? `No response from the ERP within ${Math.round(env.int.ERP_TIMEOUT_MS / 1000)} s` : `Couldn’t reach the ERP: ${e?.cause?.code ?? e?.message ?? e}`);
  }
  const text = (await res.text().catch(() => '')).slice(0, 4000);
  if (!res.ok) throw new ErpError(`The ERP answered ${res.status} ${res.statusText}${erpMessage(text)}`.trim(), res.status, text);
  return { status: res.status, text, headers: res.headers };
}

/** Pull a readable message out of an OData / JSON error body. */
function erpMessage(text: string) {
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message?.value ?? j?.error?.message ?? j?.message ?? j?.error_description;
    return typeof m === 'string' && m ? `: ${m.slice(0, 300)}` : '';
  } catch { return ''; }
}

/** GET JSON from the ERP (purchase order pull), with the connection's Basic auth. */
export async function getJson(url: string, conn: Connection): Promise<unknown> {
  await assertSafeTarget(url);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (conn.config.username) headers.Authorization = `Basic ${Buffer.from(`${conn.config.username}:${conn.secrets.password ?? ''}`).toString('base64')}`;
  let res: Response;
  try { res = await fetchImpl(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(env.int.ERP_TIMEOUT_MS * 3) }); }
  catch (e: any) { throw new ErpError(e?.name === 'TimeoutError' ? 'No response from the ERP in time' : `Couldn’t reach the ERP: ${e?.cause?.code ?? e?.message ?? e}`); }
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new ErpError(`The ERP answered ${res.status} ${res.statusText}`.trim(), res.status, text.slice(0, 4000));
  try { return JSON.parse(text); } catch { throw new ErpError('The ERP answer was not JSON', res.status, text.slice(0, 500)); }
}

/** Find the supplier id the ERP sent back, whatever it calls it. */
export function findVendorId(text: string): string | null {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return null; }
  const keys = ['VENDOR_ID', 'BusinessPartner', 'VendorAccountNumber', 'vendorId', 'vendor_id', 'erpVendorId', 'supplierId', 'SUPPLIER_ID', 'PartyId'];
  const walk = (o: unknown, depth: number): string | null => {
    if (!o || typeof o !== 'object' || depth > 5) return null;
    for (const k of keys) { const v = (o as Record<string, unknown>)[k]; if ((typeof v === 'string' && v.trim()) || typeof v === 'number') return String(v); }
    for (const v of Object.values(o as Record<string, unknown>)) { const r = walk(v, depth + 1); if (r) return r; }
    return null;
  };
  return walk(json, 0);
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
export const csvFileName = (v: Pick<Vendor, 'code'>, event: string, at = new Date()) => `vendor_${v.code}_${event.toLowerCase()}_${stamp(at)}.csv`;
export const actionFor = (v: Pick<Vendor, 'erpVendorId'>, event: ErpEvent) => (event === 'BLOCK' || event === 'UNBLOCK' ? event : v.erpVendorId ? 'UPDATE' : 'CREATE');

/* ---------- send ---------- */

export async function send(conn: Connection, v: Vendor, event: ErpEvent, ctx: { syncId: string; tenantSlug: string; homeCountry?: string }): Promise<SendResult> {
  const c = conn.config;
  if (conn.kind === 'oracle') {
    const body = toOracleSupplier(v, { orgId: c.orgId || undefined, action: v.erpVendorId ? 'UPDATE' : 'CREATE', homeCountry: ctx.homeCountry });
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Idempotency-Key': ctx.syncId };
    const shown = { ...headers, ...(c.username ? { Authorization: 'Basic •••' } : {}) };
    const result: SendResult = { target: c.url, request: { body, headers: shown } };
    if (conn.testMode) return result;
    if (!c.url) throw new ErpError('Set the Oracle endpoint URL first');
    if (c.username) headers.Authorization = `Basic ${Buffer.from(`${c.username}:${conn.secrets.password ?? ''}`).toString('base64')}`;
    const r = await post(c.url, JSON.stringify(body), headers);
    return { ...result, httpStatus: r.status, response: r.text, erpVendorId: findVendorId(r.text) };
  }

  if (conn.kind === 'webhook') {
    const occurredAt = new Date().toISOString();
    const body = { id: ctx.syncId, event: WEBHOOK_EVENTS[event], occurredAt, workspace: ctx.tenantSlug, vendor: toGenericVendor(v) };
    const json = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'User-Agent': 'VendorGate-Webhook/1', 'X-VendorGate-Event': body.event, 'X-VendorGate-Delivery': ctx.syncId, 'X-VendorGate-Timestamp': ts };
    const result: SendResult = { target: c.url, request: { body, headers: { ...headers, 'X-VendorGate-Signature': 'sha256=•••' } } };
    if (conn.testMode) return result;
    if (!c.url) throw new ErpError('Set the webhook URL first');
    if (!conn.secrets.signingSecret) throw new ErpError('Set a signing secret first');
    headers['X-VendorGate-Signature'] = `sha256=${sign(conn.secrets.signingSecret, ts, json)}`;
    const r = await post(c.url, json, headers);
    return { ...result, httpStatus: r.status, response: r.text, erpVendorId: findVendorId(r.text) };
  }

  if (conn.kind === 'csv') {
    const fileName = csvFileName(v, event);
    const csv = toCsv([CSV_COLUMNS, toCsvRow(v, actionFor(v, event))]);
    const sftp = c.delivery === 'sftp';
    const target = sftp ? `sftp://${c.host}${c.port && c.port !== '22' ? `:${c.port}` : ''}${joinDir(c.remoteDir, fileName)}` : 'Kept for download';
    const result: SendResult = { target, request: { csv, fileName } };
    if (conn.testMode || !sftp) return result;
    await sftpPut(conn, joinDir(c.remoteDir, fileName), Buffer.from(csv, 'utf8'));
    return result;
  }
  if (conn.kind === 'sap') return sapSend(conn, v, event, ctx);
  if (conn.kind === 'dynamics') return dynamicsSend(conn, v, event, ctx);
  throw new ErpError('No ERP connection is set up');
}

export const sign = (secret: string, ts: string, body: string) => crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
export const joinDir = (dir: string | undefined, f: string) => `${(dir || '/').replace(/\/?$/, '/')}${f}`;

async function sftpClient(conn: Connection) {
  const c = conn.config;
  if (!c.host || !c.username) throw new ErpError('Set the SFTP host and user name first');
  const { default: Client } = await import('ssh2-sftp-client');
  const client = new Client();
  try {
    await client.connect({ host: c.host, port: Number(c.port || 22), username: c.username, password: conn.secrets.password, readyTimeout: env.int.ERP_TIMEOUT_MS });
  } catch (e: any) { throw new ErpError(`SFTP connection failed: ${e?.message ?? e}`); }
  return client;
}

export async function sftpPut(conn: Connection, path: string, data: Buffer) {
  const client = await sftpClient(conn);
  try { await client.put(data, path); } catch (e: any) { throw new ErpError(`SFTP upload failed: ${e?.message ?? e}`); } finally { await client.end().catch(() => {}); }
}

/** Live connectivity check (does nothing in test mode). */
export async function testConnection(conn: Connection, tenantSlug: string): Promise<{ ok: boolean; message: string }> {
  if (conn.kind === 'none') return { ok: false, message: 'Choose a connector first.' };
  if (conn.testMode) return { ok: true, message: 'Test mode is on, so nothing was sent. Turn test mode off to check the real connection.' };
  const c = conn.config;
  if (conn.kind === 'webhook') {
    if (!c.url || !conn.secrets.signingSecret) return { ok: false, message: 'Enter the URL and signing secret first.' };
    const json = JSON.stringify({ id: crypto.randomUUID(), event: 'ping', occurredAt: new Date().toISOString(), workspace: tenantSlug });
    const ts = String(Math.floor(Date.now() / 1000));
    const r = await post(c.url, json, { 'Content-Type': 'application/json', 'User-Agent': 'VendorGate-Webhook/1', 'X-VendorGate-Event': 'ping', 'X-VendorGate-Timestamp': ts, 'X-VendorGate-Signature': `sha256=${sign(conn.secrets.signingSecret, ts, json)}` });
    return { ok: true, message: `Webhook answered ${r.status}.` };
  }
  if (conn.kind === 'oracle') {
    if (!c.url) return { ok: false, message: 'Enter the endpoint URL first.' };
    await assertSafeTarget(c.url);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (c.username) headers.Authorization = `Basic ${Buffer.from(`${c.username}:${conn.secrets.password ?? ''}`).toString('base64')}`;
    try {
      const res = await fetch(c.url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(env.int.ERP_TIMEOUT_MS) });
      if (res.status === 401 || res.status === 403) return { ok: false, message: `Reached the server, but it refused the credentials (${res.status}).` };
      if (res.status >= 500) return { ok: false, message: `Reached the server, but it returned an error (${res.status}).` };
      return { ok: true, message: `Reached the server (${res.status}). The first real push will confirm the payload is accepted.` };
    } catch (e: any) { return { ok: false, message: `Couldn’t reach the server: ${e?.cause?.code ?? e?.message ?? e}` }; }
  }
  if (conn.kind === 'sap') return sapTest(conn);
  if (conn.kind === 'dynamics') return dynamicsTest(conn);
  if (c.delivery !== 'sftp') return { ok: true, message: 'Files are kept here for download — nothing to connect to.' };
  const client = await sftpClient(conn);
  try { await client.list(c.remoteDir || '/'); return { ok: true, message: `Connected and listed ${c.remoteDir || '/'}.` }; }
  catch (e: any) { return { ok: false, message: `Connected, but couldn’t open ${c.remoteDir || '/'}: ${e?.message ?? e}` }; }
  finally { await client.end().catch(() => {}); }
}
