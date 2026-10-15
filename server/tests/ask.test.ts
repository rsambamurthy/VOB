import { afterEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/lib/db.js';
import { login } from './helpers.js';
import { anthropicPlanner, mockPlanner, setAskPlanner } from '../src/integrations/ai/askPlanner.js';
import { ASK_QUERIES } from '../src/services/ask/queries.js';

const ctx = { today: '2026-10-15', country: 'Saudi Arabia', currency: 'SAR', levels: ['Tax & Zakat Review', 'Finance & Risk Review', 'Master Data Review'], documents: ['Commercial Registration (CR) certificate', 'Zakat certificate (ZATCA)', 'GOSI certificate'] };
const all = ASK_QUERIES;

afterEach(() => setAskPlanner(mockPlanner));

describe('Ask VendorGate: understanding the question (test mode)', () => {
  test('picks the right search and filters', async () => {
    expect(await mockPlanner.plan('Which approved suppliers in Riyadh have a CR expiring in the next 90 days?', all, ctx)).toMatchObject({ query: 'expiring_documents', params: { withinDays: 90, location: 'Riyadh', documentTypes: ['CR'] } });
    expect(await mockPlanner.plan('Show suppliers stuck in Finance review for more than 5 days', all, ctx)).toMatchObject({ query: 'pending_approvals', params: { level: 'Finance', olderThanDays: 5 } });
    expect(await mockPlanner.plan('Which suppliers have open POs over SAR 1m but no shipment notice yet?', all, ctx)).toMatchObject({ query: 'purchase_orders', params: { minValue: 1_000_000, noShipmentNotice: true } });
    expect(await mockPlanner.plan('Invoices in exception this month, by supplier', all, ctx)).toMatchObject({ query: 'invoices', params: { status: ['EXCEPTION'], withinDays: 30, groupBySupplier: true } });
    expect(await mockPlanner.plan('Who changed their bank details in the last 30 days?', all, ctx)).toMatchObject({ query: 'change_requests', params: { bankOnly: true, withinDays: 30 } });
    expect(await mockPlanner.plan('List suppliers on hold', all, ctx)).toMatchObject({ query: 'find_vendors', params: { onHold: true } });
    expect((await mockPlanner.plan('What is the weather?', all, ctx)).query).toBeNull();
  });

  test('the AI only sees the question and the search descriptions — never supplier data', async () => {
    const calls: any[] = [];
    const fake = { messages: { create: async (args: any) => { calls.push(args); return { content: [{ type: 'tool_use', name: 'find_vendors', input: { title: 'Approved suppliers in Pune', status: ['APPROVED'], location: 'Pune' } }] }; } } };
    const p = anthropicPlanner({ apiKey: 'x', model: 'm' }, fake);
    expect(await p.plan('approved suppliers in Pune', all, ctx)).toEqual({ query: 'find_vendors', params: { status: ['APPROVED'], location: 'Pune' }, title: 'Approved suppliers in Pune' });
    const sent = JSON.stringify(calls[0]);
    expect(calls[0].messages).toEqual([{ role: 'user', content: '<question>approved suppliers in Pune</question>' }]);
    expect(calls[0].tools.map((t: any) => t.name)).toContain('cannot_answer');
    expect(sent).not.toMatch(/Precision|SA03|IBAN\d|accountNumber/);
  });
});

describe('Ask VendorGate: running searches', () => {
  test('a question returns rows with links, no masked values, and is audited', async () => {
    const admin = await login('admin@acme.test');
    const r = await admin.post('/api/ask', { question: 'Show approved suppliers' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ answered: true, test: true, search: { name: 'find_vendors' } });
    expect(r.body.result.rows.length).toBeGreaterThan(0);
    expect(r.body.result.rows.every((x: any) => x.status === 'Approved' || x.status === 'On hold')).toBe(true);
    expect(r.body.result.rows[0]._link).toMatch(/^\/staff\/vendors\//);
    expect(JSON.stringify(r.body)).not.toMatch(/iban|accountNumber|HDFC0/i);
    const log = await db.query.auditLogs.findFirst({ where: eq(schema.auditLogs.action, 'AI_ASKED') });
    expect(log?.detail).toMatchObject({ question: 'Show approved suppliers', search: 'find_vendors' });

    const x = await admin.agent.post('/api/ask/export').set('X-Requested-With', 'fetch').send({ name: r.body.search.name, params: r.body.search.params, title: r.body.search.title }).buffer(true);
    expect(x.status).toBe(200);
    expect(x.headers['content-type']).toMatch(/spreadsheetml/);
  });

  test('every search runs against real data without errors', async () => {
    const admin = await login('admin@acme.test');
    for (const q of ['Documents expiring in the next 365 days', 'Suppliers waiting for approval', 'Change requests', 'Open purchase orders', 'Invoices by supplier', 'Suppliers in Pune']) {
      const r = await admin.post('/api/ask', { question: q });
      expect(r.status, q).toBe(200);
      expect(r.body.answered, q).toBe(true);
    }
  });

  test('purchasing searches are only offered to people who can see purchasing', async () => {
    const tax = await login('tax@acme.test');
    const info = (await tax.get('/api/ask')).body;
    expect(info.searches).not.toContain('invoices');
    const r = await tax.post('/api/ask', { question: 'Invoices in exception' });
    expect(r.body.search?.name).not.toBe('invoices');
    const ex = await tax.agent.post('/api/ask/export').set('X-Requested-With', 'fetch').send({ name: 'invoices', params: {}, title: 'x' });
    expect(ex.status).toBe(403);
  });

  test('a workspace can turn it off', async () => {
    const admin = await login('admin@acme.test');
    expect((await admin.patch('/api/admin/tenant', { settings: { askAi: false } })).status).toBe(200);
    expect((await admin.post('/api/ask', { question: 'approved suppliers' })).status).toBe(403);
    await admin.patch('/api/admin/tenant', { settings: { askAi: true } });
  });
});
