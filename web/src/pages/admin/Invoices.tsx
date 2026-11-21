/**
 * Administration → Invoices: switch the add-on on, choose the invoice bases and options, rule defaults (touchless, push to
 * the ERP, debit-note emails…), the approval matrix (levels can go to the cost-centre owner), how coding becomes Oracle's
 * account, the code lists and the API keys the ERP uses.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useHelpContext } from '../../help/HelpPanel';
import { Alert } from '../../components/ui';
import { ModuleSettings, type ModuleConfig } from '../../components/ModuleSettings';
import { ApprovalLevelsCard, type ApprovalSetup } from '../../components/ApprovalLevelsCard';
import { ApiKeysCard } from '../../components/ApiKeys';
import { AlgorithmCard } from '../../components/AlgorithmCard';

interface InvoicesConfig extends ModuleConfig { approval: ApprovalSetup; accountFormat: string; defaultAccountFormat: string }

const APPROVAL_TEXT = {
  title: 'Invoice approval matrix', subject: 'invoices', field: 'invoice.amount', saved: 'Approval matrix saved. It applies to invoices submitted from now on.',
  intro: 'Submitted invoices go through these levels top to bottom. A level with a rule is skipped for invoices that don’t match — for example the budget owner only for invoices without a PO, finance only above an amount. A level can go to the owner of the invoice’s cost centre (set on Code lists); if a cost centre has no owner, everyone with the role gets it. If no level applies, a clean invoice can go through touchless (when switched on); otherwise AP approves it. The person who entered an invoice can never approve it.',
};

export function InvoicesSettings() {
  useHelpContext('invoices-settings');
  return (
    <ModuleSettings<InvoicesConfig> name="Invoices" endpoint="/admin/invoices" kindsKey="bases" ruleNoun="invoice"
      intro="Accounts payable: supplier invoices against purchase orders, contracts or neither — checked, approved through your matrix and sent to Oracle E-Business Suite."
      switchHelp="When off, the Invoices menu is hidden. Invoices already recorded are kept."
      kinds={{ title: 'What invoices are against', help: 'Switch off the bases your team doesn’t use.' }}>
      {(cfg) => <>
        {cfg.approval && <ApprovalLevelsCard endpoint="/admin/invoices/approval" setup={cfg.approval} text={APPROVAL_TEXT} />}
        <AlgorithmCard algorithmKey="invoiceDuplicates" />
        {cfg.features.find((f) => f.key === 'emailInbox')?.on && <><InboxCard /><AlgorithmCard algorithmKey="invoiceInbox" /></>}
        <AccountFormatCard initial={cfg.accountFormat} fallback={cfg.defaultAccountFormat} />
        <section className="card pad section-card" style={{ marginTop: 24 }} aria-label="Code lists">
          <h3>Code lists</h3>
          <p className="muted small" style={{ marginTop: 0 }}>Operating units, GL accounts, cost centres, projects, tasks and tax codes — refreshed from Oracle every night. Choose which codes AP may use and who owns each cost centre.</p>
          <Link className="btn btn-secondary" to="/staff/admin/invoice-codes">Open code lists</Link>
        </section>
        <div style={{ marginTop: 24 }}><KeysCard /></div>
      </>}
    </ModuleSettings>
  );
}

function KeysCard() {
  const [error, setError] = useState<string>();
  return <>
    {error && <Alert kind="error">{error}</Alert>}
    <ApiKeysCard endpoint="/admin/api-keys" onError={setError} purpose="For the ERP or middleware: code lists, supplier codes, import results and payments."
      endpoints={[['POST /invoice-codes', <>Code lists: <span className="icode">{'{ "kind": "ACCOUNT", "codes": [...], "full": true }'}</span> or Oracle rows as they are.</>],
        ['POST /invoices/results', 'Import results from Payables: imported (with the ERP invoice id and holds) or rejected (with the reasons).'],
        ['POST /payments', 'Payments, by the supplier’s ERP code and invoice numbers.']]} />
  </>;
}

interface Inbox { on: boolean; address: string | null; addressAvailable: boolean; imap: { host: string; port: number; secure: boolean; user: string; folder: string; processedFolder: string | null; passwordSet: boolean } | null }

/** Email inbox: the workspace's invoices address (forward your AP mailbox to it) and / or a mailbox VendorGate reads. */
function InboxCard() {
  const [v, setV] = useState<Inbox>();
  const [box, setBox] = useState({ host: '', port: '993', secure: true, user: '', password: '', folder: 'INBOX', processedFolder: '' });
  const [useBox, setUseBox] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'info'; text: string }>();
  const take = (x: Inbox) => { setV(x); setUseBox(!!x.imap); if (x.imap) setBox({ host: x.imap.host, port: String(x.imap.port), secure: x.imap.secure, user: x.imap.user, password: '', folder: x.imap.folder, processedFolder: x.imap.processedFolder ?? '' }); };
  useEffect(() => { api<Inbox>('/admin/invoices/inbox').then((x) => { if (!x.address && x.addressAvailable) api<Inbox>('/admin/invoices/inbox', { method: 'PUT', body: {} }).then(take); else take(x); }).catch((e) => setMsg({ kind: 'error', text: e.message })); }, []);
  const put = async (body: unknown, ok: string) => { setMsg(undefined); try { take(await api<Inbox>('/admin/invoices/inbox', { method: 'PUT', body })); setMsg({ kind: 'success', text: ok }); } catch (e: any) { setMsg({ kind: 'error', text: e.message }); } };
  const post = async (path: string) => { setMsg({ kind: 'info', text: 'Connecting…' }); try { const r = await api<{ message: string }>(`/admin/invoices/inbox/${path}`, { method: 'POST' }); setMsg({ kind: 'success', text: r.message }); } catch (e: any) { setMsg({ kind: 'error', text: e.message }); } };
  if (!v) return msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : null;
  return (
    <section className="card pad section-card" style={{ marginTop: 24 }} aria-label="Email inbox">
      <h3>Email inbox</h3>
      <p className="muted small" style={{ marginTop: 0 }}>Invoices emailed in become drafts — one per PDF, with the supplier and purchase order found where possible. They show under Invoices → Email inbox and in the Drafts tab.</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {v.address ? <div className="field"><label>Your invoices address</label>
        <div className="key-row"><span className="icode break">{v.address}</span>
          <button className="btn btn-secondary btn-sm" onClick={() => navigator.clipboard?.writeText(v.address!).then(() => setMsg({ kind: 'success', text: 'Address copied.' })).catch(() => {})}>Copy</button>
          <button className="btn btn-ghost btn-sm" onClick={() => confirm('Make a new address? The old one stops working straight away.') && put({ newAddress: true }, 'New address made. Update the forwarding rule on your mailbox.')}>New address</button></div>
        <div className="field-help">Forward your accounts-payable mailbox (for example ap-invoices@yourcompany.com) to this address, or give it to suppliers.</div></div>
        : <p className="small">{v.addressAvailable ? '' : 'A VendorGate address isn’t available on this installation — read your own mailbox instead.'}</p>}
      <label className="check-item"><input type="checkbox" checked={useBox} onChange={(e) => { setUseBox(e.target.checked); if (!e.target.checked && v.imap) put({ imap: null }, 'Mailbox removed.'); }} /> <span>Read a mailbox (IMAP) every 5 minutes</span></label>
      {useBox && <>
        <div className="field-grid">
          <div className="field"><label htmlFor="ib-host">Server</label><input id="ib-host" value={box.host} placeholder="imap.gmail.com / outlook.office365.com" onChange={(e) => setBox({ ...box, host: e.target.value })} /></div>
          <div className="field"><label htmlFor="ib-port">Port</label><input id="ib-port" inputMode="numeric" value={box.port} onChange={(e) => setBox({ ...box, port: e.target.value })} /></div>
          <div className="field"><label htmlFor="ib-user">Mailbox</label><input id="ib-user" value={box.user} placeholder="ap-invoices@yourcompany.com" onChange={(e) => setBox({ ...box, user: e.target.value })} /></div>
          <div className="field"><label htmlFor="ib-pw">Password</label><input id="ib-pw" type="password" autoComplete="off" value={box.password} placeholder={v.imap?.passwordSet ? 'Saved — leave empty to keep' : 'An app password'} onChange={(e) => setBox({ ...box, password: e.target.value })} /></div>
          <div className="field"><label htmlFor="ib-folder">Folder</label><input id="ib-folder" value={box.folder} onChange={(e) => setBox({ ...box, folder: e.target.value })} /></div>
          <div className="field"><label htmlFor="ib-done">Move read emails to (optional)</label><input id="ib-done" value={box.processedFolder} placeholder="e.g. VendorGate" onChange={(e) => setBox({ ...box, processedFolder: e.target.value })} /></div>
        </div>
        <label className="check-item"><input type="checkbox" checked={box.secure} onChange={(e) => setBox({ ...box, secure: e.target.checked })} /> <span>Secure connection (TLS)</span></label>
        <div className="btn-row">
          <button className="btn btn-secondary" disabled={!v.imap} onClick={() => post('test')}>Test the connection</button>
          <button className="btn btn-secondary" disabled={!v.imap} onClick={() => post('read')}>Read now</button>
          <button className="btn btn-primary" onClick={() => put({ imap: { host: box.host, port: Number(box.port), secure: box.secure, user: box.user, folder: box.folder, processedFolder: box.processedFolder || null, ...(box.password ? { password: box.password } : {}) } }, 'Mailbox saved.')}>Save mailbox</button>
        </div>
      </>}
    </section>
  );
}

/** How a line's coding becomes Oracle's concatenated account (DIST_CODE_CONCATENATED). */
function AccountFormatCard({ initial, fallback }: { initial: string; fallback: string }) {
  const [v, setV] = useState(initial);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const example = v.replace('{entity}', '101').replace('{costCentre}', '120').replace('{account}', '5100').replace('{project}', '').replace(/\.\.+/g, '.').replace(/^\.|\.$/g, '');
  return (
    <section className="card pad section-card" style={{ marginTop: 24 }} aria-label="Account format">
      <h3>Account in Oracle</h3>
      <p className="muted small" style={{ marginTop: 0 }}>How a line’s coding is joined into the account combination sent to Payables. Use <span className="icode">{'{entity}'}</span>, <span className="icode">{'{costCentre}'}</span>, <span className="icode">{'{account}'}</span> and <span className="icode">{'{project}'}</span>, with fixed segments as they are — for example <span className="icode">{'{entity}.{costCentre}.{account}.000'}</span>.</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="field-grid">
        <div className="field"><label htmlFor="acc-fmt">Format</label><input id="acc-fmt" className="mono" value={v} placeholder={fallback} onChange={(e) => setV(e.target.value)} /><div className="field-help">Example: <span className="mono">{example}</span></div></div>
      </div>
      <div className="btn-row"><button className="btn btn-primary" onClick={async () => { setMsg(undefined); try { await api('/admin/invoices/erp', { method: 'PUT', body: { accountFormat: v } }); setMsg({ kind: 'success', text: 'Account format saved.' }); } catch (e: any) { setMsg({ kind: 'error', text: e.message }); } }}>Save account format</button></div>
    </section>
  );
}
