/**
 * UAE PASS digital signature (eSign service provider API). Each signer signs in their own UAE PASS (an advanced or
 * qualified account), so signing starts from a button in VendorGate: we create a signer process with the PDF signed so
 * far, send the browser to UAE PASS, and on return download the signed PDF. Staging stg-id.uaepass.ae, production
 * id.uaepass.ae. Credentials and the signature policy come from the UAE PASS onboarding as a service provider.
 */
import { basic, cachedToken, http } from './http.js';
import { ProviderError, type Cfg, type LinkProvider } from './types.js';

const P = 'UAE PASS';
const base = (c: Cfg) => (c.sandbox === 'true' ? 'https://stg-id.uaepass.ae' : 'https://id.uaepass.ae');
async function auth(c: Cfg) {
  const token = await cachedToken(`uaepass:${c.clientId}:${c.sandbox}`, async () => {
    const r = await http(P, 'POST', `${base(c)}/trustedx-authserver/oauth/main-as/token`, { headers: { Authorization: basic(c.clientId, c.clientSecret) },
      form: { grant_type: 'client_credentials', scope: 'urn:safelayer:eidas:sign:process:document' } });
    return { token: r.json.access_token, expiresIn: r.json.expires_in ?? 600 };
  });
  return { Authorization: `Bearer ${token}`, 'Cache-Control': 'no-cache' };
}
const ES = '/trustedx-resources/esignsp/v2';

export const uaepass: LinkProvider = {
  key: 'uaepass', label: 'UAE PASS', kind: 'link', methods: ['UAE PASS digital signature'],
  help: 'Needs onboarding with UAE PASS as a service provider (staging first). Signers need a verified UAE PASS account (SOP2 or SOP3).',
  fields: [
    { key: 'clientId', label: 'Client ID' }, { key: 'clientSecret', label: 'Client secret', secret: true },
    { key: 'signaturePolicyId', label: 'Signature policy ID', help: 'From your UAE PASS onboarding pack' },
    { key: 'timestampProvider', label: 'Timestamp provider ID', optional: true },
  ],
  async check(c) { await auth(c); return `Connected to ${base(c)}`; },
  async start(c, a) {
    const fd = new FormData();
    fd.append('process', new Blob([JSON.stringify({
      process_type: 'urn:safelayer:eidas:processes:document:sign:esigp', labels: [['vendorgate', a.reference]],
      signer: { signature_policy_id: c.signaturePolicyId, parameters: { type: 'pades-baseline', signature_field: { name: `Sign${a.signer.order}`, location: { page: { number: 'last' }, rectangle: { x: a.signer.side === 'PARTY' ? 330 : 60, y: 120, height: 50, width: 180 } }, appearance: { signature_details: { details: [{ type: 'subject', title: 'Signed by: ' }, { type: 'date', title: 'Date: ' }] } } } } },
      ui_locales: ['en_US'], finish_callback_url: a.callbackUrl, views: { document_agreement: { skip_server_id: 'false' } },
      ...(c.timestampProvider ? { timestamp: { provider_id: c.timestampProvider } } : {}),
    })], { type: 'application/json' }));
    fd.append('document', new Blob([new Uint8Array(a.pdf)], { type: 'application/pdf' }), a.fileName);
    const r = await http(P, 'POST', `${base(c)}${ES}/signer_processes`, { headers: await auth(c), multipart: fd });
    const task = r.json?.tasks?.pending?.[0];
    if (!task?.url) throw new ProviderError(P, 'no signing task was returned');
    return { processId: String(r.json.id), url: String(task.url), state: String(r.json.documents?.[0]?.url ?? '') };
  },
  async finish(c, a) {
    const h = await auth(c);
    if (a.query.status && a.query.status !== 'finished') throw new ProviderError(P, a.query.status === 'canceled' ? 'the signer cancelled' : `signing ${a.query.status}`);
    const res = await http(P, 'GET', `${base(c)}${ES}/signer_processes/${a.processId}`, { headers: h });
    const docUrl = a.state || res.json?.documents?.[0]?.url;
    if (!docUrl) throw new ProviderError(P, 'the signed document wasn’t found');
    const pdf = (await http(P, 'GET', `${String(docUrl).startsWith('http') ? docUrl : base(c) + docUrl}/content`, { headers: h, raw: true })).buffer;
    await http(P, 'DELETE', `${base(c)}${ES}/signer_processes/${a.processId}`, { headers: h }).catch(() => {});
    return pdf;
  },
};
