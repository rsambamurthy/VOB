/**
 * Registers live check providers from the server settings, check by check. Anything not set up stays in test mode.
 * Order of precedence for a check: its own registry connector → Wathq (sa_cr) → OpenSanctions (sanctions) → aggregator → test mode.
 */
import { env } from '../../lib/env.js';
import { logger } from '../../lib/logger.js';
import { allChecks, setKindProvider } from '../../countries/registry.js';
import { openSanctionsProvider } from './opensanctions.js';
import { aggregatorProvider, connectorProvider, wathqCr, type ConnectorDef } from './connectors.js';

export function parseConnectors(json?: string): ConnectorDef[] {
  if (!json?.trim()) return [];
  const list = JSON.parse(json) as ConnectorDef[];
  if (!Array.isArray(list)) throw new Error('REGISTRY_CONNECTORS must be a JSON array');
  for (const c of list) if (!c.kind || !c.url || !c.name) throw new Error('Each registry connector needs kind, name and url');
  return list;
}

export function registerLiveCheckProviders() {
  const i = env.int;
  const known = new Set(allChecks().map((c) => c.def.kind));
  const taken = new Set<string>();
  const set = (kind: string, p: Parameters<typeof setKindProvider>[1]) => { if (!taken.has(kind)) { setKindProvider(kind, p); taken.add(kind); } };

  for (const c of parseConnectors(i.REGISTRY_CONNECTORS)) {
    if (!known.has(c.kind)) logger.warn({ kind: c.kind }, 'REGISTRY_CONNECTORS: unknown check kind');
    set(c.kind, connectorProvider(c));
  }
  if (i.WATHQ_API_KEY) set('sa_cr', connectorProvider(wathqCr(i.WATHQ_CR_BASE_URL)));
  if (i.SANCTIONS_PROVIDER === 'opensanctions' && i.OPENSANCTIONS_API_KEY) {
    set('sanctions', openSanctionsProvider({ apiKey: i.OPENSANCTIONS_API_KEY, url: i.OPENSANCTIONS_URL, dataset: i.OPENSANCTIONS_DATASET, threshold: i.OPENSANCTIONS_THRESHOLD }));
  }
  if (i.KYC_AGGREGATOR_URL) {
    const agg = aggregatorProvider({ url: i.KYC_AGGREGATOR_URL, key: i.KYC_AGGREGATOR_KEY });
    const kinds = i.KYC_AGGREGATOR_KINDS.trim() === '*' ? [...known] : i.KYC_AGGREGATOR_KINDS.split(',').map((k) => k.trim()).filter(Boolean);
    // With "*", India's checks keep Surepass when KYC_PROVIDER=surepass.
    for (const k of kinds) if (!(i.KYC_AGGREGATOR_KINDS.trim() === '*' && i.KYC_PROVIDER === 'surepass' && ['gstin', 'pan', 'bank', 'cin'].includes(k))) set(k, agg);
  }
  if (taken.size) logger.info({ checks: [...taken] }, 'Live verification providers registered');
}
