/** Shipment notices, supplier invoices and payments — building blocks for the supplier and staff screens. */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, docUrl } from '../lib/api';
import { fmtDate, fmtDateTime } from '../lib/format';
import { Alert, Empty, Modal } from '../components/ui';
import { Facts, money, qty } from './common';

export interface ShipLine { lineId: string; lineNo: number; itemCode: string | null; description: string; uom: string | null; needByDate: string | null; ordered: number; tolerancePct: number; shipped: number; received: number; available: number }
export interface InvLine { lineId: string; lineNo: number; lineType: string; itemCode: string | null; description: string; uom: string | null; hsn: string | null; ordered: number; tolerancePct: number; received: number; billed: number; unitPrice: number; taxRate: number | null; available: number; availableReceived: number }
export interface Shipment {
  id: string; number: string; supplierRef: string | null; status: 'SHIPPED' | 'PARTLY_RECEIVED' | 'RECEIVED' | 'CANCELLED'; shipDate: string; expectedDate: string | null; carrier: string | null; trackingNo: string | null;
  vehicleNo: string | null; ewayBill: string | null; packages: number | null; notes: string | null; cancelReason: string | null; createdAt: string; createdBy?: string;
  lines: { id: string; lineId: string; lineNo: number; itemCode: string | null; description: string; uom: string | null; quantity: number; receivedQty: number; batchNo: string | null }[];
}
export type InvoiceStatus = 'SUBMITTED' | 'EXCEPTION' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'PARTLY_PAID' | 'PAID';
export interface InvoiceRow {
  id: string; invoiceNumber: string; invoiceDate: string; currency: string; subtotal: number; taxAmount: number; total: number; paidAmount: number; status: InvoiceStatus; dueDate: string | null;
  poId: string; shipmentId: string | null; createdAt: string; decidedAt: string | null; warnings: number; poNumber: string; vendorName: string; vendorCode: string;
}
export type Check = { code: string; level: 'error' | 'warning' | 'ok'; message: string };
export interface InvoiceDetailData {
  invoice: InvoiceRow & { checks: Check[]; einvoice: { irn?: string; ackNo?: string; ackDate?: string; qr: boolean } | null; notes: string | null; submittedBy: string; decidedBy: string | null; decisionNote: string | null; erpInvoiceId: string | null; documentId: string | null };
  po: { id: string; poNumber: string; currency: string; paymentTerms: string | null; buyerName: string | null };
  vendor: { id: string; name: string; code: string };
  shipment: { id: string; number: string } | null;
  lines: { id: string; lineNo: number; itemCode: string | null; description: string; uom: string | null; quantity: number; unitPrice: number; amount: number; taxRate: number | null; taxAmount: number; poPrice: number; ordered: number; received: number }[];
  payments: { id: string; reference: string; paymentDate: string; method: string | null; currency: string; amount: number; withheld: number }[];
  canDecide?: boolean;
}
export interface Payment { id: string; reference: string; paymentDate: string; method: string | null; currency: string; amount: number; withheld: number; notes: string | null; allocations: { invoiceId: string | null; invoiceNumber: string; amount: number; withheld?: number }[]; vendorName: string; vendorCode: string }

const SHIP: Record<Shipment['status'], [string, string]> = { SHIPPED: ['In transit', 'badge-under_review'], PARTLY_RECEIVED: ['Partly received', 'badge-in_progress'], RECEIVED: ['Received', 'badge-approved'], CANCELLED: ['Cancelled', 'badge-invited'] };
export const ShipmentBadge = ({ s }: { s: Shipment['status'] }) => <span className={`badge sm ${SHIP[s][1]}`}>{SHIP[s][0]}</span>;
const INV: Record<InvoiceStatus, [string, string]> = { SUBMITTED: ['In review', 'badge-under_review'], EXCEPTION: ['Exception', 'badge-sent_back'], APPROVED: ['Approved', 'badge-approved'], REJECTED: ['Rejected', 'badge-rejected'], CANCELLED: ['Withdrawn', 'badge-invited'], PARTLY_PAID: ['Partly paid', 'badge-in_progress'], PAID: ['Paid', 'badge-auto'] };
export const InvoiceBadge = ({ s }: { s: InvoiceStatus }) => <span className={`badge sm ${INV[s][1]}`}>{INV[s][0]}</span>;
export const MESSAGE_KIND: Record<string, string> = { ACCEPTANCE: 'Acceptance', ASN: 'Shipment notice', ASN_CANCEL: 'Shipment notice cancelled', INVOICE: 'Approved invoice' };
const today = () => new Date().toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;

export function ChecksList({ checks }: { checks: Check[] }) {
  if (!checks.length) return null;
  const icon = { error: '✕', warning: '!', ok: '✓' };
  return <ul className="checks-list">{checks.map((c, i) => <li key={i} className={`check-${c.level}`}><span className="check-icon" aria-hidden>{icon[c.level]}</span>{c.message}</li>)}</ul>;
}

export function ShipmentsCard({ shipments, onCancel, title = 'Shipment notices', action }: { shipments: Shipment[]; onCancel?: (s: Shipment) => void; title?: string; action?: ReactNode }) {
  if (!shipments.length && !action) return null;
  return (
    <section className="card section-card">
      <div className="toolbar"><h3>{title}</h3>{action}</div>
      {!shipments.length ? <p className="muted small pad">None yet.</p> : (
        <div className="table-wrap"><table className="table static compact">
          <thead><tr><th>Notice</th><th>Shipped</th><th>Lines</th><th>Transport</th><th>Status</th><th /></tr></thead>
          <tbody>{shipments.map((s) => (
            <tr key={s.id}>
              <td><span className="mono nowrap">{s.number}</span>{s.supplierRef && <div className="muted small">Ref {s.supplierRef}</div>}</td>
              <td className="small nowrap">{fmtDate(s.shipDate)}{s.expectedDate && <div className="muted">due {fmtDate(s.expectedDate)}</div>}</td>
              <td className="small">{s.lines.map((l) => <div key={l.id}>Line {l.lineNo}: {qty(l.quantity)} {l.uom}{l.receivedQty > 0 && <span className="muted"> · {qty(l.receivedQty)} received</span>}{l.batchNo && <span className="muted"> · batch {l.batchNo}</span>}</div>)}</td>
              <td className="small">{[s.carrier, s.trackingNo, s.vehicleNo].filter(Boolean).join(' · ') || '—'}{s.ewayBill && <div className="muted">E-way bill {s.ewayBill}</div>}{s.packages && <div className="muted">{s.packages} package{s.packages === 1 ? '' : 's'}</div>}</td>
              <td><ShipmentBadge s={s.status} />{s.cancelReason && <div className="muted small">{s.cancelReason}</div>}
                {s.expectedDate && s.expectedDate < today() && (s.status === 'SHIPPED' || s.status === 'PARTLY_RECEIVED') && <div className="warn-text small">Overdue since {fmtDate(s.expectedDate)}</div>}</td>
              <td className="actions">{onCancel && s.status === 'SHIPPED' && <button className="link-btn small danger" onClick={() => onCancel(s)}>Cancel</button>}</td>
            </tr>))}</tbody>
        </table></div>
      )}
    </section>
  );
}

export function InvoicesTable({ rows, base, showVendor, showPo = true }: { rows: InvoiceRow[]; base: string; showVendor?: boolean; showPo?: boolean }) {
  const nav = useNavigate();
  if (!rows.length) return <Empty>No invoices.</Empty>;
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr><th>Invoice</th>{showVendor && <th>Supplier</th>}{showPo && <th>Order</th>}<th>Date</th><th className="num">Total</th><th>Status</th><th>Due</th></tr></thead>
      <tbody>{rows.map((i) => (
        <tr key={i.id} className="clickable" onClick={() => nav(`${base}/${i.id}`)}>
          <td><Link to={`${base}/${i.id}`} className="mono strong" onClick={(e) => e.stopPropagation()}>{i.invoiceNumber}</Link>{i.warnings > 0 && i.status === 'EXCEPTION' && <div className="warn-text small">{i.warnings} to check</div>}</td>
          {showVendor && <td>{i.vendorName}<div className="muted small">{i.vendorCode}</div></td>}
          {showPo && <td className="mono small">{i.poNumber}</td>}
          <td className="small nowrap">{fmtDate(i.invoiceDate)}</td>
          <td className="num nowrap">{money(i.total, i.currency)}{i.paidAmount > 0 && i.status !== 'PAID' && <div className="muted small">paid {money(i.paidAmount, i.currency)}</div>}</td>
          <td><InvoiceBadge s={i.status} /></td>
          <td className="small nowrap">{i.dueDate && ['APPROVED', 'PARTLY_PAID'].includes(i.status) ? <span className={i.dueDate < today() ? 'err-text' : ''}>{fmtDate(i.dueDate)}</span> : '—'}</td>
        </tr>))}</tbody>
    </table></div>
  );
}

/* ---------- Supplier: create a shipment notice ---------- */

export function ShipModal({ poId, lines, onClose, onDone }: { poId: string; lines: ShipLine[]; onClose: () => void; onDone: (number: string) => void }) {
  const open = lines.filter((l) => l.available > 0);
  const [q, setQ] = useState<Record<string, string>>(() => Object.fromEntries(open.map((l) => [l.lineId, String(Math.min(l.available, Math.max(0, l.ordered - Math.max(l.shipped, l.received))))])));
  const [batch, setBatch] = useState<Record<string, string>>({});
  const [f, setF] = useState({ shipDate: today(), expectedDate: '', supplierRef: '', carrier: '', trackingNo: '', vehicleNo: '', ewayBill: '', packages: '', notes: '' });
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const chosen = open.filter((l) => Number(q[l.lineId]) > 0);
  async function save() {
    setBusy(true); setErr(undefined);
    try {
      const r = await api<{ number: string }>(`/vendor/collab/orders/${poId}/shipments`, { body: {
        shipDate: f.shipDate, expectedDate: f.expectedDate || null, supplierRef: f.supplierRef || null, carrier: f.carrier || null, trackingNo: f.trackingNo || null, vehicleNo: f.vehicleNo || null,
        ewayBill: f.ewayBill || null, packages: f.packages ? Number(f.packages) : null, notes: f.notes || null,
        lines: chosen.map((l) => ({ lineId: l.lineId, quantity: Number(q[l.lineId]), batchNo: batch[l.lineId] || null })) } });
      onDone(r.number);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal title="Shipment notice" wide onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !chosen.length || !f.shipDate} onClick={save}>{busy ? 'Sending…' : 'Send shipment notice'}</button></>}>
      <p className="muted small">Tell the buyer what is on the way. You can ship part of a line now and the rest later.</p>
      {err && <Alert kind="error">{err}</Alert>}
      <div className="table-wrap"><table className="table static compact">
        <thead><tr><th>Line</th><th>Item</th><th className="num">Ordered</th><th className="num">Shipped so far</th><th className="num">Ship now</th><th>Batch / lot</th></tr></thead>
        <tbody>{open.map((l) => (
          <tr key={l.lineId}><td className="mono-num">{l.lineNo}</td><td><div className="strong">{l.description}</div><div className="muted small">{l.itemCode}{l.needByDate && ` · need by ${fmtDate(l.needByDate)}`}</div></td>
            <td className="num nowrap">{qty(l.ordered)} {l.uom}</td><td className="num">{qty(Math.max(l.shipped, l.received))}</td>
            <td className="num"><input className="qty-input" type="number" min={0} max={l.available} step="any" aria-label={`Quantity for line ${l.lineNo}`} value={q[l.lineId] ?? ''} onChange={(e) => setQ({ ...q, [l.lineId]: e.target.value })} />
              <div className="muted small">up to {qty(l.available)}{l.tolerancePct ? ` (incl. ${l.tolerancePct}% over)` : ''}</div></td>
            <td><input aria-label={`Batch for line ${l.lineNo}`} value={batch[l.lineId] ?? ''} maxLength={60} onChange={(e) => setBatch({ ...batch, [l.lineId]: e.target.value })} /></td></tr>))}</tbody>
      </table></div>
      <div className="field-grid">
        <div className="field"><label htmlFor="sh-date">Ship date</label><input id="sh-date" type="date" max={today()} value={f.shipDate} onChange={set('shipDate')} /></div>
        <div className="field"><label htmlFor="sh-exp">Expected delivery</label><input id="sh-exp" type="date" min={f.shipDate} value={f.expectedDate} onChange={set('expectedDate')} /></div>
        <div className="field"><label htmlFor="sh-ref">Your delivery note / dispatch no.</label><input id="sh-ref" maxLength={60} value={f.supplierRef} onChange={set('supplierRef')} /></div>
        <div className="field"><label htmlFor="sh-car">Carrier</label><input id="sh-car" maxLength={100} value={f.carrier} onChange={set('carrier')} /></div>
        <div className="field"><label htmlFor="sh-trk">Tracking / LR / AWB no.</label><input id="sh-trk" maxLength={100} value={f.trackingNo} onChange={set('trackingNo')} /></div>
        <div className="field"><label htmlFor="sh-veh">Vehicle no.</label><input id="sh-veh" maxLength={20} value={f.vehicleNo} onChange={set('vehicleNo')} /></div>
        <div className="field"><label htmlFor="sh-ewb">E-way bill no. (India)</label><input id="sh-ewb" inputMode="numeric" maxLength={14} value={f.ewayBill} onChange={set('ewayBill')} placeholder="12 digits" /></div>
        <div className="field"><label htmlFor="sh-pkg">Packages</label><input id="sh-pkg" type="number" min={1} value={f.packages} onChange={set('packages')} /></div>
      </div>
      <div className="field"><label htmlFor="sh-notes">Notes for the buyer</label><textarea id="sh-notes" rows={2} maxLength={1000} value={f.notes} onChange={set('notes')} /></div>
    </Modal>
  );
}

/* ---------- Supplier: raise an invoice ---------- */

export function InvoiceModal({ poId, currency, lines, shipments, einvoice, tolerance, onClose, onDone }: { poId: string; currency: string; lines: InvLine[]; shipments: Shipment[]; einvoice: boolean; tolerance: number; onClose: () => void; onDone: (status: string) => void }) {
  const open = lines.filter((l) => l.available > 0);
  const usable = shipments.filter((s) => s.status !== 'CANCELLED');
  const defaults = (shipmentId: string) => {
    const s = usable.find((x) => x.id === shipmentId);
    return Object.fromEntries(open.map((l) => {
      const fromShip = s?.lines.find((x) => x.lineId === l.lineId)?.quantity;
      const v = s ? Math.min(fromShip ?? 0, l.available) : l.lineType === 'GOODS' ? l.availableReceived : l.available;
      return [l.lineId, { q: v ? String(v) : '', p: String(l.unitPrice), t: l.taxRate === null ? '' : String(l.taxRate) }];
    }));
  };
  const [shipmentId, setShipmentId] = useState('');
  const [rows, setRows] = useState<Record<string, { q: string; p: string; t: string }>>(() => defaults(''));
  const [f, setF] = useState({ invoiceNumber: '', invoiceDate: today(), total: '', notes: '', irn: '', ackNo: '', ackDate: '', signedQr: '' });
  const [file, setFile] = useState<{ id: string; fileName: string }>();
  const [checks, setChecks] = useState<Check[]>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setF({ ...f, [k]: e.target.value }); setChecks(undefined); };
  const calc = useMemo(() => {
    let sub = 0, tax = 0;
    for (const l of open) { const r = rows[l.lineId]; const amt = r2(Number(r?.q || 0) * Number(r?.p || 0)); sub += amt; tax += r2(amt * Number(r?.t || 0) / 100); }
    return { sub: r2(sub), tax: r2(tax), total: r2(sub + tax) };
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setRows(defaults(shipmentId)); setChecks(undefined); }, [shipmentId]); // eslint-disable-line react-hooks/exhaustive-deps
  const body = () => ({
    invoiceNumber: f.invoiceNumber.trim(), invoiceDate: f.invoiceDate, shipmentId: shipmentId || null, currency, total: f.total ? Number(f.total) : calc.total, notes: f.notes || null, documentId: file?.id ?? null,
    lines: open.filter((l) => Number(rows[l.lineId]?.q) > 0).map((l) => ({ lineId: l.lineId, quantity: Number(rows[l.lineId].q), unitPrice: Number(rows[l.lineId].p), taxRate: rows[l.lineId].t === '' ? null : Number(rows[l.lineId].t) })),
    einvoice: einvoice && (f.irn || f.signedQr) ? { irn: f.irn || null, ackNo: f.ackNo || null, ackDate: f.ackDate || null, signedQr: f.signedQr || null } : null,
  });
  async function upload(fl: File) {
    const fd = new FormData(); fd.append('file', fl);
    try { setFile(await api<{ id: string; fileName: string }>('/vendor/collab/invoice-files', { body: fd })); } catch (e: any) { setErr(e.message); }
  }
  async function check() {
    setBusy(true); setErr(undefined);
    try { setChecks((await api<{ checks: Check[] }>(`/vendor/collab/orders/${poId}/invoices/check`, { body: body() })).checks); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function submit() {
    setBusy(true); setErr(undefined);
    try { const r = await api<{ status: string }>(`/vendor/collab/orders/${poId}/invoices`, { body: body() }); onDone(r.status); }
    catch (e: any) { setErr(e.message); if (e.details?.checks) setChecks(e.details.checks); } finally { setBusy(false); }
  }
  const ready = f.invoiceNumber.trim() && f.invoiceDate && body().lines.length;
  return (
    <Modal title="Raise an invoice" wide onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-secondary" disabled={busy || !ready} onClick={check}>Check</button><button className="btn btn-primary" disabled={busy || !ready} onClick={submit}>{busy ? 'Working…' : 'Submit invoice'}</button></>}>
      <p className="muted small">Enter the invoice as it appears on your document. It is matched with the order and what has been received; prices more than {tolerance}% above the order price are flagged.</p>
      {err && <Alert kind="error">{err}</Alert>}
      <div className="field-grid">
        <div className="field"><label htmlFor="iv-no">Invoice number</label><input id="iv-no" maxLength={40} value={f.invoiceNumber} onChange={set('invoiceNumber')} /></div>
        <div className="field"><label htmlFor="iv-date">Invoice date</label><input id="iv-date" type="date" max={today()} value={f.invoiceDate} onChange={set('invoiceDate')} /></div>
        {usable.length > 0 && <div className="field"><label htmlFor="iv-ship">For shipment</label><select id="iv-ship" value={shipmentId} onChange={(e) => setShipmentId(e.target.value)}><option value="">Not linked to a shipment</option>{usable.map((s) => <option key={s.id} value={s.id}>{s.number} · {fmtDate(s.shipDate)}</option>)}</select></div>}
        <div className="field"><label htmlFor="iv-file">Invoice file (PDF or image)</label>{file ? <div className="small">📎 {file.fileName} <button type="button" className="link-btn small" onClick={() => setFile(undefined)}>Remove</button></div> : <input id="iv-file" type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />}</div>
      </div>
      <div className="table-wrap"><table className="table static compact">
        <thead><tr><th>Line</th><th>Item</th><th className="num">Can invoice</th><th className="num">Quantity</th><th className="num">Unit price</th><th className="num">Tax %</th><th className="num">Amount</th></tr></thead>
        <tbody>{open.map((l) => { const r = rows[l.lineId] ?? { q: '', p: '', t: '' }; const up = (k: 'q' | 'p' | 't') => (e: React.ChangeEvent<HTMLInputElement>) => { setRows({ ...rows, [l.lineId]: { ...r, [k]: e.target.value } }); setChecks(undefined); };
          return (
            <tr key={l.lineId}><td className="mono-num">{l.lineNo}</td><td><div className="strong">{l.description}</div><div className="muted small">{[l.itemCode, l.hsn && `HSN ${l.hsn}`, l.lineType === 'SERVICE' && 'Service'].filter(Boolean).join(' · ')}</div></td>
              <td className="num small nowrap">{qty(l.available)} {l.uom}{l.lineType === 'GOODS' && <div className="muted">{qty(l.availableReceived)} received</div>}</td>
              <td className="num"><input className="qty-input" type="number" min={0} step="any" aria-label={`Quantity for line ${l.lineNo}`} value={r.q} onChange={up('q')} /></td>
              <td className="num"><input className="qty-input" type="number" min={0} step="any" aria-label={`Unit price for line ${l.lineNo}`} value={r.p} onChange={up('p')} /><div className="muted small">PO {money(l.unitPrice, currency)}</div></td>
              <td className="num"><input className="qty-input sm" type="number" min={0} max={100} step="any" aria-label={`Tax rate for line ${l.lineNo}`} value={r.t} onChange={up('t')} /></td>
              <td className="num nowrap">{money(r2(Number(r.q || 0) * Number(r.p || 0)), currency)}</td></tr>);
        })}</tbody>
        <tfoot><tr><td colSpan={6} className="num">Subtotal {money(calc.sub, currency)} · tax {money(calc.tax, currency)}</td><td className="num strong">{money(calc.total, currency)}</td></tr></tfoot>
      </table></div>
      <div className="field-grid">
        <div className="field"><label htmlFor="iv-total">Invoice total as printed</label><input id="iv-total" type="number" step="any" min={0} value={f.total} placeholder={String(calc.total)} onChange={set('total')} /><div className="field-help">Leave blank to use the calculated total.</div></div>
        {einvoice && <div className="field"><label htmlFor="iv-irn">E-invoice IRN</label><input id="iv-irn" maxLength={64} className="mono" value={f.irn} onChange={set('irn')} placeholder="64 characters, if you e-invoice" /></div>}
        {einvoice && <div className="field"><label htmlFor="iv-ack">Ack no. / date</label><div className="inline-fields"><input id="iv-ack" maxLength={30} value={f.ackNo} onChange={set('ackNo')} /><input aria-label="Ack date" maxLength={30} value={f.ackDate} onChange={set('ackDate')} placeholder="date" /></div></div>}
      </div>
      {einvoice && <div className="field"><label htmlFor="iv-qr">Signed QR code text (optional)</label><textarea id="iv-qr" rows={2} className="mono small" value={f.signedQr} onChange={set('signedQr')} placeholder="Paste the text read from the e-invoice QR code" /><div className="field-help">We check its GSTIN, invoice number, IRN and value against what you entered.</div></div>}
      <div className="field"><label htmlFor="iv-notes">Notes for the buyer</label><textarea id="iv-notes" rows={2} maxLength={1000} value={f.notes} onChange={set('notes')} /></div>
      {checks && <><h4>Match result</h4><ChecksList checks={checks} />{!checks.some((c) => c.level !== 'ok') && <p className="small muted">Everything matches.</p>}</>}
    </Modal>
  );
}

/* ---------- Invoice detail (both sides) ---------- */

export function InvoiceView({ d, staff, children }: { d: InvoiceDetailData; staff?: boolean; children?: ReactNode }) {
  const i = d.invoice;
  return (
    <>
      <header className="page-head">
        <div><h1><span className="mono-num">Invoice {i.invoiceNumber}</span> <InvoiceBadge s={i.status} /></h1>
          <p className="muted">{staff ? <><Link to={`/staff/vendors/${d.vendor.id}`}>{d.vendor.name}</Link> · </> : null}Order <Link to={`${staff ? '/staff' : '/vendor'}/orders/${d.po.id}`} className="mono">{d.po.poNumber}</Link> · {money(i.total, i.currency)} · dated {fmtDate(i.invoiceDate)}</p></div>
      </header>
      {children}
      {i.decisionNote && <Alert kind={i.status === 'REJECTED' ? 'error' : 'info'}>{i.status === 'REJECTED' ? 'Rejected' : i.status === 'CANCELLED' ? 'Withdrawn' : 'Approved'}{i.decidedBy ? ` by ${i.decidedBy}` : ''}{i.decidedAt ? ` on ${fmtDate(i.decidedAt)}` : ''}: “{i.decisionNote}”</Alert>}
      <section className="card section-card">
        <div className="toolbar"><h3>Lines</h3></div>
        <div className="table-wrap"><table className="table static compact">
          <thead><tr><th>Line</th><th>Item</th><th className="num">Quantity</th><th className="num">Unit price</th><th className="num">Tax</th><th className="num">Amount</th>{staff && <th className="num">Ordered / received</th>}</tr></thead>
          <tbody>{d.lines.map((l) => (
            <tr key={l.id}><td className="mono-num">{l.lineNo}</td><td><div className="strong">{l.description}</div><div className="muted small">{l.itemCode}</div></td>
              <td className="num nowrap">{qty(l.quantity)} {l.uom}</td>
              <td className="num">{money(l.unitPrice, i.currency)}{l.unitPrice !== l.poPrice && <div className={`small ${l.unitPrice > l.poPrice ? 'warn-text' : 'muted'}`}>PO {money(l.poPrice, i.currency)}</div>}</td>
              <td className="num small">{l.taxRate !== null ? `${l.taxRate}%` : ''}<div>{money(l.taxAmount, i.currency)}</div></td>
              <td className="num strong">{money(l.amount, i.currency)}</td>
              {staff && <td className="num small">{qty(l.ordered)} / {qty(l.received)}</td>}</tr>))}</tbody>
          <tfoot><tr><td colSpan={5} className="num">Subtotal {money(i.subtotal, i.currency)} · tax {money(i.taxAmount, i.currency)}</td><td className="num strong">{money(i.total, i.currency)}</td>{staff && <td />}</tr></tfoot>
        </table></div>
      </section>
      <div className="detail-grid">
        <div>
          <section className="card pad">
            <h3 className="card-title">Matching</h3>
            <ChecksList checks={i.checks} />
          </section>
          {d.payments.length > 0 && (
            <section className="card section-card">
              <div className="toolbar"><h3>Payments</h3></div>
              <table className="table static compact"><thead><tr><th>Date</th><th>Reference</th><th className="num">Paid</th><th className="num">Tax withheld</th></tr></thead>
                <tbody>{d.payments.map((p) => <tr key={p.id}><td className="small">{fmtDate(p.paymentDate)}</td><td className="mono small">{p.reference}{p.method && <span className="muted"> · {p.method}</span>}</td><td className="num">{money(p.amount, p.currency)}</td><td className="num small">{p.withheld ? money(p.withheld, p.currency) : '—'}</td></tr>)}</tbody></table>
            </section>
          )}
        </div>
        <aside className="side-col">
          <section className="card pad">
            <h3 className="card-title">Details</h3>
            <Facts items={[
              ['Submitted', <>{fmtDateTime(i.createdAt)}{staff && <div className="muted small">{i.submittedBy}</div>}</>], ['Shipment', d.shipment?.number ?? null], ['Payment terms', d.po.paymentTerms], ['Due', i.dueDate ? fmtDate(i.dueDate) : null],
              ['Paid so far', i.paidAmount ? money(i.paidAmount, i.currency) : null], ['IRN', i.einvoice?.irn ? <span className="mono small break">{i.einvoice.irn}</span> : null], ['E-invoice ack', i.einvoice?.ackNo ? `${i.einvoice.ackNo}${i.einvoice.ackDate ? ` · ${i.einvoice.ackDate}` : ''}` : null],
              ['ERP invoice id', i.erpInvoiceId], ['File', i.documentId ? <a href={docUrl(i.documentId)} target="_blank" rel="noreferrer">📎 Open invoice</a> : null],
            ]} />
            {i.notes && <p className="small muted">“{i.notes}”</p>}
          </section>
        </aside>
      </div>
    </>
  );
}

export function PaymentsTable({ rows, showVendor, invoiceBase }: { rows: Payment[]; showVendor?: boolean; invoiceBase: string }) {
  if (!rows.length) return <Empty>No payments recorded yet. They appear here when the ERP reports them.</Empty>;
  return (
    <div className="table-wrap"><table className="table static">
      <thead><tr><th>Date</th>{showVendor && <th>Supplier</th>}<th>Reference</th><th>Invoices</th><th className="num">Amount</th><th className="num">Tax withheld</th></tr></thead>
      <tbody>{rows.map((p) => (
        <tr key={p.id}><td className="small nowrap">{fmtDate(p.paymentDate)}</td>{showVendor && <td>{p.vendorName}<div className="muted small">{p.vendorCode}</div></td>}
          <td className="mono small">{p.reference}{p.method && <div className="muted">{p.method}</div>}</td>
          <td className="small">{p.allocations.map((a, k) => <div key={k}>{a.invoiceId ? <Link to={`${invoiceBase}/${a.invoiceId}`} className="mono">{a.invoiceNumber}</Link> : <span className="mono">{a.invoiceNumber}</span>} · {money(a.amount, p.currency)}</div>)}</td>
          <td className="num strong nowrap">{money(p.amount, p.currency)}</td><td className="num small">{p.withheld ? money(p.withheld, p.currency) : '—'}</td></tr>))}</tbody>
    </table></div>
  );
}

export function CancelShipmentModal({ s, onClose, onConfirm }: { s: Shipment; onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Cancel ${s.number}?`} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Keep it</button><button className="btn btn-danger" disabled={busy || reason.trim().length < 3} onClick={async () => { setBusy(true); await onConfirm(reason.trim()); setBusy(false); }}>Cancel notice</button></>}>
      <p>The buyer’s system is told the shipment notice is cancelled, and the quantities can be shipped again.</p>
      <div className="field"><label htmlFor="cs-reason">Reason</label><input id="cs-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
    </Modal>
  );
}

/* ---------- Supplier: shipments and invoices on an order ---------- */

interface SupplierCollabData { shippable: ShipLine[]; invoiceable: InvLine[]; shipments: Shipment[]; invoices: InvoiceRow[]; asnRequired: boolean; priceTolerancePct: number; einvoice: boolean }

export function SupplierCollab({ poId, currency, open, onFlash }: { poId: string; currency: string; open: boolean; onFlash: (m: string) => void }) {
  const [c, setC] = useState<SupplierCollabData>();
  const [modal, setModal] = useState<'ship' | 'invoice'>();
  const [cancel, setCancel] = useState<Shipment>();
  const [err, setErr] = useState<string>();
  const load = () => api<SupplierCollabData>(`/vendor/collab/orders/${poId}`).then(setC).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [poId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!c) return err ? <Alert kind="error">{err}</Alert> : null;
  const canShip = open && c.shippable.some((l) => l.available > 0);
  const canInvoice = c.invoiceable.some((l) => l.available > 0);
  if (!c.shippable.length && !c.invoiceable.length && !c.shipments.length && !c.invoices.length) return null;
  return (
    <>
      {err && <Alert kind="error">{err}</Alert>}
      {c.asnRequired && canShip && <Alert kind="info">The buyer needs a shipment notice for every delivery on this order. Send one when the goods leave.</Alert>}
      <ShipmentsCard shipments={c.shipments} onCancel={setCancel} action={canShip ? <button className="btn btn-secondary btn-sm" onClick={() => setModal('ship')}>Create shipment notice</button> : undefined} />
      {(canInvoice || c.invoices.length > 0) && (
        <section className="card section-card">
          <div className="toolbar"><h3>Invoices</h3>{canInvoice && <button className="btn btn-secondary btn-sm" onClick={() => setModal('invoice')}>Raise invoice</button>}</div>
          {c.invoices.length ? <InvoicesTable rows={c.invoices} base="/vendor/invoices" showPo={false} /> : <p className="muted small pad">No invoices yet.</p>}
        </section>
      )}
      {modal === 'ship' && <ShipModal poId={poId} lines={c.shippable} onClose={() => setModal(undefined)} onDone={(n) => { setModal(undefined); onFlash(`Shipment notice ${n} sent to the buyer.`); load(); }} />}
      {modal === 'invoice' && <InvoiceModal poId={poId} currency={currency} lines={c.invoiceable} shipments={c.shipments} einvoice={c.einvoice} tolerance={c.priceTolerancePct} onClose={() => setModal(undefined)}
        onDone={(st) => { setModal(undefined); onFlash(st === 'EXCEPTION' ? 'Invoice submitted. It doesn’t match the order exactly, so the buyer will review it.' : 'Invoice submitted. It matches the order and is with the buyer for approval.'); load(); }} />}
      {cancel && <CancelShipmentModal s={cancel} onClose={() => setCancel(undefined)} onConfirm={async (reason) => {
        try { await api(`/vendor/collab/shipments/${cancel.id}/cancel`, { body: { reason } }); setCancel(undefined); onFlash(`Shipment notice ${cancel.number} cancelled.`); load(); } catch (e: any) { setCancel(undefined); setErr(e.message); }
      }} />}
    </>
  );
}
