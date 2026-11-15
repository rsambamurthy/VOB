/** Facts for the AI worked out on our server (privacy mode): yes/no comparisons, peers, precision. */
import { describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/lib/db.js';
import { indiaConsistencyFacts, stateKey } from '../src/countries/in/consistency.js';
import { comparisons, comparisonConcerns, describeAge, describeTurnover, peerComparison, termsDaysOf } from '../src/services/aiFacts.js';
import { submittedVendor } from './helpers.js';

const base = { basic: { supplierCountry: 'India', region: 'Tamil Nadu', postalCode: '600041', entityType: 'Company (Pvt / Public Ltd)' }, tax: { gstin: '33AAJCI1277P1Z4', pan: 'AAJCI1277P' } };

describe('AI facts', () => {
  test('India: GSTIN state, PIN code and PAN type compared locally — yes/no only', () => {
    expect(indiaConsistencyFacts(base)).toEqual({
      'GSTIN state matches the address state': true, 'PIN code matches the address state': true,
      'PAN inside the GSTIN matches the PAN given': true, 'PAN type matches the type of entity': true,
    });
    const odd = indiaConsistencyFacts({ ...base, basic: { ...base.basic, region: 'Karnataka', postalCode: '411001', entityType: 'Partnership Firm' } });
    expect(odd['GSTIN state matches the address state']).toBe(false);
    expect(odd['PIN code matches the address state']).toBe(false);
    expect(odd['PAN type matches the type of entity']).toBe(false);
    // Unknown state spelling: not judged rather than wrongly flagged.
    expect(indiaConsistencyFacts({ ...base, basic: { ...base.basic, region: 'Somewhere' } })).not.toHaveProperty('GSTIN state matches the address state');
    expect(stateKey('Orissa')).toBe(stateKey('Odisha'));
    expect(stateKey('TN')).toBe('tamilnadu');
    // Not Indian: nothing.
    expect(indiaConsistencyFacts({ ...base, basic: { ...base.basic, supplierCountry: 'Germany' } })).toEqual({});
  });

  test('general comparisons and which of them become findings', () => {
    const v = { name: 'Integratatech.ai Private Limited', contactEmail: 'info@gmail.com', profile: { ...base, basic: { ...base.basic, websiteUrl: 'https://integratatech.ai' }, bank: { accountHolderName: 'Someone Else Traders', bankCountry: 'India' } } } as any;
    const c = comparisons(v);
    expect(c['Contact email is a free webmail address']).toBe(true);
    expect(c['Bank account holder name matches the company name']).toBe(false);
    expect(c['Bank is in the supplier’s country']).toBe(true);
    expect(c['GSTIN state matches the address state']).toBe(true);
    const own = comparisons({ ...v, contactEmail: 'info@integratatech.ai', profile: { ...v.profile, bank: { accountHolderName: 'INTEGRATATECH.AI PVT LTD', bankCountry: 'India' } } });
    expect(own).toMatchObject({ 'Contact email is a free webmail address': false, 'Contact email domain resembles the company name': true, 'Contact email domain is the same as the website': true, 'Bank account holder name matches the company name': true });
    expect(comparisonConcerns(own)).toEqual([]);
    expect(comparisonConcerns(c).map((x) => x.severity).sort()).toEqual(['info', 'medium']);
  });

  test('amounts as ranges or exact; payment terms in days', () => {
    expect(describeTurnover(42_500_000, 'INR', 'ranges')).toBe('10–100 million INR');
    expect(describeTurnover(42_500_000, 'INR', 'exact')).toBe('42,500,000 INR');
    expect(describeAge(7, 'ranges')).toBe('5–10 years');
    expect(describeAge(7, 'exact')).toBe('7 years');
    expect(termsDaysOf({ basic: { paymentTerms: 'Net 45' } })).toBe(45);
    expect(termsDaysOf({ basic: { paymentTerms: 'Advance' } })).toBe(0);
  });

  test('peers: where the supplier sits among approved suppliers — only with 5 or more to compare', async () => {
    const { id } = await submittedVendor('Peerless Pumps Ltd', 'peer1@facts.test');
    const v = (await db.query.vendors.findFirst({ where: eq(schema.vendors.id, id) }))!;
    // A workspace of its own, so other tests' suppliers don't move the numbers.
    const [t] = await db.insert(schema.tenants).values({ slug: `peers-${Date.now()}`, name: 'Peers Co' }).returning();
    const p = v.profile as any;
    const year = new Date().getFullYear();
    const peer = (i: number, turnover: string, age: number, terms: string) => ({ ...v, id: undefined, tenantId: t.id, code: `P${i}-${Date.now()}`, name: `Peer ${i}`, inviteToken: `peer-${i}-${Date.now()}-${Math.random()}`, status: 'APPROVED' as const,
      profile: { ...p, risk: { ...p.risk, annualTurnover: turnover, currency: 'INR' }, basic: { ...p.basic, yearEstablished: String(year - age), paymentTerms: terms } } });
    const add = (rows: ReturnType<typeof peer>[]) => db.insert(schema.vendors).values(rows.map(({ id: _i, ...r }) => r) as any);
    await add([peer(1, '1000000', 5, 'Net 30'), peer(2, '2000000', 8, 'Net 30'), peer(3, '5000000', 12, 'Net 45'), peer(4, '8000000', 20, 'Net 30')]);
    expect(await peerComparison(t, v)).toBeNull(); // only 4
    await add([peer(5, '9000000', 30, 'Net 60'), peer(6, '20000000', 3, 'Net 30')]);
    const me = (turnover: string, age: number, terms: string) => ({ ...v, profile: { ...p, risk: { ...p.risk, annualTurnover: turnover, currency: 'INR' }, basic: { ...p.basic, yearEstablished: String(year - age), paymentTerms: terms } } });
    const big = await peerComparison(t, me('50000000', 1, 'Net 90'));
    expect(big).toEqual({ comparedWith: '6 approved domestic suppliers of goods', annualTurnover: 'higher than 100% of them', companyAge: 'lower than 100% of them', requestedPaymentTerms: 'higher than 100% of them (typical: Net 30)' });
    const mid = await peerComparison(t, me('5000000', 12, 'Net 30'));
    expect(mid?.annualTurnover).toBe('higher than 33%, the same as 17%, lower than 50% of them');
  });
});
