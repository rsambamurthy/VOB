import { afterAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvedVendor, client, login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import { anthropicAnswerer, mockAnswerer, setHelpAnswerer } from '../src/integrations/ai/helpAnswer.js';

const ARTICLES = [
  { id: 'bank-change', title: 'Changing bank details', summary: 'Request a change; Finance and MDM approve it.', body: 'Open **Request changes**, edit the bank tab and submit. Finance and Master Data approve it.' },
  { id: 'signing-in', title: 'Signing in', summary: 'Workspace ID, email and password.', body: 'Enter your workspace ID, email and password.' },
];
afterAll(() => setHelpAnswerer(mockAnswerer));

describe('F1 help', () => {
  test('test mode points at the closest topic; questions are logged', async () => {
    const admin = await login('admin@acme.test');
    const r = await admin.post('/api/help/ask', { question: 'how do I change the bank account of a supplier?', audience: 'staff', articles: ARTICLES });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ answered: true, test: true, sources: expect.arrayContaining(['bank-change']) });
    expect(await db.query.helpQuestions.findFirst({ where: eq(schema.helpQuestions.question, 'how do I change the bank account of a supplier?') })).toMatchObject({ audience: 'staff', provider: 'mock' });
    expect((await client().post('/api/help/ask', { question: 'anything here?', audience: 'staff', articles: ARTICLES })).status).toBe(401);
  });

  test('AI answers use only the given articles, drop unknown sources, and respect the workspace switch and daily limit', async () => {
    const calls: any[] = [];
    setHelpAnswerer(anthropicAnswerer({ apiKey: 'x', model: 'm' }, { messages: { create: async (args: any) => { calls.push(args); return { content: [{ type: 'tool_use', input: { answered: true, answer: 'Open Request changes and edit the bank tab.', sources: ['bank-change', 'made-up'] } }] }; } } }));
    const admin = await login('admin@acme.test');
    const r = await admin.post('/api/help/ask', { question: 'Who approves a bank change?', audience: 'staff', articles: ARTICLES });
    expect(r.body).toEqual({ answered: true, answer: 'Open Request changes and edit the bank tab.', sources: ['bank-change'], test: false });
    expect(calls[0].messages[0].content).toContain('<article id="bank-change">');
    expect(calls[0].system).toContain('ONLY from the help articles');

    const t = await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') });
    await db.update(schema.tenants).set({ settings: { ...t!.settings, helpAi: false } }).where(eq(schema.tenants.id, t!.id));
    expect((await admin.post('/api/help/ask', { question: 'Who approves a bank change?', audience: 'staff', articles: ARTICLES })).status).toBe(403);
    await db.update(schema.tenants).set({ settings: t!.settings, plan: 'trial' }).where(eq(schema.tenants.id, t!.id));
    await db.insert(schema.helpQuestions).values(Array.from({ length: 30 }, () => ({ tenantId: t!.id, audience: 'staff', question: 'q', provider: 'anthropic' })));
    expect((await admin.post('/api/help/ask', { question: 'Who approves a bank change?', audience: 'staff', articles: ARTICLES })).status).toBe(429);
    await db.update(schema.tenants).set({ plan: t!.plan }).where(eq(schema.tenants.id, t!.id));
    await db.delete(schema.helpQuestions).where(eq(schema.helpQuestions.tenantId, t!.id));
    setHelpAnswerer(mockAnswerer);
  });

  test('workspace help topics: admins write them; staff and suppliers see the ones meant for them', async () => {
    const admin = await login('admin@acme.test');
    const staffOnly = await admin.post('/api/help/topics', { title: 'Our approval policy', summary: 'Who approves what', body: 'Orders above ₹10 lakh need the CFO.', audience: 'staff' });
    expect(staffOnly.status).toBe(201);
    const forSuppliers = await admin.post('/api/help/topics', { title: 'Payment terms at Acme', body: 'We pay 45 days from invoice receipt.', audience: 'supplier' });
    expect((await admin.post('/api/help/topics', { title: 'x', body: 'short', audience: 'staff' })).status).toBe(400);
    expect((await admin.get('/api/help/topics')).body.map((t: any) => t.title)).toEqual(['Our approval policy']);
    expect((await (await login('tax@acme.test')).post('/api/help/topics', { title: 'Nope topic', body: 'should not be allowed', audience: 'staff' })).status).toBe(403);

    const { v } = await approvedVendor('Help Topic Supplier', 'help@topics.test');
    expect((await v.get('/api/help/topics?supplier=1')).body.map((t: any) => t.title)).toEqual(['Payment terms at Acme']);
    expect((await v.post('/api/help/ask', { question: 'When will Acme pay my invoice?', audience: 'supplier', articles: [{ id: forSuppliers.body.id, title: 'Payment terms at Acme', body: 'We pay 45 days from invoice receipt.' }] })).body.sources).toEqual([forSuppliers.body.id]);

    expect((await admin.put(`/api/help/topics/${staffOnly.body.topicId}`, { title: 'Our approval policy', body: 'Orders above ₹10 lakh need the CFO and CEO.', audience: 'both' })).status).toBe(200);
    expect((await v.get('/api/help/topics?supplier=1')).body).toHaveLength(2);
    expect((await admin.del(`/api/help/topics/${staffOnly.body.topicId}`)).status).toBe(200);
    expect((await admin.del(`/api/help/topics/${forSuppliers.body.topicId}`)).status).toBe(200);
  });
});
