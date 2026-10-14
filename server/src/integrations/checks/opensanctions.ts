/**
 * Sanctions screening through the OpenSanctions matching API (https://www.opensanctions.org/docs/api/).
 * The supplier is screened as a company and each listed owner as a person, in one request.
 */
import type { CheckProvider, CheckResult } from '../../countries/types.js';
import { isoFor } from '../../countries/list.js';

export interface OpenSanctionsOptions { apiKey: string; url: string; dataset: string; threshold: number; fetchImpl?: typeof fetch }

interface MatchResult { id: string; caption: string; schema: string; score: number; match?: boolean; datasets?: string[] }

export function openSanctionsProvider(o: OpenSanctionsOptions): CheckProvider {
  const doFetch = o.fetchImpl ?? fetch;
  return {
    name: 'opensanctions', live: true,
    async check(kind, input): Promise<CheckResult> {
      if (kind !== 'sanctions') return { status: 'ERROR', message: `OpenSanctions does not answer ${kind}` };
      const country = isoFor(input.country ?? '')?.toLowerCase();
      const queries: Record<string, { schema: string; properties: Record<string, string[]> }> = {
        company: { schema: 'LegalEntity', properties: { name: [input.name], ...(country ? { country: [country] } : {}) } },
      };
      const owners = (input.owners ?? '').split('|').filter(Boolean);
      owners.forEach((n, i) => { queries[`owner${i + 1}`] = { schema: 'Person', properties: { name: [n] } }; });
      const url = `${o.url.replace(/\/$/, '')}/match/${encodeURIComponent(o.dataset)}?algorithm=best&threshold=${o.threshold}&limit=3`;
      let res: Response;
      try {
        res = await doFetch(url, { method: 'POST', headers: { Authorization: `ApiKey ${o.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ queries }), signal: AbortSignal.timeout(20_000) });
      } catch (e) {
        return { status: 'ERROR', message: `Sanctions screening service could not be reached (${(e as Error).message})` };
      }
      if (!res.ok) return { status: 'ERROR', message: `Sanctions screening service answered HTTP ${res.status}` };
      const body = await res.json() as { responses?: Record<string, { results?: MatchResult[] }> };
      const hits: { who: string; r: MatchResult }[] = [];
      for (const [q, out] of Object.entries(body.responses ?? {})) {
        const who = q === 'company' ? input.name : owners[Number(q.replace('owner', '')) - 1];
        for (const r of out.results ?? []) if (r.match || r.score >= o.threshold) hits.push({ who, r });
      }
      const screened = 1 + owners.length;
      if (!hits.length) {
        return { status: 'VERIFIED', message: `No match on sanctions lists (OpenSanctions “${o.dataset}”) for the company${owners.length ? ` and ${owners.length} owner(s)` : ''}`, data: { provider: 'OpenSanctions', dataset: o.dataset, screened: String(screened) } };
      }
      hits.sort((a, b) => b.r.score - a.r.score);
      const top = hits[0];
      const summary = hits.slice(0, 3).map((h) => `${h.who} → ${h.r.caption} (${Math.round(h.r.score * 100)}%${h.r.datasets?.length ? `, ${h.r.datasets.slice(0, 3).join(', ')}` : ''})`).join('; ');
      return {
        status: 'NOT_FOUND',
        message: `Possible match for “${top.who}”: ${top.r.caption} (${Math.round(top.r.score * 100)}% match) — a reviewer must check before approving`,
        data: { provider: 'OpenSanctions', matches: summary, topEntity: `https://www.opensanctions.org/entities/${top.r.id}/`, screened: String(screened) },
      };
    },
  };
}
