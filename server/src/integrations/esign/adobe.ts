/**
 * Adobe Acrobat Sign REST API v6. Access with an integration key or OAuth access token (Bearer). The API base for the
 * account is found from /baseUris. PDF → transient document → agreement (participants in order, ESIGN); Acrobat
 * Sign adds a signature page when the PDF has no form fields. Webhooks echo X-AdobeSign-ClientId.
 */
import { header, http } from './http.js';
import type { Cfg, EmailProvider, SignerState } from './types.js';

const P = 'Adobe Acrobat Sign';
const auth = (c: Cfg) => ({ Authorization: `Bearer ${c.accessToken}` });
async function base(c: Cfg) {
  const r = await http(P, 'GET', `${c.apiHost || 'https://api.adobesign.com'}/api/rest/v6/baseUris`, { headers: auth(c) });
  return `${String(r.json.apiAccessPoint).replace(/\/$/, '')}/api/rest/v6`;
}
const MEMBER: Record<string, SignerState> = { COMPLETED: 'SIGNED', SIGNED: 'SIGNED', REJECTED: 'DECLINED', DECLINED: 'DECLINED' };

export const adobe: EmailProvider = {
  key: 'adobe', label: 'Adobe Acrobat Sign', kind: 'email', methods: ['Electronic signature'],
  help: 'Use an integration key (Account → Adobe Sign API → API Information) or an OAuth access token with agreement_read, agreement_write and agreement_send scopes. Use a developer account for testing.',
  fields: [{ key: 'accessToken', label: 'Integration key / access token', secret: true }, { key: 'apiHost', label: 'API host', optional: true, help: 'Normally empty (https://api.adobesign.com)' }],
  async check(c) { return `Connected to ${await base(c)}`; },
  async send(c, req) {
    const b = await base(c);
    const fd = new FormData();
    fd.append('File-Name', req.fileName);
    fd.append('File', new Blob([new Uint8Array(req.pdf)], { type: 'application/pdf' }), req.fileName);
    const tr = await http(P, 'POST', `${b}/transientDocuments`, { headers: auth(c), multipart: fd });
    const r = await http(P, 'POST', `${b}/agreements`, { headers: auth(c), json: {
      fileInfos: [{ transientDocumentId: tr.json.transientDocumentId }], name: req.title.slice(0, 255), message: req.message.slice(0, 1000),
      participantSetsInfo: req.signers.map((x) => ({ memberInfos: [{ email: x.email, name: x.name }], order: x.order, role: 'SIGNER' })),
      signatureType: 'ESIGN', state: 'IN_PROCESS', externalId: { id: req.reference },
    } });
    return { externalId: r.json.id };
  },
  async status(c, id) {
    const b = await base(c);
    const a = await http(P, 'GET', `${b}/agreements/${id}`, { headers: auth(c) });
    const m = await http(P, 'GET', `${b}/agreements/${id}/members`, { headers: auth(c) });
    const st = a.json.status as string;
    return {
      state: st === 'SIGNED' || st === 'APPROVED' || st === 'COMPLETED' ? 'COMPLETED' : st === 'CANCELLED' ? 'CANCELLED' : st === 'EXPIRED' ? 'EXPIRED' : st === 'DECLINED' ? 'DECLINED' : 'SENT',
      signers: (m.json.participantSets ?? []).flatMap((p: any) => (p.memberInfos ?? []).map((x: any) => ({ email: x.email, status: MEMBER[x.status ?? p.status] ?? 'SENT' }))),
    };
  },
  async download(c, id) { return (await http(P, 'GET', `${await base(c)}/agreements/${id}/combinedDocument`, { headers: auth(c), raw: true })).buffer; },
  async cancel(c, id, reason) { await http(P, 'PUT', `${await base(c)}/agreements/${id}/state`, { headers: auth(c), json: { state: 'CANCELLED', agreementCancellationInfo: { comment: reason.slice(0, 200), notifyOthers: true } } }); },
  webhook(_c, _h, raw) {
    try { const j = JSON.parse(raw.toString('utf8')); const id = j?.agreement?.id; return id ? { externalId: String(id) } : null; } catch { return null; }
  },
  webhookAnswer(h): Record<string, string> { const id = header(h, 'x-adobesign-clientid'); return id ? { 'X-AdobeSign-ClientId': id } : {}; },
};
