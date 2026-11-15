/**
 * Public keys that verify on-prem licences. Licences are signed by Integratatech with the matching private key,
 * which is NEVER in this repository (keep it offline; see tools/licence/README.md).
 *
 * PRODUCTION: set by `npm run licence:keygen` (server). Until it is set, on-prem builds refuse to start in production.
 * DEV: for tests and local trials only — its private key is in tests/fixtures and is accepted only outside production.
 */
export const PRODUCTION_PUBLIC_KEY: string | null = null;

export const DEV_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAlGW5dFaoxIKodXiLMsOPrM17b3LP4L5blNTCZ2grtQo=
-----END PUBLIC KEY-----`;
