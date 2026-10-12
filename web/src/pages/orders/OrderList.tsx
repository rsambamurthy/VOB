import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { Alert, Empty, Modal } from '../../components/ui';
import { useHelpContext } from '../../help/HelpPanel';
import { AcceptanceBadge, DueText, money, type Counts, type OrderRow } from '../../orders/common';

interface ImportResult { created: number; updated: number; unchanged: number; failed: number; unmapped: number; errors: string[] }

export function OrderList() {
  const nav = useNavigate();
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<{ rows: OrderRow[]; counts: Counts; hasMore: boolean; page: number }>();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<ImportResult & { what: string }>();
  const [modal, setModal] = useState<'pull' | 'csv' | 'map'>();
  const [erp, setErp] = useState<{ kind: string; testMode: boolean }>();
  const filter = params.get('f') ?? 'WAITING';
  const manage = can('orders.manage');
  useHelpContext('orders');

  const load = useCallback(() => {
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (filter === 'WAITING' || filter === 'ACCEPTED' || filter === 'AUTO_ACCEPTED') qs.set('acceptance', filter);
    if (filter === 'DUE') qs.set('dueSoon', '1');
    if (filter === 'UNMAPPED') qs.set('unmapped', '1');
    if (filter === 'CLOSED') qs.set('status', 'CLOSED');
    if (params.get('page')) qs.set('page', params.get('page')!);
    if (params.get('vendor')) qs.set('vendorId', params.get('vendor')!);
    api(`/orders?${qs}`).then(setData).catch((e) => setError(e.message));
  }, [q, filter, params]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  useEffect(() => { if (can('tenant.settings') || manage) api('/admin/erp').then(setErp).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setF = (f: string) => { const p = new URLSearchParams(params); p.set('f', f); p.delete('page'); setParams(p, { replace: true }); };
  const c = data?.counts;
  const tiles: [string, string, number | undefined, string?][] = [
    ['WAITING', 'Waiting for supplier', c?.waiting, 'stat-under_review'], ['DUE', 'Auto-accept within 2 days', c?.dueSoon, 'stat-sent_back'],
    ['ACCEPTED', 'Accepted', c?.accepted, 'stat-approved'], ['AUTO_ACCEPTED', 'Auto-accepted', c?.autoAccepted, 'stat-in_progress'],
    ['CLOSED', 'Closed / cancelled', c?.closed, 'stat-invited'], ['ALL', 'All', c?.all],
  ];
  const canSample = !erp || erp.kind === 'none' || erp.testMode;

  async function samples() {
    setError(undefined);
    try { const r = await api('/orders/samples', { method: 'POST' }); setResult({ ...r, what: 'Sample purchase orders' }); load(); } catch (e: any) { setError(e.message); }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Purchase orders</h1><p className="muted">Orders from your ERP and where each one stands with the supplier.</p></div>
        {manage && <div className="head-actions">
          {erp?.kind === 'oracle' && <button className="btn btn-secondary" onClick={() => setModal('pull')}>Get from ERP</button>}
          <button className="btn btn-secondary" onClick={() => setModal('csv')}>Import CSV</button>
          {canSample && <button className="btn btn-ghost" onClick={samples} title="Creates a few Oracle-style orders for your approved vendors, to try the portal">Load sample orders</button>}
        </div>}
      </header>
      {error && <Alert kind="error">{error}</Alert>}
      {result && <ImportBanner r={result} onClose={() => setResult(undefined)} />}
      {manage && !!c?.unmapped && <Alert kind="warning"><strong>{c.unmapped}</strong> order{c.unmapped === 1 ? ' is' : 's are'} for supplier codes not linked to a vendor yet, so the supplier can’t see {c.unmapped === 1 ? 'it' : 'them'}. <button className="link-btn" onClick={() => setModal('map')}>Link supplier codes →</button></Alert>}

      <div className="stat-row stat-row-6">
        {tiles.map(([k, label, n, cls]) => (
          <button key={k} className={`stat ${cls ?? ''} ${filter === k ? 'active' : ''}`} onClick={() => setF(k)}><span className="stat-n">{n ?? '…'}</span><span className="stat-l">{label}</span></button>
        ))}
      </div>

      <div className="card">
        <div className="toolbar"><input className="search" placeholder="Search PO number, supplier or code…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search purchase orders" />
          {filter === 'UNMAPPED' && <span className="badge">Unlinked supplier codes</span>}
          {params.get('vendor') && <span className="badge">One vendor <button className="chip-x" aria-label="Show all vendors" onClick={() => { const p = new URLSearchParams(params); p.delete('vendor'); setParams(p, { replace: true }); }}>✕</button></span>}</div>
        {!data ? <div className="pad"><div className="spinner" /></div> : data.rows.length === 0 ? (
          <Empty>{c?.all ? 'No purchase orders match.' : <>No purchase orders yet. {manage && <>Connect your ERP under <Link to="/staff/admin/erp">ERP integration</Link>, import a CSV{canSample ? ', or load sample orders to try it out' : ''}.</>}</>}</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>PO</th><th>Supplier</th><th>Company / group</th><th className="num">Value</th><th>First need-by</th><th>Status</th></tr></thead>
              <tbody>{data.rows.map((r) => (
                <tr key={r.id} onClick={() => nav(`/staff/orders/${r.id}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/staff/orders/${r.id}`)}>
                  <td><div className="strong mono-num">{r.poNumber}{r.revision > 0 && <span className="muted small"> rev {r.revision}</span>}</div><div className="muted small">{fmtDate(r.poDate)} · {r.lines} line{r.lines === 1 ? '' : 's'}</div></td>
                  <td>{r.vendorName ? <><div>{r.vendorName}</div><div className="muted small mono">{r.vendorCode}</div></> : <><span className="badge flag-medium">Not linked</span><div className="muted small mono">{r.supplierCode}</div></>}</td>
                  <td className="small">{r.entity ?? '—'}<div className="muted">{r.group}</div></td>
                  <td className="num">{money(r.total, r.currency)}</td>
                  <td className="small">{fmtDate(r.firstNeedBy)}</td>
                  <td><AcceptanceBadge a={r.acceptance} status={r.status} />{r.acceptance === 'PARTIAL' && <div className="muted small">{r.pendingLines} line{r.pendingLines === 1 ? '' : 's'} waiting</div>}<div><DueText po={r} /></div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {data && (data.page > 1 || data.hasMore) && (
          <div className="pager">
            <button className="btn btn-ghost btn-sm" disabled={data.page <= 1} onClick={() => { const p = new URLSearchParams(params); p.set('page', String(data.page - 1)); setParams(p); }}>← Newer</button>
            <span className="muted small">Page {data.page}</span>
            <button className="btn btn-ghost btn-sm" disabled={!data.hasMore} onClick={() => { const p = new URLSearchParams(params); p.set('page', String(data.page + 1)); setParams(p); }}>Older →</button>
          </div>
        )}
      </div>
      {manage && <ImportHistory />}
      {modal === 'pull' && <PullModal onClose={() => setModal(undefined)} onDone={(r) => { setModal(undefined); setResult({ ...r, what: 'Pulled from Oracle' }); load(); }} />}
      {modal === 'csv' && <CsvModal onClose={() => setModal(undefined)} onDone={(r) => { setModal(undefined); setResult({ ...r, what: 'CSV import' }); load(); }} />}
      {modal === 'map' && <MapModal onClose={() => setModal(undefined)} onDone={() => { load(); }} />}
    </div>
  );
}

function ImportBanner({ r, onClose }: { r: ImportResult & { what: string }; onClose: () => void }) {
  return (
    <Alert kind={r.failed ? 'warning' : 'success'}>
      <div className="row-between"><span><strong>{r.what}:</strong> {r.created} new, {r.updated} updated, {r.unchanged} unchanged{r.failed ? `, ${r.failed} failed` : ''}{r.unmapped ? ` · ${r.unmapped} for unlinked supplier codes` : ''}.</span><button className="icon-btn" onClick={onClose} aria-label="Dismiss">✕</button></div>
      {r.errors.length > 0 && <ul className="small">{r.errors.slice(0, 5).map((e) => <li key={e}>{e}</li>)}</ul>}
    </Alert>
  );
}

function PullModal({ onClose, onDone }: { onClose: () => void; onDone: (r: ImportResult) => void }) {
  const [f, setF] = useState({ poNumber: '', supplierNumber: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function go() { setBusy(true); setError(undefined); try { onDone(await api('/orders/pull', { body: f })); } catch (e: any) { setError(e.message); setBusy(false); } }
  return (
    <Modal title="Get purchase orders from Oracle" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={go} disabled={busy}>{busy ? 'Getting…' : 'Get orders'}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <p className="muted small">Orders are pulled automatically every night. Use this when a PO was just approved or changed in Oracle and the supplier needs it now. Leave both empty to get everything changed since the last pull.</p>
      <div className="field-grid">
        <div className="field"><label htmlFor="pl-po">PO number</label><input id="pl-po" value={f.poNumber} onChange={(e) => setF({ ...f, poNumber: e.target.value })} placeholder="e.g. 4500012345" /></div>
        <div className="field"><label htmlFor="pl-sup">Supplier number</label><input id="pl-sup" value={f.supplierNumber} onChange={(e) => setF({ ...f, supplierNumber: e.target.value })} /></div>
      </div>
    </Modal>
  );
}

function CsvModal({ onClose, onDone }: { onClose: () => void; onDone: (r: ImportResult) => void }) {
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ref = useRef<HTMLInputElement>(null);
  async function go() {
    if (!file) return;
    setBusy(true); setError(undefined);
    try { onDone(await api('/orders/import-csv', { body: { csv: await file.text() } })); } catch (e: any) { setError(e.message); setBusy(false); }
  }
  return (
    <Modal title="Import purchase orders from CSV" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={go} disabled={!file || busy}>{busy ? 'Importing…' : 'Import'}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <p className="small">One row per PO line; the PO’s own columns repeat on each of its rows. Re-importing a PO updates it — lines whose quantity, price, need-by date or item changed go back to the supplier for acceptance.</p>
      <p className="small"><a href="/api/orders/import-template.csv" download>Download the template</a> (with two example rows).</p>
      <input ref={ref} type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0])} aria-label="CSV file" />
    </Modal>
  );
}

function MapModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [codes, setCodes] = useState<{ supplierCode: string; orders: number; latest: string | null }[]>();
  const [vendors, setVendors] = useState<{ id: string; name: string; code: string }[]>([]);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const load = () => api('/orders/unmapped').then(setCodes);
  useEffect(() => { load(); api('/staff/vendors?status=APPROVED').then((r) => setVendors(r.vendors)).catch(() => {}); }, []);
  async function link(code: string) {
    try { const r = await api('/orders/map-supplier', { body: { code, vendorId: pick[code] } }); setMsg({ kind: 'success', text: `${code} linked — ${r.attached} order${r.attached === 1 ? '' : 's'} sent to the supplier.` }); load(); onDone(); }
    catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  }
  return (
    <Modal title="Link supplier codes to vendors" wide onClose={onClose} footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
      <p className="muted small">The ERP sends each order with its own supplier code. Link each code to the approved vendor it belongs to; their waiting orders appear in their portal straight away, and future orders with that code are linked automatically.</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {!codes ? <div className="spinner" /> : !codes.length ? <Empty>Every supplier code is linked.</Empty> : (
        <table className="table static compact"><thead><tr><th>Supplier code</th><th className="num">Orders</th><th>Vendor</th><th /></tr></thead>
          <tbody>{codes.map((c) => (
            <tr key={c.supplierCode}><td className="mono">{c.supplierCode}</td><td className="num">{c.orders}</td>
              <td><select value={pick[c.supplierCode] ?? ''} onChange={(e) => setPick({ ...pick, [c.supplierCode]: e.target.value })} aria-label={`Vendor for ${c.supplierCode}`}><option value="">Choose an approved vendor…</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.code})</option>)}</select></td>
              <td className="actions"><button className="btn btn-primary btn-sm" disabled={!pick[c.supplierCode]} onClick={() => link(c.supplierCode)}>Link</button></td></tr>
          ))}</tbody></table>
      )}
    </Modal>
  );
}

function ImportHistory() {
  const [rows, setRows] = useState<{ id: string; source: string; requestedBy: string; status: string; created: number; updated: number; unchanged: number; failed: number; unmapped: number; errors: string[]; createdAt: string }[]>();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (open && !rows) api('/orders/imports').then(setRows); }, [open, rows]);
  const SRC: Record<string, string> = { oracle: 'Oracle', api: 'API', csv: 'CSV', demo: 'Sample' };
  return (
    <section className="card section-card" style={{ marginTop: 16 }}>
      <div className="toolbar"><button className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? '▾' : '▸'} Import history</button></div>
      {open && (rows ? (
        <table className="table static compact"><thead><tr><th>When</th><th>Source</th><th>By</th><th className="num">New</th><th className="num">Updated</th><th className="num">Failed</th><th>Notes</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td className="small nowrap">{fmtDateTime(r.createdAt)}</td><td>{SRC[r.source] ?? r.source}</td><td className="small">{r.requestedBy}</td><td className="num">{r.created}</td><td className="num">{r.updated}</td>
            <td className="num">{r.failed ? <span className="err-text">{r.failed}</span> : 0}</td><td className="small muted">{r.errors[0] ?? (r.unmapped ? `${r.unmapped} unlinked supplier code${r.unmapped === 1 ? '' : 's'}` : '')}</td></tr>)}
            {!rows.length && <tr><td colSpan={7} className="muted">Nothing imported yet.</td></tr>}</tbody></table>
      ) : <div className="pad"><div className="spinner" /></div>)}
    </section>
  );
}
