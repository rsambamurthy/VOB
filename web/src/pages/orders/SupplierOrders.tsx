import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, loc } from '../../lib/format';
import { Alert, Empty, Modal } from '../../components/ui';
import { AcceptanceBadge, DueText, Facts, LinesTable, money, type Counts, type OrderDetailData, type OrderRow } from '../../orders/common';
import { useSupplier } from '../../orders/SupplierShell';
import { useHelpContext } from '../../help/HelpPanel';

interface ListResp { rows: OrderRow[]; hasMore: boolean; page: number; counts: Counts; filters: { entities: { id: string; code: string; name: string }[]; sites: { id: string; code: string; name: string }[] } }

const TILES: [string, string, keyof Counts, string][] = [
  ['WAITING', 'Waiting for you', 'waiting', 'stat-under_review'], ['ACCEPTED', 'Accepted', 'accepted', 'stat-approved'],
  ['AUTO_ACCEPTED', 'Auto-accepted', 'autoAccepted', 'stat-in_progress'], ['CLOSED', 'Closed / cancelled', 'closed', 'stat-invited'], ['ALL', 'All orders', 'all', ''],
];

export function SupplierOrderList() {
  useHelpContext('supplier-orders');
  const { info } = useSupplier();
  const [sp, setSp] = useSearchParams();
  const f = sp.get('f') ?? 'WAITING';
  const [q, setQ] = useState(sp.get('q') ?? '');
  const entityId = sp.get('entity') ?? '';
  const siteId = sp.get('site') ?? '';
  const page = Number(sp.get('page') ?? 1);
  const [d, setD] = useState<ListResp>();
  const [error, setError] = useState<string>();
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); if (v) n.set(k, v); else n.delete(k); if (k !== 'page') n.delete('page'); setSp(n, { replace: true }); };

  useEffect(() => {
    const qs = new URLSearchParams();
    if (f === 'CLOSED') qs.set('status', 'CLOSED'); else if (f !== 'ALL') qs.set('acceptance', f);
    if (sp.get('q')) qs.set('q', sp.get('q')!);
    if (entityId) qs.set('entityId', entityId);
    if (siteId) qs.set('siteId', siteId);
    if (page > 1) qs.set('page', String(page));
    api<ListResp>(`/vendor/orders?${qs}`).then(setD).catch((e) => setError(e.message));
  }, [sp]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Purchase orders</h1><p className="muted">Orders {info?.buyer.name} has placed with {info?.vendor.name}. Accept each order (or individual lines) to confirm you can supply it as written.</p></div>
      </header>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="stat-row stat-row-5">
        {TILES.map(([k, label, key, cls]) => (
          <button key={k} className={`stat ${cls} ${f === k ? 'active' : ''}`} onClick={() => set('f', k === 'WAITING' ? '' : k)}><span className="stat-n">{d ? d.counts[key] : '…'}</span><span className="stat-l">{label}</span></button>
        ))}
      </div>
      <section className="card">
        <div className="toolbar filters">
          <form onSubmit={(e) => { e.preventDefault(); set('q', q.trim()); }} className="inline-form"><input type="search" aria-label="Search orders" placeholder="PO number or item" value={q} onChange={(e) => setQ(e.target.value)} /></form>
          {d && d.filters.entities.length > 1 && <select aria-label="Company" value={entityId} onChange={(e) => set('entity', e.target.value)}><option value="">All companies</option>{d.filters.entities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
          {d && d.filters.sites.length > 1 && <select aria-label="Delivery site" value={siteId} onChange={(e) => set('site', e.target.value)}><option value="">All delivery sites</option>{d.filters.sites.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
        </div>
        {!d ? <div className="spinner" /> : d.rows.length ? (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>PO number</th><th>Ordered by</th><th>PO date</th><th>First need-by</th><th className="num">Value</th><th>Status</th></tr></thead>
            <tbody>{d.rows.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/vendor/orders/${r.id}`} className="strong mono-num">{r.poNumber}</Link>{r.revision > 0 && <div className="muted small">revision {r.revision}</div>}</td>
                <td className="small">{r.entity ?? '—'}{r.buyerName && <div className="muted">{r.buyerName}</div>}</td>
                <td className="small nowrap">{fmtDate(r.poDate)}</td>
                <td className="small nowrap">{fmtDate(r.firstNeedBy)}</td>
                <td className="num">{money(r.total, r.currency)}<div className="muted small">{r.lines} line{r.lines === 1 ? '' : 's'}</div></td>
                <td><AcceptanceBadge a={r.acceptance} status={r.status} />{r.acceptance === 'PARTIAL' && <div className="muted small">{r.pendingLines} line{r.pendingLines === 1 ? '' : 's'} waiting</div>}<div><DueText po={r} /></div></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty>{f === 'WAITING' ? 'Nothing waiting for you. New orders appear here as soon as they are sent.' : 'No orders here.'}</Empty>}
        {d && (page > 1 || d.hasMore) && <div className="pager"><button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => set('page', String(page - 1))}>← Previous</button><span className="small muted">Page {page}</span><button className="btn btn-ghost btn-sm" disabled={!d.hasMore} onClick={() => set('page', String(page + 1))}>Next →</button></div>}
      </section>
    </div>
  );
}

export function SupplierOrderDetail() {
  useHelpContext('supplier-order');
  const { id = '' } = useParams();
  const { info, reload } = useSupplier();
  const [d, setD] = useState<OrderDetailData>();
  const [error, setError] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const load = useCallback(() => api<OrderDetailData>(`/vendor/orders/${id}`).then((r) => { setD(r); setSel(new Set(r.lines.filter((l) => l.acceptance === 'PENDING' && l.status === 'OPEN').map((l) => l.id))); }).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  if (error && !d) return <div className="page"><Link to="/vendor/orders" className="back">← Purchase orders</Link><Alert kind="error">{error}</Alert></div>;
  if (!d) return <div className="page"><div className="spinner" /></div>;
  const { po } = d;
  const pending = d.lines.filter((l) => l.acceptance === 'PENDING' && l.status === 'OPEN');
  const canAccept = po.status === 'OPEN' && pending.length > 0;
  const all = sel.size === pending.length;

  return (
    <div className="page">
      <Link to="/vendor/orders" className="back">← Purchase orders</Link>
      <header className="page-head">
        <div><h1><span className="mono-num">PO {po.poNumber}</span>{po.revision > 0 && <span className="muted small"> revision {po.revision}</span>} <AcceptanceBadge a={po.acceptance} status={po.status} /></h1>
          <p className="muted">{d.entity?.name ?? info?.buyer.name} · {money(po.total, po.currency)} · ordered {fmtDate(po.poDate)}{po.status === 'OPEN' && (po.acceptance === 'PENDING' || po.acceptance === 'PARTIAL') && <> · <DueText po={po} /></>}</p></div>
      </header>
      {flash && <Alert kind="success">{flash}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      {po.revision > 0 && canAccept && d.history.some((h) => h.action === 'PO_REVISED') && <Alert kind="info">This order was changed after you last saw it. Lines that changed need your acceptance again.</Alert>}

      {canAccept && (
        <div className="action-bar">
          <div><strong>{pending.length === d.lines.filter((l) => l.status === 'OPEN').length ? 'This order is waiting for your acceptance.' : `${pending.length} line${pending.length === 1 ? ' is' : 's are'} waiting for your acceptance.`}</strong>
            <div className="muted small">{po.acceptDueAt ? `If you don’t respond, it is accepted automatically on ${fmtDate(po.acceptDueAt)}.` : 'Please accept, or contact the buyer if anything is wrong.'}</div></div>
          <button className="btn btn-primary" disabled={!sel.size} onClick={() => setConfirm(true)}>{all ? 'Accept order' : `Accept ${sel.size} selected line${sel.size === 1 ? '' : 's'}`}</button>
        </div>
      )}

      <section className="card section-card">
        <div className="toolbar"><h3>Lines</h3>{canAccept && pending.length > 1 && <span className="muted small">Untick lines you can’t accept yet</span>}</div>
        <LinesTable lines={d.lines} currency={po.currency} select={canAccept ? { selected: sel, toggle: (lid) => { const n = new Set(sel); if (n.has(lid)) n.delete(lid); else n.add(lid); setSel(n); }, toggleAll: (on) => setSel(on ? new Set(pending.map((l) => l.id)) : new Set()) } : undefined} />
      </section>
      <div className="detail-grid">
        <div>
          <section className="card pad">
            <h3 className="card-title">Order</h3>
            <Facts items={[
              ['Ordered by', d.entity?.name ?? info?.buyer.name ?? null], ['Buyer', po.buyerName ? <>{po.buyerName}{po.buyerEmail && <div className="small"><a href={`mailto:${po.buyerEmail}?subject=${encodeURIComponent(`PO ${po.poNumber}`)}`}>{po.buyerEmail}</a></div>}</> : null],
              ['PO date', fmtDate(po.poDate)], ['Payment terms', po.paymentTerms], ['Incoterms', po.incoterms], ['Your site', po.supplierSiteCode], ['Currency', po.currency],
            ]} />
            {po.notes && <p className="small muted">“{po.notes}”</p>}
            {po.attachments.length > 0 && <ul className="plain-list small">{po.attachments.map((a) => <li key={a.url}><a href={a.url} target="_blank" rel="noreferrer">📎 {a.name}</a></li>)}</ul>}
          </section>
          {d.receipts.length > 0 && (
            <section className="card section-card">
              <div className="toolbar"><h3>Received so far</h3></div>
              <table className="table static compact"><thead><tr><th>Receipt</th><th>Date</th><th>Line</th><th className="num">Quantity</th></tr></thead>
                <tbody>{d.receipts.map((r) => <tr key={r.id}><td className="mono">{r.receiptNumber}</td><td>{fmtDate(r.receiptDate)}</td><td>{d.lines.find((l) => l.id === r.lineId)?.lineNo ?? '—'}</td><td className="num">{Number(r.quantity).toLocaleString(loc())}</td></tr>)}</tbody></table>
            </section>
          )}
        </div>
        <aside className="side-col">
          {d.history.length > 0 && (
            <section className="card pad">
              <h3 className="card-title">History</h3>
              <ul className="plain-list small">{d.history.map((h) => <li key={h.id}><strong>{SUP_HIST[h.action] ?? h.action}</strong>{h.detail?.lines && <> · lines {h.detail.lines}</>}{h.detail?.note && <div className="muted">“{h.detail.note}”</div>}<div className="muted">{h.actor ? `${h.actor} · ` : ''}{fmtDateTime(h.createdAt)}</div></li>)}</ul>
            </section>
          )}
        </aside>
      </div>
      {confirm && <AcceptModal po={d.po} count={sel.size} all={all} onClose={() => setConfirm(false)} onAccept={async (note) => {
        try {
          await api(`/vendor/orders/${po.id}/accept`, { body: { lineIds: all ? undefined : [...sel], note: note || undefined } });
          setConfirm(false); setError(undefined); setFlash(all ? `PO ${po.poNumber} accepted. ${info?.buyer.name} has been told.` : `${sel.size} line${sel.size === 1 ? '' : 's'} accepted.`); load(); reload();
        } catch (e: any) { setConfirm(false); setError(e.message); }
      }} />}
    </div>
  );
}
const SUP_HIST: Record<string, string> = { PO_RECEIVED: 'Order sent to you', PO_REVISED: 'Order changed', PO_ACCEPTED: 'Accepted', PO_AUTO_ACCEPTED: 'Accepted automatically' };

function AcceptModal({ po, count, all, onClose, onAccept }: { po: OrderRow; count: number; all: boolean; onClose: () => void; onAccept: (note: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={all ? `Accept PO ${po.poNumber}?` : `Accept ${count} line${count === 1 ? '' : 's'}?`} onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={async () => { setBusy(true); await onAccept(note.trim()); setBusy(false); }}>{busy ? 'Accepting…' : 'Accept'}</button></>}>
      <p>You’re confirming that you can supply {all ? 'this order' : 'these lines'} at the quantities, prices and dates shown. This is sent to the buyer’s system and can’t be undone here.</p>
      <div className="field"><label htmlFor="acc-note">Note for the buyer (optional)</label><textarea id="acc-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Dispatch planned in two lots" /></div>
    </Modal>
  );
}
