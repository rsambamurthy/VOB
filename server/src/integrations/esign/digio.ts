/**
 * Digio — Aadhaar eSign (OTP / biometric through a licensed ESP), DSC token signing and electronic signatures.
 * Digio holds the ESP agreements; we use its REST API with the client id / secret (Basic auth).
 * Sandbox https://ext.digio.in:444, production https://api.digio.in. Digio emails each signer the signing link.
 * Webhooks carry the document id; when a webhook secret is set, the x-digio-checksum header is checked.
 */
import crypto from 'node:crypto';
import { basic, header, http } from './http.js';
import type { Cfg, EmailProvider, SignerState } from './types.js';

const P = 'Digio';
const base = (c: Cfg) => (c.sandbox === 'true' ? 'https://ext.digio.in:444' : 'https://api.digio.in');
const auth = (c: Cfg) => ({ Authorization: basic(c.clientId, c.clientSecret) });
const PARTY: Record<string, SignerState> = { signed: 'SIGNED', rejected: 'DECLINED', declined: 'DECLINED' };
export const SIGN_TYPES = { aadhaar: 'Aadhaar eSign (OTP)', dsc: 'DSC token', electronic: 'Electronic signature' } as const;

export const digio: EmailProvider = {
  key: 'digio', label: 'Aadhaar eSign / DSC (Digio)', kind: 'email', methods: ['Aadhaar eSign', 'DSC token', 'Electronic signature'],
  help: 'Ask Digio for API keys (sandbox first). Aadhaar eSign signs with the signer’s Aadhaar OTP; DSC uses their USB token. Set the webhook URL shown below in the Digio dashboard.',
  fields: [
    { key: 'clientId', label: 'Client ID' }, { key: 'clientSecret', label: 'Client secret', secret: true },
    { key: 'signType', label: 'How people sign', options: SIGN_TYPES },
    { key: 'webhookSecret', label: 'Webhook secret', secret: true, optional: true },
  ],
  async check(c) {
    try { await http(P, 'GET', `${base(c)}/v2/client/document/DID_CONNECTION_CHECK`, { headers: auth(c) }); }
    catch (e) { const s = (e as { status?: number }).status; if (s === 401 || s === 403) throw e; }
    return `Connected to ${base(c)}`;
  },
  async send(c, req) {
    const signType = c.signType || 'aadhaar';
    const r = await http(P, 'POST', `${base(c)}/v2/client/document/uploadpdf`, { headers: auth(c), json: {
      signers: req.signers.sort((a, b) => a.order - b.order).map((x) => ({ identifier: x.email, name: x.name, sign_type: signType, reason: req.title.slice(0, 100) })),
      expire_in_days: 15, display_on_page: 'last', notify_signers: true, send_sign_link: true, sequential: true,
      file_name: req.fileName, file_data: req.pdf.toString('base64'), customer_notification_mode: 'EMAIL', comment: req.message.slice(0, 500),
    } });
    return { externalId: String(r.json.id) };
  },
  async status(c, id) {
    const r = await http(P, 'GET', `${base(c)}/v2/client/document/${id}`, { headers: auth(c) });
    const st = String(r.json.agreement_status ?? '').toLowerCase();
    return {
      state: st === 'completed' ? 'COMPLETED' : st === 'expired' ? 'EXPIRED' : st === 'cancelled' || st === 'canceled' ? 'CANCELLED' : st === 'rejected' || st === 'declined' ? 'DECLINED' : 'SENT',
      signers: (r.json.signing_parties ?? []).map((x: any) => ({ email: x.identifier, status: PARTY[String(x.status).toLowerCase()] ?? 'SENT', signedAt: x.signed_at })),
    };
  },
  async download(c, id) { return (await http(P, 'GET', `${base(c)}/v2/client/document/download?document_id=${encodeURIComponent(id)}`, { headers: auth(c), raw: true })).buffer; },
  async cancel(c, id) { await http(P, 'POST', `${base(c)}/v2/client/document/${id}/cancel`, { headers: auth(c), json: {} }); },
  webhook(c, h, raw) {
    if (c.webhookSecret) {
      const want = crypto.createHmac('sha256', c.webhookSecret).update(raw).digest('hex');
      const got = header(h, 'x-digio-checksum') ?? '';
      if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return null;
    }
    try { const j = JSON.parse(raw.toString('utf8')); const id = j?.payload?.document?.id ?? j?.document_id ?? j?.id; return id ? { externalId: String(id) } : null; } catch { return null; }
  },
};
