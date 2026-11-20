/** The e-signature connectors (see types.ts) and the workspace's chosen one with its decrypted credentials. */
import { decrypt, encrypt } from '../../lib/crypto.js';
import { adobe } from './adobe.js';
import { digio } from './digio.js';
import { docusign } from './docusign.js';
import { testProvider } from './test.js';
import { uaepass } from './uaepass.js';
import { zoho } from './zoho.js';
import type { Cfg, ESignProvider } from './types.js';

export * from './types.js';
export const PROVIDERS: Record<string, ESignProvider> = { test: testProvider, docusign, adobe, zoho, digio, uaepass };
export const providerOf = (key: string) => PROVIDERS[key] ?? null;

/** What the settings store: the provider, sandbox or live, and the credentials encrypted as one string. */
export interface ESignSettings { provider?: string; sandbox?: boolean; credentials?: string }
export function sealCredentials(values: Record<string, string>) { return encrypt(JSON.stringify(values)); }
export function openCredentials(s: ESignSettings): Record<string, string> {
  if (!s.credentials) return {};
  try { return JSON.parse(decrypt(s.credentials)); } catch { return {}; }
}
export const cfgOf = (s: ESignSettings): Cfg => ({ ...openCredentials(s), sandbox: s.sandbox === false ? 'false' : 'true' });
/** Settings for screens: which secrets are set, never their values. */
export function esignView(s: ESignSettings | undefined) {
  const creds = s ? openCredentials(s) : {};
  return {
    provider: s?.provider ?? null, sandbox: s?.sandbox !== false,
    values: Object.fromEntries(Object.entries(creds).filter(([k]) => !PROVIDERS[s?.provider ?? '']?.fields.find((f) => f.key === k)?.secret)),
    secretsSet: Object.keys(creds).filter((k) => PROVIDERS[s?.provider ?? '']?.fields.find((f) => f.key === k)?.secret && creds[k]),
    providers: Object.values(PROVIDERS).map((p) => ({ key: p.key, label: p.label, kind: p.kind, help: p.help, methods: p.methods, fields: p.fields })),
  };
}
