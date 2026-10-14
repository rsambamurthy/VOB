import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, loc } from '../../lib/format';
import { Alert, Empty, Modal } from '../../components/ui';
import { AcceptanceBadge, DueText, Facts, LinesTable, money, type Counts, type OrderDetailData, type OrderRow } from '../../orders/common';
import { SupplierCollab } from '../../orders/collab';
import { useSupplier } from '../../orders/SupplierShell';
import { useHelpContext } from '../../help/HelpPanel';
import { backArrow, fwdArrow, t, type Key } from '../../i18n';

interface ListResp { rows: OrderRow[]; hasMore: boolean; page: number; counts: Counts; filters: { entities: { id: string; code: string; name: string }[]; sites: { id: string; code: string; name: string }[] } }

const TILES = (): [string, string, keyof Counts, string][] => [
  ['WAITING', t('orders.tileWaiting'), 'waiting', 'stat-under_review'], ['ACCEPTED', t('orders.tileAccepted'), 'accepted', 'stat-approved'],
  ['AUTO_ACCEPTED', t('orders.tileAuto'), 'autoAccepted', 'stat-in_progress'], ['CLOSED', t('orders.tileClosed'), 'closed', 'stat-invited'], ['ALL', t('orders.tileAll'), 'all', ''],
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
        <div><h1>{t('orders.title')}</h1><p className="muted">{t('orders.intro', { buyer: info?.buyer.name, vendor: info?.vendor.name })}</p></div>
      </header>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="stat-row stat-row-5">
        {TILES().map(([k, label, key, cls]) => (
          <button key={k} className={`stat ${cls} ${f === k ? 'active' : ''}`} onClick={() => set('f', k === 'WAITING' ? '' : k)}><span className="stat-n">{d ? d.counts[key] : '…'}</span><span className="stat-l">{label}</span></button>
        ))}
      </div>
      <section className="card">
        <div className="toolbar filters">
          <form onSubmit={(e) => { e.preventDefault(); set('q', q.trim()); }} className="inline-form"><input type="search" aria-label={t('orders.search')} placeholder={t('orders.searchPh')} value={q} onChange={(e) => setQ(e.target.value)} /></form>
          {d && d.filters.entities.length > 1 && <select aria-label={t('orders.company')} value={entityId} onChange={(e) => set('entity', e.target.value)}><option value="">{t('orders.allCompanies')}</option>{d.filters.entities.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
          {d && d.filters.sites.length > 1 && <select aria-label={t('orders.site')} value={siteId} onChange={(e) => set('site', e.target.value)}><option value="">{t('orders.allSites')}</option>{d.filters.sites.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
        </div>
        {!d ? <div className="spinner" /> : d.rows.length ? (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>{t('orders.colPo')}</th><th>{t('orders.colOrderedBy')}</th><th>{t('orders.colPoDate')}</th><th>{t('orders.colNeedBy')}</th><th className="num">{t('orders.colValue')}</th><th>{t('common.status')}</th></tr></thead>
            <tbody>{d.rows.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/vendor/orders/${r.id}`} className="strong mono-num">{r.poNumber}</Link>{r.revision > 0 && <div className="muted small">{t('orders.revision', { n: r.revision })}</div>}</td>
                <td className="small">{r.entity ?? '—'}{r.buyerName && <div className="muted">{r.buyerName}</div>}</td>
                <td className="small nowrap">{fmtDate(r.poDate)}</td>
                <td className="small nowrap">{fmtDate(r.firstNeedBy)}</td>
                <td className="num">{money(r.total, r.currency)}<div className="muted small">{t('orders.lines', { count: r.lines })}</div></td>
                <td><AcceptanceBadge a={r.acceptance} status={r.status} />{r.acceptance === 'PARTIAL' && <div className="muted small">{t('orders.linesWaiting', { count: r.pendingLines })}</div>}<div><DueText po={r} /></div></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty>{f === 'WAITING' ? t('orders.emptyWaiting') : t('orders.empty')}</Empty>}
        {d && (page > 1 || d.hasMore) && <div className="pager"><button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => set('page', String(page - 1))}>{backArrow()} {t('orders.previous')}</button><span className="small muted">{t('orders.page', { n: page })}</span><button className="btn btn-ghost btn-sm" disabled={!d.hasMore} onClick={() => set('page', String(page + 1))}>{t('orders.next')} {fwdArrow()}</button></div>}
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
  if (error && !d) return <div className="page"><Link to="/vendor/orders" className="back">{backArrow()} {t('order.back')}</Link><Alert kind="error">{error}</Alert></div>;
  if (!d) return <div className="page"><div className="spinner" /></div>;
  const { po } = d;
  const pending = d.lines.filter((l) => l.acceptance === 'PENDING' && l.status === 'OPEN');
  const canAccept = po.status === 'OPEN' && pending.length > 0;
  const all = sel.size === pending.length;

  return (
    <div className="page">
      <Link to="/vendor/orders" className="back">{backArrow()} {t('order.back')}</Link>
      <header className="page-head">
        <div><h1><span className="mono-num">{t('order.poNumber', { n: po.poNumber })}</span>{po.revision > 0 && <span className="muted small"> {t('orders.revision', { n: po.revision })}</span>} <AcceptanceBadge a={po.acceptance} status={po.status} /></h1>
          <p className="muted">{d.entity?.name ?? info?.buyer.name} · {money(po.total, po.currency)} · {t('order.orderedOn', { date: fmtDate(po.poDate) })}{po.status === 'OPEN' && (po.acceptance === 'PENDING' || po.acceptance === 'PARTIAL') && <> · <DueText po={po} /></>}</p></div>
      </header>
      {flash && <Alert kind="success">{flash}</Alert>}
      {error && <Alert kind="error">{error}</Alert>}
      {po.revision > 0 && canAccept && d.history.some((h) => h.action === 'PO_REVISED') && <Alert kind="info">{t('order.changedNotice')}</Alert>}

      {canAccept && (
        <div className="action-bar">
          <div><strong>{pending.length === d.lines.filter((l) => l.status === 'OPEN').length ? t('order.waitingWhole') : t('order.waitingLines', { count: pending.length })}</strong>
            <div className="muted small">{po.acceptDueAt ? t('order.autoOn', { date: fmtDate(po.acceptDueAt) }) : t('order.pleaseAccept')}</div></div>
          <button className="btn btn-primary" disabled={!sel.size} onClick={() => setConfirm(true)}>{all ? t('order.acceptOrder') : t('order.acceptSelected', { count: sel.size })}</button>
        </div>
      )}

      <section className="card section-card">
        <div className="toolbar"><h3>{t('order.lines')}</h3>{canAccept && pending.length > 1 && <span className="muted small">{t('order.untick')}</span>}</div>
        <LinesTable lines={d.lines} currency={po.currency} select={canAccept ? { selected: sel, toggle: (lid) => { const n = new Set(sel); if (n.has(lid)) n.delete(lid); else n.add(lid); setSel(n); }, toggleAll: (on) => setSel(on ? new Set(pending.map((l) => l.id)) : new Set()) } : undefined} />
      </section>
      <SupplierCollab key={`${po.id}:${po.acceptance}`} poId={po.id} currency={po.currency} open={po.status === 'OPEN'} onFlash={(m) => { setError(undefined); setFlash(m); load(); }} />
      <div className="detail-grid">
        <div>
          <section className="card pad">
            <h3 className="card-title">{t('order.order')}</h3>
            <Facts items={[
              [t('order.orderedBy'), d.entity?.name ?? info?.buyer.name ?? null], [t('order.buyer'), po.buyerName ? <>{po.buyerName}{po.buyerEmail && <div className="small"><a href={`mailto:${po.buyerEmail}?subject=${encodeURIComponent(`PO ${po.poNumber}`)}`}>{po.buyerEmail}</a></div>}</> : null],
              [t('order.poDate'), fmtDate(po.poDate)], [t('order.paymentTerms'), po.paymentTerms], [t('order.incoterms'), po.incoterms], [t('order.yourSite'), po.supplierSiteCode], [t('order.currency'), po.currency],
            ]} />
            {po.notes && <p className="small muted">“{po.notes}”</p>}
            {po.attachments.length > 0 && <ul className="plain-list small">{po.attachments.map((a) => <li key={a.url}><a href={a.url} target="_blank" rel="noreferrer">📎 {a.name}</a></li>)}</ul>}
          </section>
          {d.receipts.length > 0 && (
            <section className="card section-card">
              <div className="toolbar"><h3>{t('order.receivedSoFar')}</h3></div>
              <table className="table static compact"><thead><tr><th>{t('order.receipt')}</th><th>{t('common.date')}</th><th>{t('common.line')}</th><th className="num">{t('common.quantity')}</th></tr></thead>
                <tbody>{d.receipts.map((r) => <tr key={r.id}><td className="mono">{r.receiptNumber}</td><td>{fmtDate(r.receiptDate)}</td><td>{d.lines.find((l) => l.id === r.lineId)?.lineNo ?? '—'}</td><td className="num">{Number(r.quantity).toLocaleString(loc())}</td></tr>)}</tbody></table>
            </section>
          )}
        </div>
        <aside className="side-col">
          {d.history.length > 0 && (
            <section className="card pad">
              <h3 className="card-title">{t('order.history')}</h3>
              <ul className="plain-list small">{d.history.map((h) => <li key={h.id}><strong>{SUP_HIST.includes(h.action) ? t(`order.hist${h.action}` as Key) : h.action}</strong>{h.detail?.lines && <> · {t('order.linesN', { n: h.detail.lines })}</>}{h.detail?.note && <div className="muted">“{h.detail.note}”</div>}<div className="muted">{h.actor ? `${h.actor} · ` : ''}{fmtDateTime(h.createdAt)}</div></li>)}</ul>
            </section>
          )}
        </aside>
      </div>
      {confirm && <AcceptModal po={d.po} count={sel.size} all={all} onClose={() => setConfirm(false)} onAccept={async (note) => {
        try {
          await api(`/vendor/orders/${po.id}/accept`, { body: { lineIds: all ? undefined : [...sel], note: note || undefined } });
          setConfirm(false); setError(undefined); setFlash(all ? t('order.acceptedFlash', { po: po.poNumber, buyer: info?.buyer.name }) : t('order.linesAcceptedFlash', { count: sel.size })); load(); reload();
        } catch (e: any) { setConfirm(false); setError(e.message); }
      }} />}
    </div>
  );
}
const SUP_HIST = ['PO_RECEIVED', 'PO_REVISED', 'PO_ACCEPTED', 'PO_AUTO_ACCEPTED'];

function AcceptModal({ po, count, all, onClose, onAccept }: { po: OrderRow; count: number; all: boolean; onClose: () => void; onAccept: (note: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={all ? t('order.acceptTitle', { po: po.poNumber }) : t('order.acceptLinesTitle', { count })} onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-primary" disabled={busy} onClick={async () => { setBusy(true); await onAccept(note.trim()); setBusy(false); }}>{busy ? t('order.accepting') : t('order.accept')}</button></>}>
      <p>{all ? t('order.acceptExplainOrder') : t('order.acceptExplainLines')}</p>
      <div className="field"><label htmlFor="acc-note">{t('order.noteForBuyer')}</label><textarea id="acc-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('order.notePh')} /></div>
    </Modal>
  );
}
