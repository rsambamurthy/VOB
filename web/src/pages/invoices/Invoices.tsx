/**
 * Invoices add-on (accounts payable): the invoice list with tabs, new invoices / credit / debit notes, bulk upload, Excel
 * import, the Ready-for-ERP queue (manual push) and payments. One `InvoiceTable` for the list and the queue.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDate, money } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useHelpContext } from '../../help/HelpPanel';
import { Alert, Empty, Modal } from '../../components/ui';
import { TabStrip } from '../../components/TabStrip';
import { ExcelImportModal } from '../../components/ExcelImport';
import { PaymentsTable, type Payment } from '../../orders/collab';
import { ApStatus, ErpBadge, KIND_LABEL, useInvoiceSetup, type ApRow, type Counts, type InvKind, type InvoiceSetup } from '../../components/Invoices';
import { blankDraft, draftBody, InvoiceForm, type Draft } from './InvoiceForm';

interface List { rows: ApRow[]; hasMore: boolean; page: number; counts: Counts; can: { capture: boolean; manage: boolean } }
const TABS: [string, string, keyof Counts | null][] = [
  ['REVIEW', 'To review', 'review'], ['EXCEPTION', 'Exceptions', 'exceptions'], ['IN_APPROVAL', 'In approval', 'inApproval'], ['DRAFT', 'Drafts', 'drafts'],
  ['READY', 'Ready for ERP', 'ready'], ['FAILED', 'Import failed', 'failed'], ['UNPAID', 'Unpaid', 'unpaid'], ['OVERDUE', 'Overdue', 'overdue'], ['PAID', 'Paid', 'paid'], ['REJECTED', 'Rejected', 'rejected'], ['', 'All', 'all'],
];
export const AP_BASE = '/staff/ap/invoices';
const today = () => new Date().toISOString().slice(0, 10);

function useInvoiceList(status: string, q: string, page: number) {
  const [data, setData] = useState<List>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    const p = new URLSearchParams({ page: String(page) });
    if (status) p.set('status', status);
    if (q) p.set('q', q);
    api<List>(`/staff/invoices?${p}`).then(setData).catch((e) => setError(e.message));
  }, [status, q, page]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  return { data, error, load };
}

export function InvoiceTable({ rows, selected, onSelect }: { rows: ApRow[]; selected?: Set<string>; onSelect?: (ids: Set<string>) => void }) {
  const nav = useNavigate();
  if (!rows.length) return <Empty>No invoices here.</Empty>;
  const toggle = (id: string) => { const n = new Set(selected); if (n.has(id)) n.delete(id); else n.add(id); onSelect?.(n); };
  return (
    <div className="table-wrap"><table className="table">
      <thead><tr>{onSelect && <th><input type="checkbox" aria-label="Select all" checked={!!selected && selected.size === rows.length} onChange={(e) => onSelect(new Set(e.target.checked ? rows.map((r) => r.id) : []))} /></th>}
        <th>Invoice</th><th>Supplier</th><th>Against</th><th>Date</th><th className="num">Total</th><th>Status</th><th>Due</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id} className="clickable" onClick={() => (onSelect ? toggle(r.id) : nav(`${AP_BASE}/${r.id}`))}>
          {onSelect && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${r.invoiceNumber}`} checked={!!selected?.has(r.id)} onChange={() => toggle(r.id)} /></td>}
          <td><Link to={`${AP_BASE}/${r.id}`} className="mono strong" onClick={(e) => e.stopPropagation()}>{r.invoiceNumber || '(no number yet)'}</Link>
            {r.kind !== 'INVOICE' && <div className="small"><span className="badge sm">{KIND_LABEL[r.kind]}</span></div>}
            {r.warnings > 0 && ['EXCEPTION', 'IN_APPROVAL', 'DRAFT'].includes(r.status) && <div className="warn-text small">{r.warnings} to check</div>}</td>
          <td>{r.partyName ?? '—'}<div className="muted small mono">{r.partyCode}</div></td>
          <td className="small">{r.poNumber ? <span className="mono">{r.poNumber}</span> : r.contractNumber ? <span className="mono">{r.contractNumber}</span> : r.basisLabel}</td>
          <td className="small nowrap">{fmtDate(r.invoiceDate)}</td>
          <td className="num nowrap">{money(r.kind === 'INVOICE' ? r.total : -r.total, r.currency)}{r.paidAmount > 0 && r.status !== 'PAID' && <div className="muted small">{money(r.paidAmount, r.currency)} paid</div>}</td>
          <td><ApStatus status={r.status} label={r.statusLabel} /> {r.erpStatus && <div><ErpBadge status={r.erpStatus} label={r.erpLabel} /></div>}</td>
          <td className="small nowrap">{r.dueDate && ['APPROVED', 'PARTLY_PAID'].includes(r.status) ? <span className={r.dueDate < today() ? 'err-text' : ''}>{fmtDate(r.dueDate)}</span> : '—'}</td>
        </tr>))}</tbody>
    </table></div>
  );
}

const Pages = ({ data, page, setPage }: { data: List; page: number; setPage: (n: number) => void }) => (page > 1 || data.hasMore ? (
  <div className="pager"><button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Newer</button><span className="muted small">Page {page}</span>
    <button className="btn btn-secondary btn-sm" disabled={!data.hasMore} onClick={() => setPage(page + 1)}>Older →</button></div>) : null);

export function ApInvoices() {
  useHelpContext('ap-invoices');
  const { me } = useSession();
  const setup = useInvoiceSetup();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'REVIEW';
  const status = tab === 'all' ? '' : tab;
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const { data, error, load } = useInvoiceList(status, q, page);
  const [creating, setCreating] = useState<InvKind>();
  const [bulk, setBulk] = useState(false);
  const [importing, setImporting] = useState(false);
  const [flash, setFlash] = useState<string>();
  useEffect(() => { setPage(1); }, [status, q]);
  const s = me?.invoices;
  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Invoices</h1><p className="muted">Supplier invoices against purchase orders, contracts or neither — checked, approved through the matrix and sent to the ERP.</p></div>
        {data?.can.capture && setup && <div className="head-actions">
          {s?.bulkUpload && <button className="btn btn-secondary" onClick={() => setBulk(true)}>Upload PDFs</button>}
          {s?.excelImport && <button className="btn btn-secondary" onClick={() => setImporting(true)}>Import from Excel</button>}
          {s?.creditNotes && <button className="btn btn-secondary" onClick={() => setCreating('CREDIT')}>Credit note</button>}
          {s?.debitNotes && <button className="btn btn-secondary" onClick={() => setCreating('DEBIT')}>Debit note</button>}
          <button className="btn btn-primary" onClick={() => setCreating('INVOICE')}>+ New invoice</button></div>}
      </header>
      {error && <Alert kind="error">{error}</Alert>}
      {flash && <Alert kind="success">{flash}</Alert>}
      <TabStrip>{TABS.map(([k, l, c]) => <button key={k || 'all'} role="tab" aria-selected={tab === (k || 'all')} className={tab === (k || 'all') ? 'active' : ''} onClick={() => setParams(k === 'REVIEW' ? {} : { tab: k || 'all' })}>
        {l}{c && data && data.counts[c] > 0 && <span className="tab-count">{data.counts[c]}</span>}</button>)}</TabStrip>
      <div className="card">
        <div className="toolbar"><input className="search" placeholder="Search invoice, PO, supplier or code…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search invoices" />
          {status === 'READY' && <Link to="/staff/ap/ready" className="btn btn-secondary btn-sm">Send to the ERP…</Link>}</div>
        {!data ? <div className="pad"><div className="spinner" /></div> : <><InvoiceTable rows={data.rows} /><Pages data={data} page={page} setPage={setPage} /></>}
      </div>
      {creating && setup && <NewInvoiceModal kind={creating} setup={setup} onClose={() => setCreating(undefined)} onCreated={(id) => nav(`${AP_BASE}/${id}`)} />}
      {bulk && <BulkUploadModal onClose={() => setBulk(false)} onDone={(n) => { setBulk(false); setFlash(`${n} draft${n === 1 ? '' : 's'} created — open each to finish and submit it.`); setParams({ tab: 'DRAFT' }); load(); }} />}
      {importing && (
        <ExcelImportModal<{ row: number; supplier: string; invoiceNumber: string }> title="Import invoices from Excel" endpoint="/staff/invoices/import" templateUrl="/staff/invoices/import-template.xlsx"
          intro="One row per invoice line; rows with the same supplier and invoice number make one invoice. Invoices come in as drafts — open each, attach the PDF and submit it."
          columns={[{ label: 'Supplier', cell: (r) => r.supplier }, { label: 'Invoice', cell: (r) => r.invoiceNumber }]}
          onClose={() => setImporting(false)} onDone={(n) => { setImporting(false); setFlash(`${n} invoice${n === 1 ? '' : 's'} imported as drafts.`); setParams({ tab: 'DRAFT' }); load(); }} />
      )}
    </div>
  );
}

export function NewInvoiceModal({ kind, setup, related, onClose, onCreated }: { kind: InvKind; setup: InvoiceSetup; related?: { id: string; partyId: string }; onClose: () => void; onCreated: (id: string) => void }) {
  const [v, setV] = useState<Draft>(() => ({ ...blankDraft(kind, setup), ...(related ? { partyId: related.partyId, relatedInvoiceId: related.id } : {}) }));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true); setError(undefined);
    try { const r = await api<{ invoice: { id: string } }>('/staff/invoices', { body: draftBody(v) }); onCreated(r.invoice.id); }
    catch (e: any) { setError(e.message); setBusy(false); }
  }
  const ready = !!v.partyId && (kind === 'INVOICE' ? v.basis !== 'po' || !!v.poId : !!v.relatedInvoiceId) && (kind === 'DEBIT' || v.invoiceNumber.trim().length > 0);
  return (
    <Modal title={`New ${KIND_LABEL[kind].toLowerCase()}`} wide onClose={onClose} footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !ready} onClick={create}>Save draft</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <p className="muted small" style={{ marginTop: 0 }}>{kind === 'DEBIT' ? 'A debit note is raised by you against the supplier’s invoice — it reduces what is paid. It is numbered when saved.'
        : 'Saved as a draft and checked. Attach the PDF on the next screen, then submit it for approval.'}</p>
      <InvoiceForm value={v} onChange={setV} setup={setup} fixedParty={!!related} />
    </Modal>
  );
}

interface BulkResult { files: { fileName: string; poNumber: string | null }[]; skipped: string[]; created: { id: string }[]; duplicates: string[] }
function BulkUploadModal({ onClose, onDone }: { onClose: () => void; onDone: (n: number) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [check, setCheck] = useState<BulkResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function send(commit: boolean) {
    setBusy(true); setError(undefined);
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f));
    try {
      const r = await api<BulkResult>(`/staff/invoices/bulk${commit ? '?commit=1' : ''}`, { body: fd });
      if (commit) onDone(r.created.length); else setCheck(r);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal title="Upload invoice PDFs" wide onClose={onClose} footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      {!check ? <button className="btn btn-primary" disabled={busy || !files.length} onClick={() => send(false)}>Check files</button>
        : <button className="btn btn-primary" disabled={busy || !check.files.length} onClick={() => send(true)}>Create {check.files.length} draft{check.files.length === 1 ? '' : 's'}</button>}</>}>
      {error && <Alert kind="error">{error}</Alert>}
      <p className="muted small" style={{ marginTop: 0 }}>PDFs or a .zip of them (up to 25 files at a time). Each file becomes a draft. A purchase order number in the file name — for example <span className="icode">PO-4512 Kirloskar.pdf</span> — links the draft to that order and its supplier. The same file uploaded twice is skipped.</p>
      <input type="file" multiple accept=".pdf,.zip,application/pdf,application/zip" aria-label="Invoice files" onChange={(e) => { setFiles([...(e.target.files ?? [])]); setCheck(undefined); }} />
      {check && (
        <div className="table-wrap" style={{ marginTop: 12 }}><table className="table static compact">
          <thead><tr><th>File</th><th>Purchase order</th></tr></thead>
          <tbody>{check.files.map((f) => <tr key={f.fileName}><td className="small">{f.fileName}</td><td className="small">{f.poNumber ? <span className="mono">{f.poNumber}</span> : <span className="muted">Not found — choose it on the draft</span>}</td></tr>)}</tbody>
        </table>{check.skipped.length > 0 && <p className="muted small">Skipped (not PDF or Word): {check.skipped.join(', ')}</p>}</div>
      )}
    </Modal>
  );
}

/** Ready for ERP: approved invoices waiting for a manual push (or that failed to import and were fixed). */
export function ApReady() {
  useHelpContext('ap-invoices');
  const { me } = useSession();
  const [tab, setTab] = useState<'READY' | 'FAILED'>('READY');
  const [page, setPage] = useState(1);
  const { data, error, load } = useInvoiceList(tab, '', page);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'warning'; text: string }>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSel(new Set()); setPage(1); }, [tab]);
  async function push() {
    setBusy(true); setMsg(undefined);
    try {
      const r = await api<{ sent: number; waiting: { invoiceNumber: string; error: string | null }[] }>('/staff/invoices/push', { body: { ids: [...sel] } });
      setMsg(r.waiting.length ? { kind: 'warning', text: `${r.sent} sent. Not sent: ${r.waiting.map((w) => `${w.invoiceNumber} (${w.error ?? 'waiting'})`).join('; ')}` } : { kind: 'success', text: `${r.sent} invoice${r.sent === 1 ? '' : 's'} sent to the ERP.` });
      setSel(new Set()); load();
    } catch (e: any) { setMsg({ kind: 'error', text: e.message }); } finally { setBusy(false); }
  }
  return (
    <div className="page">
      <header className="page-head"><div><h1>Ready for ERP</h1><p className="muted">{me?.invoices?.pushMode === 'automatic' ? 'Approved invoices are sent automatically; ones that couldn’t be sent wait here.' : 'Approved invoices wait here until you send them. Choose the ones to send.'}</p></div>
        <div className="head-actions"><button className="btn btn-primary" disabled={busy || !sel.size} onClick={push}>Send {sel.size || ''} to the ERP</button></div></header>
      {error && <Alert kind="error">{error}</Alert>}
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <TabStrip>{(['READY', 'FAILED'] as const).map((k) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{k === 'READY' ? 'Waiting' : 'Import failed'}
        {data && data.counts[k === 'READY' ? 'ready' : 'failed'] > 0 && <span className="tab-count">{data.counts[k === 'READY' ? 'ready' : 'failed']}</span>}</button>)}</TabStrip>
      {tab === 'FAILED' && <Alert kind="info">The ERP refused these. Fix the cause in the ERP or on the invoice’s coding, then send them again.</Alert>}
      <div className="card">{!data ? <div className="pad"><div className="spinner" /></div> : <><InvoiceTable rows={data.rows} selected={sel} onSelect={setSel} /><Pages data={data} page={page} setPage={setPage} /></>}</div>
    </div>
  );
}

export function ApPayments() {
  useHelpContext('ap-invoices');
  const [page, setPage] = useState(1);
  const [d, setD] = useState<{ rows: Payment[]; hasMore: boolean }>();
  const [error, setError] = useState<string>();
  useEffect(() => { api<{ rows: Payment[]; hasMore: boolean }>(`/staff/invoices/payments?page=${page}`).then(setD).catch((e) => setError(e.message)); }, [page]);
  return (
    <div className="page">
      <header className="page-head"><div><h1>Payments</h1><p className="muted">Payments the ERP reported, with the invoices each one settled.</p></div></header>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="card">{!d ? <div className="pad"><div className="spinner" /></div> : <>
        <PaymentsTable rows={d.rows} showVendor invoiceBase={AP_BASE} />
        {(page > 1 || d.hasMore) && <div className="pager"><button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Newer</button><span className="muted small">Page {page}</span><button className="btn btn-secondary btn-sm" disabled={!d.hasMore} onClick={() => setPage(page + 1)}>Older →</button></div>}</>}</div>
    </div>
  );
}
