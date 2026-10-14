import { afterAll, describe, expect, test } from 'vitest';
import { openSanctionsProvider } from '../src/integrations/checks/opensanctions.js';
import { aggregatorProvider, connectorProvider, wathqCr } from '../src/integrations/checks/connectors.js';
import { parseConnectors } from '../src/integrations/checks/index.js';
import { checkProviders, providerForKind, setKindProvider } from '../src/countries/registry.js';
import { gccMockChecks, ibanCheck, sanctionsCheck } from '../src/countries/gcc/index.js';
import { isSensitive, maskProfile, sealProfile, isSealed } from '../src/lib/fieldCrypto.js';
import { isKeyChange } from '../src/countries/registry.js';

type Call = { url: string; init: RequestInit };
const fakeFetch = (status: number, body: unknown, calls: Call[] = []) =>
  (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }) as unknown as typeof fetch;
const ctx = { legalName: 'Riyadh Industrial Supplies Co.' };

describe('live verification providers', () => {
  afterAll(() => { for (const k of ['sanctions', 'sa_cr', 'qa_cr']) setKindProvider(k, null); });

  test('sanctions input carries the owners; the test provider screens them too', async () => {
    const n = sanctionsCheck.normalise({ name: '  Riyadh  Supplies ', country: 'Saudi Arabia', owner1: 'Noura Al-Qahtani', owner2: '', owner3: 'Embargo Test Person' });
    expect(n.input).toEqual({ name: 'Riyadh Supplies', country: 'Saudi Arabia', owners: 'Noura Al-Qahtani|Embargo Test Person' });
    expect(n.masked).toBe('Riyadh Supplies + 2 owner(s)');
    const r = await gccMockChecks.check('sanctions', n.input, ctx);
    expect(r.status).toBe('NOT_FOUND');
    expect(r.message).toContain('Embargo Test Person');
  });

  test('OpenSanctions: screens company and owners in one request; no hit → clear', async () => {
    const calls: Call[] = [];
    const p = openSanctionsProvider({ apiKey: 'k1', url: 'https://api.opensanctions.org', dataset: 'sanctions', threshold: 0.8, fetchImpl: fakeFetch(200, { responses: { company: { results: [{ id: 'x', caption: 'Other Co', schema: 'Company', score: 0.4, match: false }] }, owner1: { results: [] } } }, calls) });
    const r = await p.check('sanctions', { name: 'Riyadh Supplies', country: 'Saudi Arabia', owners: 'Noura Al-Qahtani' }, ctx);
    expect(r.status).toBe('VERIFIED');
    expect(calls[0].url).toBe('https://api.opensanctions.org/match/sanctions?algorithm=best&threshold=0.8&limit=3');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('ApiKey k1');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.queries.company).toEqual({ schema: 'LegalEntity', properties: { name: ['Riyadh Supplies'], country: ['sa'] } });
    expect(body.queries.owner1).toEqual({ schema: 'Person', properties: { name: ['Noura Al-Qahtani'] } });
  });

  test('OpenSanctions: a hit on an owner is a possible match with the entity and lists', async () => {
    const p = openSanctionsProvider({ apiKey: 'k', url: 'https://x.test', dataset: 'default', threshold: 0.8, fetchImpl: fakeFetch(200, { responses: { company: { results: [] }, owner1: { results: [{ id: 'NK-abc', caption: 'Ivan Example', schema: 'Person', score: 0.93, match: true, datasets: ['us_ofac_sdn', 'eu_fsf'] }] } } }) });
    const r = await p.check('sanctions', { name: 'A Co', country: '', owners: 'Ivan Exampel' }, ctx);
    expect(r.status).toBe('NOT_FOUND');
    expect(r.message).toContain('Ivan Exampel');
    expect(r.message).toContain('93%');
    expect(r.data?.matches).toContain('us_ofac_sdn');
    expect(r.data?.topEntity).toContain('NK-abc');
  });

  test('OpenSanctions: service errors are errors, not "clear"', async () => {
    const p = openSanctionsProvider({ apiKey: 'k', url: 'https://x.test', dataset: 'sanctions', threshold: 0.8, fetchImpl: fakeFetch(401, { detail: 'bad key' }) });
    expect((await p.check('sanctions', { name: 'A Co', owners: '' }, ctx)).status).toBe('ERROR');
  });

  test('Wathq connector: active CR verified with its name; suspended is not active; 404 not found', async () => {
    const calls: Call[] = [];
    const env = { WATHQ_API_KEY: 'wk' };
    const ok = connectorProvider(wathqCr('https://api.wathq.sa/v5/commercialregistration'), env, fakeFetch(200, { name: 'شركة الرياض', status: { id: 1, name: 'active' }, expiryDate: '1448-01-01' }, calls));
    const r = await ok.check('sa_cr', { cr: '7001234567' }, ctx);
    expect(r).toMatchObject({ status: 'VERIFIED', message: 'Active on Wathq', nameOnRecord: 'شركة الرياض' });
    expect(r.data).toMatchObject({ status: 'active', expiryDate: '1448-01-01' });
    expect(calls[0].url).toBe('https://api.wathq.sa/v5/commercialregistration/info/7001234567?language=en');
    expect((calls[0].init.headers as Record<string, string>).apiKey).toBe('wk');
    const susp = connectorProvider(wathqCr('https://w.test'), env, fakeFetch(200, { name: 'X', status: { name: 'suspended' } }));
    expect((await susp.check('sa_cr', { cr: '1' }, ctx)).status).toBe('NOT_FOUND');
    const nf = connectorProvider(wathqCr('https://w.test'), env, fakeFetch(404, {}));
    expect((await nf.check('sa_cr', { cr: '1' }, ctx))).toMatchObject({ status: 'NOT_FOUND', message: 'Not found on Wathq' });
  });

  test('registry connectors from JSON: POST body placeholders and env secrets', async () => {
    const [def] = parseConnectors(JSON.stringify([{ kind: 'qa_cr', name: 'moci', source: 'MOCI', method: 'POST', url: 'https://moci.test/lookup', headers: { 'X-Key': '${MOCI_KEY}' }, body: { crNo: '{cr}' }, namePath: 'result.name' }]));
    const calls: Call[] = [];
    const p = connectorProvider(def, { MOCI_KEY: 'secret' }, fakeFetch(200, { result: { name: 'WEST BAY TRADING' } }, calls));
    expect(await p.check('qa_cr', { cr: '123456' }, ctx)).toMatchObject({ status: 'VERIFIED', nameOnRecord: 'WEST BAY TRADING' });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ crNo: '123456' });
    expect((calls[0].init.headers as Record<string, string>)['X-Key']).toBe('secret');
    expect(() => parseConnectors('[{"kind":"x"}]')).toThrow(/kind, name and url/);
  });

  test('aggregator: posts kind, input and legal name; validates the answer', async () => {
    const calls: Call[] = [];
    const p = aggregatorProvider({ url: 'https://kyc.test/', key: 'agg', fetchImpl: fakeFetch(200, { status: 'VERIFIED', message: 'Account open', nameOnRecord: 'RIYADH INDUSTRIAL', data: { bank: 'Al Rajhi', n: 3 } }, calls) });
    const r = await p.check('gcc_iban', { iban: 'SA03...', holder: 'Riyadh' }, ctx);
    expect(r).toMatchObject({ status: 'VERIFIED', nameOnRecord: 'RIYADH INDUSTRIAL', data: { bank: 'Al Rajhi', n: '3' } });
    expect(calls[0].url).toBe('https://kyc.test/checks/gcc_iban');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer agg');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ kind: 'gcc_iban', input: { iban: 'SA03...', holder: 'Riyadh' }, legalName: ctx.legalName });
    const odd = aggregatorProvider({ url: 'https://kyc.test', fetchImpl: fakeFetch(200, { ok: true }) });
    expect((await odd.check('qa_cr', {}, ctx)).status).toBe('ERROR');
  });

  test('a live provider for one check wins over the pack test provider, and the Integrations status says so', () => {
    expect(providerForKind('sa_cr')!.live).toBe(false);
    setKindProvider('sa_cr', connectorProvider(wathqCr('https://w.test'), {}, fakeFetch(200, {})));
    expect(providerForKind('sa_cr')!.name).toBe('wathq');
    expect(providerForKind('sa_vat')!.live).toBe(false);
    const sa = checkProviders('SA').find((p) => p.code === 'SA')!;
    expect(sa).toMatchObject({ live: false, partlyLive: true, provider: 'wathq + mock' });
    expect(sa.checks).toEqual([{ kind: 'sa_cr', label: 'Commercial Registration (Wathq)', provider: 'wathq', live: true }, { kind: 'sa_vat', label: 'VAT registration (ZATCA)', provider: 'mock', live: false }]);
    setKindProvider('sa_cr', null);
    expect(providerForKind('sa_cr')!.live).toBe(false);
  });

  test('Gulf IBAN check: format, masking, and the test provider', async () => {
    expect(ibanCheck.normalise({ iban: 'SA03 8000 0000 6080 1016 7519', holder: 'Riyadh' })).toMatchObject({ input: { iban: 'SA0380000000608010167519' }, masked: 'SA03••••7519', error: undefined });
    expect(ibanCheck.normalise({ iban: 'SA0380000000608010167518' }).error).toBeTruthy();
    expect((await gccMockChecks.check('gcc_iban', { iban: 'SA0380000000608010167519', holder: 'Riyadh Co' }, ctx))).toMatchObject({ status: 'VERIFIED', nameOnRecord: 'RIYADH CO' });
  });

  test('sensitive fields come from the packs: Qatar TIN and Oman tax card are encrypted and masked; CR changes are flagged', () => {
    for (const f of ['tax.pan', 'tax.tan', 'tax.foreignTin', 'bank.accountNumber', 'bank.iban', 'tax.tinNumber', 'tax.taxCardNumber']) expect(isSensitive(f)).toBe(true);
    expect(isSensitive('tax.vatNumber')).toBe(false);
    const sealed = sealProfile({ tax: { tinNumber: '5012345671', crNumber: '123456' } });
    expect(isSealed(sealed.tax.tinNumber)).toBe(true);
    expect(sealed.tax.crNumber).toBe('123456');
    expect(maskProfile({ tax: { tinNumber: '5012345671' } }).tax.tinNumber).toBe('501•••••71');
    for (const f of ['bank.iban', 'tax.gstin', 'tax.crNumber', 'tax.vatNumber', 'basic.nameArabic', 'tax.tinNumber', 'basic.vendorName']) expect(isKeyChange(f)).toBe(true);
    expect(isKeyChange('basic.address')).toBe(false);
  });
});
