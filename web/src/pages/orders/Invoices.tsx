import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Alert, Modal } from '../../components/ui';
import { useHelpContext } from '../../help/HelpPanel';
import { InvoiceView, InvoicesTable, PaymentsTable, type InvoiceDetailData, type InvoiceRow, type Payment } from '../../orders/collab';

interface ListData { rows: InvoiceRow[]; hasMore: boolean; page: number; counts: { review: number; exceptions: number; unpaid: number; paid: number; rejected: number; all: number }; canDecide?: boolean }
const TILES: [string, string, keyof ListData['counts'], string?][] = [['REVIEW', 'To review', 'review', 'stat-under_review'], ['EXCEPTION', 'Exceptions', 'exceptions', 'stat-sent_back'], ['UNPAID', 'Approved, unpaid', 'unpaid', 'stat-approved'], ['PAID', 'Paid', 'paid', 'stat-in_progress'], ['REJECTED', 'Rejected', 'rejected', 'stat-invited'], ['ALL', 'All', 'all']];

function InvoiceList({ base, prefix, staff }: { base: string; prefix: string; staff?: boolean }) {
  const [params, setParams] = useSearchParams();
  const filter = params.get('f') ?? (staff ? 'REVIEW' : 'ALL');
  const [q, setQ] = useState('');
  const [d, setD] = useState<ListData>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const t = setTimeout(() => {
      const p = new URLSearchParams();
      if (filter !== 'ALL') p.set('status', filter);
      if (q.trim()) p.set('q', q.trim());
      if (params.get('vendor')) p.set('vendorId', params.get('vendor')!);
      api<ListData>(`${prefix}/invoices?${p}`).then(setD).catch((e) => setError(e.message));
    }, 200);
    return () => clearTimeout(t);
  }, [filter, q, prefix, params]);
  return (
    <>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="stat-row stat-row-6">
        {TILES.map(([k, label, c, cls]) => <button key={k} className={`stat ${cls ?? ''} ${filter === k ? 'active' : ''}`} onClick={() => setParams({ f: k }, { replace: true })}><span className="stat-n">{d?.counts[c] ?? '…'}</span><span className="stat-l">{label}</span></button>)}
      </div>
      <div className="card">
        <div className="toolbar"><input className="search" placeholder={staff ? 'Search invoice, PO or supplier…' : 'Search invoice or PO number…'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search invoices" /></div>
        {!d ? <div className="pad"><div className="spinner" /></div> : <InvoicesTable rows={d.rows} base={base} showVendor={staff} />}
      </div>
    </>
  );
}

/* ---------- Staff ---------- */

export function StaffInvoices() {
  useHelpContext('invoices');
  return (
    <div className="page">
      <header className="page-head"><div><h1>Supplier invoices</h1><p className="muted">Invoices suppliers raised against your purchase orders, matched with the order and receipts.</p></div>
        <div className="head-actions"><Link className="btn btn-ghost" to="/staff/payments">Payments</Link></div></header>
      <InvoiceList base="/staff/invoices" prefix="" staff />
    </div>
  );
}

export function StaffInvoiceDetail() {
  const { id = '' } = useParams();
  useHelpContext('invoices');
  const [d, setD] = useState<InvoiceDetailData>();
  const [error, setError] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const [decide, setDecide] = useState<'APPROVE' | 'REJECT'>();
  const load = useCallback(() => api<InvoiceDetailData>(`/invoices/${id}`).then(setD).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  if (!d) return <div className="page">{error ? <Alert kind="error">{error}</Alert> : <div className="spinner" />}</div>;
  const open = d.invoice.status === 'SUBMITTED' || d.invoice.status === 'EXCEPTION';
  return (
    <div className="page">
      <Link to="/staff/invoices" className="back">← Supplier invoices</Link>
      <InvoiceView d={d} staff>
        {flash && <Alert kind="success">{flash}</Alert>}
        {error && <Alert kind="error">{error}</Alert>}
        {open && d.canDecide && (
          <div className="action-bar">
            <div><strong>{d.invoice.status === 'EXCEPTION' ? 'This invoice doesn’t match cleanly.' : 'This invoice matches the order.'}</strong><div className="muted small">{d.invoice.status === 'EXCEPTION' ? 'Check the points under Matching. You can still approve it with a note.' : 'Approving sends it to your ERP for payment.'}</div></div>
            <div className="btn-row"><button className="btn btn-secondary" onClick={() => setDecide('REJECT')}>Reject…</button><button className="btn btn-primary" onClick={() => setDecide('APPROVE')}>Approve{d.invoice.status === 'EXCEPTION' ? '…' : ''}</button></div>
          </div>
        )}
      </InvoiceView>
      {decide && <DecideModal decision={decide} exception={d.invoice.status === 'EXCEPTION'} onClose={() => setDecide(undefined)} onSubmit={async (note) => {
        try { await api(`/invoices/${id}/decide`, { body: { decision: decide, note: note || undefined } }); setDecide(undefined); setError(undefined); setFlash(decide === 'APPROVE' ? 'Approved. The supplier has been told and the invoice is on its way to the ERP.' : 'Rejected. The supplier has been told why.'); load(); }
        catch (e: any) { setDecide(undefined); setError(e.message); }
      }} />}
    </div>
  );
}

function DecideModal({ decision, exception, onClose, onSubmit }: { decision: 'APPROVE' | 'REJECT'; exception: boolean; onClose: () => void; onSubmit: (note: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const needs = decision === 'REJECT' || exception;
  return (
    <Modal title={decision === 'APPROVE' ? 'Approve invoice' : 'Reject invoice'} onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className={`btn ${decision === 'APPROVE' ? 'btn-primary' : 'btn-danger'}`} disabled={busy || (needs && note.trim().length < 3)} onClick={async () => { setBusy(true); await onSubmit(note.trim()); setBusy(false); }}>{decision === 'APPROVE' ? 'Approve' : 'Reject'}</button></>}>
      <div className="field"><label htmlFor="dec-note">{decision === 'REJECT' ? 'Reason (the supplier sees this)' : exception ? 'Why it can be approved despite the exceptions' : 'Note (optional)'}</label>
        <textarea id="dec-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} /></div>
    </Modal>
  );
}

export function StaffPayments() {
  const [d, setD] = useState<{ rows: Payment[] }>();
  const [error, setError] = useState<string>();
  useEffect(() => { api('/payments').then(setD).catch((e) => setError(e.message)); }, []);
  return (
    <div className="page">
      <Link to="/staff/invoices" className="back">← Supplier invoices</Link>
      <header className="page-head"><div><h1>Payments</h1><p className="muted">Payments your ERP reported to suppliers. Each one sends the supplier a payment advice.</p></div></header>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="card">{!d ? <div className="pad"><div className="spinner" /></div> : <PaymentsTable rows={d.rows} showVendor invoiceBase="/staff/invoices" />}</div>
    </div>
  );
}

/* ---------- Supplier ---------- */

export function SupplierInvoices() {
  return (
    <div className="page">
      <header className="page-head"><div><h1>Invoices</h1><p className="muted">Invoices you raised and where each one stands. Raise a new one from the purchase order.</p></div></header>
      <InvoiceList base="/vendor/invoices" prefix="/vendor/collab" />
    </div>
  );
}

export function SupplierInvoiceDetail() {
  const { id = '' } = useParams();
  const [d, setD] = useState<InvoiceDetailData>();
  const [error, setError] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const load = useCallback(() => api<InvoiceDetailData>(`/vendor/collab/invoices/${id}`).then(setD).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  if (!d) return <div className="page">{error ? <Alert kind="error">{error}</Alert> : <div className="spinner" />}</div>;
  const open = d.invoice.status === 'SUBMITTED' || d.invoice.status === 'EXCEPTION';
  return (
    <div className="page">
      <Link to="/vendor/invoices" className="back">← Invoices</Link>
      <InvoiceView d={d}>
        {flash && <Alert kind="success">{flash}</Alert>}
        {error && <Alert kind="error">{error}</Alert>}
        {open && <div className="action-bar"><div><strong>With the buyer for review.</strong><div className="muted small">{d.invoice.status === 'EXCEPTION' ? 'It doesn’t match the order exactly, so the buyer will look at it more closely.' : 'It matches the order.'} You can withdraw it while it is in review.</div></div>
          <button className="btn btn-secondary" onClick={async () => { try { await api(`/vendor/collab/invoices/${id}/cancel`, { method: 'POST' }); setFlash('Invoice withdrawn.'); load(); } catch (e: any) { setError(e.message); } }}>Withdraw</button></div>}
      </InvoiceView>
    </div>
  );
}

export function SupplierPayments() {
  const [d, setD] = useState<{ rows: Payment[] }>();
  const [error, setError] = useState<string>();
  useEffect(() => { api('/vendor/collab/payments').then(setD).catch((e) => setError(e.message)); }, []);
  return (
    <div className="page">
      <header className="page-head"><div><h1>Payments</h1><p className="muted">Payments the buyer has made to you, and the invoices they cover.</p></div></header>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="card">{!d ? <div className="pad"><div className="spinner" /></div> : <PaymentsTable rows={d.rows} invoiceBase="/vendor/invoices" />}</div>
    </div>
  );
}
