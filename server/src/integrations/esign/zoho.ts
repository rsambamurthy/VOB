/**
 * Zoho Sign API v1 with a self-client OAuth refresh token (scope ZohoSign.documents.ALL). Data centre picks the hosts
 * (zoho.com, zoho.in, zoho.eu, zoho.ae, zoho.sa…). A request is created with the PDF and recipients, then submitted
 * with one signature field per signer on the last page. Webhooks are set up in Zoho Sign (Settings → Developer).
 */
import { PDFDocument } from 'pdf-lib';
import { cachedToken, http } from './http.js';
import type { Cfg, EmailProvider, SignerState } from './types.js';

const P = 'Zoho Sign';
const dc = (c: Cfg) => c.dataCenter || 'com';
async function auth(c: Cfg) {
  const token = await cachedToken(`zoho:${c.clientId}:${dc(c)}`, async () => {
    const r = await http(P, 'POST', `https://accounts.zoho.${dc(c)}/oauth/v2/token`, { form: { refresh_token: c.refreshToken, client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'refresh_token' } });
    if (!r.json?.access_token) throw new Error(`${P}: ${r.json?.error ?? 'no access token returned'}`);
    return { token: r.json.access_token, expiresIn: r.json.expires_in ?? 3600 };
  });
  return { Authorization: `Zoho-oauthtoken ${token}` };
}
const api = (c: Cfg) => `https://sign.zoho.${dc(c)}/api/v1`;
const ACTION: Record<string, SignerState> = { SIGNED: 'SIGNED', DECLINED: 'DECLINED' };

export const zoho: EmailProvider = {
  key: 'zoho', label: 'Zoho Sign', kind: 'email', methods: ['Electronic signature'],
  help: 'In the Zoho API console create a Self Client, generate a code with scope ZohoSign.documents.ALL and exchange it for a refresh token. Choose the data centre of your Zoho account.',
  fields: [
    { key: 'clientId', label: 'Client ID' }, { key: 'clientSecret', label: 'Client secret', secret: true }, { key: 'refreshToken', label: 'Refresh token', secret: true },
    { key: 'dataCenter', label: 'Data centre', options: { com: 'United States (zoho.com)', in: 'India (zoho.in)', eu: 'Europe (zoho.eu)', ae: 'UAE (zoho.ae)', sa: 'Saudi Arabia (zoho.sa)', 'com.au': 'Australia (zoho.com.au)' } },
  ],
  async check(c) { await auth(c); return `Connected to Zoho Sign (${dc(c)})`; },
  async send(c, req) {
    const h = await auth(c);
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(req.pdf)], { type: 'application/pdf' }), req.fileName);
    fd.append('data', JSON.stringify({ requests: { request_name: req.title.slice(0, 120), is_sequential: true, expiration_days: 30, email_reminders: true, reminder_period: 5, notes: req.message.slice(0, 1000),
      actions: req.signers.map((x) => ({ action_type: 'SIGN', recipient_name: x.name, recipient_email: x.email, signing_order: x.order, verify_recipient: true, verification_type: 'EMAIL' })) } }));
    const r = await http(P, 'POST', `${api(c)}/requests`, { headers: h, multipart: fd });
    const rq = r.json.requests;
    const pages = (await PDFDocument.load(req.pdf, { ignoreEncryption: true })).getPageCount();
    const docId = rq.document_ids[0].document_id;
    const fields = { requests: { actions: rq.actions.map((a: any, i: number) => ({ action_id: a.action_id, action_type: 'SIGN', recipient_name: a.recipient_name, recipient_email: a.recipient_email,
      fields: [{ document_id: docId, field_name: 'Signature', field_type_name: 'Signature', field_label: 'Signature', page_no: pages - 1, x_coord: req.signers[i]?.side === 'PARTY' ? 330 : 60, y_coord: 640, abs_width: 180, abs_height: 40, is_mandatory: true }] })) } };
    const sub = new FormData(); sub.append('data', JSON.stringify(fields));
    await http(P, 'POST', `${api(c)}/requests/${rq.request_id}/submit`, { headers: h, multipart: sub });
    return { externalId: String(rq.request_id) };
  },
  async status(c, id) {
    const r = await http(P, 'GET', `${api(c)}/requests/${id}`, { headers: await auth(c) });
    const rq = r.json.requests; const st = String(rq.request_status).toLowerCase();
    return {
      state: st === 'completed' ? 'COMPLETED' : st === 'declined' ? 'DECLINED' : st === 'expired' ? 'EXPIRED' : st === 'recalled' ? 'CANCELLED' : 'SENT',
      signers: (rq.actions ?? []).map((a: any) => ({ email: a.recipient_email, status: ACTION[a.action_status] ?? 'SENT' })),
    };
  },
  async download(c, id) { return (await http(P, 'GET', `${api(c)}/requests/${id}/pdf`, { headers: await auth(c), raw: true })).buffer; },
  async cancel(c, id) { await http(P, 'POST', `${api(c)}/requests/${id}/recall`, { headers: await auth(c) }); },
  webhook(_c, _h, raw) {
    const s = raw.toString('utf8');
    try { const j = JSON.parse(s); const id = j?.requests?.request_id; return id ? { externalId: String(id) } : null; }
    catch { const m = s.match(/request_id["=:\s]+"?(\d+)/); return m ? { externalId: m[1] } : null; }
  },
};
