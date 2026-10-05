import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { approvedVendor, login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import { sign } from '../src/integrations/erp/drivers.js';
import { findVendorId } from '../src/integrations/erp/drivers.js';
import { toCsv } from '../src/lib/erpMapper.js';

/** A tiny stand-in ERP that records what it receives. */
const got: { headers: http.IncomingHttpHeaders; body: string }[] = [];
let reply: { status: number; body: string } = { status: 200, body: '{"vendorId":"ERP-123"}' };
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => { got.push({ headers: req.headers, body }); res.writeHead(reply.status, { 'Content-Type': 'application/json' }); res.end(reply.body); });
});
let url = '';
beforeAll(async () => { await new Promise<void>((r) => server.listen(0, '127.0.0.1', r)); url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`; });
afterAll(async () => {
  const admin = await login('admin@acme.test');
  await admin.put('/api/admin/erp', { kind: 'none', testMode: true, autoPush: true });
  server.close();
});

const syncsOf = (vendorId: string) => db.select().from(schema.erpSyncs).where(eq(schema.erpSyncs.vendorId, vendorId)).orderBy(desc(schema.erpSyncs.createdAt));

describe('ERP push', () => {
  test('settings: permission, secrets are never returned, live mode needs a URL and secret', async () => {
    const admin = await login('admin@acme.test');
    expect((await (await login('tax@acme.test')).get('/api/admin/erp')).status).toBe(403);
    expect((await admin.get('/api/admin/erp')).body.kind).toBe('none');
    expect((await admin.put('/api/admin/erp', { kind: 'webhook', testMode: false, autoPush: true, config: { url } })).status).toBe(400); // no secret
    const r = await admin.put('/api/admin/erp', { kind: 'webhook', testMode: false, autoPush: true, config: { url }, secrets: { signingSecret: 'whsec_test_123' } });
    expect(r.status).toBe(200);
    expect(r.body.secretsSet).toEqual({ signingSecret: true });
    expect(JSON.stringify((await admin.get('/api/admin/erp')).body)).not.toContain('whsec_test_123');
    // saving again without the secret keeps it
    expect((await admin.put('/api/admin/erp', { kind: 'webhook', testMode: false, autoPush: true, config: { url } })).body.secretsSet.signingSecret).toBe(true);
    expect((await admin.post('/api/admin/erp/test')).body).toMatchObject({ ok: true });
    expect(got.at(-1)!.headers['x-vendorgate-event']).toBe('ping');
  });

  test('webhook: approval pushes a signed event and stores the ERP id; block pushes the hold', async () => {
    got.length = 0; reply = { status: 200, body: '{"result":{"vendorId":"ERP-123"}}' };
    const { id, admin } = await approvedVendor('ERP Webhook Co', 'erp@hook.test');
    expect(got).toHaveLength(1);
    const h = got[0].headers;
    expect(h['x-vendorgate-event']).toBe('vendor.approved');
    expect(h['x-vendorgate-signature']).toBe(`sha256=${sign('whsec_test_123', String(h['x-vendorgate-timestamp']), got[0].body)}`);
    const body = JSON.parse(got[0].body);
    expect(body.vendor).toMatchObject({ name: 'ERP Webhook Co', status: 'ACTIVE', blocked: false, bank: { ifsc: 'HDFC0000001' } });
    const v = await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) });
    expect(v).toMatchObject({ erpVendorId: 'ERP-123', erpSyncStatus: 'SYNCED' });

    await (await login('mdm@acme.test')).post(`/api/staff/vendors/${id}/block`, { reason: 'Test hold' });
    expect(got.at(-1)!.headers['x-vendorgate-event']).toBe('vendor.blocked');
    expect(JSON.parse(got.at(-1)!.body).vendor).toMatchObject({ blocked: true, blockedReason: 'Test hold', erpVendorId: 'ERP-123' });
    const erp = (await admin.get(`/api/staff/vendors/${id}/erp`)).body;
    expect(erp.deliveries.map((d: any) => d.event)).toEqual(['BLOCK', 'CREATE']);
    expect(erp.deliveries.every((d: any) => d.status === 'SENT')).toBe(true);
  });

  test('failures are recorded, the team is emailed, and retry works', async () => {
    const { id } = await approvedVendor('ERP Retry Co', 'erp@retry.test');
    const mdm = await login('mdm@acme.test');
    reply = { status: 500, body: 'ORA-00001: unique constraint violated' };
    expect((await (await login('tax@acme.test')).post(`/api/staff/vendors/${id}/erp/push`)).status).toBe(403);
    const push = await mdm.post(`/api/staff/vendors/${id}/erp/push`);
    expect(push.status).toBe(202);
    const [failed] = await syncsOf(id);
    expect(failed).toMatchObject({ status: 'FAILED', httpStatus: 500, attempts: 1 });
    expect(failed.error).toMatch(/500/);
    expect(failed.response).toContain('ORA-00001');
    const mail = await db.query.emailOutbox.findFirst({ where: eq(schema.emailOutbox.to, 'mdm@acme.test'), orderBy: desc(schema.emailOutbox.createdAt) });
    expect(mail?.subject).toBe('ERP push failed: ERP Retry Co');
    expect((await mdm.get('/api/staff/erp/deliveries?status=FAILED')).body.map((d: any) => d.id)).toContain(failed.id);

    reply = { status: 201, body: '{"VENDOR_ID": 777}' };
    const retried = await mdm.post(`/api/staff/erp/deliveries/${failed.id}/retry`);
    expect(retried.body).toMatchObject({ status: 'SENT', attempts: 2, erpVendorId: '777' });
    expect((await mdm.post(`/api/staff/erp/deliveries/${failed.id}/retry`)).status).toBe(409);
  });

  test('Oracle in test mode records the payload, sends nothing and never stores a fake ERP id', async () => {
    const admin = await login('admin@acme.test');
    await admin.put('/api/admin/erp', { kind: 'oracle', testMode: true, autoPush: true, config: { url: 'https://erp.example.com/webservices/rest/supplier', username: 'ISG_USER', orgId: '204' }, secrets: { password: 's3cret' } });
    got.length = 0;
    const { id } = await approvedVendor('ERP Oracle Co', 'erp@oracle.test');
    expect(got).toHaveLength(0);
    const [s] = await syncsOf(id);
    expect(s).toMatchObject({ status: 'TEST', kind: 'oracle', event: 'CREATE' });
    const data = (s.request as any).body.ERPVendorsData.VENDOR.VENDOR_DATA;
    expect(data).toMatchObject({ SYNC_ACTION: 'CREATE', VENDOR_ID: '', VENDOR_NAME: 'ERP Oracle Co' });
    expect(data.VENDOR_SITES.SITE_DATA[0].ORG_ID).toBe('204');
    expect((s.request as any).headers.Authorization).toBe('Basic •••');
    expect(JSON.stringify(s.request)).not.toContain('s3cret');
    const v = await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) });
    expect(v).toMatchObject({ erpVendorId: null, erpSyncStatus: 'TEST' });
    const preview = (await admin.get(`/api/admin/erp/preview?vendorId=${id}`)).body;
    expect(preview.request.body.ERPVendorsData.VENDOR.VENDOR_DATA.VENDOR_NAME).toBe('ERP Oracle Co');
  });

  test('CSV: files kept for download, bulk export, auto-push off', async () => {
    const admin = await login('admin@acme.test');
    await admin.put('/api/admin/erp', { kind: 'csv', testMode: false, autoPush: false, config: { delivery: 'download' } });
    const { id } = await approvedVendor('ERP Csv Co', 'erp@csv.test');
    expect(await syncsOf(id)).toHaveLength(0); // auto-push off
    const mdm = await login('mdm@acme.test');
    const sync = (await mdm.post(`/api/staff/vendors/${id}/erp/push`)).body;
    expect(sync).toMatchObject({ status: 'SENT', target: 'Kept for download' });
    const file = await mdm.get(`/api/staff/erp/deliveries/${sync.id}/payload`);
    expect(file.headers['content-type']).toMatch(/text\/csv/);
    expect(file.text.split('\r\n')[0]).toMatch(/^ACTION,VENDOR_CODE,ERP_VENDOR_ID,VENDOR_NAME/);
    expect(file.text).toContain('ERP Csv Co');
    const all = await mdm.get('/api/staff/erp/export.csv');
    expect(all.text).toContain('ERP Webhook Co');
    expect(all.text).toContain('Precision Valves');
  });

  test('helpers: vendor id discovery and CSV formula guarding', () => {
    expect(findVendorId('{"data":{"items":[{"SUPPLIER_ID":"S-9"}]}}')).toBe('S-9');
    expect(findVendorId('not json')).toBeNull();
    expect(toCsv([['=HYPERLINK("x")', 'a,b', 'plain']])).toBe(`"'=HYPERLINK(""x"")","a,b",plain\r\n`);
  });
});
