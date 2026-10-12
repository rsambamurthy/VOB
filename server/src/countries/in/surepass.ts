/**
 * Surepass adapter. Paths and the base URL are configurable (SUREPASS_*), because providers
 * version their APIs — confirm them against your Surepass dashboard / sandbox before going live.
 * Response parsing is defensive: it looks for the commonly used field names and keeps the rest.
 */
import type { CheckProvider, CheckResult } from '../types.js';

type Kind = 'gstin' | 'pan' | 'bank' | 'cin';

interface Cfg { baseUrl: string; token: string; paths: Record<Kind, string> }

const pick = (o: Record<string, unknown> | undefined, ...keys: string[]) => {
  for (const k of keys) { const v = o?.[k]; if (v !== undefined && v !== null && v !== '') return String(v); }
  return undefined;
};

export function surepassChecks(cfg: Cfg, fetchImpl: typeof fetch = fetch): CheckProvider {
  return {
    name: 'surepass', live: true,
    async check(kind, input) {
      if (!(kind in cfg.paths)) return { status: 'ERROR', message: `Surepass doesn’t run ${kind} checks` };
      const body = kind === 'gstin' ? { id_number: input.gstin }
        : kind === 'pan' ? { id_number: input.pan }
        : kind === 'bank' ? { id_number: input.accountNumber, ifsc: input.ifsc, ifsc_details: true }
        : { id_number: input.cin };
      let res: Response;
      try {
        res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, '')}${cfg.paths[kind as Kind]}`, {
          method: 'POST', headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (e: any) {
        return { status: 'ERROR', message: `Verification service unreachable (${e?.name === 'TimeoutError' ? 'timeout' : 'network'}). Try again later.` };
      }
      const json = await res.json().catch(() => ({})) as { success?: boolean; message?: string; message_code?: string; data?: Record<string, unknown> };
      const d = json.data ?? {};
      if (res.status === 401 || res.status === 403) return { status: 'ERROR', message: 'Verification provider rejected our credentials — contact support' };
      if (res.status === 429) return { status: 'ERROR', message: 'Verification provider rate limit reached. Try again in a minute.' };
      if (res.status >= 500) return { status: 'ERROR', message: `Verification provider error (${res.status}). Try again later.` };
      if (!json.success || res.status === 404 || res.status === 422) return { status: 'NOT_FOUND', message: json.message || 'No record found' };
      return parse(kind as Kind, d);
    },
  };
}

function parse(kind: Kind, d: Record<string, unknown>): CheckResult {
  if (kind === 'gstin') {
    const st = pick(d, 'gstin_status', 'status');
    const active = !st || /active/i.test(st);
    return { status: active ? 'VERIFIED' : 'NOT_FOUND', message: active ? 'GSTIN is active' : `GSTIN status: ${st}`, nameOnRecord: pick(d, 'legal_name', 'business_name', 'trade_name'),
      data: clean({ tradeName: pick(d, 'business_name', 'trade_name'), gstStatus: st, taxpayerType: pick(d, 'taxpayer_type', 'constitution_of_business'), registeredOn: pick(d, 'date_of_registration', 'registration_date'), address: pick(d, 'address') }) };
  }
  if (kind === 'pan') {
    return { status: 'VERIFIED', message: 'PAN is valid', nameOnRecord: pick(d, 'full_name', 'name', 'registered_name'),
      data: clean({ category: pick(d, 'category', 'pan_type'), aadhaarLinked: pick(d, 'aadhaar_linked', 'aadhaar_seeding_status') }) };
  }
  if (kind === 'bank') {
    const exists = pick(d, 'account_exists', 'is_valid');
    if (exists && /^(false|0|no)$/i.test(exists)) return { status: 'NOT_FOUND', message: 'Bank account not found / penny-drop failed' };
    const ifsc = (d.ifsc_details ?? {}) as Record<string, unknown>;
    return { status: 'VERIFIED', message: 'Penny-drop succeeded', nameOnRecord: pick(d, 'full_name', 'name_at_bank', 'beneficiary_name'),
      data: clean({ bank: pick(ifsc, 'bank_name', 'bank'), branch: pick(ifsc, 'branch'), city: pick(ifsc, 'city') }) };
  }
  const st = pick(d, 'company_status', 'status');
  return { status: !st || /active/i.test(st) ? 'VERIFIED' : 'NOT_FOUND', message: st ? `MCA status: ${st}` : 'Company found on MCA', nameOnRecord: pick(d, 'company_name', 'name'),
    data: clean({ companyStatus: st, incorporated: pick(d, 'date_of_incorporation', 'incorporation_date'), category: pick(d, 'company_category', 'class_of_company') }) };
}

const clean = (o: Record<string, string | undefined>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v)) as Record<string, string>;
