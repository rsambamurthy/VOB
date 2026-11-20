/** Contracts → Migration: bringing a customer's existing contracts in — imports, bulk signed copies, the inbox, bulk reading, review and a checklist. */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtSize, money } from '../../lib/format';
import { useHelpContext } from '../../help/HelpPanel';
import { Alert, Modal } from '../../components/ui';
import { ExcelImportModal } from '../../components/ExcelImport';
import { ContractStatus, useContractSetup } from '../../components/Contracts';

type Row = { id: string; number: string; title: string; status: string; party: string };
interface Status {
  totals: { parties: number; contracts: number; active: number; withSignedCopy: number; obligations: number; inbox: number; unread: number };
  checks: Record<string, { label: string; count: number; contracts: Row[] }>;
  review: { contractId: string; number: string; title: string; status: string; readingId: string; fields: { field: string; label: string; value: string | number | boolean; current: unknown }[] }[];
}
interface PlanLine { file: string; contract?: { id: string; number: string; title: string }; result: 'attach' | 'inbox' | 'duplicate' | 'error'; note?: string }
interface Plan { plan: PlanLine[]; skipped: string[]; attach: number; inbox: number; duplicate: number; errors: number; committed: boolean }
interface InboxFile { id: string; fileName: string; size: number; reason: string; candidates: { id: string; number: string; title: string }[]; uploadedByName: string; uploadedAt: string }

const show = (field: string, v: unknown) => (v === null || v === undefined || v === '' ? 'empty' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : field.endsWith('Date') ? fmtDate(String(v)) : field === 'value' ? money(Number(v)) : String(v));
const RESULT: Record<PlanLine['result'], [string, string]> = { attach: ['Attach', 'badge-approved'], inbox: ['To the inbox', 'badge-attention'], duplicate: ['Already there', ''], error: ['Not accepted', 'badge-rejected'] };

export function ContractMigration() {
  useHelpContext('contract-migration');
  const [s, setS] = useState<Status>();
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'warning'; text: string }>();
  const [modal, setModal] = useState<'parties' | 'contracts' | 'obligations'>();
  const load = useCallback(() => api<Status>('/staff/contracts/migration').then(setS).catch((e) => setMsg({ kind: 'error', text: e.message })), []);
  useEffect(() => { load(); }, [load]);
  const done = (text: string) => { setMsg({ kind: 'success', text }); load(); };
  if (!s) return <div className="page">{msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : <div className="spinner" />}</div>;
  const t = s.totals;
  return (
    <div className="page">
      <header className="page-head"><div><h1>Bring existing contracts in</h1><p className="muted">Parties and contracts from Excel, signed copies in bulk, the terms read from the files, and a checklist of what is still missing.</p></div></header>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="stat-row">
        <div className="stat stat-invited"><span className="stat-n">{t.parties}</span><span className="stat-l">Parties</span></div>
        <div className="stat stat-approved"><span className="stat-n">{t.contracts}</span><span className="stat-l">Contracts ({t.active} active)</span></div>
        <div className="stat stat-attention"><span className="stat-n">{t.active ? `${Math.round((t.withSignedCopy / t.active) * 100)}%` : '—'}</span><span className="stat-l">Active with a signed copy ({t.withSignedCopy} of {t.active})</span></div>
        <div className="stat stat-invited"><span className="stat-n">{t.obligations}</span><span className="stat-l">Obligations</span></div>
        <div className="stat stat-rejected"><span className="stat-n">{t.inbox}</span><span className="stat-l">Files in the inbox</span></div>
      </div>

      <section className="card pad section-card">
        <h3>1. Parties and contracts from Excel</h3>
        <p className="muted small">Suppliers and customers first (or let the contracts import create them), then the contracts with their dates, value, renewal and notice terms. Statements of work can name their master agreement.</p>
        <div className="btn-row" style={{ justifyContent: 'flex-start' }}>
          <button className="btn btn-secondary" onClick={() => setModal('parties')}>Import parties</button>
          <button className="btn btn-secondary" onClick={() => setModal('contracts')}>Import contracts</button>
        </div>
      </section>

      <BulkFiles onDone={(text) => done(text)} />
      <Inbox count={t.inbox} onChanged={(text) => done(text)} />
      <BulkRead unread={t.unread} onDone={(text) => done(text)} />
      <Review items={s.review} onDone={(text) => done(text)} />

      <section className="card pad section-card">
        <h3>6. Obligations from Excel</h3>
        <p className="muted small">Deliverables, payments, reports and service levels for many contracts at once — each row names its contract by number or reference.</p>
        <button className="btn btn-secondary" onClick={() => setModal('obligations')}>Import obligations</button>
      </section>

      <section className="card pad section-card" aria-label="Checklist">
        <h3>7. What is still missing</h3>
        {Object.entries(s.checks).map(([k, c]) => <Check key={k} c={c} />)}
      </section>

      {modal === 'parties' && <ExcelImportModal<{ row: number; kind: string; name: string; country: string }> title="Import parties" endpoint="/staff/parties/import" templateUrl="/staff/parties/import-template.xlsx"
        intro="One row per supplier or customer." columns={[{ label: 'Name', cell: (r) => r.name }, { label: 'Kind', cell: (r) => r.kind }, { label: 'Country', cell: (r) => r.country }]} onClose={() => setModal(undefined)} onDone={(n) => { setModal(undefined); done(`${n} parties imported.`); }} />}
      {modal === 'contracts' && <ExcelImportModal<{ row: number; title: string; party: string; type: string }> title="Import existing contracts" endpoint="/staff/contracts/import" templateUrl="/staff/contracts/import-template.xlsx"
        intro="One row per contract signed outside VendorGate." options={[{ key: 'createParties', label: 'Create missing parties', help: 'A supplier or customer not found by name or code is created (Party country is then needed).' }]}
        columns={[{ label: 'Title', cell: (r) => r.title }, { label: 'Party', cell: (r) => r.party }, { label: 'Type', cell: (r) => r.type }]} onClose={() => setModal(undefined)} onDone={(n) => { setModal(undefined); done(`${n} contracts imported.`); }} />}
      {modal === 'obligations' && <ExcelImportModal<{ row: number; contract: string; title: string }> title="Import obligations" endpoint="/staff/contracts/obligations/import" templateUrl="/staff/contracts/obligations/import-template.xlsx"
        intro="Obligations are added to the contracts; existing ones are kept." columns={[{ label: 'Contract', cell: (r) => r.contract }, { label: 'What', cell: (r) => r.title }]} onClose={() => setModal(undefined)} onDone={(n) => { setModal(undefined); done(`${n} obligations imported.`); }} />}
    </div>
  );
}

/** 2. Many signed copies (or .zip files): check which contract each goes to, then upload. */
function BulkFiles({ onDone }: { onDone: (text: string) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [kind, setKind] = useState('SIGNED');
  const [plan, setPlan] = useState<Plan>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  async function go(commit: boolean) {
    setBusy(true); setErr(undefined);
    try {
      const fd = new FormData(); files.forEach((f) => fd.append('files', f));
      const r = await api<Plan>(`/staff/contracts/migration/files?kind=${kind}${commit ? '&commit=1' : ''}`, { method: 'POST', body: fd });
      setPlan(r);
      if (commit) { setFiles([]); onDone(`${r.attach} file${r.attach === 1 ? '' : 's'} attached${r.inbox ? `, ${r.inbox} to the inbox` : ''}${r.errors ? `, ${r.errors} not accepted` : ''}.`); }
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <section className="card pad section-card" aria-label="Signed copies in bulk">
      <h3>2. Signed copies in bulk</h3>
      <p className="muted small">Choose the files (Word, PDF or images) or .zip files of them. Each file goes to the contract whose <b>number</b> (e.g. SVC-2026-0001) or <b>reference</b> is in its name; the rest go to the inbox below. Check first — nothing is saved until you upload.</p>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field"><label htmlFor="bf-files">Files</label><input id="bf-files" type="file" multiple accept=".pdf,.docx,.png,.jpg,.jpeg,.zip" onChange={(e) => { setFiles([...(e.target.files ?? [])].slice(0, 25)); setPlan(undefined); }} /></div>
        <div className="field"><label htmlFor="bf-kind">They are</label><select id="bf-kind" value={kind} onChange={(e) => setKind(e.target.value)}><option value="SIGNED">Signed copies</option><option value="ANNEXURE">Annexures</option><option value="OTHER">Other files</option></select></div>
        <button className="btn btn-secondary" disabled={!files.length || busy} onClick={() => go(false)}>Check</button>
        {plan && !plan.committed && <button className="btn btn-primary" disabled={busy || !(plan.attach + plan.inbox)} onClick={() => go(true)}>Upload {plan.attach + plan.inbox} file{plan.attach + plan.inbox === 1 ? '' : 's'}</button>}
      </div>
      {files.length > 0 && <p className="small muted">{files.length} chosen ({fmtSize(files.reduce((a, f) => a + f.size, 0))}). Up to 25 files or .zip files at a time.</p>}
      {err && <Alert kind="error">{err}</Alert>}
      {plan && <>
        <p className="small"><b>{plan.attach}</b> to attach · <b>{plan.inbox}</b> to the inbox · {plan.duplicate} already there{plan.errors ? <> · <b>{plan.errors}</b> not accepted</> : null}{plan.skipped.length ? ` · ${plan.skipped.length} skipped` : ''}</p>
        <div className="table-wrap" style={{ maxHeight: 320, overflow: 'auto' }}><table className="table static compact"><thead><tr><th>File</th><th>Contract</th><th /></tr></thead>
          <tbody>{plan.plan.map((p, i) => <tr key={i}><td className="small">{p.file}</td><td className="small">{p.contract ? <><span className="mono">{p.contract.number}</span> {p.contract.title}</> : <span className="muted">{p.note}</span>}</td>
            <td><span className={`badge sm ${RESULT[p.result][1]}`}>{RESULT[p.result][0]}</span>{p.result === 'error' && <div className="small muted">{p.note}</div>}</td></tr>)}</tbody></table></div>
        {plan.skipped.length > 0 && <p className="small muted">Skipped: {plan.skipped.join(', ')}</p>}
      </>}
    </section>
  );
}

/** 3. Files that didn't match one contract: attach, make a new contract from it, or remove. */
function Inbox({ count, onChanged }: { count: number; onChanged: (text: string) => void }) {
  const [files, setFiles] = useState<InboxFile[]>();
  const [attach, setAttach] = useState<InboxFile>();
  const [create, setCreate] = useState<InboxFile>();
  const load = useCallback(() => api<{ files: InboxFile[] }>('/staff/contracts/migration/inbox').then((r) => setFiles(r.files)).catch(() => setFiles([])), []);
  useEffect(() => { load(); }, [load, count]);
  const act = async (fn: () => Promise<unknown>, text: string) => { try { await fn(); load(); onChanged(text); } catch (e: any) { alert(e.message); } };
  return (
    <section className="card pad section-card" aria-label="Inbox">
      <h3>3. Inbox {files?.length ? `(${files.length})` : ''}</h3>
      <p className="muted small">Files whose name didn’t point to one contract. Attach each to its contract, make a new contract from it (VendorGate reads the terms), or remove it.</p>
      {!files ? <div className="spinner" /> : !files.length ? <p className="small muted">Empty.</p> : <table className="table static compact"><tbody>{files.map((f) => (
        <tr key={f.id}><td><a href={`/api/staff/contracts/migration/inbox/${f.id}/file`} target="_blank" rel="noreferrer">{f.fileName}</a> <span className="muted small">{fmtSize(f.size)}</span><div className="muted small">{f.reason} · {f.uploadedByName}, {fmtDateTime(f.uploadedAt)}</div></td>
          <td className="actions" style={{ whiteSpace: 'normal' }}>
            {f.candidates.map((c) => <button key={c.id} className="btn btn-ghost btn-sm" onClick={() => act(() => api(`/staff/contracts/migration/inbox/${f.id}/attach`, { body: { contractId: c.id, kind: 'SIGNED' } }), `${f.fileName} attached to ${c.number}.`)}>To {c.number}</button>)}
            <button className="btn btn-secondary btn-sm" onClick={() => setAttach(f)}>Attach to…</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setCreate(f)}>New contract</button>
            <button className="link-btn small" onClick={() => confirm(`Remove ${f.fileName}?`) && act(() => api(`/staff/contracts/migration/inbox/${f.id}`, { method: 'DELETE' }), 'Removed.')}>Remove</button>
          </td></tr>))}</tbody></table>}
      {attach && <AttachModal f={attach} onClose={() => setAttach(undefined)} onDone={(n) => { setAttach(undefined); load(); onChanged(`Attached to ${n}.`); }} />}
      {create && <NewFromFile f={create} onClose={() => setCreate(undefined)} onDone={(r) => { setCreate(undefined); load(); onChanged(`${r.number} created from ${create.fileName}${r.read === 'read' ? ' and read — check the values on the contract' : ''}.`); }} />}
    </section>
  );
}

function AttachModal({ f, onClose, onDone }: { f: InboxFile; onClose: () => void; onDone: (number: string) => void }) {
  const [q, setQ] = useState('');
  const [list, setList] = useState<{ id: string; number: string; title: string; status: string }[]>([]);
  const [kind, setKind] = useState('SIGNED');
  const [err, setErr] = useState<string>();
  useEffect(() => { const h = setTimeout(() => api<{ contracts: typeof list }>(`/staff/contracts?q=${encodeURIComponent(q)}&pageSize=20`).then((r) => setList(r.contracts)).catch(() => {}), 250); return () => clearTimeout(h); }, [q]);
  return (
    <Modal title={`Attach ${f.fileName}`} onClose={onClose}>
      {err && <Alert kind="error">{err}</Alert>}
      <div className="field"><label htmlFor="at-q">Find the contract</label><input id="at-q" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Number, title, reference or party" /></div>
      <div className="field"><label htmlFor="at-k">It is</label><select id="at-k" value={kind} onChange={(e) => setKind(e.target.value)}><option value="SIGNED">The signed copy</option><option value="ANNEXURE">An annexure</option><option value="OTHER">Another file</option></select></div>
      <table className="table static compact"><tbody>{list.map((c) => <tr key={c.id}><td className="mono small">{c.number}</td><td className="small">{c.title}</td><td><ContractStatus status={c.status} /></td>
        <td><button className="btn btn-primary btn-sm" onClick={async () => { try { await api(`/staff/contracts/migration/inbox/${f.id}/attach`, { body: { contractId: c.id, kind } }); onDone(c.number); } catch (e: any) { setErr(e.message); } }}>Attach</button></td></tr>)}</tbody></table>
    </Modal>
  );
}

function NewFromFile({ f, onClose, onDone }: { f: InboxFile; onClose: () => void; onDone: (r: { contractId: string; number: string; read: string | null }) => void }) {
  const setup = useContractSetup();
  const [kind, setKind] = useState<'SUPPLIER' | 'CUSTOMER'>('SUPPLIER');
  const [parties, setParties] = useState<{ id: string; name: string; code: string }[]>([]);
  const [form, setForm] = useState({ partyId: '', type: '', title: f.fileName.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ') });
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ parties: typeof parties }>(`/staff/parties/options?kind=${kind}`).then((r) => setParties(r.parties)).catch(() => {}); }, [kind]);
  const direction = kind === 'SUPPLIER' ? 'BUY' : 'SELL';
  const types = (setup?.config.types ?? []).filter((x) => x.on && x.directions.includes(direction));
  return (
    <Modal title="New contract from this file" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !form.partyId || !form.type} onClick={async () => { setBusy(true); try { onDone(await api(`/staff/contracts/migration/inbox/${f.id}/contract`, { body: { ...form, direction } })); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } }}>{busy ? 'Creating and reading…' : 'Create'}</button></>}>
      <p className="muted small">The contract starts as a draft with <b>{f.fileName}</b> as its signed copy. VendorGate reads it for the dates, value and terms; check them on the contract, then mark it as signed.</p>
      {err && <Alert kind="error">{err}</Alert>}
      <div className="field"><label htmlFor="nf-title">Title</label><input id="nf-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></div>
      <div className="field"><label htmlFor="nf-kind">With a</label><select id="nf-kind" value={kind} onChange={(e) => { setKind(e.target.value as typeof kind); setForm({ ...form, partyId: '', type: '' }); }}><option value="SUPPLIER">Supplier</option><option value="CUSTOMER">Customer</option></select></div>
      <div className="field"><label htmlFor="nf-party">Party</label><select id="nf-party" value={form.partyId} onChange={(e) => setForm({ ...form, partyId: e.target.value })}><option value="">Choose…</option>{parties.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}</select></div>
      <div className="field"><label htmlFor="nf-type">Contract type</label><select id="nf-type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="">Choose…</option>{types.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></div>
    </Modal>
  );
}

/** 4. Read every uploaded contract file that hasn't been read (masked before any AI, as on one contract). */
function BulkRead({ unread, onDone }: { unread: number; onDone: (text: string) => void }) {
  const [progress, setProgress] = useState<{ read: number; left: number; failed: { number: string; error: string }[] }>();
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    let read = 0; const failed: { number: string; error: string }[] = [];
    try {
      for (let i = 0; i < 100; i++) {
        const r = await api<{ read: number; failed: { number: string; error: string }[]; remaining: number }>('/staff/contracts/migration/read', { method: 'POST' });
        read += r.read; failed.push(...r.failed); setProgress({ read, left: r.remaining, failed: [...failed] });
        if (!r.remaining || (!r.read && !r.failed.length)) break;
      }
      onDone(`${read} contract${read === 1 ? '' : 's'} read${failed.length ? `, ${failed.length} couldn’t be read` : ''}. Check the values below.`);
    } catch (e: any) { onDone(e.message); } finally { setBusy(false); }
  }
  return (
    <section className="card pad section-card" aria-label="Read the files">
      <h3>4. Read the uploaded contracts</h3>
      <p className="muted small">VendorGate reads each uploaded Word or PDF contract once — dates, value, notice and renewal terms — the same way as “Read the contract”, with names, numbers and amounts masked before any AI. Scans can’t be read.</p>
      <button className="btn btn-secondary" disabled={busy || !unread} onClick={run}>{busy ? `Reading… ${progress ? `${progress.read} done, ${progress.left} left` : ''}` : unread ? `Read ${unread} contract${unread === 1 ? '' : 's'}` : 'Nothing left to read'}</button>
      {progress && progress.failed.length > 0 && <details className="small" style={{ marginTop: 8 }}><summary>{progress.failed.length} couldn’t be read</summary><ul>{progress.failed.map((x, i) => <li key={i}><span className="mono">{x.number}</span> — {x.error}</li>)}</ul></details>}
    </section>
  );
}

/** 5. Values found that the contract doesn't have yet (blanks only on active contracts). */
function Review({ items, onDone }: { items: Status['review']; onDone: (text: string) => void }) {
  return (
    <section className="card pad section-card" aria-label="Review the values found">
      <h3>5. Review the values found {items.length ? `(${items.length})` : ''}</h3>
      <p className="muted small">What reading found that the contract doesn’t have yet. On an active contract only empty details and the renewal terms can be filled in here; anything else changes through an amendment.</p>
      {!items.length ? <p className="small muted">Nothing to review.</p> : <table className="table static compact"><tbody>{items.map((x) => (
        <tr key={x.contractId}><td><Link to={`/staff/contracts/${x.contractId}`} className="mono small">{x.number}</Link><div className="small">{x.title}</div></td>
          <td className="small">{x.fields.map((f) => <div key={f.field}>{f.label}: <b>{show(f.field, f.value)}</b> <span className="muted">(now {show(f.field, f.current)})</span></div>)}</td>
          <td><button className="btn btn-primary btn-sm" onClick={async () => { try { await api(`/staff/contracts/migration/review/${x.contractId}`, { body: { readingId: x.readingId, fields: x.fields.map((f) => f.field) } }); onDone(`${x.number} updated.`); } catch (e: any) { onDone(e.message); } }}>Use these</button></td></tr>))}</tbody></table>}
    </section>
  );
}

function Check({ c }: { c: Status['checks'][string] }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: '1px solid var(--border, #e6e9f0)', padding: '8px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}><span><span className={`badge sm ${c.count ? 'badge-attention' : 'badge-approved'}`} style={{ marginInlineEnd: 8 }}>{c.count ? 'To do' : 'Done'}</span>{c.label}</span><span>{c.count ? <button className="link-btn" onClick={() => setOpen(!open)}>{c.count}</button> : <span className="muted">0</span>}</span></div>
      {open && <table className="table static compact"><tbody>{c.contracts.map((r) => <tr key={r.id}><td><Link to={`/staff/contracts/${r.id}`} className="mono small">{r.number}</Link></td><td className="small">{r.title}</td><td className="small muted">{r.party}</td></tr>)}</tbody></table>}
      {open && c.count > c.contracts.length && <p className="small muted">…and {c.count - c.contracts.length} more.</p>}
    </div>
  );
}
