/**
 * Administration → Invoices: switch the add-on on, choose the invoice bases and options, rule defaults (touchless, push to
 * the ERP, debit-note emails…), the approval matrix (levels can go to the cost-centre owner), how coding becomes Oracle's
 * account, the code lists and the API keys the ERP uses.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { useHelpContext } from '../../help/HelpPanel';
import { Alert } from '../../components/ui';
import { ModuleSettings, type ModuleConfig } from '../../components/ModuleSettings';
import { ApprovalLevelsCard, type ApprovalSetup } from '../../components/ApprovalLevelsCard';
import { ApiKeysCard } from '../../components/ApiKeys';

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
