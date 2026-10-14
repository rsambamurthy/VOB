/**
 * Microsoft Dynamics 365 Finance & Operations supplier connector — OData data entities.
 *
 *  CREATE  — POST data/VendorsV2 (account number = the VendorGate vendor code), then data/VendorBankAccounts.
 *  UPDATE  — PATCH VendorsV2(dataAreaId,VendorAccountNumber) name and address.
 *  BLOCK / UNBLOCK — PATCH OnHoldStatus to All / No.
 *
 * Auth: Microsoft Entra ID app registration, OAuth 2.0 client credentials (scope "<environment URL>/.default").
 * Register the app under System administration → Microsoft Entra ID applications in F&O.
 */
import type { Vendor } from '../../db/schema.js';
import { toGenericVendor } from '../../lib/erpMapper.js';
import { ErpError, request, type Connection, type ErpEvent, type SendResult } from './drivers.js';

const ISO3: Record<string, string> = {
  IN: 'IND', SA: 'SAU', AE: 'ARE', BH: 'BHR', QA: 'QAT', KW: 'KWT', OM: 'OMN', US: 'USA', GB: 'GBR', DE: 'DEU', FR: 'FRA', SG: 'SGP', CN: 'CHN', JP: 'JPN',
  EG: 'EGY', JO: 'JOR', LK: 'LKA', BD: 'BGD', NP: 'NPL', PK: 'PAK', MY: 'MYS', ID: 'IDN', TH: 'THA', VN: 'VNM', AU: 'AUS', CA: 'CAN', NL: 'NLD', IT: 'ITA', ES: 'ESP', CH: 'CHE', TR: 'TUR', KR: 'KOR', HK: 'HKG', ZA: 'ZAF',
};
export const iso3 = (c: string) => ISO3[c] ?? c;
const env_ = (c: Connection) => (c.config.url ?? '').replace(/\/+$/, '');
const cut = (s: string | undefined, n: number) => (s ?? '').slice(0, n);
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

const tokens = new Map<string, { token: string; until: number }>();
export async function dynamicsToken(c: Connection) {
  const key = `${c.config.tenantId}|${c.config.clientId}|${env_(c)}`;
  const hit = tokens.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  if (!c.config.tenantId || !c.config.clientId || !c.secrets.clientSecret) throw new ErpError('Enter the Azure tenant, app (client) id and client secret first');
  const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: c.config.clientId, client_secret: c.secrets.clientSecret, scope: `${env_(c)}/.default` });
  const r = await request('POST', `https://login.microsoftonline.com/${encodeURIComponent(c.config.tenantId)}/oauth2/v2.0/token`, form.toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
  const j = JSON.parse(r.text) as { access_token?: string; expires_in?: number };
  if (!j.access_token) throw new ErpError('Microsoft sign-in didn’t return a token');
  tokens.set(key, { token: j.access_token, until: Date.now() + Math.max(60, (j.expires_in ?? 3600) - 120) * 1000 });
  return j.access_token;
}
/** Tests. */
export const clearDynamicsTokens = () => tokens.clear();

export function toDynamicsVendor(v: Vendor, c: Connection) {
  const g = toGenericVendor(v);
  const tax = ((v.profile ?? {}) as any).tax ?? {};
  return {
    dataAreaId: c.config.dataAreaId, VendorAccountNumber: g.code, VendorOrganizationName: cut(g.name, 100),
    ...(c.config.vendorGroup ? { VendorGroupId: c.config.vendorGroup } : {}),
    AddressCountryRegionId: iso3(g.address.country || 'IN'), AddressCity: cut(g.address.city, 60), AddressZipCode: cut(g.address.postalCode, 10),
    AddressStreet: cut([g.address.line1, g.address.line2].filter(Boolean).join('\n'), 250), AddressState: cut(g.address.state, 10),
    PrimaryEmailAddress: cut(g.contact.email, 255), PrimaryPhoneNumber: cut(g.contact.mobile, 255),
    TaxExemptNumber: cut(tax.gstin || tax.vatNumber || '', 20),
    OnHoldStatus: g.blocked ? 'All' : 'No',
  };
}

export function toDynamicsBank(v: Vendor, c: Connection) {
  const g = toGenericVendor(v);
  if (!g.bank.accountNumber && !g.bank.iban) return null;
  return {
    dataAreaId: c.config.dataAreaId, VendorAccountNumber: g.code, BankAccountId: 'MAIN', Name: cut(g.bank.bankName || 'Main account', 60),
    BankAccountNumber: cut(g.bank.accountNumber, 34), RoutingNumber: cut(g.bank.ifsc, 20), SWIFTCode: cut(g.bank.swift, 20), IBAN: cut(g.bank.iban, 34),
    AddressCountryRegionId: iso3(g.bank.country || g.address.country || 'IN'),
  };
}

export async function dynamicsSend(c: Connection, v: Vendor, event: ErpEvent, ctx: { syncId: string }): Promise<SendResult> {
  const area = c.config.dataAreaId ?? '';
  const key = `${env_(c)}/data/VendorsV2(dataAreaId=${q(area)},VendorAccountNumber=${q(v.erpVendorId ?? '')})?cross-company=true`;
  let method = 'POST', url = `${env_(c)}/data/VendorsV2?cross-company=true`, body: unknown;
  const bank = !v.erpVendorId ? toDynamicsBank(v, c) : null;
  if ((event === 'BLOCK' || event === 'UNBLOCK') && v.erpVendorId) { method = 'PATCH'; url = key; body = { OnHoldStatus: event === 'BLOCK' ? 'All' : 'No' }; }
  else if (v.erpVendorId) { method = 'PATCH'; url = key; const { dataAreaId: _a, VendorAccountNumber: _n, OnHoldStatus: _h, ...rest } = toDynamicsVendor(v, c); body = rest; }
  else body = toDynamicsVendor(v, c);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json', 'OData-Version': '4.0', 'X-Idempotency-Key': ctx.syncId };
  const result: SendResult = { target: `${method} ${url}`, request: { body: bank ? { vendor: body, bankAccount: bank } : body, headers: { ...headers, Authorization: 'Bearer •••' } } };
  if (c.testMode) return result;
  if (!c.config.url || !area) throw new ErpError('Set the Dynamics environment URL and legal entity first');
  const auth = { Authorization: `Bearer ${await dynamicsToken(c)}` };
  const r = await request(method, url, JSON.stringify(body), { ...headers, ...auth });
  let id: string | null = null;
  try { id = JSON.parse(r.text)?.VendorAccountNumber ?? null; } catch { /* PATCH answers 204 */ }
  let response = r.text;
  if (bank) {
    try { await request('POST', `${env_(c)}/data/VendorBankAccounts?cross-company=true`, JSON.stringify(bank), { ...headers, ...auth }); }
    catch (e: any) { response = `${response}\n\nVendor created, but the bank account wasn’t: ${e?.message ?? e}`; }
  }
  return { ...result, httpStatus: r.status, response, erpVendorId: id };
}

export async function dynamicsTest(c: Connection) {
  if (!c.config.url) return { ok: false, message: 'Enter the Dynamics environment URL first.' };
  try {
    const token = await dynamicsToken(c);
    await request('GET', `${env_(c)}/data/VendorsV2?$top=1&cross-company=true`, undefined, { Authorization: `Bearer ${token}`, Accept: 'application/json' });
    return { ok: true, message: 'Signed in with the app registration and read the vendor list.' };
  } catch (e: any) { return { ok: false, message: String(e?.message ?? e) }; }
}

export const dynamicsMessageAuth = async (c: Connection) => ({ Authorization: `Bearer ${await dynamicsToken(c)}` });
