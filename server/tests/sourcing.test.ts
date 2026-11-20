/** Sourcing foundations: plan/licence add-on, workspace switch, formats, sub-features, rule defaults and locks, permissions. */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { login } from './helpers.js';
import { db, schema } from '../src/lib/db.js';
import type { Tenant } from '../src/db/schema.js';
import { resolveFeatures } from '../src/lib/features.js';
import { effectiveLimits } from '../src/lib/plans.js';
import { featureState, formatOn, resolveRules, sourcingOn } from '../src/services/sourcing/config.js';

let acme: Tenant;
const reload = async () => (acme = (await db.query.tenants.findFirst({ where: eq(schema.tenants.slug, 'acme') }))!);
const setLimits = (limits: Tenant['limits']) => db.update(schema.tenants).set({ limits }).where(eq(schema.tenants.id, acme.id));
let original: Pick<Tenant, 'settings' | 'limits'>;

beforeAll(async () => { await reload(); original = { settings: acme.settings, limits: acme.limits }; });
afterAll(async () => { await db.update(schema.tenants).set(original).where(eq(schema.tenants.id, acme.id)); });

describe('plan features', () => {
  test('Sourcing is an add-on: off unless switched on explicitly; other features stay on unless switched off', () => {
    expect(resolveFeatures({})).toMatchObject({ erp: true, ai: true, sourcing: false });
    expect(resolveFeatures({ erp: false }, { sourcing: true })).toMatchObject({ erp: false, sourcing: true });
    expect(resolveFeatures({ sourcing: true }, { sourcing: false }).sourcing).toBe(false);
    expect(effectiveLimits({ plan: 'enterprise', limits: {} }).features.sourcing).toBe(false);
    expect(effectiveLimits({ plan: 'enterprise', limits: { features: { sourcing: true }, sourcingFormats: ['rfq'] } })).toMatchObject({ features: { sourcing: true }, sourcingFormats: ['rfq'] });
  });
});

describe('sourcing configuration', () => {
  test('not in the plan: no module, no permissions on the Roles screen, and it can’t be switched on', async () => {
    await setLimits({});
    const admin = await login('admin@acme.test');
    expect((await admin.get('/api/auth/me')).body.sourcing).toEqual({ on: false, formats: [] });
    expect((await admin.get('/api/staff/sourcing/events')).status).toBe(404);
    expect(Object.keys((await admin.get('/api/admin/roles')).body.permissions).some((p) => p.startsWith('sourcing.'))).toBe(false);
    const cfg = (await admin.get('/api/admin/sourcing')).body;
    expect(cfg).toMatchObject({ licensed: false, on: false });
    const r = await admin.put('/api/admin/sourcing', { enabled: true, formats: { rfq: true } });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PLAN_LIMIT');
  });

  test('in the plan with some formats: the administrator switches it on; unlicensed, unreleased or no formats are refused', async () => {
    await setLimits({ features: { sourcing: true }, sourcingFormats: ['rfq'] });
    const admin = await login('admin@acme.test');
    const cfg = (await admin.get('/api/admin/sourcing')).body;
    expect(cfg.licensed).toBe(true);
    expect(cfg.formats.find((f: any) => f.key === 'reverse')).toMatchObject({ licensed: false, available: true });
    expect(cfg.formats.find((f: any) => f.key === 'dutch')).toMatchObject({ available: false });
    expect(cfg.rules.find((r: any) => r.key === 'visibility')).toMatchObject({ value: 'rank', locked: false });

    expect((await admin.put('/api/admin/sourcing', { enabled: true, formats: { reverse: true } })).status).toBe(403);
    expect((await admin.put('/api/admin/sourcing', { enabled: true, formats: { dutch: true } })).body.error).toMatch(/isn’t available yet/);
    expect((await admin.put('/api/admin/sourcing', { enabled: true, formats: {} })).body.error).toMatch(/at least one format/);
    expect((await admin.put('/api/admin/sourcing', { enabled: true, formats: { rfq: true }, features: { emd: true } })).status).toBe(400);
    expect((await admin.put('/api/admin/sourcing', { enabled: true, formats: { rfq: true }, rules: { minStepPct: 50 } })).body.error).toMatch(/at most 20/);
    // Users without workspace settings permission can't change it.
    expect((await (await login('tax@acme.test')).put('/api/admin/sourcing', { enabled: true, formats: { rfq: true } })).status).toBe(403);

    const ok = await admin.put('/api/admin/sourcing', { enabled: true, formats: { rfq: true }, features: { outsideBidders: false, autoExtension: true }, rules: { minStepPct: 1, extensionMinutes: 5 }, locked: ['visibility', 'minStepPct'] });
    expect(ok.status).toBe(200);
    expect(ok.body.changes).toEqual(expect.arrayContaining(['Sourcing on', 'Sealed bid / RFQ on', 'Invite outside bidders off', 'Minimum bid step: 0.5 → 1', 'Minimum bid step locked']));
    // Only differences from the defaults are stored.
    await reload();
    expect(acme.settings.sourcing).toMatchObject({ enabled: true, features: { outsideBidders: false }, rules: { minStepPct: 1 }, locked: ['visibility', 'minStepPct'] });
    expect(acme.settings.sourcing!.features).not.toHaveProperty('autoExtension');
    expect(acme.settings.sourcing!.rules).not.toHaveProperty('extensionMinutes');
    const log = await db.query.auditLogs.findFirst({ where: eq(schema.auditLogs.action, 'SOURCING_SETTINGS_CHANGED'), orderBy: (a, { desc }) => desc(a.createdAt) });
    expect((log!.detail as any).changes).toContain('Sourcing on');

    expect((await admin.get('/api/auth/me')).body.sourcing).toEqual({ on: true, formats: ['rfq'] });
    expect(Array.isArray((await admin.get('/api/staff/sourcing/events')).body.events)).toBe(true);
    expect(Object.keys((await admin.get('/api/admin/roles')).body.permissions)).toContain('sourcing.events');
    // Users need sourcing.view.
    expect((await (await login('tax@acme.test')).get('/api/staff/sourcing/events')).status).toBe(403);
  });

  test('switched off again: the module disappears but the choices are kept', async () => {
    const admin = await login('admin@acme.test');
    expect((await admin.put('/api/admin/sourcing', { enabled: false, formats: { rfq: true }, features: { outsideBidders: false }, rules: { minStepPct: 1 }, locked: ['visibility', 'minStepPct'] })).status).toBe(200);
    expect((await admin.get('/api/staff/sourcing/config')).status).toBe(404);
    expect((await admin.get('/api/admin/sourcing')).body.formats.find((f: any) => f.key === 'rfq')).toMatchObject({ chosen: true, on: false });
    // Taking the feature out of the plan also switches it off, without touching the settings.
    await admin.put('/api/admin/sourcing', { enabled: true, formats: { rfq: true }, features: { outsideBidders: false }, rules: { minStepPct: 1 }, locked: ['visibility', 'minStepPct'] });
    await setLimits({ features: { sourcing: false } });
    await reload();
    expect(sourcingOn(acme)).toBe(false);
    expect(acme.settings.sourcing?.enabled).toBe(true);
    await setLimits({ features: { sourcing: true }, sourcingFormats: ['rfq'] });
    await reload();
    expect(formatOn(acme, 'rfq')).toBe(true);
    expect(formatOn(acme, 'reverse')).toBe(false);
  });

  test('rules for an event: defaults, buyer choices within range, locks, value policies, sub-feature dependencies', async () => {
    await reload();
    const base = resolveRules(acme);
    expect(base).toMatchObject({ visibility: 'rank', minStepPct: 1, extensionMinutes: 5, envelope: 'single', openingQuorum: 2 });
    expect(resolveRules(acme, { extensionMinutes: 10, openingQuorum: 3 })).toMatchObject({ extensionMinutes: 10, openingQuorum: 3 });
    expect(() => resolveRules(acme, { visibility: 'ladder' })).toThrow(/set by your administrator/);
    expect(resolveRules(acme, { visibility: 'rank' }).visibility).toBe('rank'); // same as the locked value is fine
    expect(() => resolveRules(acme, { extensionMinutes: 99 })).toThrow(/at most 30/);
    expect(() => resolveRules(acme, { colour: 'red' } as any)).toThrow(/Unknown rule/);

    // Two envelopes above a value.
    const valued = { ...acme, settings: { ...acme.settings, sourcing: { ...acme.settings.sourcing, rules: { ...acme.settings.sourcing!.rules, twoEnvelopeAbove: 5_000_000 } } } } as Tenant;
    expect(resolveRules(valued, {}, { estimatedValue: 4_000_000 }).envelope).toBe('single');
    expect(resolveRules(valued, {}, { estimatedValue: 6_000_000 }).envelope).toBe('two');

    // Without auto-extension there are no extension rules.
    const noExt = { ...acme, settings: { ...acme.settings, sourcing: { ...acme.settings.sourcing, features: { autoExtension: false } } } } as Tenant;
    expect(resolveRules(noExt)).not.toHaveProperty('extensionMinutes');

    // A sub-feature that needs another plan feature (ERP) stays off without it.
    const noErp = { ...acme, limits: { ...acme.limits, features: { ...acme.limits.features, erp: false } } } as Tenant;
    expect(featureState(noErp, 'awardToErp')).toMatchObject({ on: false, chosen: true, needs: 'erp' });
    expect(featureState(acme, 'awardToErp').on).toBe(true);
  });
});
