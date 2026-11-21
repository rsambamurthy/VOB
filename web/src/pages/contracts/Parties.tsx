/** Contracts → Parties: suppliers and customers, and one party's page (details, contacts, supplier link, contracts). */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDate, money } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useHelpContext } from '../../help/HelpPanel';
import { Alert, Empty, Modal, StatusBadge } from '../../components/ui';
import { TabStrip } from '../../components/TabStrip';
import { Pager } from '../../components/Pager';
import { RiskBadge } from '../../components/Risk';
import { ExcelImportModal } from '../../components/ExcelImport';
import { HistoryCard } from '../../components/HistoryCard';
import { ContractStatus, KIND_LABEL, NewPartyModal, PartyForm, partyBody, usePartySetup, type PartyData } from '../../components/Contracts';
import type { VendorStatus } from '../../lib/types';

interface Supplier { id: string; code: string; name: string; status: string; riskBand: string | null }
interface PartyRow extends PartyData { id: string; code: string; status: string; vendorId: string | null; contracts: number; activeContracts: number; supplier: Supplier | null }

export function PartiesList() {
  useHelpContext('contract-parties');
  const { me, can } = useSession();
  const setup = usePartySetup();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const kind = params.get('kind') ?? '';
  const archived = params.get('status') === 'ARCHIVED';
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ parties: PartyRow[]; total: number; page: number; pageSize: number }>();
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [flash, setFlash] = useState<string>();
  const customers = !!me?.contracts?.directions.includes('SELL');
  const load = useCallback(() => {
    const p = new URLSearchParams({ page: String(page) });
    if (q) p.set('q', q); if (kind) p.set('kind', kind); if (archived) p.set('status', 'ARCHIVED');
    api<typeof data>(`/staff/parties?${p}`).then(setData).catch((e) => setError(e.message));
  }, [q, kind, archived, page]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  useEffect(() => { setPage(1); }, [q, kind, archived]);
  const tabs: [string, string][] = [['', 'All'], ['SUPPLIER', 'Suppliers'], ...(customers ? [['CUSTOMER', 'Customers'] as [string, string]] : []), ['ARCHIVED', 'Archived']];
  const current = archived ? 'ARCHIVED' : kind;
  return (
    <div className="page">
      <header className="page-head">
        <div><h1>{me?.contracts?.on ? 'Parties' : 'Suppliers'}</h1><p className="muted">{me?.contracts?.on ? `The ${customers ? 'suppliers and customers' : 'suppliers'} you have contracts with.` : 'The suppliers you receive invoices from.'}</p></div>
        {(can('contracts.manage') || can('invoices.capture') || can('invoices.manage')) && setup && <div className="head-actions">
          <button className="btn btn-secondary" onClick={() => setImporting(true)}>Import from Excel</button>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>+ New party</button></div>}
      </header>
      {error && <Alert kind="error">{error}</Alert>}
      {flash && <Alert kind="success">{flash}</Alert>}
      <TabStrip>{tabs.map(([k, l]) => <button key={k || 'all'} role="tab" aria-selected={current === k} className={current === k ? 'active' : ''} onClick={() => setParams(k === 'ARCHIVED' ? { status: 'ARCHIVED' } : k ? { kind: k } : {})}>{l}</button>)}</TabStrip>
      <div className="card">
        <div className="toolbar"><input className="search" placeholder="Search name, code, tax or registration number…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search parties" /></div>
        {!data ? <div className="pad"><div className="spinner" /></div> : data.parties.length === 0 ? <Empty>{q ? 'No parties match.' : 'No parties yet.'}</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Party</th><th>Type</th><th>Country</th><th>Tax number</th>{me?.contracts?.on && <th className="num">Contracts</th>}{me?.contracts?.linkSuppliers && <th>Supplier record</th>}</tr></thead>
            <tbody>{data.parties.map((p) => (
              <tr key={p.id} onClick={() => nav(`/staff/parties/${p.id}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/staff/parties/${p.id}`)}>
                <td><div className="strong"><Link to={`/staff/parties/${p.id}`} onClick={(e) => e.stopPropagation()}>{p.name}</Link></div><div className="muted small mono">{p.code}</div></td>
                <td>{KIND_LABEL[p.kind]}</td><td>{p.country}</td><td className="mono small">{p.taxNo ?? '—'}</td>
                {me?.contracts?.on && <td className="num">{p.activeContracts} active{p.contracts > p.activeContracts ? ` · ${p.contracts} in all` : ''}</td>}
                {me?.contracts?.linkSuppliers && <td>{p.supplier ? <><StatusBadge status={p.supplier.status as VendorStatus} />{p.supplier.riskBand && <RiskBadge band={p.supplier.riskBand} />}</> : <span className="muted small">—</span>}</td>}
              </tr>))}</tbody>
          </table><Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} /></div>
        )}
      </div>
      {creating && setup && <NewPartyModal kind={kind === 'CUSTOMER' ? 'CUSTOMER' : 'SUPPLIER'} countries={setup.countries} country={setup.country} onClose={() => setCreating(false)} onCreated={(p) => nav(`/staff/parties/${p.id}`)} />}
      {importing && (
        <ExcelImportModal<{ row: number; kind: string; name: string; country: string }> title="Import parties" endpoint="/staff/parties/import" templateUrl="/staff/parties/import-template.xlsx"
          intro="One row per supplier or customer, with one contact. Rows that look like an existing party (same name, tax or registration number) are left out."
          columns={[{ label: 'Name', cell: (r) => r.name }, { label: 'Type', cell: (r) => KIND_LABEL[r.kind] }, { label: 'Country', cell: (r) => r.country }]}
          onClose={() => setImporting(false)} onDone={(n) => { setImporting(false); setFlash(`${n} part${n === 1 ? 'y' : 'ies'} imported.`); load(); }} />
      )}
    </div>
  );
}

interface PartyDetailData {
  party: PartyRow & { createdByName: string; createdAt: string };
  supplier: Supplier | null; canLink: boolean;
  contracts: { id: string; number: string; title: string; type: string; direction: string; status: string; value: string | null; currency: string; startDate: string | null; endDate: string | null }[];
  history: { actor: string; action: string; detail: Record<string, unknown> | null; createdAt: string }[];
}
const ACTIONS: Record<string, string> = { PARTY_CREATED: 'Created', PARTY_UPDATED: 'Details changed', PARTY_ARCHIVED: 'Archived', PARTY_RESTORED: 'Restored', PARTY_LINKED: 'Linked to the supplier record', PARTY_UNLINKED: 'Unlinked from the supplier record', PARTY_SENT_FOR_ONBOARDING: 'Sent for supplier onboarding' };

export function PartyDetail() {
  useHelpContext('contract-parties');
  const { id } = useParams();
  const { me, can } = useSession();
  const setup = usePartySetup();
  const typeLabel = (k: string) => (k === 'amendment' ? 'Amendment' : me?.contracts?.types.find((x) => x.key === k)?.label ?? k);
  const [d, setD] = useState<PartyDetailData>();
  const [form, setForm] = useState<PartyData>();
  const [editing, setEditing] = useState(false);
  const [dup, setDup] = useState(false);
  const [linking, setLinking] = useState(false);
  const [flash, setFlash] = useState<{ kind: 'success' | 'error' | 'warning'; text: string }>();
  const take = (r: PartyDetailData) => { setD(r); setForm(r.party); };
  const load = useCallback(() => api<PartyDetailData>(`/staff/parties/${id}`).then(take).catch((e) => setFlash({ kind: 'error', text: e.message })), [id]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<PartyDetailData>, ok: string) => { setFlash(undefined); try { take(await fn()); setFlash({ kind: 'success', text: ok }); return true; } catch (e: any) { setFlash({ kind: 'error', text: e.message }); return false; } };
  if (!d || !form) return <div className="page">{flash ? <Alert kind="error">{flash.text}</Alert> : <div className="spinner" />}</div>;
  const p = d.party;
  const manage = can('contracts.manage') || can('invoices.capture') || can('invoices.manage');
  async function save() {
    setFlash(undefined);
    try { take(await api<PartyDetailData>(`/staff/parties/${p.id}`, { method: 'PATCH', body: partyBody(form!, dup) })); setEditing(false); setDup(false); setFlash({ kind: 'success', text: 'Saved.' }); }
    catch (e: any) { setFlash({ kind: /looks like/.test(e.message) ? 'warning' : 'error', text: e.message }); if (/looks like/.test(e.message)) setDup(true); }
  }
  return (
    <div className="page">
      <nav className="breadcrumb"><Link to="/staff/parties">{me?.contracts?.on ? 'Parties' : 'Suppliers'}</Link> › {p.code}</nav>
      <header className="page-head">
        <div><h1>{p.name}</h1><p className="muted"><span className="mono">{p.code}</span> · {KIND_LABEL[p.kind]} · {p.country}{p.status === 'ARCHIVED' && <> · <span className="badge sm">Archived</span></>}</p></div>
        {manage && <div className="head-actions">
          {!editing && <button className="btn btn-secondary" onClick={() => setEditing(true)}>Edit</button>}
          <button className="btn btn-secondary" onClick={() => run(() => api(`/staff/parties/${p.id}/archive`, { body: { archived: p.status !== 'ARCHIVED' } }), p.status === 'ARCHIVED' ? 'Restored.' : 'Archived.')}>{p.status === 'ARCHIVED' ? 'Restore' : 'Archive'}</button>
        </div>}
      </header>
      {flash && <Alert kind={flash.kind}>{flash.text}</Alert>}
      <div className="detail-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)', gap: 16, alignItems: 'start' }}>
        <div>
          <section className="card pad section-card">
            <h3>Details</h3>
            {editing && setup ? <>
              <PartyForm value={form} onChange={(v) => { setForm(v); setDup(false); }} countries={setup.countries} kindFixed />
              <div className="btn-row"><button className="btn btn-secondary" onClick={() => { setForm(p); setEditing(false); setDup(false); }}>Cancel</button><button className="btn btn-primary" onClick={save}>{dup ? 'Save anyway' : 'Save'}</button></div>
            </> : (
              <dl className="kv">
                {p.legalName && <><dt>Legal name</dt><dd>{p.legalName}</dd></>}
                <dt>Registration number</dt><dd className="mono">{p.registrationNo ?? '—'}</dd>
                <dt>Tax number</dt><dd className="mono">{p.taxNo ?? '—'}</dd>
                <dt>Address</dt><dd>{[p.address.line1, p.address.city, p.address.region, p.address.postalCode].filter(Boolean).join(', ') || '—'}</dd>
                <dt>Email / phone</dt><dd>{[p.email, p.phone].filter(Boolean).join(' · ') || '—'}</dd>
                {p.website && <><dt>Website</dt><dd><a href={p.website} target="_blank" rel="noreferrer noopener">{p.website}</a></dd></>}
                <dt>Contacts</dt><dd>{p.contacts.length ? <ul className="plain-list">{p.contacts.map((c, i) => <li key={i}>{c.name}{c.role ? `, ${c.role}` : ''}{c.email ? ` · ${c.email}` : ''}{c.phone ? ` · ${c.phone}` : ''}{c.signatory && <span className="badge sm badge-approved" style={{ marginInlineStart: 6 }}>Signs</span>}</li>)}</ul> : '—'}</dd>
                {p.notes && <><dt>Notes</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{p.notes}</dd></>}
                {me?.invoices?.on && p.kind === 'SUPPLIER' && <><dt>In the ERP</dt><dd className="mono">{p.ap?.erpSupplierCode ? `${p.ap.erpSupplierCode}${p.ap.erpSiteCode ? ` / ${p.ap.erpSiteCode}` : ''}` : '—'}</dd>
                  <dt>Payment terms</dt><dd>{p.ap?.paymentTerms ?? '—'}</dd>
                  <dt>Default coding</dt><dd className="mono">{[p.ap?.defaultAccount, p.ap?.defaultCostCentre].filter(Boolean).join(' · ') || '—'}</dd>
                  <dt>Accounts email</dt><dd>{p.ap?.accountsEmail ?? '—'}</dd></>}
              </dl>
            )}
          </section>
          {me?.contracts?.on && <section className="card pad section-card">
            <h3>Contracts</h3>
            {d.contracts.length ? <table className="table static compact"><thead><tr><th>Number</th><th>Title</th><th>Type</th><th>Status</th><th className="num">Value</th><th>Ends</th></tr></thead>
              <tbody>{d.contracts.map((c) => <tr key={c.id}><td className="mono"><Link to={`/staff/contracts/${c.id}`}>{c.number}</Link></td><td>{c.title}</td><td className="small">{typeLabel(c.type)}</td><td><ContractStatus status={c.status} /></td>
                <td className="num">{c.value === null ? '—' : money(c.value, c.currency)}</td><td className="small">{c.endDate ? fmtDate(c.endDate) : '—'}</td></tr>)}</tbody></table> : <p className="muted small">No contracts with {p.name} yet.</p>}
          </section>}
        </div>
        <div>
          {d.canLink && (
            <section className="card pad section-card">
              <h3>Supplier record</h3>
              {d.supplier ? <>
                <p style={{ margin: 0 }}><Link to={`/staff/vendors/${d.supplier.id}`}>{d.supplier.name}</Link> <span className="muted small mono">{d.supplier.code}</span></p>
                <p><StatusBadge status={d.supplier.status as VendorStatus} />{d.supplier.riskBand && <RiskBadge band={d.supplier.riskBand} />}</p>
                {manage && <button className="link-btn small" onClick={() => run(() => api(`/staff/parties/${p.id}/link`, { body: { vendorId: null } }), 'Unlinked.')}>Unlink</button>}
              </> : <>
                <p className="muted small">Not linked to an onboarded supplier. Link it to see the supplier’s status and risk here — or send it for full onboarding.</p>
                {manage && <div className="btn-row">
                  <button className="btn btn-secondary btn-sm" onClick={() => setLinking(true)}>Link to a supplier</button>
                  {can('vendors.create') && <button className="btn btn-secondary btn-sm" onClick={() => confirm(`Invite ${p.name} to supplier onboarding? The first contact with an email gets the invitation.`) && run(() => api(`/staff/parties/${p.id}/onboard`, { method: 'POST' }), 'Invited to supplier onboarding.')}>Send for onboarding</button>}
                </div>}
              </>}
            </section>
          )}
          <HistoryCard rows={d.history} actions={ACTIONS} extra={(h) => (Array.isArray(h.detail?.fields) ? (h.detail!.fields as string[]).join(', ') : typeof h.detail?.source === 'string' ? `from ${h.detail.source}` : null)} />
        </div>
      </div>
      {linking && <LinkSupplierModal onClose={() => setLinking(false)} onPick={(vendorId) => run(() => api(`/staff/parties/${p.id}/link`, { body: { vendorId } }), 'Linked.').then((ok) => ok && setLinking(false))} />}
    </div>
  );
}

function LinkSupplierModal({ onClose, onPick }: { onClose: () => void; onPick: (vendorId: string) => void }) {
  const [list, setList] = useState<{ id: string; name: string; code: string }[]>([]);
  const [q, setQ] = useState('');
  useEffect(() => { api<{ vendors: typeof list }>('/staff/vendors/options').then((r) => setList(r.vendors)).catch(() => {}); }, []);
  const shown = list.filter((v) => !q || `${v.name} ${v.code}`.toLowerCase().includes(q.toLowerCase())).slice(0, 50);
  return (
    <Modal title="Link to a supplier" onClose={onClose} footer={<button className="btn btn-secondary" onClick={onClose}>Close</button>}>
      <input className="search" autoFocus placeholder="Search suppliers…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search suppliers" />
      <ul className="plain-list">{shown.map((v) => <li key={v.id}><button className="link-btn" onClick={() => onPick(v.id)}>{v.name}</button> <span className="muted small mono">{v.code}</span></li>)}</ul>
    </Modal>
  );
}
