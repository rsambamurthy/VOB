/**
 * Integratatech's licence tool (never shipped to customers).
 *
 *   npm run licence -- keygen
 *       Makes the signing key pair once: the PRIVATE key goes to ~/.vendorgate/licence-signing-key.pem (keep it offline,
 *       backed up, never in git); the PUBLIC key is written into src/lib/licenceKeys.ts — commit that.
 *
 *   npm run licence -- issue --customer "Acme Industries Ltd" --id VG-2026-0001 --from 2026-12-01 --until 2027-11-30 \
 *       --users 50 --vendors 5000 [--no-ai] [--no-erp] [--no-kyc] [--no-collab] [--sourcing all|rfq,reverse] [--grace 15] [--key <private.pem>] [--out <file>]
 *
 *   npm run licence -- show <file>      check a licence file and print what it contains
 */
import fs from 'node:fs';
import { SOURCING_FORMAT_KEYS, type SourcingFormat } from '../src/lib/features.js';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { signLicence, verifyLicence, licenceState, type Licence } from '../src/lib/licence.js';

const [cmd, ...args] = process.argv.slice(2);
const defaultKey = path.join(os.homedir(), '.vendorgate', 'licence-signing-key.pem');
const die = (m: string): never => { console.error(m); process.exit(1); };

if (cmd === 'keygen') {
  if (fs.existsSync(defaultKey)) die(`A signing key already exists at ${defaultKey}. Licences issued with it would stop working if it were replaced — not overwriting.`);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(defaultKey), { recursive: true, mode: 0o700 });
  fs.writeFileSync(defaultKey, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const pub = String(publicKey.export({ type: 'spki', format: 'pem' })).trim();
  const keysFile = path.resolve('src/lib/licenceKeys.ts');
  const src = fs.readFileSync(keysFile, 'utf8').replace(/export const PRODUCTION_PUBLIC_KEY: string \| null = [^;]+;/s, `export const PRODUCTION_PUBLIC_KEY: string | null = \`${pub}\`;`);
  fs.writeFileSync(keysFile, src);
  console.log(`Private signing key: ${defaultKey}\n  Keep it offline and backed up (e.g. in a password manager). Anyone with it can issue licences.\nPublic key written to src/lib/licenceKeys.ts — commit it and rebuild the image.`);
} else if (cmd === 'issue') {
  const { values } = parseArgs({ args, options: { customer: { type: 'string' }, id: { type: 'string' }, from: { type: 'string' }, until: { type: 'string' }, users: { type: 'string' }, vendors: { type: 'string' },
    'no-ai': { type: 'boolean' }, 'no-erp': { type: 'boolean' }, 'no-kyc': { type: 'boolean' }, 'no-collab': { type: 'boolean' }, sourcing: { type: 'string' }, grace: { type: 'string' }, key: { type: 'string' }, out: { type: 'string' }, notes: { type: 'string' } } });
  if (!values.customer || !values.id || !values.from || !values.until) die('Usage: npm run licence -- issue --customer "<name>" --id <licence no.> --from YYYY-MM-DD --until YYYY-MM-DD [--users N] [--vendors N] [--no-ai] [--sourcing all|rfq,reverse] [--out file]');
  const keyFile = values.key ?? defaultKey;
  if (!fs.existsSync(keyFile)) die(`No signing key at ${keyFile}. Run "npm run licence -- keygen" first (once).`);
  const num = (x?: string) => (x === undefined || x === 'unlimited' ? null : Number(x));
  const lic: Licence = { v: 1, id: values.id!, customer: values.customer!, issuedAt: new Date().toISOString(), validFrom: values.from!, validUntil: values.until!, maxUsers: num(values.users), maxVendors: num(values.vendors),
    features: { ai: !values['no-ai'], erp: !values['no-erp'], kyc: !values['no-kyc'], collab: !values['no-collab'], sourcing: !!values.sourcing },
    ...(values.sourcing && values.sourcing !== 'all' ? { sourcingFormats: sourcingFormatsArg(values.sourcing) } : {}), graceDays: values.grace ? Number(values.grace) : 15, ...(values.notes ? { notes: values.notes } : {}) };
  const token = signLicence(lic, fs.readFileSync(keyFile, 'utf8'));
  const out = values.out ?? `vendorgate-licence-${lic.id}.lic`;
  fs.writeFileSync(out, `${token}\n`);
  console.log(`Licence ${lic.id} for ${lic.customer}, ${lic.validFrom} to ${lic.validUntil}, users ${lic.maxUsers ?? 'unlimited'}, suppliers ${lic.maxVendors ?? 'unlimited'} → ${out}`);
} else if (cmd === 'show') {
  const file = args[0] ?? die('Usage: npm run licence -- show <file>');
  const v = verifyLicence(fs.readFileSync(file, 'utf8'), { production: false });
  if (!v.ok) die(v.error);
  console.log(JSON.stringify({ ...v.licence, status: licenceState(v.licence) }, null, 2));
} else die('Usage: npm run licence -- keygen | issue … | show <file>');

function sourcingFormatsArg(v: string) {
  const list = v.split(',').map((x) => x.trim()).filter(Boolean);
  const bad = list.filter((x) => !(SOURCING_FORMAT_KEYS as string[]).includes(x));
  if (bad.length) die(`Unknown sourcing format(s): ${bad.join(', ')}. Use: all, or a list of ${SOURCING_FORMAT_KEYS.join(', ')}`);
  return list as SourcingFormat[];
}
