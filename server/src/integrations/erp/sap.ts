/**
 * SAP S/4HANA (Cloud or on-premise) supplier connector — OData v2 API_BUSINESS_PARTNER.
 *
 *  CREATE  — deep insert of A_BusinessPartner: organisation BP with the supplier roles (FLVN00/FLVN01),
 *            address + email, tax number, bank account, and the company code / purchasing org extensions.
 *  UPDATE  — PATCH the BP name and search term (deep updates aren't supported by the API).
 *  BLOCK / UNBLOCK — PATCH A_Supplier posting and purchasing blocks.
 *
 * Every write first fetches a CSRF token (x-csrf-token: Fetch) and sends it back with the session cookies.
 * Auth: a communication user (Basic). In S/4HANA Cloud use communication scenario SAP_COM_0008.
 */
import type { Vendor } from '../../db/schema.js';
import { toGenericVendor } from '../../lib/erpMapper.js';
import { ErpError, request, type Connection, type ErpEvent, type SendResult } from './drivers.js';

export const SAP_BP_PATH = '/sap/opu/odata/sap/API_BUSINESS_PARTNER';
const base = (c: Connection) => `${(c.config.url ?? '').replace(/\/+$/, '')}${SAP_BP_PATH}`;
const basic = (c: Connection) => `Basic ${Buffer.from(`${c.config.username ?? ''}:${c.secrets.password ?? ''}`).toString('base64')}`;
const cut = (s: string | undefined, n: number) => (s ?? '').slice(0, n);
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Fetch a CSRF token and the session cookies that go with it. */
export async function sapCsrf(c: Connection) {
  const r = await request('GET', `${base(c)}/`, undefined, { Authorization: basic(c), 'x-csrf-token': 'Fetch', Accept: 'application/json' });
  const token = r.headers.get('x-csrf-token');
  if (!token) throw new ErpError('SAP didn’t return a CSRF token — check the communication user’s authorisations');
  const cookies = (typeof (r.headers as any).getSetCookie === 'function' ? (r.headers as any).getSetCookie() as string[] : [r.headers.get('set-cookie') ?? '']).filter(Boolean).map((x) => x.split(';')[0]);
  return { token, cookie: cookies.join('; ') };
}

/** Tax category: GSTIN → IN3; elsewhere the VAT/TRN number under "<country>0" unless the connection says otherwise. */
function taxes(v: Vendor, c: Connection, country: string) {
  const tax = ((v.profile ?? {}) as any).tax ?? {};
  const out: { BPTaxType: string; BPTaxNumber: string }[] = [];
  if (tax.gstin) out.push({ BPTaxType: c.config.taxType || 'IN3', BPTaxNumber: String(tax.gstin) });
  else if (tax.vatNumber) out.push({ BPTaxType: c.config.taxType || `${country}0`, BPTaxNumber: String(tax.vatNumber) });
  return out;
}

export function toSapBusinessPartner(v: Vendor, c: Connection) {
  const g = toGenericVendor(v);
  const country = g.address.country || 'IN';
  const bank = g.bank.accountNumber || g.bank.iban ? [{
    BankIdentification: '0001', BankCountryKey: g.bank.country || country, BankNumber: cut(g.bank.ifsc || g.bank.swift, 15), SWIFTCode: cut(g.bank.swift, 11),
    BankAccount: cut(g.bank.accountNumber, 18), IBAN: cut(g.bank.iban, 34), BankAccountHolderName: cut(g.bank.accountName || g.name, 60),
  }] : [];
  return {
    BusinessPartnerCategory: '2',
    ...(c.config.grouping ? { BusinessPartnerGrouping: c.config.grouping } : {}),
    OrganizationBPName1: cut(g.name, 40), OrganizationBPName2: cut(g.name.slice(40), 40), SearchTerm1: cut(g.code, 20),
    to_BusinessPartnerAddress: { results: [{
      Country: country, CityName: cut(g.address.city, 40), PostalCode: cut(g.address.postalCode, 10), StreetName: cut(g.address.line1, 60), Language: 'EN',
      ...(g.contact.email ? { to_EmailAddress: { results: [{ EmailAddress: cut(g.contact.email, 241) }] } } : {}),
      ...(g.contact.mobile ? { to_MobilePhoneNumber: { results: [{ PhoneNumber: cut(g.contact.mobile, 30) }] } } : {}),
    }] },
    to_BusinessPartnerRole: { results: [{ BusinessPartnerRole: 'FLVN00' }, { BusinessPartnerRole: 'FLVN01' }] },
    to_BusinessPartnerTax: { results: taxes(v, c, country) },
    to_BusinessPartnerBank: { results: bank },
    to_Supplier: {
      ...(c.config.companyCode ? { to_SupplierCompany: { results: [{ CompanyCode: c.config.companyCode }] } } : {}),
      ...(c.config.purchasingOrg ? { to_SupplierPurchasingOrg: { results: [{ PurchasingOrganization: c.config.purchasingOrg }] } } : {}),
    },
  };
}

export async function sapSend(c: Connection, v: Vendor, event: ErpEvent, ctx: { syncId: string }): Promise<SendResult> {
  const g = toGenericVendor(v);
  let method = 'POST', url = `${base(c)}/A_BusinessPartner`, body: unknown;
  if ((event === 'BLOCK' || event === 'UNBLOCK') && v.erpVendorId) {
    method = 'PATCH'; url = `${base(c)}/A_Supplier(${q(v.erpVendorId)})`;
    body = { PostingIsBlocked: event === 'BLOCK', PurchasingIsBlocked: event === 'BLOCK' };
  } else if (v.erpVendorId) {
    method = 'PATCH'; url = `${base(c)}/A_BusinessPartner(${q(v.erpVendorId)})`;
    body = { OrganizationBPName1: cut(g.name, 40), OrganizationBPName2: cut(g.name.slice(40), 40), SearchTerm1: cut(g.code, 20) };
  } else body = toSapBusinessPartner(v, c);
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Idempotency-Key': ctx.syncId };
  const result: SendResult = { target: `${method} ${url}`, request: { body, headers: { ...headers, Authorization: 'Basic •••', 'x-csrf-token': '•••' } } };
  if (c.testMode) return result;
  if (!c.config.url) throw new ErpError('Set the SAP system URL first');
  const { token, cookie } = await sapCsrf(c);
  const r = await request(method, url, JSON.stringify(body), { ...headers, Authorization: basic(c), 'x-csrf-token': token, ...(cookie ? { Cookie: cookie } : {}) });
  let id: string | null = null;
  try { id = JSON.parse(r.text)?.d?.BusinessPartner ?? null; } catch { /* PATCH answers 204 with no body */ }
  return { ...result, httpStatus: r.status, response: r.text, erpVendorId: id };
}

export async function sapTest(c: Connection) {
  if (!c.config.url) return { ok: false, message: 'Enter the SAP system URL first.' };
  try { await sapCsrf(c); return { ok: true, message: 'Signed in to SAP and got a CSRF token for API_BUSINESS_PARTNER.' }; }
  catch (e: any) { return { ok: false, message: e?.httpStatus === 401 || e?.httpStatus === 403 ? `SAP refused the communication user (${e.httpStatus}).` : String(e?.message ?? e) }; }
}

/** Headers for posting order messages to the SAP-side middleware (Basic auth with the same user). */
export const sapMessageAuth = (c: Connection) => ({ Authorization: basic(c) });
