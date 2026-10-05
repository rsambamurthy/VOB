import { describe, expect, test } from 'vitest';
import ExcelJS from 'exceljs';
import { login } from './helpers.js';
import { mask, parseFilters } from '../src/services/reports.js';

describe('reports', () => {
  test('permission: tax cannot see reports, finance and MDM can', async () => {
    expect((await (await login('tax@acme.test')).get('/api/reports/dashboard')).status).toBe(403);
    expect((await (await login('finance@acme.test')).get('/api/reports/dashboard')).status).toBe(200);
    expect((await (await login('mdm@acme.test')).get('/api/reports')).status).toBe(200);
  });

  test('dashboard: funnel, turnaround, levels, ageing, workload, monthly', async () => {
    const r = (await (await login('admin@acme.test')).get('/api/reports/dashboard')).body;
    expect(r.funnel.map((x: any) => x.key)).toEqual(['invited', 'started', 'submitted', 'approved']);
    const [inv, started, sub, appr] = r.funnel.map((x: any) => x.count);
    expect(inv).toBeGreaterThanOrEqual(started); expect(started).toBeGreaterThanOrEqual(sub); expect(sub).toBeGreaterThanOrEqual(appr);
    expect(appr).toBeGreaterThan(0);
    expect(r.turnaround.total.count).toBeGreaterThan(0);
    expect(r.byLevel.map((l: any) => l.label)).toEqual(expect.arrayContaining(['Tax Review', 'Master Data Approval']));
    expect(r.ageing.buckets).toHaveLength(4);
    expect(r.ageing.rows.map((x: any) => x.stage)).toEqual(['INVITED', 'IN_PROGRESS', 'SENT_BACK', 'UNDER_REVIEW']);
    expect(r.monthly).toHaveLength(12);
    expect(r.tiles).toMatchObject({ activeVendors: expect.any(Number), needsAttention: expect.any(Number), overdueSteps: expect.any(Number) });
    expect(Array.isArray(r.workload)).toBe(true);
    // vendor-type filter narrows the cohort
    const imp = (await (await login('admin@acme.test')).get('/api/reports/dashboard?vendorType=GOVERNMENT')).body;
    expect(imp.funnel[0].count).toBeLessThanOrEqual(inv);
  });

  test('every report runs; register masks PAN and bank account', async () => {
    const admin = await login('admin@acme.test');
    const list = (await admin.get('/api/reports')).body;
    expect(list.map((x: any) => x.key)).toEqual(['vendor-register', 'pending-approvals', 'sla-breaches', 'turnaround', 'change-requests', 'expiring-documents', 'blocked', 'erp-deliveries']);
    for (const r of list) expect((await admin.get(`/api/reports/${r.key}?from=2020-01-01`)).status).toBe(200);
    const reg = (await admin.get('/api/reports/vendor-register')).body;
    const precision = reg.rows.find((x: any) => x.vendor === 'Precision Valves Pvt Ltd');
    expect(precision.pan).toMatch(/•/);
    expect(precision.account).toMatch(/^•+\d{4}$/);
    const exp = (await admin.get('/api/reports/expiring-documents?days=30')).body;
    expect(exp.rows.some((x: any) => x.vendor === 'Precision Valves Pvt Ltd' && x.state === 'Expiring')).toBe(true);
    expect((await admin.get('/api/reports/nope')).status).toBe(404);
  });

  test('Excel download is a real workbook with an About sheet', async () => {
    const admin = await login('admin@acme.test');
    const r = await admin.get('/api/reports/vendor-register?format=xlsx').buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(r.headers['content-type']).toMatch(/spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(r.body);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Vendor register', 'About']);
    const ws = wb.worksheets[0];
    expect(ws.getRow(1).getCell(1).value).toBe('Vendor code');
    expect(ws.rowCount).toBeGreaterThan(1);
  });

  test('helpers', () => {
    expect(mask('AAFCL1234Q', 3, 1)).toBe('AAF••••••Q');
    expect(mask('501000123456', 0, 4)).toBe('••••••3456');
    const f = parseFilters({ from: '2026-01-01', to: '2026-03-31', vendorType: 'IMPORT' });
    expect(f.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(f.vendorType).toBe('IMPORT');
    expect(parseFilters({ vendorType: 'HACK' }).vendorType).toBeUndefined();
  });
});
