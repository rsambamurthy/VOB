import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { fmtDateTime } from '../../lib/format';
import { Alert, Empty, Modal } from '../../components/ui';
import { ErpBadge, type Delivery } from '../../components/Erp';

type Kind = 'none' | 'oracle' | 'sap' | 'dynamics' | 'webhook' | 'csv';
interface Conn { kind: Kind; testMode: boolean; autoPush: boolean; config: Record<string, string>; secretsSet: Record<string, boolean> }

const KINDS: { key: Kind; title: string; text: string }[] = [
  { key: 'none', title: 'Not connected', text: 'Use the manual “ERP export” button on each vendor.' },
  { key: 'oracle', title: 'Oracle E-Business Suite', text: 'POST the supplier payload (ERPVendorsData: vendor → sites → banks) to a REST service.' },
  { key: 'sap', title: 'SAP S/4HANA', text: 'Create the business partner (supplier roles, address, tax, bank, company code) through API_BUSINESS_PARTNER.' },
  { key: 'dynamics', title: 'Dynamics 365 Finance', text: 'Create the vendor (VendorsV2) and its bank account through the OData data entities.' },
  { key: 'webhook', title: 'Webhook', text: 'POST a signed JSON event to your middleware, iPaaS or another ERP.' },
  { key: 'csv', title: 'CSV file', text: 'One CSV file per change, kept here for download or uploaded to an SFTP folder.' },
];

function randomSecret() { const b = new Uint8Array(32); crypto.getRandomValues(b); return 'whsec_' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }

export function ErpSettings() {
  const { can } = useSession();
  const [saved, setSaved] = useState<Conn>();
  const [f, setF] = useState<Conn>();
  const [secrets, setSecrets] = useState<Record<string, string | null>>({});
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'info'; text: string }>();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<any>();
  const [newSecret, setNewSecret] = useState<string>();

  useEffect(() => { api<Conn>('/admin/erp').then((c) => { setSaved(c); setF(c); }).catch((e) => setMsg({ kind: 'error', text: e.message })); }, []);
  if (!f || !saved) return <div className="page"><div className="spinner" /></div>;
  const cfg = (k: string) => f.config[k] ?? '';
  const setCfg = (k: string, v: string) => setF({ ...f, config: { ...f.config, [k]: v } });
  const dirty = JSON.stringify(f) !== JSON.stringify(saved) || Object.keys(secrets).length > 0;

  async function save() {
    setBusy(true); setMsg(undefined);
    try {
      const c = await api<Conn>('/admin/erp', { method: 'PUT', body: { kind: f!.kind, testMode: f!.testMode, autoPush: f!.autoPush, config: f!.config, secrets } });
      setSaved(c); setF(c); setSecrets({});
      setMsg({ kind: 'success', text: newSecret ? 'Saved. Copy the signing secret now — it won’t be shown again.' : 'ERP settings saved.' });
    } catch (e: any) { setMsg({ kind: 'error', text: e.message }); } finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setMsg(undefined);
    try { const r = await api<{ ok: boolean; message: string }>('/admin/erp/test', { method: 'POST' }); setMsg({ kind: r.ok ? 'success' : 'error', text: r.message }); }
    catch (e: any) { setMsg({ kind: 'error', text: e.message }); } finally { setBusy(false); }
  }
  async function showPreview() {
    try { setPreview(await api('/admin/erp/preview')); } catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  }

  // A render helper (not a component) so the input keeps focus while typing.
  const secretField = (k: string, label: string, help?: string) => (
    <div className="field">
      <label htmlFor={`erp-${k}`}>{label}</label>
      <input id={`erp-${k}`} type="password" autoComplete="new-password" value={secrets[k] ?? ''} placeholder={saved.kind === f.kind && saved.secretsSet[k] && secrets[k] !== null ? '•••••••• saved — type to replace' : ''}
        onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value })} />
      <div className="field-help">{help ?? 'Stored encrypted. Never shown again after saving.'}
        {saved.kind === f.kind && saved.secretsSet[k] && secrets[k] !== null && <> <button type="button" className="link-btn small danger" onClick={() => setSecrets({ ...secrets, [k]: null })}>Remove saved value</button></>}
        {secrets[k] === null && <span className="small"> — will be removed on save</span>}
      </div>
    </div>
  );

  return (
    <div className="page narrow-page">
      <header className="page-head"><div><h1>ERP integration</h1><p className="muted">Send approved vendors — and later changes, blocks and unblocks — to your ERP automatically.</p></div></header>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="stack">
        <section className="card pad section-card">
          <h3>Connector</h3>
          <div className="kind-grid">
            {KINDS.map((k) => (
              <label key={k.key} className={`kind-card ${f.kind === k.key ? 'active' : ''}`}>
                <input type="radio" name="erp-kind" checked={f.kind === k.key} onChange={() => setF({ ...f, kind: k.key, config: k.key === saved.kind ? saved.config : k.key === 'csv' ? { delivery: 'download' } : {} })} />
                <strong>{k.title}</strong><span className="small muted">{k.text}</span>
              </label>
            ))}
          </div>
        </section>

        {f.kind !== 'none' && (
          <section className="card pad section-card">
            <h3>{KINDS.find((k) => k.key === f.kind)!.title} settings</h3>
            {f.kind === 'oracle' && (
              <div className="field-grid">
                <div className="field field-wide"><label htmlFor="erp-url">Endpoint URL</label><input id="erp-url" value={cfg('url')} placeholder="https://ebs.example.com/webservices/rest/vendor_onboarding/create_supplier/" onChange={(e) => setCfg('url', e.target.value)} />
                  <div className="field-help">A REST service (Integrated SOA Gateway or your middleware) that accepts the ERPVendorsData JSON and creates or updates the supplier. Updates carry the VENDOR_ID it returned.</div></div>
                <div className="field"><label htmlFor="erp-user">User name</label><input id="erp-user" value={cfg('username')} autoComplete="off" onChange={(e) => setCfg('username', e.target.value)} /></div>
                {secretField('password', 'Password')}
                <div className="field"><label htmlFor="erp-org">Operating unit (ORG_ID)</label><input id="erp-org" value={cfg('orgId')} placeholder="e.g. 204" onChange={(e) => setCfg('orgId', e.target.value)} /></div>
                <div className="field field-wide"><h4 className="sub-head">Purchase orders (supplier collaboration)</h4></div>
                <div className="field field-wide"><label htmlFor="erp-poPullUrl">Purchase order pull URL</label><input id="erp-poPullUrl" value={cfg('poPullUrl')} placeholder="https://ebs.example.com/webservices/rest/vg_po/get_purchase_orders/" onChange={(e) => setCfg('poPullUrl', e.target.value)} />
                  <div className="field-help">Called nightly and from <strong>Get from ERP</strong> as <span className="mono">GET …?changedSince=&lt;time&gt;[&amp;poNumber=][&amp;supplierNumber=]</span>. It should return approved POs with PO_HEADERS_ALL columns, nested LINES → SHIPMENTS (PO_LINE_LOCATIONS_ALL) and optional RECEIPTS.</div></div>
                <div className="field field-wide"><label htmlFor="erp-ackUrl">Acknowledgement URL</label><input id="erp-ackUrl" value={cfg('ackUrl')} placeholder="https://ebs.example.com/webservices/rest/vg_po/acknowledge/" onChange={(e) => setCfg('ackUrl', e.target.value)} />
                  <div className="field-help">Receives a POST each time a supplier accepts (or a PO is auto-accepted): PO_HEADER_ID, SEGMENT1, REVISION_NUM, ACCEPTED_FLAG, ACCEPTANCE_TYPE and the accepted LINES — for your service to record in PO_ACCEPTANCES.</div></div>
                <div className="field field-wide"><label htmlFor="erp-asnUrl">Shipment notice URL</label><input id="erp-asnUrl" value={cfg('asnUrl')} placeholder="https://ebs.example.com/webservices/rest/vg_po/asn/" onChange={(e) => setCfg('asnUrl', e.target.value)} />
                  <div className="field-help">Receives each shipment notice (and cancellation) as a HEADER with SHIPMENT_NUM, SHIPPED_DATE, EXPECTED_RECEIPT_DATE, carrier and waybill, and LINES with PO_HEADER_ID, PO_LINE_ID and QUANTITY — shaped for the receiving open interface (RCV_HEADERS_INTERFACE / RCV_TRANSACTIONS_INTERFACE).</div></div>
                <div className="field field-wide"><label htmlFor="erp-invoiceUrl">Invoice URL</label><input id="erp-invoiceUrl" value={cfg('invoiceUrl')} placeholder="https://ebs.example.com/webservices/rest/vg_ap/invoice/" onChange={(e) => setCfg('invoiceUrl', e.target.value)} />
                  <div className="field-help">Receives each supplier invoice once approved: INVOICE_NUM, INVOICE_DATE, VENDOR_NUM, INVOICE_AMOUNT and ITEM / TAX LINES matched to PO_LINE_ID — shaped for the payables open interface (AP_INVOICES_INTERFACE).</div></div>
              </div>
            )}
            {f.kind === 'sap' && (
              <div className="field-grid">
                <div className="field field-wide"><label htmlFor="erp-url">SAP system URL</label><input id="erp-url" value={cfg('url')} placeholder="https://my123456-api.s4hana.cloud.sap" onChange={(e) => setCfg('url', e.target.value)} />
                  <div className="field-help">The API host. VendorGate calls <span className="mono">/sap/opu/odata/sap/API_BUSINESS_PARTNER</span>, fetching a CSRF token before each write. In S/4HANA Cloud, set up communication scenario SAP_COM_0008 (Business Partner, Customer and Supplier Integration).</div></div>
                <div className="field"><label htmlFor="erp-user">Communication user</label><input id="erp-user" value={cfg('username')} autoComplete="off" onChange={(e) => setCfg('username', e.target.value)} /></div>
                {secretField('password', 'Password')}
                <div className="field"><label htmlFor="erp-grouping">BP grouping</label><input id="erp-grouping" value={cfg('grouping')} placeholder="e.g. BP02 (blank = system default)" onChange={(e) => setCfg('grouping', e.target.value)} /></div>
                <div className="field"><label htmlFor="erp-cc">Company code</label><input id="erp-cc" value={cfg('companyCode')} placeholder="e.g. 1010" onChange={(e) => setCfg('companyCode', e.target.value)} /></div>
                <div className="field"><label htmlFor="erp-porg">Purchasing organisation</label><input id="erp-porg" value={cfg('purchasingOrg')} placeholder="e.g. 1010" onChange={(e) => setCfg('purchasingOrg', e.target.value)} /></div>
                <div className="field"><label htmlFor="erp-tax">Tax number category</label><input id="erp-tax" value={cfg('taxType')} placeholder="IN3 for GSTIN; blank = default" onChange={(e) => setCfg('taxType', e.target.value)} /></div>
                <div className="field field-wide"><h4 className="sub-head">Purchase orders (supplier collaboration)</h4></div>
                <div className="field field-wide"><label htmlFor="erp-messageUrl">Order message URL</label><input id="erp-messageUrl" value={cfg('messageUrl')} placeholder="https://your-tenant.it-cpi.cfapps.eu10.hana.ondemand.com/http/vendorgate" onChange={(e) => setCfg('messageUrl', e.target.value)} />
                  <div className="field-help">Your Integration Suite (CPI) flow. Receives acceptances, shipment notices and approved invoices as JSON events (purchase_order.accepted, shipment.created, shipment.cancelled, invoice.approved) with the same communication user — map them to purchase order confirmations, inbound deliveries and supplier invoices.</div></div>
              </div>
            )}
            {f.kind === 'dynamics' && (
              <div className="field-grid">
                <div className="field field-wide"><label htmlFor="erp-url">Environment URL</label><input id="erp-url" value={cfg('url')} placeholder="https://contoso.operations.dynamics.com" onChange={(e) => setCfg('url', e.target.value)} />
                  <div className="field-help">Vendors are created through <span className="mono">data/VendorsV2</span> with your VendorGate vendor code as the account number (set the vendor number sequence to allow manual numbers), then the bank account through <span className="mono">data/VendorBankAccounts</span>.</div></div>
                <div className="field"><label htmlFor="erp-tenant">Microsoft Entra tenant id</label><input id="erp-tenant" value={cfg('tenantId')} placeholder="contoso.onmicrosoft.com or GUID" onChange={(e) => setCfg('tenantId', e.target.value)} /></div>
                <div className="field"><label htmlFor="erp-client">App (client) id</label><input id="erp-client" value={cfg('clientId')} autoComplete="off" onChange={(e) => setCfg('clientId', e.target.value)} /></div>
                {secretField('clientSecret', 'Client secret', 'From the app registration. Register the same app under System administration → Microsoft Entra ID applications in Dynamics. Stored encrypted.')}
                <div className="field"><label htmlFor="erp-area">Legal entity (dataAreaId)</label><input id="erp-area" value={cfg('dataAreaId')} placeholder="e.g. inmf" onChange={(e) => setCfg('dataAreaId', e.target.value)} /></div>
                <div className="field"><label htmlFor="erp-vgroup">Vendor group</label><input id="erp-vgroup" value={cfg('vendorGroup')} placeholder="e.g. DOM" onChange={(e) => setCfg('vendorGroup', e.target.value)} /></div>
                <div className="field field-wide"><h4 className="sub-head">Purchase orders (supplier collaboration)</h4></div>
                <div className="field field-wide"><label htmlFor="erp-messageUrl">Order message URL</label><input id="erp-messageUrl" value={cfg('messageUrl')} placeholder="https://prod-00.westeurope.logic.azure.com/workflows/…" onChange={(e) => setCfg('messageUrl', e.target.value)} />
                  <div className="field-help">Your Logic App or Power Automate flow. Receives acceptances, shipment notices and approved invoices as JSON events with a bearer token from the same app registration — map them to purchase order confirmations, shipment notices and pending vendor invoices.</div></div>
              </div>
            )}
            {f.kind === 'webhook' && (
              <div className="field-grid">
                <div className="field field-wide"><label htmlFor="erp-url">Webhook URL</label><input id="erp-url" value={cfg('url')} placeholder="https://integration.example.com/vendorgate" onChange={(e) => setCfg('url', e.target.value)} /></div>
                <div className="field field-wide">
                  <label htmlFor="erp-signingSecret">Signing secret</label>
                  <div className="control-row">
                    <input id="erp-signingSecret" type={newSecret ? 'text' : 'password'} autoComplete="new-password" value={secrets.signingSecret ?? ''} placeholder={saved.kind === 'webhook' && saved.secretsSet.signingSecret ? '•••••••• saved — type or generate to replace' : ''} onChange={(e) => { setNewSecret(undefined); setSecrets({ ...secrets, signingSecret: e.target.value }); }} />
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => { const s = randomSecret(); setNewSecret(s); setSecrets({ ...secrets, signingSecret: s }); }}>Generate</button>
                  </div>
                  <div className="field-help">Each request carries <span className="mono">X-VendorGate-Signature: sha256=HMAC(secret, timestamp + "." + body)</span> and <span className="mono">X-VendorGate-Timestamp</span>. Verify both on your side and reject requests older than 5 minutes. Events: vendor.approved, vendor.updated, vendor.blocked, vendor.unblocked, vendor.synced — and for purchase orders purchase_order.accepted, shipment.created, shipment.cancelled, invoice.approved. Return <span className="mono">{'{"vendorId": "…"}'}</span> to store your ERP’s id.</div>
                </div>
              </div>
            )}
            {f.kind === 'csv' && (
              <>
                <div className="level-checks">
                  <label className="checkbox"><input type="radio" name="csv-del" checked={cfg('delivery') !== 'sftp'} onChange={() => setCfg('delivery', 'download')} /> Keep files here for download</label>
                  <label className="checkbox"><input type="radio" name="csv-del" checked={cfg('delivery') === 'sftp'} onChange={() => setCfg('delivery', 'sftp')} /> Upload to an SFTP folder</label>
                </div>
                {cfg('delivery') === 'sftp' && (
                  <div className="field-grid">
                    <div className="field"><label htmlFor="erp-host">SFTP host</label><input id="erp-host" value={cfg('host')} placeholder="sftp.example.com" onChange={(e) => setCfg('host', e.target.value)} /></div>
                    <div className="field"><label htmlFor="erp-port">Port</label><input id="erp-port" inputMode="numeric" value={cfg('port')} placeholder="22" onChange={(e) => setCfg('port', e.target.value)} /></div>
                    <div className="field"><label htmlFor="erp-user">User name</label><input id="erp-user" value={cfg('username')} autoComplete="off" onChange={(e) => setCfg('username', e.target.value)} /></div>
                    {secretField('password', 'Password')}
                    <div className="field field-wide"><label htmlFor="erp-dir">Remote folder</label><input id="erp-dir" value={cfg('remoteDir')} placeholder="/inbound/suppliers" onChange={(e) => setCfg('remoteDir', e.target.value)} /></div>
                  </div>
                )}
                <p className="small muted">Files are named <span className="mono">vendor_VND-00012_create_20261004-101500.csv</span> with a header row; the ACTION column says CREATE, UPDATE, BLOCK or UNBLOCK.</p>
              </>
            )}
          </section>
        )}

        {f.kind !== 'none' && (
          <section className="card pad section-card">
            <h3>Behaviour</h3>
            <label className="check-item"><input type="checkbox" checked={f.testMode} onChange={(e) => setF({ ...f, testMode: e.target.checked })} />
              <span><strong>Test mode</strong><span className="muted small block">Builds and records exactly what would be sent, but sends nothing. Turn off once the settings are confirmed.</span></span></label>
            <label className="check-item"><input type="checkbox" checked={f.autoPush} onChange={(e) => setF({ ...f, autoPush: e.target.checked })} />
              <span><strong>Push automatically</strong><span className="muted small block">On final approval, when an approved change takes effect, and on block / unblock (sets or clears the payment hold). Otherwise use “Push to ERP” on the vendor.</span></span></label>
            {!f.testMode && <Alert kind="warning">Live mode: vendor records, including bank details, will be sent to the address above.</Alert>}
          </section>
        )}

        <div className="btn-row">
          <button className="btn btn-primary" disabled={busy || !dirty} onClick={save}>Save settings</button>
          {saved.kind !== 'none' && <button className="btn btn-secondary" disabled={busy || dirty} onClick={test} title={dirty ? 'Save first' : undefined}>Test connection</button>}
          {saved.kind !== 'none' && <button className="btn btn-ghost" disabled={dirty} onClick={showPreview}>Preview payload</button>}
        </div>

        {can('vendors.export') && <Deliveries />}
      </div>

      {preview && (
        <Modal title={`What would be sent — ${preview.vendor.name}`} wide onClose={() => setPreview(undefined)}>
          <p className="small muted">Target: <span className="mono">{preview.target}</span></p>
          {preview.request.headers && <pre className="code small">{Object.entries(preview.request.headers).map(([k, v]) => `${k}: ${v}`).join('\n')}</pre>}
          <pre className="code">{preview.request.csv ?? JSON.stringify(preview.request.body, null, 2)}</pre>
        </Modal>
      )}
    </div>
  );
}

function Deliveries() {
  const [filter, setFilter] = useState('');
  const [rows, setRows] = useState<(Delivery & { vendor: { id: string; name: string; code: string } })[]>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => api(`/staff/erp/deliveries${filter ? `?status=${filter}` : ''}`).then(setRows).catch((e) => setError(e.message)), [filter]);
  useEffect(() => { load(); }, [load]);
  async function retry(id: string) { try { await api(`/staff/erp/deliveries/${id}/retry`, { method: 'POST' }); load(); } catch (e: any) { setError(e.message); } }
  return (
    <section className="card section-card">
      <div className="toolbar">
        <h3 className="grow">Recent deliveries</h3>
        <div className="seg">{[['', 'All'], ['FAILED', 'Failed'], ['TEST', 'Test'], ['SENT', 'Sent']].map(([k, l]) => <button key={k} className={`seg-btn ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>{l}</button>)}</div>
        <a className="btn btn-secondary btn-sm" href="/api/staff/erp/export.csv" download>All approved vendors (CSV)</a>
      </div>
      {error && <div className="pad"><Alert kind="error">{error}</Alert></div>}
      {!rows ? <div className="pad"><div className="spinner" /></div> : !rows.length ? <Empty>No deliveries yet.</Empty> : (
        <div className="table-wrap">
          <table className="table compact">
            <thead><tr><th>Vendor</th><th>Event</th><th>Status</th><th>Target / error</th><th>When</th><th /></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="no-hover">
                <td><Link to={`/staff/vendors/${r.vendor.id}`}>{r.vendor.name}</Link><div className="muted small mono">{r.vendor.code}</div></td>
                <td className="small">{r.event}</td>
                <td><ErpBadge status={r.status} />{r.attempts > 1 && <span className="muted small"> ×{r.attempts}</span>}</td>
                <td className="small break">{r.error ? <span className="err-text">{r.error}</span> : <span className="muted">{r.target}</span>}{r.erpVendorId && <div className="muted">ERP id {r.erpVendorId}</div>}</td>
                <td className="small muted">{fmtDateTime(r.sentAt ?? r.createdAt)}</td>
                <td className="nowrap">
                  <a className="link-btn small" href={`/api/staff/erp/deliveries/${r.id}/payload`} target="_blank" rel="noreferrer">{r.fileName ? 'Download' : 'Payload'}</a>
                  {r.status === 'FAILED' && <> · <button className="link-btn small" onClick={() => retry(r.id)}>Retry</button></>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
