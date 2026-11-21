/**
 * One AP invoice, credit or debit note: the draft form while it is a draft (PDF, save, submit), then lines and coding, checks,
 * the approval matrix (FlowPanel), the single decision when no level applies, ERP status and holds, payments, notes against
 * it, and actions (send to the ERP, email a debit note, raise a credit / debit note, cancel).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, money } from '../../lib/format';
import { useHelpContext } from '../../help/HelpPanel';
import { Alert, Modal } from '../../components/ui';
import { FlowPanel } from '../../components/ApprovalFlow';
import { PriceCheckCard, type PriceCheck } from '../../components/PriceCheck';
import { ChecksList } from '../../orders/collab';
import { Facts, qty } from '../../orders/common';
import { ApStatus, ErpBadge, KIND_LABEL, SOURCE_LABEL, useInvoiceSetup, type ApDetail, type InvKind } from '../../components/Invoices';
import { draftBody, draftFrom, InvoiceForm, type Draft } from './InvoiceForm';
import { AP_BASE, NewInvoiceModal } from './Invoices';
import { DuplicatesCard, ForwardModal } from './Duplicates';

export function ApInvoiceDetail() {
  useHelpContext('ap-invoices');
  const { id } = useParams();
  const nav = useNavigate();
  const setup = useInvoiceSetup();
  const [d, setD] = useState<ApDetail & { priceCheck?: PriceCheck | null }>();
  const [draft, setDraft] = useState<Draft>();
  const [error, setError] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [decide, setDecide] = useState<'APPROVE' | 'REJECT'>();
  const [cancel, setCancel] = useState(false);
  const [note, setNote] = useState<InvKind>();
  const [forward, setForward] = useState(false);
  const take = useCallback((x: ApDetail) => { setD(x); setDraft(x.can.edit ? draftFrom(x) : undefined); }, []);
  const load = useCallback(() => api<ApDetail>(`/staff/invoices/${id}`).then(take).catch((e) => setError(e.message)), [id, take]);
  useEffect(() => { load(); }, [load]);

  async function act(path: string, body?: unknown, done?: string) {
    setBusy(true); setError(undefined); setFlash(undefined);
    try { take(await api<ApDetail>(`/staff/invoices/${id}${path}`, { method: path ? 'POST' : 'PUT', body: body ?? {} })); if (done) setFlash(done); return true; }
    catch (e: any) { setError(e.message); return false; } finally { setBusy(false); }
  }
  async function upload(f: File) {
    const fd = new FormData(); fd.append('file', f);
    await act('/file', fd, 'File attached.');
  }
  async function saveAndSubmit() {
    if (!draft) return;
    if (await act('', draftBody(draft))) await act('/submit', {}, 'Submitted.');
  }
  if (!d || !setup) return <div className="page">{error ? <Alert kind="error">{error}</Alert> : <div className="spinner" />}</div>;
  const i = d.invoice;
  const errors = i.checks.filter((c) => c.level === 'error');
  const sign = i.kind === 'INVOICE' ? 1 : -1;
  return (
    <div className="page">
      <Link to={AP_BASE} className="back">← Invoices</Link>
      <header className="page-head">
        <div><h1><span className="mono-num">{KIND_LABEL[i.kind]} {i.invoiceNumber || '(no number yet)'}</span> <ApStatus status={i.status} label={i.statusLabel} /> <ErpBadge status={i.erpStatus} label={i.erpLabel} /></h1>
          <p className="muted">{d.party ? <>{d.party.name} <span className="mono small">{d.party.code}</span></> : 'Supplier not chosen'}
            {d.po && <> · order <span className="mono">{d.po.poNumber}</span></>}{d.contract && <> · contract <Link to={`/staff/contracts/${d.contract.id}`} className="mono">{d.contract.number}</Link></>}
            {d.related && <> · against <Link to={`${AP_BASE}/${d.related.id}`} className="mono">{d.related.invoiceNumber}</Link></>} · {money(sign * i.total, i.currency)} · {fmtDate(i.invoiceDate)}</p></div>
        <div className="head-actions">
          {d.can.creditNote && setup.settings.creditNotes && <button className="btn btn-secondary" onClick={() => setNote('CREDIT')}>Credit note</button>}
          {d.can.debitNote && setup.settings.debitNotes && <button className="btn btn-secondary" onClick={() => setNote('DEBIT')}>Debit note</button>}
          {d.can.forward && <button className="btn btn-secondary" onClick={() => setForward(true)}>Forward for approval…</button>}
          {d.can.cancel && <button className="btn btn-ghost" onClick={() => setCancel(true)}>Cancel {KIND_LABEL[i.kind].toLowerCase()}</button>}
        </div>
      </header>
      {error && <Alert kind="error">{error}</Alert>}
      {flash && <Alert kind="success">{flash}</Alert>}
      {i.decisionNote && <Alert kind={i.status === 'REJECTED' ? 'error' : 'info'}>{i.status === 'REJECTED' ? 'Rejected' : i.status === 'CANCELLED' ? 'Cancelled' : 'Approved'}{i.decidedBy ? ` by ${i.decidedBy}` : ''}{i.decidedAt ? ` on ${fmtDate(i.decidedAt)}` : ''}: “{i.decisionNote}”</Alert>}

      <DuplicatesCard d={d} base={AP_BASE} onDone={take} />
      {draft && (
        <section className="card pad section-card" aria-label="Draft">
          <h3>Draft — finish and submit</h3>
          <ChecksList checks={i.checks.filter((c) => c.level !== 'ok' && !c.rule)} />
          <InvoiceForm value={draft} onChange={setDraft} setup={setup} />
          <div className="field"><label htmlFor="inv-file">{i.kind === 'DEBIT' ? 'Supporting document (optional — the debit note PDF is made for you)' : 'The supplier’s PDF'}</label>
            {d.file && <div className="small">Attached: <a href={`/api/staff/invoices/${i.id}/file`} target="_blank" rel="noreferrer">{d.file}</a></div>}
            <input id="inv-file" type="file" accept="application/pdf,image/*" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></div>
          <div className="btn-row">
            <button className="btn btn-secondary" disabled={busy} onClick={() => act('', draftBody(draft), 'Draft saved and checked.')}>Save draft</button>
            {d.can.submit && <button className="btn btn-primary" disabled={busy} onClick={saveAndSubmit}>Save and submit</button>}
          </div>
        </section>
      )}
      {!draft && i.status === 'DRAFT' && d.can.submit && (
        <section className="card pad section-card"><div className="decision-bar"><div><strong>This draft came from the supplier portal.</strong></div>
          <button className="btn btn-primary" disabled={busy} onClick={() => act('/submit', {}, 'Submitted.')}>Submit</button></div></section>
      )}

      {d.can.decide && (
        <section className="card pad decision-bar">
          <div><strong>{i.status === 'EXCEPTION' ? 'This invoice doesn’t match cleanly.' : 'No approval level applies to this invoice.'}</strong>
            <div className="muted small">{i.status === 'EXCEPTION' ? 'Check the points below. You can still approve it with a note.' : 'Approve it to release it for the ERP.'}</div></div>
          <div className="btn-row"><button className="btn btn-secondary" onClick={() => setDecide('REJECT')}>Reject…</button><button className="btn btn-primary" onClick={() => setDecide('APPROVE')}>Approve{i.status === 'EXCEPTION' ? '…' : ''}</button></div>
        </section>
      )}

      {!draft && (
        <section className="card section-card">
          <div className="toolbar"><h3>Lines</h3></div>
          <div className="table-wrap"><table className="table static compact">
            <thead><tr><th>Line</th><th>Item</th><th className="num">Quantity</th><th className="num">Unit price</th><th className="num">Tax</th><th className="num">Amount</th><th>Coding</th></tr></thead>
            <tbody>{d.lines.map((l, k) => (
              <tr key={l.id}><td className="mono-num">{l.lineNo ?? k + 1}</td><td><div className="strong">{l.description}</div><div className="muted small">{l.itemCode}</div></td>
                <td className="num nowrap">{qty(l.quantity)} {l.uom}{l.ordered != null && <div className="muted small">ordered {qty(l.ordered)} · received {qty(l.received ?? 0)}</div>}</td>
                <td className="num">{money(l.unitPrice, i.currency)}{l.poPrice != null && l.poPrice !== l.unitPrice && <div className={`small ${l.unitPrice > l.poPrice ? 'warn-text' : 'muted'}`}>PO {money(l.poPrice, i.currency)}</div>}</td>
                <td className="num small">{l.taxRate !== null ? `${l.taxRate}%` : ''}<div>{money(l.taxAmount, i.currency)}</div></td>
                <td className="num strong">{money(l.amount, i.currency)}</td>
                <td className="small mono">{[l.glAccount, l.costCentre, l.project].filter(Boolean).join(' · ') || <span className="muted">from the order</span>}</td></tr>))}</tbody>
            <tfoot><tr><td colSpan={5} className="num">Before tax {money(i.subtotal, i.currency)} · tax {money(i.taxAmount, i.currency)}</td><td className="num strong">{money(i.total, i.currency)}</td><td /></tr></tfoot>
          </table></div>
        </section>
      )}

      <div className="detail-grid">
        <div>
          {!draft && <section className="card pad"><h3 className="card-title">Checks</h3>{i.checks.length ? <ChecksList checks={i.checks.filter((c) => !c.rule)} /> : <p className="muted small">No checks yet.</p>}
            {errors.length > 0 && i.status === 'DRAFT' && <p className="err-text small">Fix these before it can be submitted.</p>}</section>}
          {d.priceCheck && <PriceCheckCard check={d.priceCheck} currency={i.currency} lines={d.lines.map((l) => ({ key: l.id, label: `${l.lineNo ?? ''} ${l.itemCode ?? ''} ${l.description ?? ''}`.trim(), unitPrice: l.unitPrice }))} />}
          {(d.flow.steps.length > 0 || i.status === 'IN_APPROVAL') && (
            <FlowPanel flow={d.flow} title="Approval matrix" onDecide={async (action, remarks) => { const r = await api<ApDetail>(`/staff/invoices/${id}/approval`, { body: { action, remarks } }); take(r); }} />
          )}
          {i.erpStatus && (
            <section className="card pad section-card" aria-label="ERP">
              <h3>ERP</h3>
              <Facts items={[['Status', <ErpBadge key="s" status={i.erpStatus} label={i.erpLabel} />], ['Sent', i.erpSentAt ? fmtDateTime(i.erpSentAt) : null], ['ERP invoice id', i.erpInvoiceId], ['Problem', i.erpError ? <span className="err-text">{i.erpError}</span> : null]]} />
              {!!i.erpHolds?.length && <><h4>Holds in the ERP</h4><ul className="small">{i.erpHolds.map((h, k) => <li key={k}><span className="mono">{h.code}</span>{h.reason ? ` — ${h.reason}` : ''}</li>)}</ul></>}
              {d.messages.length > 0 && <table className="table static compact"><thead><tr><th>Message</th><th>Status</th><th>Sent</th></tr></thead>
                <tbody>{d.messages.map((m) => <tr key={m.id}><td className="small">{m.connector}</td><td className="small">{m.status}{m.error && <div className="err-text">{m.error}</div>}</td><td className="small">{m.sentAt ? fmtDateTime(m.sentAt) : '—'}</td></tr>)}</tbody></table>}
              {d.can.push && <div className="btn-row"><button className="btn btn-primary btn-sm" disabled={busy} onClick={async () => { setBusy(true); setError(undefined);
                try { const r = await api<{ sent: number; waiting: { error: string | null }[] }>('/staff/invoices/push', { body: { ids: [i.id] } }); await load(); if (r.sent) setFlash('Sent to the ERP.'); else setError(r.waiting[0]?.error ?? 'Not sent.'); }
                catch (e: any) { setError(e.message); } finally { setBusy(false); } }}>{i.erpStatus === 'FAILED' ? 'Send again' : 'Send to the ERP'}</button></div>}
            </section>
          )}
          {d.payments.length > 0 && (
            <section className="card section-card"><div className="toolbar"><h3>Payments</h3></div>
              <table className="table static compact"><thead><tr><th>Date</th><th>Reference</th><th className="num">Paid</th><th className="num">Withheld</th></tr></thead>
                <tbody>{d.payments.map((p) => <tr key={p.id}><td className="small">{fmtDate(p.paymentDate)}</td><td className="mono small">{p.reference}{p.method && <span className="muted"> · {p.method}</span>}</td><td className="num">{money(p.amount, p.currency)}</td><td className="num small">{p.withheld ? money(p.withheld, p.currency) : '—'}</td></tr>)}</tbody></table>
            </section>
          )}
          {d.notesOnIt.length > 0 && (
            <section className="card section-card"><div className="toolbar"><h3>Credit and debit notes</h3></div>
              <table className="table static compact"><tbody>{d.notesOnIt.map((n) => <tr key={n.id}><td><Link to={`${AP_BASE}/${n.id}`} className="mono">{n.invoiceNumber}</Link></td><td className="small">{KIND_LABEL[n.kind]}</td><td className="num">{money(-n.total, i.currency)}</td><td className="small">{n.status}</td></tr>)}</tbody></table>
            </section>
          )}
        </div>
        <aside className="side-col">
          <section className="card pad">
            <h3 className="card-title">Details</h3>
            <Facts items={[
              ['Came from', d.mail ? <span key="m">Email from {d.mail.fromName ?? d.mail.fromAddress}<div className="muted small">“{d.mail.subject ?? '(no subject)'}” · {fmtDateTime(d.mail.receivedAt)}</div></span> : SOURCE_LABEL[i.source] ?? i.source], ['Entered by', i.submittedBy], ['Operating unit', i.entityCode], ['GL date', i.glDate ? fmtDate(i.glDate) : null], ['Due', i.dueDate ? fmtDate(i.dueDate) : null],
              ['Payment terms', d.po?.paymentTerms ?? d.party?.ap?.paymentTerms ?? null], ['Supplier in the ERP', d.party?.ap?.erpSupplierCode ? `${d.party.ap.erpSupplierCode}${d.party.ap.erpSiteCode ? ` / ${d.party.ap.erpSiteCode}` : ''}` : null],
              ['Tax number', d.party?.taxNo ?? null], ['Paid so far', i.paidAmount ? money(i.paidAmount, i.currency) : null], ['Net payable', i.netPayable !== null && i.netPayable !== i.total ? money(i.netPayable, i.currency) : null],
              ['IRN', i.einvoice?.irn ? <span className="mono small break">{i.einvoice.irn}</span> : null],
              ['File', d.file || (i.kind === 'DEBIT' && i.status !== 'DRAFT') ? <a href={`/api/staff/invoices/${i.id}/file`} target="_blank" rel="noreferrer">{d.file ?? 'Debit note PDF'}</a> : null],
            ]} />
            {i.description && <p className="small">{i.description}</p>}
            {i.notes && <p className="small muted">“{i.notes}”</p>}
          </section>
          {i.kind === 'DEBIT' && i.status !== 'DRAFT' && (
            <section className="card pad">
              <h3 className="card-title">Debit note to the supplier</h3>
              <p className="small">{i.emailedAt ? `Emailed ${fmtDateTime(i.emailedAt)}${d.debitNoteTo ? ` to ${d.debitNoteTo}` : ''}.` : d.debitNoteTo ? `Not emailed yet. It goes to ${d.debitNoteTo}.` : 'No email address for the supplier’s accounts team — add one on the party.'}</p>
              {d.can.email && d.debitNoteTo && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => act('/email', {}, 'Debit note emailed.')}>{i.emailedAt ? 'Email again' : 'Email to the supplier'}</button>}
            </section>
          )}
        </aside>
      </div>

      {decide && <DecideModal decision={decide} exception={i.status === 'EXCEPTION'} onClose={() => setDecide(undefined)} onDone={async (note) => { if (await act('/decide', { decision: decide, note }, decide === 'APPROVE' ? 'Approved.' : 'Rejected.')) setDecide(undefined); }} />}
      {cancel && (
        <Modal title={`Cancel this ${KIND_LABEL[i.kind].toLowerCase()}?`} onClose={() => setCancel(false)} footer={<><button className="btn btn-secondary" onClick={() => setCancel(false)}>Keep it</button>
          <button className="btn btn-danger" disabled={busy} onClick={async () => { if (await act('/cancel', { reason: 'Cancelled by AP' }, 'Cancelled.')) setCancel(false); }}>Cancel it</button></>}>
          <p>It stays in the list as cancelled and can’t be submitted again.</p></Modal>
      )}
      {forward && <ForwardModal id={i.id} onClose={() => setForward(false)} onDone={(x) => { take(x); setFlash('Forwarded.'); }} />}
      {note && <NewInvoiceModal kind={note} setup={setup} related={{ id: i.id, partyId: i.partyId ?? '' }} onClose={() => setNote(undefined)} onCreated={(nid) => { setNote(undefined); nav(`${AP_BASE}/${nid}`); }} />}
    </div>
  );
}

function DecideModal({ decision, exception, onClose, onDone }: { decision: 'APPROVE' | 'REJECT'; exception: boolean; onClose: () => void; onDone: (note: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  const needs = decision === 'REJECT' || exception;
  return (
    <Modal title={decision === 'APPROVE' ? 'Approve invoice' : 'Reject invoice'} onClose={onClose} footer={<><button className="btn btn-secondary" onClick={onClose}>Close</button>
      <button className={`btn ${decision === 'APPROVE' ? 'btn-primary' : 'btn-danger'}`} disabled={needs && !note.trim()} onClick={() => onDone(note)}>{decision === 'APPROVE' ? 'Approve' : 'Reject'}</button></>}>
      <div className="field"><label htmlFor="dec-note">{decision === 'REJECT' ? 'Why' : exception ? 'Why it can be approved' : 'Note (optional)'}</label><textarea id="dec-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></div>
    </Modal>
  );
}
