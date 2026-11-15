/** Corrective actions: suggestions, raising (incl. conditions of approval), the supplier's evidence, review, reminders, risk and holds. */
import { describe, expect, test } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../src/lib/db.js';
import { approvedVendor, invitedSupplier, login, submittedVendor } from './helpers.js';
import { runActionReminders } from '../src/services/correctiveActions.js';
import { refreshRisk } from '../src/services/risk.js';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const mails = async (to: string) => db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, to)).orderBy(desc(schema.emailOutbox.createdAt));
const acme = async () => (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!;

describe('corrective actions', () => {
  test('during review: the approver raises a condition; the supplier answers with evidence; review asks for more, then accepts', async () => {
    const { id, v } = await submittedVendor('Remedy Rivets Ltd', 'ca1@ca.test');
    const tax = await login('tax@acme.test'); // approver of the current step (no actions.manage)
    const outsider = await login('vendoradmin@acme.test');
    expect((await outsider.post(`/api/staff/actions/vendor/${id}`, { items: [{ title: 'Something', priority: 'LOW', dueOn: inDays(10) }] })).status).toBe(403);
    expect((await tax.get(`/api/staff/actions/vendor/${id}`)).body).toMatchObject({ canRaise: true, condition: true });
    expect((await tax.post(`/api/staff/actions/vendor/${id}`, { items: [{ title: 'Late', priority: 'LOW', dueOn: inDays(-1) }] })).status).toBe(400);
    const r = await tax.post(`/api/staff/actions/vendor/${id}`, { items: [{ title: 'Send your ISO 9001 certificate', description: 'The questionnaire says you hold it.', priority: 'HIGH', dueOn: inDays(14) }] });
    expect(r.status).toBe(201);
    expect(r.body[0]).toMatchObject({ condition: true, status: 'OPEN', raisedByName: 'Suresh Iyer' });
    const aid = r.body[0].id;
    expect((await mails('ca1@ca.test'))[0].subject).toMatch(/corrective actions for you/);

    // The supplier sees it (even while under review) and answers.
    const me = (await v.get('/api/vendor')).body;
    expect(me.correctiveActions).toHaveLength(1);
    expect(me.correctiveActions[0]).not.toHaveProperty('raisedById');
    expect((await v.post(`/api/vendor/actions/${aid}/submit`, {})).status).toBe(400); // nothing to send
    expect((await v.agent.post(`/api/vendor/actions/${aid}/file`).set('X-Requested-With', 'fetch').attach('file', Buffer.from('%PDF-1.4\n%%EOF'), { filename: 'iso.pdf', contentType: 'application/pdf' })).status).toBe(201);
    const sent = await v.post(`/api/vendor/actions/${aid}/submit`, { note: 'Attached our ISO 9001 certificate, valid to 2028.' });
    expect(sent.body[0]).toMatchObject({ status: 'SUBMITTED', evidence: [{ fileName: 'iso.pdf' }] });
    expect((await mails('tax@acme.test'))[0].subject).toBe('Evidence to review: Remedy Rivets Ltd — Send your ISO 9001 certificate');
    expect((await v.post(`/api/vendor/actions/${aid}/submit`, {})).status).toBe(409); // with the buyer now

    // Review: someone who neither raised it nor manages actions can't; rejecting needs remarks.
    expect((await outsider.post(`/api/staff/actions/${aid}/review`, { decision: 'ACCEPT' })).status).toBe(403);
    expect((await tax.post(`/api/staff/actions/${aid}/review`, { decision: 'REJECT' })).status).toBe(400);
    expect((await tax.post(`/api/staff/actions/${aid}/review`, { decision: 'REJECT', remarks: 'The certificate expired last year.' })).status).toBe(200);
    expect((await mails('ca1@ca.test'))[0].subject).toMatch(/more needed/);
    const again = (await v.get('/api/vendor/actions')).body[0];
    expect(again).toMatchObject({ status: 'OPEN', rejected: true, reviewRemarks: 'The certificate expired last year.' });
    await v.post(`/api/vendor/actions/${aid}/submit`, { note: 'Renewed certificate attached.' });
    // Anyone with actions.manage may also review (finance).
    expect((await (await login('finance@acme.test')).post(`/api/staff/actions/${aid}/review`, { decision: 'ACCEPT' })).status).toBe(200);
    expect((await v.get('/api/vendor/actions')).body[0].status).toBe('ACCEPTED');
    const log = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.vendorId, id));
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(['CORRECTIVE_ACTIONS_RAISED', 'CORRECTIVE_ACTION_ANSWERED', 'CORRECTIVE_ACTION_REJECTED', 'CORRECTIVE_ACTION_ACCEPTED']));
  });

  test('suggestions from findings (expired certificate), left out once raised', async () => {
    const { id } = await approvedVendor('Suggest Springs Ltd', 'ca2@ca.test');
    await db.update(schema.documents).set({ expiresOn: inDays(-5) }).where(and(eq(schema.documents.vendorId, id), eq(schema.documents.docType, 'PAN_CARD')));
    const fin = await login('finance@acme.test');
    const d = (await fin.get(`/api/staff/actions/vendor/${id}`)).body;
    expect(d.condition).toBe(false);
    const s = d.suggestions.find((x: any) => x.source === 'document:PAN_CARD');
    expect(s).toMatchObject({ title: 'Upload a renewed PAN Card', priority: 'MEDIUM' });
    await fin.post(`/api/staff/actions/vendor/${id}`, { items: [{ ...s, dueOn: inDays(s.dueInDays) }] });
    expect((await fin.get(`/api/staff/actions/vendor/${id}`)).body.suggestions.some((x: any) => x.source === 'document:PAN_CARD')).toBe(false);
  });

  test('daily: reminder before the due date; when overdue the supplier and raiser are told, risk goes up, and (if switched on) a high-priority one holds the supplier', async () => {
    const { id } = await approvedVendor('Overdue Owls Ltd', 'ca3@ca.test');
    const fin = await login('finance@acme.test');
    const [soon, late] = (await fin.post(`/api/staff/actions/vendor/${id}`, { items: [
      { title: 'Send the improvement plan', priority: 'MEDIUM', dueOn: inDays(2) },
      { title: 'Restore your GSTIN registration', priority: 'HIGH', dueOn: inDays(5) },
    ] })).body;
    await db.update(schema.correctiveActions).set({ dueOn: inDays(-1) }).where(eq(schema.correctiveActions.id, late.id));
    const t = await acme();
    await db.update(schema.tenants).set({ settings: { ...t.settings, risk: { ...(t.settings.risk ?? {}), holdOnOverdueAction: true } } }).where(eq(schema.tenants.id, t.id));
    try {
      const r = await runActionReminders();
      expect(r.overdue).toBeGreaterThanOrEqual(1);
      const subjects = (await mails('ca3@ca.test')).map((m) => m.subject);
      expect(subjects.some((x) => x.startsWith('Reminder: “Send the improvement plan” is due'))).toBe(true);
      expect(subjects).toContain('Overdue: “Restore your GSTIN registration”');
      expect((await mails('finance@acme.test'))[0].subject).toBe('Overdue: Overdue Owls Ltd — Restore your GSTIN registration');
      const v = (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) }))!;
      expect(v).toMatchObject({ blockSource: 'RISK' });
      expect(v.blockedReason).toMatch(/Corrective action overdue: Restore your GSTIN registration/);
      const risk = await refreshRisk(id, { alert: false });
      expect(risk!.signals.find((x) => x.code === 'actionsOverdue')).toMatchObject({ label: '1 corrective action overdue (1 high priority)', points: 25 });
      // Not told twice the same day.
      await runActionReminders();
      expect((await mails('ca3@ca.test')).filter((m) => m.subject.startsWith('Overdue:'))).toHaveLength(1);
      void soon;
    } finally {
      const fresh = await acme();
      await db.update(schema.tenants).set({ settings: { ...fresh.settings, risk: { ...(fresh.settings.risk ?? {}), holdOnOverdueAction: false } } }).where(eq(schema.tenants.id, t.id));
    }
  });

  test('change the due date or cancel; overview lists open, to review and overdue', async () => {
    const { id } = await approvedVendor('Overview Otters Ltd', 'ca4@ca.test');
    const fin = await login('finance@acme.test');
    const [a] = (await fin.post(`/api/staff/actions/vendor/${id}`, { items: [{ title: 'Explain the late deliveries', priority: 'LOW', dueOn: inDays(10) }] })).body;
    expect((await fin.patch(`/api/staff/actions/${a.id}`, { dueOn: inDays(20) })).status).toBe(200);
    expect((await fin.get('/api/staff/actions?filter=mine')).body.rows.some((r: any) => r.id === a.id && r.dueOn === inDays(20))).toBe(true);
    expect((await fin.patch(`/api/staff/actions/${a.id}`, { cancel: true, reason: 'Resolved by phone' })).status).toBe(200);
    expect((await fin.get('/api/staff/actions?filter=closed')).body.rows.find((r: any) => r.id === a.id)).toMatchObject({ status: 'CANCELLED' });
    expect((await fin.get('/api/staff/actions')).body.counts).toHaveProperty('overdue');
  });

  test('while still onboarding, an open action is the next step in the supplier guide', async () => {
    const { id, v } = await invitedSupplier('Guided Gaskets Ltd', 'ca5@ca.test');
    await v.put('/api/vendor/profile/basic', { entityType: 'Company (Pvt / Public Ltd)' });
    const admin = await login('admin@acme.test');
    expect((await admin.post(`/api/staff/actions/vendor/${id}`, { items: [{ title: 'Send your factory licence', priority: 'MEDIUM', dueOn: inDays(7) }] })).status).toBe(201);
    const g = (await v.get('/api/vendor/guide')).body;
    expect(g).toMatchObject({ nextKind: 'action', next: { tab: 'actions' }, openActions: 1 });
    expect(g.next.text).toMatch(/^Answer the corrective action “Send your factory licence”/);
  });
});
