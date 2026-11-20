/** Administration → Contracts: switch the module on, choose contract types and options, rule defaults, our company details and internal approval. */
import { useState } from 'react';
import { api } from '../../lib/api';
import { useHelpContext } from '../../help/HelpPanel';
import { useSession } from '../../lib/session';
import { Alert } from '../../components/ui';
import { ModuleSettings, type ModuleConfig } from '../../components/ModuleSettings';
import { ApprovalLevelsCard, type ApprovalSetup } from '../../components/ApprovalLevelsCard';

type Company = Partial<Record<'legalName' | 'address' | 'city' | 'country' | 'registrationNo' | 'taxNo' | 'signatoryName' | 'signatoryRole', string>>;
interface ProviderDef { key: string; label: string; kind: 'email' | 'link'; help: string; methods: string[]; fields: { key: string; label: string; secret?: boolean; optional?: boolean; help?: string; options?: Record<string, string> }[] }
interface ESign { provider: string | null; sandbox: boolean; values: Record<string, string>; secretsSet: string[]; providers: ProviderDef[]; webhookBase: string }
interface ContractsConfig extends ModuleConfig { approval: ApprovalSetup; company: Company; companyDefaults: Company; esign: ESign }

const APPROVAL_TEXT = {
  title: 'Contract approval', subject: 'contracts', field: 'contract.value', saved: 'Contract approval flow saved. It applies to contracts submitted from now on.',
  intro: 'Before a drafted contract goes to the other party, it goes through these levels top to bottom. A level with a rule is skipped for contracts that don’t match — for example, Legal only when the wording was changed from the library or a fallback clause is used, Finance only above a value. If no level applies, the contract is approved straight away. The person who owns or drafted a contract can never approve it.',
};

export function ContractsSettings() {
  useHelpContext('contracts-settings');
  const { me } = useSession();
  const contractsOnly = me?.plan?.features.onboarding === false;
  return (
    <ModuleSettings<ContractsConfig> name="Contracts" endpoint="/admin/contracts" kindsKey="types" ruleNoun="contract"
      intro="Supplier and customer contracts: which types your team uses, the options switched on, and the defaults every new contract starts with."
      switchHelp="When off, the Contracts and Parties menus are hidden. Contracts and parties already recorded are kept."
      kinds={{ title: 'Contract types', help: 'Each type has its own number prefix. Some types are only for suppliers or only for customers.' }}
      kindExtra={(k) => <span className="muted small" style={{ marginInlineStart: 6 }}>
        <span className="mono">{String(k.prefix ?? '')}</span>
        {(k.directions as string[] | undefined)?.map((d) => <span key={d} className="badge sm" style={{ marginInlineStart: 4 }}>{d === 'BUY' ? 'Supplier' : 'Customer'}</span>)}
      </span>}>
      {(cfg) => <>
        {contractsOnly && <Alert kind="info">This workspace has the Contracts plan, without supplier onboarding. Parties are kept as light records; linking them to onboarded suppliers needs supplier onboarding.</Alert>}
        <CompanyCard company={cfg.company} defaults={cfg.companyDefaults} />
        {cfg.features.find((f) => f.key === 'esign')?.on && <ESignCard initial={cfg.esign} />}
        {cfg.approval && <ApprovalLevelsCard endpoint="/admin/contracts/approval" setup={cfg.approval} text={APPROVAL_TEXT} />}
      </>}
    </ModuleSettings>
  );
}

const COMPANY_FIELDS: [keyof Company, string, string?][] = [
  ['legalName', 'Legal name'], ['registrationNo', 'Registration number', 'e.g. CIN, CR number'], ['taxNo', 'Tax number', 'e.g. GSTIN, VAT / TRN'],
  ['address', 'Registered address'], ['city', 'City', 'Courts, arbitration seat and place of signing'], ['signatoryName', 'Signatory'], ['signatoryRole', 'Signatory’s role'],
];
/** Our details printed on contracts (the us.* merge fields). Empty boxes use the workspace's billing details. */
function CompanyCard({ company, defaults }: { company: Company; defaults: Company }) {
  const [v, setV] = useState<Company>(company);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  async function save() {
    setMsg(undefined);
    try { await api('/admin/contracts/company', { method: 'PUT', body: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) }); setMsg({ kind: 'success', text: 'Company details saved. New documents use them.' }); }
    catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  }
  return (
    <section className="card pad section-card" style={{ marginTop: 24 }} aria-label="Our company on contracts">
      <h3>Our company on contracts</h3>
      <p className="muted small" style={{ marginTop: 0 }}>Printed in contract documents (the “us” merge fields). Empty boxes use your billing details, shown in grey.</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="field-grid">
        {COMPANY_FIELDS.map(([k, label, help]) => (
          <div key={k} className={`field${k === 'address' ? ' field-wide' : ''}`}><label htmlFor={`co-${k}`}>{label}</label>
            <input id={`co-${k}`} value={v[k] ?? ''} placeholder={defaults[k] || help || ''} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></div>
        ))}
      </div>
      <div className="btn-row"><button className="btn btn-primary" onClick={save}>Save company details</button></div>
    </section>
  );
}

/** The e-signature provider: one per workspace. Secrets are write-only (left empty = keep the saved one). */
function ESignCard({ initial }: { initial: ESign }) {
  const [e, setE] = useState(initial);
  const [values, setValues] = useState<Record<string, string>>(initial.values);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'info'; text: string }>();
  const p = e.providers.find((x) => x.key === e.provider);
  async function save() {
    setMsg(undefined);
    try { const r = await api<{ esign: ESign }>('/admin/contracts/esign', { method: 'PUT', body: { provider: e.provider, sandbox: e.sandbox, values } }); setE(r.esign); setValues(r.esign.values); setMsg({ kind: 'success', text: 'E-signature settings saved.' }); }
    catch (err: any) { setMsg({ kind: 'error', text: err.message }); }
  }
  async function check() {
    setMsg({ kind: 'info', text: 'Checking…' });
    const r = await api<{ ok: boolean; message: string }>('/admin/contracts/esign/check', { method: 'POST' }).catch((err) => ({ ok: false, message: err.message }));
    setMsg({ kind: r.ok ? 'success' : 'error', text: r.message });
  }
  return (
    <section className="card pad section-card" style={{ marginTop: 24 }} aria-label="E-signature">
      <h3>E-signature</h3>
      <p className="muted small" style={{ marginTop: 0 }}>Contracts are sent for signature through this provider. Use the provider’s sandbox until you have tried it end to end.</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="field-grid">
        <div className="field"><label htmlFor="es-p">Provider</label>
          <select id="es-p" value={e.provider ?? ''} onChange={(ev) => { setE({ ...e, provider: ev.target.value || null }); setValues({}); }}>
            <option value="">None — sign on paper and upload</option>{e.providers.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></div>
        {p && p.key !== 'test' && <div className="field"><label className="check-item"><input type="checkbox" checked={e.sandbox} onChange={(ev) => setE({ ...e, sandbox: ev.target.checked })} /> <span>Sandbox / test environment</span></label></div>}
      </div>
      {p && <>
        <p className="small">{p.help}</p>
        {p.key === 'test' && <Alert kind="warning">Test signing adds a certificate page marked TEST. It is not a legal signature — use it to try the flow only.</Alert>}
        <div className="field-grid">{p.fields.map((f) => (
          <div key={f.key} className={`field${f.key === 'privateKey' ? ' field-wide' : ''}`}><label htmlFor={`es-${f.key}`}>{f.label}{f.optional ? ' (optional)' : ''}</label>
            {f.options ? <select id={`es-${f.key}`} value={values[f.key] ?? ''} onChange={(ev) => setValues({ ...values, [f.key]: ev.target.value })}><option value="">Choose…</option>{Object.entries(f.options).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              : f.key === 'privateKey' ? <textarea id={`es-${f.key}`} rows={4} value={values[f.key] ?? ''} placeholder={e.secretsSet.includes(f.key) && e.provider === initial.provider ? 'Saved — paste a new key to replace it' : '-----BEGIN RSA PRIVATE KEY-----'} onChange={(ev) => setValues({ ...values, [f.key]: ev.target.value })} />
              : <input id={`es-${f.key}`} type={f.secret ? 'password' : 'text'} autoComplete="off" value={values[f.key] ?? ''} placeholder={f.secret && e.secretsSet.includes(f.key) ? 'Saved — leave empty to keep' : ''} onChange={(ev) => setValues({ ...values, [f.key]: ev.target.value })} />}
            {f.help && <div className="field-help">{f.help}</div>}</div>))}</div>
        {p.kind === 'email' && <p className="small muted">Webhook URL for the provider: <span className="mono">{e.webhookBase}{p.key}</span> — VendorGate also checks every 15 minutes.</p>}
        {p.kind === 'link' && p.key !== 'test' && <p className="small muted">Signers sign from VendorGate with their own {p.label} account.</p>}
      </>}
      <div className="btn-row"><button className="btn btn-secondary" disabled={!initial.provider} onClick={check}>Test the connection</button><button className="btn btn-primary" onClick={save}>Save e-signature settings</button></div>
    </section>
  );
}
