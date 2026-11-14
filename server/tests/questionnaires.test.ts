/**
 * Questionnaires by supplier category. Targeted at Government suppliers and at "Goods & Services", which other
 * test files don't use, so files running at the same time aren't affected.
 */
import { afterAll, describe, expect, test } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { approvedVendor, invitedSupplier, login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import { score } from '../src/services/questionnaires.js';

const PDF = '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF';
const created: string[] = [];
const ESG = {
  title: 'Gov ESG self-assessment', titleAr: 'تقييم ذاتي للاستدامة', appliesIf: { field: 'vendor.vendorType', op: 'eq', value: 'GOVERNMENT' }, required: true,
  questions: [
    { id: 'envPolicy', text: 'Do you have a written environmental policy?', textAr: 'هل لديكم سياسة بيئية مكتوبة؟', type: 'yesno', required: true },
    { id: 'envFile', text: 'Upload your environmental policy', type: 'file', required: true, points: 5, showIf: { questionId: 'envPolicy', equals: 'Yes' } },
    { id: 'childLabour', text: 'How often do you check your own suppliers for child labour?', type: 'choice', required: true, options: [{ label: 'Every year', points: 10 }, { label: 'Sometimes', points: 5 }, { label: 'Never', points: 0, knockout: true }] },
    { id: 'notes', text: 'Anything else?', type: 'text', required: false },
  ],
  bands: { low: 75, medium: 50 },
};
afterAll(async () => { const admin = await login('admin@acme.test'); for (const id of created) await admin.post(`/api/questionnaires/${id}/archive`); });
const flagsOf = async (id: string) => (await (await login('admin@acme.test')).get(`/api/staff/vendors/${id}`)).body.flags.map((f: any) => f.code);

describe('scoring', () => {
  test('points, % of maximum, bands, knock-outs; hidden follow-ups don’t count', () => {
    const qs = ESG.questions.map((q) => (q.type === 'yesno' ? { ...q, options: [{ label: 'Yes', points: 10 }, { label: 'No', points: 0 }] } : q)) as any;
    expect(score(qs, { envPolicy: 'Yes', envFile: { documentId: 'd', fileName: 'p.pdf' }, childLabour: 'Every year' }, ESG.bands)).toMatchObject({ score: 25, maxScore: 25, percent: 100, band: 'LOW' });
    expect(score(qs, { envPolicy: 'No', childLabour: 'Sometimes' }, ESG.bands)).toMatchObject({ score: 5, maxScore: 20, percent: 25, band: 'HIGH' });
    expect(score(qs, { envPolicy: 'Yes', childLabour: 'Sometimes' }, ESG.bands)).toMatchObject({ percent: 60, band: 'MEDIUM' });
    expect(score(qs, { envPolicy: 'Yes', envFile: { documentId: 'd', fileName: 'p.pdf' }, childLabour: 'Never' }, ESG.bands)).toMatchObject({ percent: 60, band: 'HIGH', knockouts: ['childLabour'] });
  });
});

describe('questionnaires', () => {
  let esgId = '', infoSecId = '';
  test('admin builds questionnaires; checked for mistakes; others cannot', async () => {
    const admin = await login('admin@acme.test');
    expect((await (await login('tax@acme.test')).post('/api/questionnaires', ESG)).status).toBe(403);
    expect((await admin.post('/api/questionnaires', { ...ESG, questions: [{ id: 'a', text: 'Pick one', type: 'choice' }] })).status).toBe(400);
    expect((await admin.post('/api/questionnaires', { ...ESG, appliesIf: { field: 'basic.supplyCategory', op: 'eq', value: '' } })).status).toBe(400);
    expect((await admin.post('/api/questionnaires', { ...ESG, questions: [{ id: 'b', text: 'Follow-up', type: 'text', showIf: { questionId: 'zzz', equals: 'Yes' } }] })).status).toBe(400);
    const r = await admin.post('/api/questionnaires', ESG);
    expect(r.status).toBe(201);
    esgId = r.body.id; created.push(esgId);
    expect(r.body.questions[0].options).toEqual([{ label: 'Yes', labelAr: 'نعم', points: 10 }, { label: 'No', labelAr: 'لا', points: 0 }]);
    const s = await admin.post('/api/questionnaires', { title: 'Information security', appliesIf: { field: 'basic.supplyCategory', op: 'eq', value: 'Goods & Services' }, required: false, questions: [{ id: 'iso', text: 'ISO 27001 certified?', type: 'yesno' }] });
    infoSecId = s.body.id; created.push(infoSecId);
  });

  test('required during onboarding; follow-ups, files and scores; reviewers see the risk', async () => {
    const { v, id } = await invitedSupplier('Gov Roads Board', 'roads@q.test', 'GOVERNMENT');
    let me = (await v.get('/api/vendor')).body;
    const q = me.questionnaires.find((x: any) => x.id === esgId);
    expect(q).toMatchObject({ outstanding: true, required: true, status: 'NEW', title: 'Gov ESG self-assessment' });
    expect(q.result).toBeUndefined(); // scores are for the buyer
    expect(q.questions[2].options[0]).toEqual({ value: 'Every year', label: 'Every year' });
    expect(me.questionnaires.find((x: any) => x.id === infoSecId)).toBeUndefined();
    expect(me.checklist.find((c: any) => c.id === `questionnaire.${esgId}`)).toMatchObject({ ok: false, section: 'questionnaires', message: 'Gov ESG self-assessment must be answered' });

    expect((await v.put(`/api/vendor/questionnaires/${esgId}`, { answers: { envPolicy: 'Yes', childLabour: 'Not a choice' } })).status).toBe(200);
    me = (await v.get('/api/vendor')).body;
    expect(me.questionnaires.find((x: any) => x.id === esgId)).toMatchObject({ status: 'DRAFT', answers: { envPolicy: 'Yes' } });
    const missing = await v.post(`/api/vendor/questionnaires/${esgId}/submit`, { answers: { childLabour: 'Every year' } });
    expect(missing.status).toBe(422);
    expect(missing.body.details.map((d: any) => d.id)).toEqual(['envFile']); // the follow-up shows because they said Yes
    const file = await v.agent.post(`/api/vendor/questionnaires/${esgId}/file`).set('X-Requested-With', 'fetch').attach('file', Buffer.from(PDF), { filename: 'env-policy.pdf', contentType: 'application/pdf' });
    expect(file.status).toBe(201);
    const ok = await v.post(`/api/vendor/questionnaires/${esgId}/submit`, { answers: { envFile: file.body } });
    expect(ok.status).toBe(200);
    expect(ok.body.checklist.find((c: any) => c.id === `questionnaire.${esgId}`).ok).toBe(true);
    // The category decides: choosing "Goods & Services" brings the (optional) information-security one.
    await v.put('/api/vendor/profile/basic', { supplyCategory: 'Goods & Services' });
    me = (await v.get('/api/vendor')).body;
    expect(me.questionnaires.find((x: any) => x.id === infoSecId)).toMatchObject({ required: false, outstanding: false });

    const staff = (await (await login('tax@acme.test')).get(`/api/staff/vendors/${id}`)).body;
    expect(staff.questionnaires.find((x: any) => x.id === esgId).result).toMatchObject({ percent: 100, band: 'LOW' });
    expect(staff.questionnaires.find((x: any) => x.id === esgId).questions[2].options[2]).toMatchObject({ points: 0, knockout: true });
    expect(staff.questionnaireHistory[0]).toMatchObject({ questionnaireId: esgId, band: 'LOW', submittedByName: 'roads@q.test' });
  });

  test('a knock-out answer flags the supplier as high risk; a buyer can answer on the supplier’s behalf', async () => {
    const admin = await login('admin@acme.test');
    const id = (await admin.post('/api/staff/vendors', { name: 'Gov Ports Trust', vendorType: 'GOVERNMENT', contactFirstName: 'P', contactLastName: 'T', contactEmail: 'ports@q.test', contactMobile: '9800033366', notify: false })).body.vendor.id;
    expect((await admin.put(`/api/staff/vendors/${id}/assist/questionnaires/${esgId}`, { answers: { envPolicy: 'No' } })).status).toBe(200);
    const r = await admin.post(`/api/staff/vendors/${id}/assist/questionnaires/${esgId}/submit`, { answers: { childLabour: 'Never' } });
    expect(r.status).toBe(200);
    expect(r.body.questionnaires.find((x: any) => x.id === esgId).result).toMatchObject({ band: 'HIGH', knockouts: ['childLabour'] });
    const row = (await db.select().from(schema.questionnaireResponses).where(eq(schema.questionnaireResponses.vendorId, id)))[0];
    expect(row).toMatchObject({ status: 'SUBMITTED', submittedByName: 'Anita Rao' });
    expect(row.questions).toBeTruthy(); // a copy of the questions answered
    expect(await flagsOf(id)).toContain('QUESTIONNAIRE_HIGH_RISK');
    const audit = (await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.vendorId, id))).find((a) => a.action === 'QUESTIONNAIRE_SUBMITTED');
    expect(audit?.detail).toMatchObject({ risk: 'HIGH', onBehalf: 'yes' });
  });

  test('a buyer sends a questionnaire to an approved supplier; flagged until answered', async () => {
    const { v, id } = await approvedVendor('Approved Answering Co', 'answer@q.test');
    const admin = await login('admin@acme.test');
    expect((await (await login('tax@acme.test')).post(`/api/staff/vendors/${id}/questionnaires/${esgId}/request`, {})).status).toBe(403);
    expect((await admin.post(`/api/staff/vendors/${id}/questionnaires/${esgId}/request`, { dueOn: '2027-01-31' })).status).toBe(200);
    expect(await flagsOf(id)).toContain('QUESTIONNAIRE_DUE');
    const mail = (await db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, 'answer@q.test')).orderBy(desc(schema.emailOutbox.createdAt)))[0];
    expect(mail.subject).toMatch(/please complete the Gov ESG self-assessment/);
    const me = (await v.get('/api/vendor')).body;
    expect(me.questionnaires.find((x: any) => x.id === esgId)).toMatchObject({ outstanding: true, requested: true, dueOn: '2027-01-31' });
    // Approved: no checklist blocking, but the portal can answer.
    expect(me.checklist.find((c: any) => c.id === `questionnaire.${esgId}`)).toBeUndefined();
    expect((await v.post(`/api/vendor/questionnaires/${esgId}/submit`, { answers: { envPolicy: 'No', childLabour: 'Every year' } })).status).toBe(200);
    expect(await flagsOf(id)).not.toContain('QUESTIONNAIRE_DUE');
    const list = (await admin.get('/api/questionnaires')).body.find((x: any) => x.id === esgId);
    expect(list.submitted).toBeGreaterThanOrEqual(3);
    expect(list.highRisk).toBeGreaterThanOrEqual(1);
  });
});
