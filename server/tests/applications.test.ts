/** Self-registration: public "Become a supplier" links, email code, screening (accept / decline). */
import { describe, expect, test } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { approvedVendor, client, lastLinkTo, login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import { gstinCheckChar } from '../src/lib/validators.js';

const gstin = (pan: string, st = '27') => { const g = `${st}${pan}1Z`; return g + gstinCheckChar(g); };
const lastMail = async (to: string) => (await db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, to)).orderBy(desc(schema.emailOutbox.createdAt)))[0];
const base = { vendorType: 'DOMESTIC', contactFirstName: 'Asha', contactLastName: 'Nair', contactMobile: '9800044411' };

async function applyAndVerify(slug: string, body: Record<string, unknown>) {
  const pub = client();
  const r = await pub.post(`/api/apply/${slug}`, body);
  expect(r.status).toBe(201);
  expect((await pub.post(`/api/apply/${slug}/${r.body.id}/verify`, { code: r.body.devOtp })).status).toBe(200);
  return r.body.id as string;
}

describe('self-registration links', () => {
  let slug = ''; let linkId = '';
  test('admin creates a link; the public page shows the buyer and the home registration number', async () => {
    expect((await (await login('tax@acme.test')).post('/api/staff/registration-links', { name: 'Website' })).status).toBe(403);
    const admin = await login('admin@acme.test');
    expect((await admin.post('/api/staff/registration-links', { name: 'Trade fair', notifyEmails: 'not-an-email' })).status).toBe(400);
    const r = await admin.post('/api/staff/registration-links', { name: 'Trade fair Mumbai', intro: 'Thanks for visiting our stand.', notifyEmails: 'fair-team@acme.test' });
    expect(r.status).toBe(201);
    ({ slug, id: linkId } = r.body);
    expect(r.body.url).toMatch(new RegExp(`/apply/${slug}$`));
    const page = (await client().get(`/api/apply/${slug}`)).body;
    expect(page).toMatchObject({ buyer: { name: 'Acme Industries Ltd' }, link: { name: 'Trade fair Mumbai', intro: 'Thanks for visiting our stand.' }, registrationId: { label: 'GSTIN', fieldId: 'tax.gstin' } });
    const qr = await admin.agent.get(`/api/staff/registration-links/${linkId}/qr`).set('X-Requested-With', 'fetch');
    expect(qr.status).toBe(200);
    expect(qr.headers['content-type']).toBe('image/png');
    expect((await client().get('/api/apply/not-a-real-link')).status).toBe(404);
  });

  test('apply, confirm the email, screened by a buyer, accepted → supplier invited with what they gave', async () => {
    const pub = client();
    expect((await pub.post(`/api/apply/${slug}`, { ...base, name: 'Bad Gst Co', contactEmail: 'bad@apply.test', registrationId: '27AAAAA0000A1Z0' })).status).toBe(400);
    // A bot filling the hidden field gets a normal-looking answer and nothing is stored.
    expect((await pub.post(`/api/apply/${slug}`, { ...base, name: 'Spam Bot Ltd', contactEmail: 'bot@apply.test', company: 'x' })).status).toBe(201);
    const pan = 'AAFCA7731K';
    const r = await pub.post(`/api/apply/${slug}`, { ...base, name: 'Applied Polymers Pvt Ltd', contactEmail: 'Asha@Applied.test', registrationId: gstin(pan), website: 'www.applied.test', supplies: 'PVC granules', message: 'Met you at the fair' });
    expect(r.status).toBe(201);
    expect((await lastMail('asha@applied.test')).body).toContain(r.body.devOtp);
    const admin = await login('admin@acme.test');
    // Not visible to buyers until the email is confirmed.
    expect((await admin.get('/api/staff/applications')).body.map((a: any) => a.companyName)).not.toContain('Applied Polymers Pvt Ltd');
    expect((await pub.post(`/api/apply/${slug}/${r.body.id}/verify`, { code: '000000' })).status).toBe(400);
    expect((await pub.post(`/api/apply/${slug}/${r.body.id}/verify`, { code: r.body.devOtp })).status).toBe(200);
    expect((await lastMail('fair-team@acme.test')).subject).toBe('New supplier application: Applied Polymers Pvt Ltd');
    const list = (await admin.get('/api/staff/applications')).body;
    const app = list.find((a: any) => a.companyName === 'Applied Polymers Pvt Ltd');
    expect(app).toMatchObject({ status: 'PENDING', linkName: 'Trade fair Mumbai', email: 'asha@applied.test', registrationId: gstin(pan), registrationLabel: 'GSTIN' });
    expect(app.codeHash).toBeUndefined();
    expect(list.find((a: any) => a.companyName === 'Spam Bot Ltd')).toBeUndefined();
    expect((await admin.get('/api/staff/applications/count')).body.pending).toBeGreaterThan(0);

    const acc = await admin.post(`/api/staff/applications/${app.id}/accept`, {});
    expect(acc.status).toBe(200);
    const v = (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, acc.body.vendor.id) }))!;
    expect(v).toMatchObject({ status: 'INVITED', name: 'Applied Polymers Pvt Ltd', contactEmail: 'asha@applied.test' });
    expect((v.profile as any).tax).toMatchObject({ gstin: gstin(pan), hasGst: 'Yes' });
    expect((v.profile as any).basic).toMatchObject({ websiteUrl: 'www.applied.test', itemsSupplied: 'PVC granules' });
    expect((await lastMail('asha@applied.test')).subject).toMatch(/application was accepted/);
    expect(await lastLinkTo('asha@applied.test')).toMatch(/\/onboard\//);
    expect((await admin.post(`/api/staff/applications/${app.id}/accept`, {})).status).toBe(409);
    const logs = (await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.vendorId, v.id))).map((x) => x.action);
    expect(logs).toEqual(expect.arrayContaining(['VENDOR_CREATED', 'APPLICATION_ACCEPTED']));
  });

  test('reviewers see likely duplicates; decline tells the applicant', async () => {
    const { id } = await approvedVendor('Existing Steel Ltd', 'existing@apply.test');
    const p = (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) }))!.profile as any;
    const appId = await applyAndVerify(slug, { ...base, name: 'Existing Steel Ltd', contactEmail: 'someone@apply.test', registrationId: gstin(p.tax.pan, '29') });
    const admin = await login('admin@acme.test');
    const app = (await admin.get('/api/staff/applications')).body.find((a: any) => a.id === appId);
    const hints = app.hints.map((h: any) => h.text).join(' | ');
    expect(hints).toMatch(/A supplier with this name exists/);
    // Same PAN inside a GSTIN from another state, on a supplier with another name, is caught by the duplicate check.
    const app2Id = await applyAndVerify(slug, { ...base, name: 'Existing Steel (Karnataka) Pvt Ltd', contactEmail: 'ka@apply.test', registrationId: gstin(p.tax.pan, '29') });
    const app2 = (await admin.get('/api/staff/applications')).body.find((a: any) => a.id === app2Id);
    expect(app2.hints.map((h: any) => h.text).join(' | ')).toMatch(/Existing Steel Ltd has the same PAN/);

    expect((await admin.post(`/api/staff/applications/${appId}/decline`, { reason: 'You are already registered with us as Existing Steel Ltd.', notify: true })).status).toBe(200);
    expect((await lastMail('someone@apply.test')).body).toMatch(/already registered/);
    expect((await admin.get('/api/staff/applications?status=DECLINED')).body.map((a: any) => a.id)).toContain(appId);
  });

  test('a disabled link stops taking applications', async () => {
    const admin = await login('admin@acme.test');
    expect((await admin.put(`/api/staff/registration-links/${linkId}`, { active: false })).status).toBe(200);
    expect((await client().get(`/api/apply/${slug}`)).status).toBe(404);
    expect((await client().post(`/api/apply/${slug}`, { ...base, name: 'Late Comer Ltd', contactEmail: 'late@apply.test' })).status).toBe(404);
    const links = (await admin.get('/api/staff/registration-links')).body;
    expect(links.find((l: any) => l.id === linkId)).toMatchObject({ active: false, accepted: 1 });
  });
});
