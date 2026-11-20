/** Managing signed contracts: amendments, obligations, agreed prices, the ERP — cards on the contract page, and the Obligations list. */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, money } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useHelpContext } from '../../help/HelpPanel';
import { Alert, Empty, Modal } from '../../components/ui';
import { TabStrip } from '../../components/TabStrip';
import { Pager } from '../../components/Pager';
import { ExcelImportModal } from '../../components/ExcelImport';
import { MessageStatus } from '../../components/ErpMessage';
import { ContractStatus } from '../../components/Contracts';

type Notify = (d: any, text?: string, kind?: 'success' | 'warning' | 'error') => void;
export interface Obligation { id: string; title: string; kind: string; side: 'US' | 'PARTY'; ownerId: string | null; owner: string | null; dueDate: string; recurrence: string; amount: number | null; remindDays: number; status: string; note: string | null; doneAt: string | null; doneByName: string | null; overdue: boolean; dueSoon: boolean }
export interface Manage {
  options: { obligations: boolean; prices: boolean; erp: boolean; renewalAlerts: boolean };
  obligations: Obligation[]; kinds: Record<string, string>; recurrence: Record<string, string>;
  prices: { id: string; itemCode: string | null; description: string; uom: string | null; price: number }[];
  amendments: { id: string; number: string; title: string; status: string; signedDate: string | null; lines: string[]; applied: boolean }[];
  amends: { parent: { id: string; number: string; title: string }; lines: string[]; applied: boolean } | null;
  canAmend: boolean;
  erpMessages: { id: string; status: string; connector: string; error: string | null; createdAt: string; sentAt: string | null; target: string | null }[];
}
async function call(path: string, body: unknown, onDetail: Notify, ok: string, method = 'POST') {
  try { onDetail(await api(path, { method, body }), ok); return true; } catch (e: any) { onDetail(undefined, e.message, 'error'); return false; }
}

/* ---------------- amendments ---------------- */

export function AmendsCard({ m }: { m: Manage }) {
  if (!m.amends) return null;
  return (
    <section className="card pad section-card" aria-label="What this amendment changes">
      <h3>What this amendment changes</h3>
      <p className="small muted" style={{ marginTop: 0 }}>Amends <Link to={`/staff/contracts/${m.amends.parent.id}`}>{m.amends.parent.number}</Link> — {m.amends.parent.title}. {m.amends.applied ? 'Applied to the contract when it was signed.' : 'Applied to the contract when this amendment is signed.'}</p>
      <ol style={{ margin: 0, paddingInlineStart: 20 }}>{m.amends.lines.map((l, i) => <li key={i}>{l}</li>)}</ol>
    </section>
  );
}

export function AmendmentsCard({ contract, m, manage }: { contract: { id: string; endDate: string | null; value: number | null; currency: string; noticeDays: number | null; autoRenew: boolean; renewalTermMonths: number | null }; m: Manage; manage: boolean }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  if (!m.amendments.length && !(manage && m.canAmend)) return null;
  return (
    <section className="card pad section-card" aria-label="Amendments" id="amendments">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div><h3 style={{ marginBottom: 2 }}>Amendments</h3><p className="muted small" style={{ marginTop: 0 }}>Dates, value, renewal or terms change through a signed amendment — drafted, approved, reviewed and signed like any contract.</p></div>
        {manage && m.canAmend && <button className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>+ New amendment</button>}
      </div>
      {m.amendments.length > 0 && <table className="table static compact"><thead><tr><th>Number</th><th>Changes</th><th>Status</th></tr></thead>
        <tbody>{m.amendments.map((a) => <tr key={a.id}><td className="mono"><Link to={`/staff/contracts/${a.id}`}>{a.number}</Link>{a.signedDate && <div className="muted small">signed {fmtDate(a.signedDate)}</div>}</td>
          <td className="small">{a.lines.join(' ')}</td><td><ContractStatus status={a.status} />{a.applied && <div className="muted small">applied</div>}</td></tr>)}</tbody></table>}
      {open && <NewAmendmentModal contract={contract} onClose={() => setOpen(false)} onCreated={(id) => nav(`/staff/contracts/${id}`)} />}
    </section>
  );
}

function NewAmendmentModal({ contract: c, onClose, onCreated }: { contract: Parameters<typeof AmendmentsCard>[0]['contract']; onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState({ endDate: c.endDate ?? '', value: c.value === null ? '' : String(c.value), noticeDays: c.noticeDays === null ? '' : String(c.noticeDays), autoRenew: c.autoRenew, renewalTermMonths: c.renewalTermMonths === null ? '' : String(c.renewalTermMonths), description: '' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(/,/g, '')));
  async function create() {
    setBusy(true); setError(undefined);
    try {
      const body: Record<string, unknown> = { description: f.description || null };
      if (f.endDate !== (c.endDate ?? '')) body.endDate = f.endDate || null;
      if (num(f.value) !== c.value) body.value = num(f.value);
      if (num(f.noticeDays) !== c.noticeDays) body.noticeDays = num(f.noticeDays);
      if (f.autoRenew !== c.autoRenew) body.autoRenew = f.autoRenew;
      if (f.autoRenew && num(f.renewalTermMonths) !== c.renewalTermMonths) body.renewalTermMonths = num(f.renewalTermMonths);
      const r = await api<{ contract: { id: string } }>(`/staff/contracts/${c.id}/amendments`, { body });
      onCreated(r.contract.id);
    } catch (e: any) { setError(e.message); setBusy(false); }
  }
  return (
    <Modal title="New amendment" wide onClose={onClose} footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={create}>Create the amendment</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <p className="muted small" style={{ marginTop: 0 }}>Change what the amendment changes; leave the rest as it is. It is created as a draft — draft it from the Amendment template, get it approved and signed; the contract changes when it is signed.</p>
      <div className="field-grid">
        <div className="field"><label htmlFor="am-end">End date</label><input id="am-end" type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></div>
        <div className="field"><label htmlFor="am-val">Value ({c.currency})</label><input id="am-val" inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /></div>
        <div className="field"><label htmlFor="am-notice">Notice period (days)</label><input id="am-notice" inputMode="numeric" value={f.noticeDays} onChange={(e) => setF({ ...f, noticeDays: e.target.value })} /></div>
        <div className="field"><label className="check-item"><input type="checkbox" checked={f.autoRenew} onChange={(e) => setF({ ...f, autoRenew: e.target.checked })} /> <span>Renews automatically</span></label>
          {f.autoRenew && <><label htmlFor="am-renew">for (months)</label><input id="am-renew" inputMode="numeric" value={f.renewalTermMonths} onChange={(e) => setF({ ...f, renewalTermMonths: e.target.value })} /></>}</div>
        <div className="field field-wide"><label htmlFor="am-desc">Other changes (in words)</label><textarea id="am-desc" rows={3} value={f.description} placeholder="e.g. Two more chillers are added to the scope from 1 April." onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
      </div>
    </Modal>
  );
}

/* ---------------- obligations ---------------- */

export function ObligationsCard({ contractId, m, manage, ended, owners, partyName, onDetail }: { contractId: string; m: Manage; manage: boolean; ended: boolean; owners: { id: string; name: string }[]; partyName: string; onDetail: Notify }) {
  const [edit, setEdit] = useState<Obligation | 'new'>();
  if (!m.options.obligations) return null;
  const open = m.obligations.filter((o) => o.status === 'OPEN'), closed = m.obligations.filter((o) => o.status !== 'OPEN');
  const row = (o: Obligation) => (
    <tr key={o.id}>
      <td><b>{o.title}</b><div className="muted small">{m.kinds[o.kind]} · {o.side === 'US' ? 'we do it' : `${partyName} does it`}{o.recurrence !== 'NONE' ? ` · ${m.recurrence[o.recurrence].toLowerCase()}` : ''}{o.amount !== null ? ` · ${money(o.amount)}` : ''}</div></td>
      <td className="small">{fmtDate(o.dueDate)}{o.overdue && <div><span className="badge sm badge-rejected">Overdue</span></div>}{o.dueSoon && <div><span className="badge sm flag-medium">Due soon</span></div>}</td>
      <td className="small">{o.owner ?? '—'}</td>
      <td className="actions" style={{ whiteSpace: 'nowrap' }}>{o.status === 'OPEN' ? manage && <>
        <button className="btn btn-secondary btn-sm" onClick={() => call(`/staff/contracts/${contractId}/obligations/${o.id}/status`, { status: 'DONE' }, onDetail, o.recurrence !== 'NONE' ? 'Done — the next one is added.' : 'Marked as done.')}>Done</button>
        <button className="link-btn small" onClick={() => setEdit(o)}>Edit</button></>
        : <span className="muted small">{o.status === 'DONE' ? 'Done' : 'Waived'}{o.doneByName ? ` by ${o.doneByName}` : ''}{o.doneAt ? `, ${fmtDate(o.doneAt)}` : ''}</span>}</td>
    </tr>);
  return (
    <section className="card pad section-card" aria-label="Obligations">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div><h3 style={{ marginBottom: 2 }}>Obligations</h3><p className="muted small" style={{ marginTop: 0 }}>Deliverables, payments, reports and service levels — the owner is reminded before each due date and when one is overdue.</p></div>
        {manage && !ended && <button className="btn btn-secondary btn-sm" onClick={() => setEdit('new')}>+ Add obligation</button>}
      </div>
      {!m.obligations.length ? <p className="muted small">None yet.</p> : <table className="table static compact"><thead><tr><th>What</th><th>Due</th><th>Owner</th><th /></tr></thead><tbody>{open.map(row)}{closed.slice(0, 10).map(row)}</tbody></table>}
      {edit && <ObligationModal contractId={contractId} o={edit === 'new' ? null : edit} m={m} owners={owners} partyName={partyName} onClose={() => setEdit(undefined)} onDetail={(d, t, k) => { onDetail(d, t, k); if (d) setEdit(undefined); }} />}
    </section>
  );
}

function ObligationModal({ contractId, o, m, owners, partyName, onClose, onDetail }: { contractId: string; o: Obligation | null; m: Manage; owners: { id: string; name: string }[]; partyName: string; onClose: () => void; onDetail: Notify }) {
  const [f, setF] = useState({ title: o?.title ?? '', kind: o?.kind ?? 'DELIVERABLE', side: o?.side ?? 'PARTY', ownerId: o?.ownerId ?? '', dueDate: o?.dueDate ?? '', recurrence: o?.recurrence ?? 'NONE', amount: o?.amount === null || !o ? '' : String(o.amount), remindDays: String(o?.remindDays ?? 7), note: o?.note ?? '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const body = { ...f, ownerId: f.ownerId || null, amount: f.amount ? Number(f.amount.replace(/,/g, '')) : null, remindDays: Number(f.remindDays || 0), note: f.note || null };
  const base = `/staff/contracts/${contractId}/obligations`;
  return (
    <Modal title={o ? 'Edit obligation' : 'Add an obligation'} wide onClose={onClose} footer={<>
      {o && <button className="btn btn-secondary" onClick={() => call(`${base}/${o.id}/status`, { status: 'WAIVED' }, onDetail, 'Waived.')}>Waive</button>}
      {o && <button className="btn btn-secondary" onClick={() => confirm('Remove this obligation?') && call(`${base}/${o.id}`, undefined, onDetail, 'Removed.', 'DELETE')}>Remove</button>}
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={f.title.trim().length < 3 || !f.dueDate} onClick={() => (o ? call(`${base}/${o.id}`, body, onDetail, 'Saved.', 'PUT') : call(base, body, onDetail, 'Obligation added.'))}>Save</button></>}>
      <div className="field-grid">
        <div className="field field-wide"><label htmlFor="ob-title">What has to be done</label><input id="ob-title" value={f.title} onChange={set('title')} placeholder="e.g. Quarterly preventive maintenance report" /></div>
        <div className="field"><label htmlFor="ob-kind">Kind</label><select id="ob-kind" value={f.kind} onChange={set('kind')}>{Object.entries(m.kinds).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="field"><label htmlFor="ob-side">Who does it</label><select id="ob-side" value={f.side} onChange={set('side')}><option value="PARTY">{partyName}</option><option value="US">We do</option></select></div>
        <div className="field"><label htmlFor="ob-due">Due date</label><input id="ob-due" type="date" value={f.dueDate} onChange={set('dueDate')} /></div>
        <div className="field"><label htmlFor="ob-rec">Repeats</label><select id="ob-rec" value={f.recurrence} onChange={set('recurrence')}>{Object.entries(m.recurrence).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="field"><label htmlFor="ob-owner">Owner (gets the reminders)</label><select id="ob-owner" value={f.ownerId} onChange={set('ownerId')}><option value="">The contract’s owner</option>{owners.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>
        <div className="field"><label htmlFor="ob-remind">Remind (days before)</label><input id="ob-remind" inputMode="numeric" value={f.remindDays} onChange={set('remindDays')} /></div>
        <div className="field"><label htmlFor="ob-amt">Amount (optional)</label><input id="ob-amt" inputMode="decimal" value={f.amount} onChange={set('amount')} /></div>
        <div className="field field-wide"><label htmlFor="ob-note">Note</label><textarea id="ob-note" rows={2} value={f.note} onChange={set('note')} /></div>
      </div>
    </Modal>
  );
}

/** Contracts → Obligations: open obligations across all contracts. */
export function ObligationsList() {
  useHelpContext('contract-obligations');
  const { can } = useSession();
  const [importing, setImporting] = useState(false);
  const [params, setParams] = useSearchParams();
  const filter = params.get('filter') ?? 'open';
  const mine = params.get('mine') === '1';
  const [page, setPage] = useState(1);
  const [d, setD] = useState<{ obligations: (Obligation & { contract: { id: string; number: string; title: string; party: string } })[]; total: number; page: number; pageSize: number; overdue: number; kinds: Record<string, string> }>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => api<typeof d>(`/staff/contracts/obligations?filter=${filter}&page=${page}${mine ? '&mine=1' : ''}`).then(setD).catch((e) => setError(e.message)), [filter, page, mine]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [filter, mine]);
  const tabs: [string, string][] = [['open', 'Open'], ['overdue', `Overdue${d?.overdue ? ` (${d.overdue})` : ''}`], ['soon', 'Due in 30 days'], ['done', 'Done']];
  return (
    <div className="page">
      <header className="page-head"><div><h1>Obligations</h1><p className="muted">What has to be done under your contracts, and when.</p></div>
        <div className="head-actions"><label className="check-item"><input type="checkbox" checked={mine} onChange={(e) => setParams({ filter, ...(e.target.checked ? { mine: '1' } : {}) })} /> <span>Only mine</span></label>{can('contracts.manage') && <button className="btn btn-secondary" onClick={() => setImporting(true)}>Import from Excel</button>}</div></header>
      {importing && <ExcelImportModal<{ row: number; contract: string; title: string }> title="Import obligations" endpoint="/staff/contracts/obligations/import" templateUrl="/staff/contracts/obligations/import-template.xlsx"
        intro="Obligations for many contracts at once — each row names its contract by number or reference. Existing obligations are kept." columns={[{ label: 'Contract', cell: (r) => r.contract }, { label: 'What', cell: (r) => r.title }]}
        onClose={() => setImporting(false)} onDone={() => { setImporting(false); load(); }} />}
      {error && <Alert kind="error">{error}</Alert>}
      <TabStrip>{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'active' : ''} onClick={() => setParams({ filter: k, ...(mine ? { mine: '1' } : {}) })}>{l}</button>)}</TabStrip>
      <div className="card">
        {!d ? <div className="pad"><div className="spinner" /></div> : !d.obligations.length ? <Empty>Nothing here.</Empty> : <div className="table-wrap"><table className="table">
          <thead><tr><th>What</th><th>Contract</th><th>Due</th><th>Owner</th></tr></thead>
          <tbody>{d.obligations.map((o) => <tr key={o.id}>
            <td><b>{o.title}</b><div className="muted small">{d.kinds[o.kind]} · {o.side === 'US' ? 'we do it' : `${o.contract.party} does it`}</div></td>
            <td><Link to={`/staff/contracts/${o.contract.id}`} className="mono">{o.contract.number}</Link><div className="muted small">{o.contract.title}</div></td>
            <td className="small">{fmtDate(o.dueDate)}{o.overdue && <div><span className="badge sm badge-rejected">Overdue</span></div>}{o.status !== 'OPEN' && <div className="muted">{o.status === 'DONE' ? 'Done' : 'Waived'}</div>}</td>
            <td className="small">{o.owner ?? '—'}</td></tr>)}</tbody></table>
          <Pager page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} /></div>}
      </div>
    </div>
  );
}

/* ---------------- prices and ERP ---------------- */

export function PricesCard({ contractId, currency, m, manage, editable, onDetail, reload }: { contractId: string; currency: string; m: Manage; manage: boolean; editable: boolean; onDetail: Notify; reload: () => void }) {
  const [rows, setRows] = useState<{ itemCode: string; description: string; uom: string; price: string }[] | null>(null);
  const [importing, setImporting] = useState(false);
  if (!m.options.prices) return null;
  const start = () => setRows(m.prices.length ? m.prices.map((p) => ({ itemCode: p.itemCode ?? '', description: p.description, uom: p.uom ?? '', price: String(p.price) })) : [{ itemCode: '', description: '', uom: '', price: '' }]);
  const set = (i: number, k: string, v: string) => setRows(rows!.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <section className="card pad section-card" aria-label="Agreed prices">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div><h3 style={{ marginBottom: 2 }}>Agreed prices</h3><p className="muted small" style={{ marginTop: 0 }}>Purchase orders and supplier invoices for these items are checked against these prices (matched on item code).</p></div>
        {manage && editable && !rows && <div className="btn-row" style={{ margin: 0 }}><button className="btn btn-secondary btn-sm" onClick={() => setImporting(true)}>Import from Excel</button><button className="btn btn-secondary btn-sm" onClick={start}>Edit</button></div>}
      </div>
      {!rows ? (m.prices.length ? <table className="table static compact"><thead><tr><th>Item code</th><th>Description</th><th>Unit</th><th className="num">Price ({currency})</th></tr></thead>
        <tbody>{m.prices.map((p) => <tr key={p.id}><td className="mono small">{p.itemCode ?? '—'}</td><td>{p.description}</td><td className="small">{p.uom ?? ''}</td><td className="num">{money(p.price, currency)}</td></tr>)}</tbody></table> : <p className="muted small">No prices yet.</p>)
        : <>
          <table className="table static compact"><thead><tr><th>Item code</th><th>Description</th><th>Unit</th><th>Price</th><th /></tr></thead><tbody>{rows.map((r, i) => <tr key={i}>
            <td><input aria-label={`Item code ${i + 1}`} value={r.itemCode} onChange={(e) => set(i, 'itemCode', e.target.value)} /></td>
            <td><input aria-label={`Description ${i + 1}`} value={r.description} onChange={(e) => set(i, 'description', e.target.value)} /></td>
            <td><input aria-label={`Unit ${i + 1}`} value={r.uom} onChange={(e) => set(i, 'uom', e.target.value)} style={{ width: 70 }} /></td>
            <td><input aria-label={`Price ${i + 1}`} inputMode="decimal" value={r.price} onChange={(e) => set(i, 'price', e.target.value)} style={{ width: 110 }} /></td>
            <td><button className="icon-btn" aria-label={`Remove line ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button></td></tr>)}</tbody></table>
          <button className="link-btn small" onClick={() => setRows([...rows, { itemCode: '', description: '', uom: '', price: '' }])}>+ Add a line</button>
          <div className="btn-row"><button className="btn btn-secondary" onClick={() => setRows(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => call(`/staff/contracts/${contractId}/prices`, { prices: rows.filter((r) => r.description.trim()).map((r) => ({ itemCode: r.itemCode || null, description: r.description, uom: r.uom || null, price: Number(r.price.replace(/,/g, '')) })) }, onDetail, 'Prices saved.', 'PUT').then((ok) => ok && setRows(null))}>Save prices</button></div>
        </>}
      {importing && <ExcelImportModal<{ row: number; itemCode: string | null; description: string; price: number }> title="Import prices" endpoint={`/staff/contracts/${contractId}/prices/import`} templateUrl="/staff/contracts/prices-template.xlsx"
        intro="One row per item or service at the agreed price. Importing replaces the whole price list."
        columns={[{ label: 'Item code', cell: (r) => r.itemCode ?? '' }, { label: 'Description', cell: (r) => r.description }, { label: 'Price', cell: (r) => money(r.price, currency) }]}
        onClose={() => setImporting(false)} onDone={() => { setImporting(false); reload(); }} />}
    </section>
  );
}

export function ErpCard({ contractId, m, manage, active, onDetail }: { contractId: string; m: Manage; manage: boolean; active: boolean; onDetail: Notify }) {
  if (!m.options.erp || (!m.erpMessages.length && !active)) return null;
  return (
    <section className="card pad section-card" aria-label="ERP">
      <h3>ERP</h3>
      {!m.erpMessages.length ? <p className="muted small">Not sent yet. Signed supplier contracts go to the ERP as a blanket agreement with their prices.</p>
        : <ul className="plain-list">{m.erpMessages.map((x) => <li key={x.id} className="small"><MessageStatus status={x.status} error={x.error} /> {fmtDateTime(x.sentAt ?? x.createdAt)}</li>)}</ul>}
      {manage && active && <button className="btn btn-secondary btn-sm" onClick={() => call(`/staff/contracts/${contractId}/erp`, {}, onDetail, 'Queued for the ERP.')}>{m.erpMessages.length ? 'Send again' : 'Send to the ERP'}</button>}
    </section>
  );
}
