/**
 * Live answers for registry and bank checks:
 *  - Registry connectors: a small HTTP lookup described in JSON (URL, headers, where the name and status are in the
 *    answer). Wathq (Saudi CR) is built in; other registries are added in REGISTRY_CONNECTORS once credentials exist.
 *  - KYC aggregator: one middleware URL that answers any check in a fixed format (docs/VERIFICATION.md).
 */
import type { CheckProvider, CheckResult } from '../../countries/types.js';

export interface ConnectorDef {
  /** Check it answers, e.g. "sa_cr" */
  kind: string;
  /** Provider name stored on each result, e.g. "wathq" */
  name: string;
  /** Shown in messages, e.g. "Wathq" */
  source: string;
  method?: 'GET' | 'POST';
  /** URL with {input} placeholders, e.g. https://api.wathq.sa/v5/commercialregistration/info/{cr} */
  url: string;
  /** Header values may use ${ENV_VAR} so keys stay out of the JSON */
  headers?: Record<string, string>;
  /** POST body; string values may use {input} placeholders */
  body?: Record<string, unknown>;
  /** HTTP statuses meaning "no such record" (default 404) */
  notFoundStatus?: number[];
  /** Dotted paths into the answer */
  namePath?: string;
  statusPath?: string;
  /** Status values that count as active (case-insensitive); others come back "not active" */
  activeValues?: string[];
  /** Extra values to keep with the result: label → dotted path */
  dataPaths?: Record<string, string>;
}

const get = (o: unknown, path?: string): unknown => (path ? path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o) : undefined);
const fillEnv = (v: string, envVars: Record<string, string | undefined>) => v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => envVars[k] ?? '');
const fillInput = (v: string, input: Record<string, string>, encode: boolean) => v.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => (encode ? encodeURIComponent(input[k] ?? '') : input[k] ?? ''));
function fillBody(b: unknown, input: Record<string, string>): unknown {
  if (typeof b === 'string') return fillInput(b, input, false);
  if (Array.isArray(b)) return b.map((x) => fillBody(x, input));
  if (b && typeof b === 'object') return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, fillBody(v, input)]));
  return b;
}

export function connectorProvider(d: ConnectorDef, envVars: Record<string, string | undefined> = process.env, fetchImpl: typeof fetch = fetch): CheckProvider {
  return {
    name: d.name, live: true,
    async check(kind, input): Promise<CheckResult> {
      if (kind !== d.kind) return { status: 'ERROR', message: `${d.source} does not answer ${kind}` };
      const headers: Record<string, string> = { Accept: 'application/json' };
      for (const [k, v] of Object.entries(d.headers ?? {})) headers[k] = fillEnv(v, envVars);
      const method = d.method ?? 'GET';
      if (method === 'POST') headers['Content-Type'] = 'application/json';
      let res: Response;
      try {
        res = await fetchImpl(fillInput(d.url, input, true), { method, headers, body: method === 'POST' ? JSON.stringify(fillBody(d.body ?? input, input)) : undefined, signal: AbortSignal.timeout(20_000) });
      } catch (e) { return { status: 'ERROR', message: `${d.source} could not be reached (${(e as Error).message})` }; }
      if ((d.notFoundStatus ?? [404]).includes(res.status)) return { status: 'NOT_FOUND', message: `Not found on ${d.source}` };
      if (!res.ok) return { status: 'ERROR', message: `${d.source} answered HTTP ${res.status}` };
      const body = await res.json().catch(() => ({}));
      const name = get(body, d.namePath);
      const status = get(body, d.statusPath);
      const data: Record<string, string> = { source: d.source };
      for (const [label, path] of Object.entries(d.dataPaths ?? {})) { const v = get(body, path); if (v !== undefined && v !== null) data[label] = String(v); }
      if (status !== undefined) data.status = String(status);
      const active = d.activeValues?.length ? d.activeValues.some((a) => a.toLowerCase() === String(status ?? '').toLowerCase()) : true;
      if (!active) return { status: 'NOT_FOUND', message: `Found on ${d.source}, but its status is “${status}”`, nameOnRecord: name ? String(name) : undefined, data };
      return { status: 'VERIFIED', message: `Active on ${d.source}`, nameOnRecord: name ? String(name) : undefined, data };
    },
  };
}

/** Saudi Commercial Registration through Wathq. Confirm the path and field names against your Wathq subscription. */
export const wathqCr = (baseUrl: string): ConnectorDef => ({
  kind: 'sa_cr', name: 'wathq', source: 'Wathq', method: 'GET',
  url: `${baseUrl.replace(/\/$/, '')}/info/{cr}?language=en`,
  headers: { apiKey: '${WATHQ_API_KEY}' },
  notFoundStatus: [400, 404], namePath: 'name', statusPath: 'status.name',
  activeValues: ['active', 'نشط', 'قائم'], dataPaths: { expiryDate: 'expiryDate', crNationalNumber: 'crNationalNumber' },
});

/** Any check, through a KYC aggregator / your own middleware (contract in docs/VERIFICATION.md). */
export function aggregatorProvider(o: { url: string; key?: string; fetchImpl?: typeof fetch }): CheckProvider {
  const doFetch = o.fetchImpl ?? fetch;
  return {
    name: 'aggregator', live: true,
    async check(kind, input, ctx): Promise<CheckResult> {
      let res: Response;
      try {
        res = await doFetch(`${o.url.replace(/\/$/, '')}/checks/${encodeURIComponent(kind)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(o.key ? { Authorization: `Bearer ${o.key}` } : {}) },
          body: JSON.stringify({ kind, input, legalName: ctx.legalName }), signal: AbortSignal.timeout(30_000),
        });
      } catch (e) { return { status: 'ERROR', message: `Verification service could not be reached (${(e as Error).message})` }; }
      if (!res.ok) return { status: 'ERROR', message: `Verification service answered HTTP ${res.status}` };
      const b = await res.json().catch(() => null) as Partial<CheckResult> | null;
      if (!b || !['VERIFIED', 'NOT_FOUND', 'ERROR'].includes(String(b.status))) return { status: 'ERROR', message: 'Verification service gave an answer VendorGate does not understand' };
      const data = b.data && typeof b.data === 'object' ? Object.fromEntries(Object.entries(b.data).map(([k, v]) => [k, String(v)])) : undefined;
      return { status: b.status as CheckResult['status'], message: String(b.message ?? (b.status === 'VERIFIED' ? 'Verified' : 'Not found')).slice(0, 500), nameOnRecord: b.nameOnRecord ? String(b.nameOnRecord) : undefined, data };
    },
  };
}
