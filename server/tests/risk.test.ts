/** Ongoing risk monitoring: scores from signals, monitored checks, alerts, optional automatic hold, bank-change risk. */
import { afterEach, describe, expect, test } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { approvedVendor, login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import { setKycProvider } from '../src/integrations/kyc/index.js';
import { indiaMockChecks } from '../src/countries/in/mockChecks.js';
import { bandOf, runRiskMonitoring } from '../src/services/risk.js';

afterEach(() => setKycProvider(indiaMockChecks));
/** GSTINs of these suppliers come back cancelled from the (test) GST portal. */
const cancelling = (names: string[]) => setKycProvider({ ...indiaMockChecks, async check(kind, input, ctx) {
  if (kind === 'gstin' && names.some((n) => ctx.legalName.toUpperCase().includes(n.toUpperCase()))) return { status: 'VERIFIED', message: 'GSTIN is cancelled (test mode)', data: { gstStatus: 'Cancelled' } };
  return indiaMockChecks.check(kind, input, ctx);
} });
const vendorRow = async (id: string) => (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) }))!;

describe('risk', () => {
  test('bands', () => {
    expect(bandOf(10, [])).toBe('LOW');
    expect(bandOf(30, [])).toBe('MEDIUM');
    expect(bandOf(55, [])).toBe('HIGH');
    expect(bandOf(5, [{ code: 'x', label: 'x', points: 5, critical: true }])).toBe('HIGH');
  });

  test('a clean approved supplier is low risk; a cancelled GSTIN found by monitoring makes it high risk and alerts', async () => {
    const { id } = await approvedVendor('Riskless Rivets Ltd', 'rivets@risk.test');
    const admin = await login('admin@acme.test');
    const page = (await admin.get(`/api/staff/vendors/${id}`)).body;
    expect(page.risk).toMatchObject({ band: 'LOW' });
    expect(page.risk.score).toBeLessThan(25);

    cancelling(['Riskless Rivets']);
    expect((await (await login('tax@acme.test')).post(`/api/staff/risk/vendors/${id}/check`, {})).status).toBe(403);
    const r = await (await login('mdm@acme.test')).post(`/api/staff/risk/vendors/${id}/check`, {});
    expect(r.status).toBe(200);
    expect(r.body.band).toBe('HIGH');
    expect(r.body.signals[0]).toMatchObject({ code: 'check.gstin', critical: true, label: 'GSTIN: GSTIN is cancelled (test mode)' });
    const v = await vendorRow(id);
    expect(v).toMatchObject({ riskBand: 'HIGH', blockedAt: null });
    expect(v.lastMonitoredAt).toBeTruthy();
    expect((await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.vendorId, id))).map((a) => a.action)).toContain('RISK_RAISED');
    const mail = (await db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, 'mdm@acme.test')).orderBy(desc(schema.emailOutbox.createdAt)))[0];
    expect(mail.subject).toBe('High risk: Riskless Rivets Ltd');
    // Listed on the Risk page and flagged in the vendor list.
    const overview = (await admin.get('/api/staff/risk?band=HIGH')).body;
    expect(overview.rows.map((x: any) => x.id)).toContain(id);
    expect((await admin.get('/api/staff/vendors?q=Riskless')).body.vendors[0].flags.map((f: any) => f.code)).toContain('RISK_HIGH');
    // Still high on the next refresh, but not alerted twice.
    const before = (await db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, 'mdm@acme.test'))).length;
    await (await login('mdm@acme.test')).post(`/api/staff/risk/vendors/${id}/check`, {});
    expect((await db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, 'mdm@acme.test'))).length).toBe(before);
  });

  test('settings: monitoring interval, alert recipients, automatic hold on a serious hit', async () => {
    const admin = await login('admin@acme.test');
    expect((await (await login('tax@acme.test')).put('/api/staff/risk/settings', { monitorDays: 30, alertEmails: '', autoHold: true })).status).toBe(403);
    expect((await admin.put('/api/staff/risk/settings', { monitorDays: 30, alertEmails: 'nope', autoHold: true })).status).toBe(400);
    const { id } = await approvedVendor('Holdable Hinges Ltd', 'hinges@risk.test');
    try {
      expect((await admin.put('/api/staff/risk/settings', { monitorDays: 14, alertEmails: 'risk-desk@acme.test', autoHold: true })).status).toBe(200);
      cancelling(['Holdable Hinges']);
      await admin.post(`/api/staff/risk/vendors/${id}/check`, {});
      const v = await vendorRow(id);
      expect(v).toMatchObject({ blockSource: 'RISK' });
      expect(v.blockedReason).toMatch(/Risk monitoring: GSTIN/);
      const mail = (await db.select().from(schema.emailOutbox).where(eq(schema.emailOutbox.to, 'risk-desk@acme.test')).orderBy(desc(schema.emailOutbox.createdAt)))[0];
      expect(mail.subject).toBe('On hold — High risk: Holdable Hinges Ltd');
      // A person lifts it.
      expect((await admin.post(`/api/staff/vendors/${id}/unblock`, { reason: 'GST restored — confirmed on the portal', notifyVendor: false })).status).toBe(200);
    } finally {
      await admin.put('/api/staff/risk/settings', { monitorDays: 30, alertEmails: '', autoHold: false });
    }
  });

  test('daily monitoring re-checks suppliers that are due', async () => {
    const { id } = await approvedVendor('Due For Check Ltd', 'due@risk.test');
    await db.update(schema.vendors).set({ lastMonitoredAt: null }).where(eq(schema.vendors.id, id));
    const r = await runRiskMonitoring();
    expect(r.monitored).toBeGreaterThan(0);
    const v = await vendorRow(id);
    expect(v.lastMonitoredAt).toBeTruthy();
    expect(v.riskBand).toBe('LOW');
    const checks = await db.select().from(schema.verifications).where(eq(schema.verifications.vendorId, id));
    expect(checks.some((c) => c.kind === 'gstin' && c.requestedBy === 'system (risk monitoring)')).toBe(true);
  });

  test('bank-change risk for reviewers: new holder name, recent contact change, new supplier', async () => {
    const { v, id, admin } = await approvedVendor('Careful Couplings Ltd', 'careful@risk.test');
    expect((await admin.post(`/api/staff/vendors/${id}/contact`, { email: 'careful-new@risk.test', reason: 'asked by phone' })).status).toBe(200);
    expect((await v.post('/api/vendor/change-requests', { changes: { bank: { accountHolderName: 'Quick Cash Traders', accountNumber: '000777666551', ifsc: 'ICIC0000777' } }, note: 'New bank' })).status).toBe(201);
    const cr = (await admin.get(`/api/staff/vendors/${id}`)).body.changeRequests.find((c: any) => c.status === 'PENDING');
    expect(cr.bankRisk.band).toBe('HIGH');
    expect(cr.bankRisk.reasons.map((x: any) => x.code).sort()).toEqual(['contactChanged', 'holderName', 'newSupplier']);
  });
});
