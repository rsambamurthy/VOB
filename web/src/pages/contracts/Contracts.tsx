/** Contracts → All contracts: supplier and customer contracts, filters, expiring soon, new contract and Excel import. */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDate, money } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useHelpContext } from '../../help/HelpPanel';
import { Alert, Empty, Modal } from '../../components/ui';
import { TabStrip } from '../../components/TabStrip';
import { Pager } from '../../components/Pager';
import { ExcelImportModal } from '../../components/ExcelImport';
import { ContractStatus, DIRECTION_LABEL, typeLabel, useContractSetup, type Direction, type Setup } from '../../components/Contracts';
import { blankContract, contractBody, ContractForm, type ContractData } from './ContractForm';

interface Row { id: string; number: string; reference: string | null; title: string; direction: Direction; type: string; status: string; value: number | null; currency: string; startDate: string | null; endDate: string | null; party: { id: string; name: string; code: string }; owner: string | null; daysLeft: number | null; expiring: boolean }
interface List { contracts: Row[]; total: number; page: number; pageSize: number; counts: Record<string, number>; expiring: number }
const TABS = [['all', 'All'], ['BUY', 'Supplier contracts'], ['SELL', 'Customer contracts'], ['expiring', 'Expiring'], ['DRAFT', 'Drafts'], ['IN_APPROVAL', 'In approval'], ['ended', 'Ended']] as const;

export function ContractsList() {
  useHelpContext('contracts');
  const { me, can } = useSession();
  const setup = useContractSetup();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'all';
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<List>();
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [flash, setFlash] = useState<string>();
  const customers = !!me?.contracts?.directions.includes('SELL');
  const load = useCallback(() => {
    const p = new URLSearchParams({ page: String(page) });
    if (q) p.set('q', q);
    if (tab === 'BUY' || tab === 'SELL') p.set('direction', tab);
    if (tab === 'expiring') { p.set('filter', 'expiring'); p.set('sort', 'end'); }
    if (tab === 'DRAFT' || tab === 'IN_APPROVAL') p.set('status', tab);
    if (tab === 'ended') p.set('status', 'ENDED');
    api<List>(`/staff/contracts?${p}`).then(setData).catch((e) => setError(e.message));
  }, [q, tab, page]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  useEffect(() => { setPage(1); }, [q, tab]);
  const c = data?.counts ?? {};
  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Contracts</h1><p className="muted">{customers ? 'Supplier and customer contracts' : 'Supplier contracts'} — dates, value, renewal and the signed copies.</p></div>
        {can('contracts.manage') && setup && <div className="head-actions">
          <button className="btn btn-secondary" onClick={() => setImporting(true)}>Import from Excel</button>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>+ New contract</button></div>}
      </header>
      {error && <Alert kind="error">{error}</Alert>}
      {flash && <Alert kind="success">{flash}</Alert>}
      {data && (
        <div className="stat-row">
          <button className={`stat stat-approved ${tab === 'all' ? 'active' : ''}`} onClick={() => setParams({})}><span className="stat-n">{c.ACTIVE ?? 0}</span><span className="stat-l">Active</span></button>
          <button className={`stat stat-attention ${tab === 'expiring' ? 'active' : ''}`} onClick={() => setParams({ tab: 'expiring' })}><span className="stat-n">{data.expiring}</span><span className="stat-l">Expiring soon</span></button>
          <button className={`stat stat-invited ${tab === 'DRAFT' ? 'active' : ''}`} onClick={() => setParams({ tab: 'DRAFT' })}><span className="stat-n">{c.DRAFT ?? 0}</span><span className="stat-l">Drafts</span></button>
          <button className={`stat stat-rejected ${tab === 'ended' ? 'active' : ''}`} onClick={() => setParams({ tab: 'ended' })}><span className="stat-n">{(c.EXPIRED ?? 0) + (c.TERMINATED ?? 0)}</span><span className="stat-l">Expired or terminated</span></button>
        </div>
      )}
      <TabStrip>{TABS.filter(([k]) => customers || (k !== 'BUY' && k !== 'SELL')).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setParams(k === 'all' ? {} : { tab: k })}>{l}</button>)}</TabStrip>
      <div className="card">
        <div className="toolbar"><input className="search" placeholder="Search number, title, reference or party…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search contracts" /></div>
        {!data ? <div className="pad"><div className="spinner" /></div> : data.contracts.length === 0 ? <Empty>{q ? 'No contracts match.' : tab === 'expiring' ? 'No contracts are ending soon.' : 'No contracts yet. Add one, or import the ones you already have from Excel.'}</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Number</th><th>Title</th><th>Party</th><th>Type</th><th>Status</th><th className="num">Value</th><th>Ends</th><th>Owner</th></tr></thead>
              <tbody>{data.contracts.map((r) => (
                <tr key={r.id} onClick={() => nav(`/staff/contracts/${r.id}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/staff/contracts/${r.id}`)}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}><Link to={`/staff/contracts/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.number}</Link>{r.reference && <div className="muted small">{r.reference}</div>}</td>
                  <td><div className="strong">{r.title}</div>{customers && <div className="muted small">{DIRECTION_LABEL[r.direction]}</div>}</td>
                  <td>{r.party.name}<div className="muted small mono">{r.party.code}</div></td>
                  <td className="small">{typeLabel(setup, r.type)}</td>
                  <td><ContractStatus status={r.status} expiring={r.expiring} /></td>
                  <td className="num">{r.value === null ? '—' : money(r.value, r.currency)}</td>
                  <td className="small">{r.endDate ? fmtDate(r.endDate) : 'No fixed end'}{r.expiring && r.daysLeft !== null && <div className="muted small">in {r.daysLeft} day{r.daysLeft === 1 ? '' : 's'}</div>}</td>
                  <td className="small">{r.owner ?? '—'}</td>
                </tr>
              ))}</tbody>
            </table>
            <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          </div>
        )}
      </div>
      {creating && setup && <NewContractModal setup={setup} ownerId={me?.user.id ?? ''} onClose={() => setCreating(false)} onCreated={(id) => nav(`/staff/contracts/${id}`)} />}
      {importing && (
        <ExcelImportModal<{ row: number; title: string; party: string; type: string }> title="Import existing contracts" endpoint="/staff/contracts/import" templateUrl="/staff/contracts/import-template.xlsx"
          intro="For contracts already signed outside VendorGate: one row each, with the party, type, dates and value. They come in as active (or expired if the end date has passed). Upload the signed copies on each contract afterwards."
          options={[{ key: 'createParties', label: 'Create missing parties', help: 'A supplier or customer not found by name or code is created (Party country is then needed).' }]}
          columns={[{ label: 'Title', cell: (r) => r.title }, { label: 'Party', cell: (r) => r.party }, { label: 'Type', cell: (r) => typeLabel(setup, r.type) }]}
          onClose={() => setImporting(false)} onDone={(n) => { setImporting(false); setFlash(`${n} contract${n === 1 ? '' : 's'} imported.`); load(); }} />
      )}
    </div>
  );
}

function NewContractModal({ setup, ownerId, onClose, onCreated }: { setup: Setup; ownerId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const [c, setC] = useState<ContractData>(blankContract(setup, 'BUY', ownerId));
  const [signed, setSigned] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true); setError(undefined);
    try { const r = await api<{ contract: { id: string } }>('/staff/contracts', { body: { ...contractBody(c), signed } }); onCreated(r.contract.id); }
    catch (e: any) { setError(e.message); setBusy(false); }
  }
  return (
    <Modal title="New contract" wide onClose={onClose} footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || c.title.trim().length < 3 || !c.partyId} onClick={create}>{signed ? 'Record contract' : 'Create draft'}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <p className="muted small" style={{ marginTop: 0 }}>A draft until it is signed — upload the signed copy and mark it signed on the contract. For a contract already signed, tick “Already signed”.</p>
      <ContractForm value={c} onChange={setC} setup={setup} askSigned signed={signed} onSigned={setSigned} />
    </Modal>
  );
}
