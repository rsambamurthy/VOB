import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { fmtDate, fmtDateTime, humanize } from '../../lib/format';
import { Alert, Modal } from '../../components/ui';
import { useHelpContext } from '../../help/HelpPanel';
import { AcceptanceBadge, DueText, Facts, LinesTable, money, qty, type OrderDetailData } from '../../orders/common';

interface Message { id: string; kind: string; connector: string; status: string; attempts: number; target: string | null; error: string | null; httpStatus: number | null; requestedBy: string | null; sentAt: string | null; createdAt: string; request: any }
const MSG_STATUS: Record<string, [string, string]> = { SENT: ['Sent', 'badge-approved'], TEST: ['Test mode — not sent', 'badge-in_progress'], PENDING: ['Sending…', 'badge-under_review'], FAILED: ['Failed', 'badge-rejected'], NO_CONNECTOR: ['No ERP connection', 'badge-invited'] };
const SOURCE: Record<string, string> = { oracle: 'Oracle EBS', api: 'API', csv: 'CSV import', demo: 'Sample (test mode)' };

export function OrderDetail() {
  const { id = '' } = useParams();
  const { can } = useSession();
  useHelpContext('order');
  const [d, setD] = useState<OrderDetailData & { messages: Message[] }>();
  const [error, setError] = useState<string>();
  const [accepting, setAccepting] = useState(false);
  const [payload, setPayload] = useState<Message>();
  const load = useCallback(() => api(`/orders/${id}`).then(setD).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  if (error && !d) return <div className="page"><Alert kind="error">{error}</Alert></div>;
  if (!d) return <div className="page"><div className="spinner" /></div>;
  const { po } = d;
  const waiting = po.status === 'OPEN' && (po.acceptance === 'PENDING' || po.acceptance === 'PARTIAL');

  return (
    <div className="page">
      <Link to="/staff/orders" className="back">← Purchase orders</Link>
      <header className="page-head">
        <div><h1><span className="mono-num">PO {po.poNumber}</span>{po.revision > 0 && <span className="muted small">revision {po.revision}</span>} <AcceptanceBadge a={po.acceptance} status={po.status} /></h1>
          <p className="muted">{d.vendor ? <Link to={`/staff/vendors/${d.vendor.id}`}>{d.vendor.name}</Link> : <>Supplier code <span className="mono">{po.supplierCode}</span> (not linked to a vendor)</>} · {money(po.total, po.currency)} · <DueText po={po} /></p></div>
        {can('orders.manage') && waiting && d.vendor && <div className="head-actions"><button className="btn btn-secondary" onClick={() => setAccepting(true)}>Record supplier acceptance…</button></div>}
      </header>
      {error && <Alert kind="error">{error}</Alert>}
      {!d.vendor && <Alert kind="warning">This order’s supplier code isn’t linked to a vendor yet, so no supplier can see it. Link it from <Link to="/staff/orders?f=UNMAPPED">Purchase orders</Link>.</Alert>}

      <section className="card section-card">
        <div className="toolbar"><h3>Lines</h3><span className="muted small">{d.lines.length} line{d.lines.length === 1 ? '' : 's'}</span></div>
        <LinesTable lines={d.lines} currency={po.currency} />
      </section>
      <div className="detail-grid">
        <div>
          {d.receipts.length > 0 && (
            <section className="card section-card">
              <div className="toolbar"><h3>Receipts</h3></div>
              <table className="table static compact"><thead><tr><th>Receipt</th><th>Date</th><th>Line</th><th className="num">Quantity</th></tr></thead>
                <tbody>{d.receipts.map((r) => <tr key={r.id}><td className="mono">{r.receiptNumber}</td><td>{fmtDate(r.receiptDate)}</td><td>{d.lines.find((l) => l.id === r.lineId)?.lineNo ?? '—'}</td><td className="num">{qty(r.quantity)}</td></tr>)}</tbody></table>
            </section>
          )}
          <section className="card section-card">
            <div className="toolbar"><h3>Messages to the ERP</h3></div>
            {d.messages.length ? (
              <table className="table static compact"><thead><tr><th>When</th><th>What</th><th>Status</th><th>Target</th><th /></tr></thead>
                <tbody>{d.messages.map((m) => (
                  <tr key={m.id}><td className="small nowrap">{fmtDateTime(m.createdAt)}</td><td className="small">{m.kind === 'ACCEPTANCE' ? 'Acceptance' : humanize(m.kind)}<div className="muted">{m.requestedBy}</div></td>
                    <td><span className={`badge ${MSG_STATUS[m.status]?.[1] ?? ''}`}>{MSG_STATUS[m.status]?.[0] ?? m.status}</span>{m.error && m.status === 'FAILED' && <div className="err-text small">{m.error}</div>}</td>
                    <td className="small muted break">{m.target ?? '—'}</td>
                    <td className="actions">{m.request && <button className="link-btn small" onClick={() => setPayload(m)}>Payload</button>}
                      {m.status === 'FAILED' && can('orders.manage') && <button className="link-btn small" onClick={async () => { try { await api(`/orders/messages/${m.id}/retry`, { method: 'POST' }); load(); } catch (e: any) { setError(e.message); } }}>Retry</button>}</td></tr>
                ))}</tbody></table>
            ) : <p className="pad muted small">Nothing sent yet. Each acceptance is sent back to the ERP through the connector under ERP integration.</p>}
          </section>
        </div>
        <aside className="side-col">
          <section className="card pad">
            <h3 className="card-title">Order</h3>
            <Facts items={[
              ['Company', d.entity ? `${d.entity.name} (${d.entity.code})` : null], ['Buying group', d.group ? `${d.group.name}${d.group.autoAcceptDays ? ` · auto-accepts after ${d.group.autoAcceptDays} days` : ' · manual acceptance'}` : null],
              ['Buyer', po.buyerName ? <>{po.buyerName}{po.buyerEmail && <div className="muted small">{po.buyerEmail}</div>}</> : null], ['PO date', fmtDate(po.poDate)], ['Type', po.poType],
              ['Payment terms', po.paymentTerms], ['Incoterms', po.incoterms], ['Supplier site', po.supplierSiteCode], ['ERP id', <span className="mono small">{po.erpId}</span>],
              ['Source', `${SOURCE[po.source ?? ''] ?? po.source} · synced ${fmtDateTime(po.syncedAt)}`],
            ]} />
            {po.notes && <p className="small muted">“{po.notes}”</p>}
            {po.attachments.length > 0 && <ul className="plain-list small">{po.attachments.map((a) => <li key={a.url}><a href={a.url} target="_blank" rel="noreferrer">📎 {a.name}</a></li>)}</ul>}
          </section>
          <section className="card pad">
            <h3 className="card-title">History</h3>
            <ul className="plain-list small">{d.history.map((h) => <li key={h.id}><strong>{HIST[h.action] ?? humanize(h.action)}</strong>{h.detail?.lines && <> · lines {h.detail.lines}</>}{h.detail?.note && <div className="muted">“{h.detail.note}”</div>}<div className="muted">{h.actor} · {fmtDateTime(h.createdAt)}</div></li>)}</ul>
          </section>
        </aside>
      </div>
      {accepting && <BuyerAcceptModal d={d} onClose={() => setAccepting(false)} onDone={() => { setAccepting(false); load(); }} />}
      {payload && <Modal title="What was sent to the ERP" wide onClose={() => setPayload(undefined)}><pre className="code">{payload.request.csv ?? JSON.stringify(payload.request.body ?? payload.request, null, 2)}</pre></Modal>}
    </div>
  );
}
const HIST: Record<string, string> = { PO_RECEIVED: 'Received from the ERP', PO_UPDATED: 'Updated from the ERP', PO_REVISED: 'Revised — changed lines need acceptance again', PO_ACCEPTED: 'Accepted', PO_AUTO_ACCEPTED: 'Auto-accepted', PO_ACK_FAILED: 'Sending the acceptance to the ERP failed' };

function BuyerAcceptModal({ d, onClose, onDone }: { d: OrderDetailData; onClose: () => void; onDone: () => void }) {
  const pending = d.lines.filter((l) => l.acceptance === 'PENDING' && l.status === 'OPEN');
  const [sel, setSel] = useState(new Set(pending.map((l) => l.id)));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  async function go() {
    try { await api(`/orders/${d.po.id}/accept`, { body: { lineIds: [...sel], note } }); onDone(); } catch (e: any) { setError(e.message); }
  }
  return (
    <Modal title="Record the supplier’s acceptance" wide onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!sel.size || note.trim().length < 3} onClick={go}>Record acceptance of {sel.size} line{sel.size === 1 ? '' : 's'}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <p className="small muted">Use this when the supplier confirmed outside the portal. It’s recorded under your name, marked “on behalf of the supplier”, and sent to the ERP like any other acceptance.</p>
      <LinesTable lines={pending} currency={d.po.currency} select={{ selected: sel, toggle: (id) => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setSel(n); }, toggleAll: (on) => setSel(on ? new Set(pending.map((l) => l.id)) : new Set()) }} />
      <div className="field" style={{ marginTop: 12 }}><label htmlFor="ba-note">How did the supplier confirm?</label><input id="ba-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Confirmed by email from Ravi Kumar on 12 Oct" /></div>
    </Modal>
  );
}
