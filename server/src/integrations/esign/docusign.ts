/**
 * DocuSign eSignature REST API v2.1 with JWT grant (an integration key with RSA key pair, impersonating one user).
 * Envelope = our PDF + signers in routing order; signature fields anchor on the /vgsig-us/ and /vgsig-party/ marks
 * VendorGate prints (invisibly) in its signature blocks. Status comes by Connect webhook (HMAC-checked when a key is
 * set) and by polling. Sandbox: account-d.docusign.com; production: account.docusign.com.
 */
import crypto from 'node:crypto';
import { cachedToken, header, http } from './http.js';
import { ProviderError, type Cfg, type EmailProvider, type SignerState } from './types.js';

const P = 'DocuSign';
const authHost = (c: Cfg) => (c.sandbox === 'true' ? 'account-d.docusign.com' : 'account.docusign.com');
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
export function jwtAssertion(c: Cfg, now = Math.floor(Date.now() / 1000)) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: c.integrationKey, sub: c.userId, aud: authHost(c), iat: now, exp: now + 3600, scope: 'signature impersonation' }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(c.privateKey.replace(/\\n/g, '\n'));
  return `${head}.${body}.${b64url(sig)}`;
}
async function session(c: Cfg) {
  const token = await cachedToken(`ds:${c.integrationKey}:${c.userId}:${c.sandbox}`, async () => {
    const r = await http(P, 'POST', `https://${authHost(c)}/oauth/token`, { form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwtAssertion(c) } });
    return { token: r.json.access_token, expiresIn: r.json.expires_in ?? 3600 };
  });
  const info = await http(P, 'GET', `https://${authHost(c)}/oauth/userinfo`, { headers: { Authorization: `Bearer ${token}` } });
  const acc = (info.json.accounts as { account_id: string; base_uri: string; is_default: boolean }[]).find((a) => (c.accountId ? a.account_id === c.accountId : a.is_default));
  if (!acc) throw new ProviderError(P, 'the account id isn’t one this user can use');
  return { headers: { Authorization: `Bearer ${token}` }, base: `${acc.base_uri}/restapi/v2.1/accounts/${acc.account_id}` };
}
const SIGNER: Record<string, SignerState> = { completed: 'SIGNED', declined: 'DECLINED' };

export const docusign: EmailProvider = {
  key: 'docusign', label: 'DocuSign', kind: 'email', methods: ['Electronic signature'],
  help: 'Create an integration key with an RSA key pair in DocuSign Admin (Apps and Keys), grant consent once for the user, and set a Connect HMAC key for webhook checks.',
  fields: [
    { key: 'integrationKey', label: 'Integration key' }, { key: 'userId', label: 'User ID (API username)' }, { key: 'accountId', label: 'Account ID', optional: true, help: 'Empty = the user’s default account' },
    { key: 'privateKey', label: 'RSA private key', secret: true }, { key: 'hmacKey', label: 'Connect HMAC key', secret: true, optional: true },
  ],
  async check(c) { const s = await session(c); return `Connected to ${s.base.split('/accounts/')[0]}`; },
  async send(c, req) {
    const s = await session(c);
    const anchors = { US: '/vgsig-us/', PARTY: '/vgsig-party/' };
    const r = await http(P, 'POST', `${s.base}/envelopes`, { headers: s.headers, json: {
      emailSubject: req.title.slice(0, 100), emailBlurb: req.message.slice(0, 2000), status: 'sent',
      documents: [{ documentId: '1', name: req.fileName, fileExtension: 'pdf', documentBase64: req.pdf.toString('base64') }],
      recipients: { signers: req.signers.map((x, i) => ({ recipientId: String(i + 1), routingOrder: String(x.order), name: x.name, email: x.email,
        tabs: { signHereTabs: [{ anchorString: anchors[x.side], anchorUnits: 'pixels', anchorYOffset: '-8', anchorIgnoreIfNotPresent: 'true' }] } })) },
      eventNotification: { url: req.callbackUrl, requireAcknowledgment: 'true', loggingEnabled: 'true', includeHMAC: c.hmacKey ? 'true' : 'false',
        envelopeEvents: ['completed', 'declined', 'voided'].map((e) => ({ envelopeEventStatusCode: e })), recipientEvents: [{ recipientEventStatusCode: 'Completed' }], eventData: { version: 'restv2.1', format: 'json' } },
    } });
    return { externalId: r.json.envelopeId };
  },
  async status(c, id) {
    const s = await session(c);
    const r = await http(P, 'GET', `${s.base}/envelopes/${id}?include=recipients`, { headers: s.headers });
    const st = r.json.status as string;
    return {
      state: st === 'completed' ? 'COMPLETED' : st === 'declined' ? 'DECLINED' : st === 'voided' ? 'CANCELLED' : 'SENT',
      signers: (r.json.recipients?.signers ?? []).map((x: any) => ({ email: x.email, status: SIGNER[x.status] ?? 'SENT', signedAt: x.signedDateTime })),
    };
  },
  async download(c, id) { const s = await session(c); return (await http(P, 'GET', `${s.base}/envelopes/${id}/documents/combined`, { headers: s.headers, raw: true })).buffer; },
  async cancel(c, id, reason) { const s = await session(c); await http(P, 'PUT', `${s.base}/envelopes/${id}`, { headers: s.headers, json: { status: 'voided', voidedReason: reason.slice(0, 200) } }); },
  webhook(c, h, raw) {
    if (c.hmacKey) {
      const want = crypto.createHmac('sha256', c.hmacKey).update(raw).digest('base64');
      const got = header(h, 'x-docusign-signature-1') ?? '';
      if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return null;
    }
    try { const j = JSON.parse(raw.toString('utf8')); const id = j?.data?.envelopeId ?? j?.envelopeId; return id ? { externalId: String(id) } : null; } catch { return null; }
  },
};
