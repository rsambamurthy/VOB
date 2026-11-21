/**
 * Possible duplicates on an invoice (the configurable duplicate check): what matched, links to those invoices, “Not a
 * duplicate” with a note, and earlier decisions. Forwarding for approval lives here too (both are AP actions on an invoice
 * waiting for a decision).
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { Alert, Modal } from '../../components/ui';
import type { ApDetail } from '../../components/Invoices';

export function DuplicatesCard({ d, base, onDone }: { d: ApDetail; base: string; onDone: (x: ApDetail) => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const dups = d.invoice.checks.filter((c) => c.rule && c.level !== 'ok');
  if (!dups.length && !d.duplicateCleared.length) return null;
  async function clear() {
    setError(undefined);
    try { onDone(await api<ApDetail>(`/staff/invoices/${d.invoice.id}/not-duplicate`, { body: { note } })); setOpen(false); setNote(''); }
    catch (e: any) { setError(e.message); }
  }
  return (
    <section className="card pad section-card" aria-label="Possible duplicates">
      <h3>{dups.length ? 'Possible duplicates' : 'Duplicate check'}</h3>
      {dups.map((c, i) => (
        <div key={i} className={c.level === 'error' ? 'err-text small' : 'warn-text small'} style={{ marginBottom: 6 }}>
          <strong>{c.rule}</strong> {(c.message.includes(' — ') ? c.message.split(' — ').pop()! : c.message).replace(/\s*\([A-Z]\d\)$/, '')}
          {c.refs?.length ? <>: {c.refs.slice(0, 5).map((r, k) => <span key={r.id}>{k ? ', ' : ''}<Link to={`${base}/${r.id}`} className="mono">{r.number}</Link></span>)}{c.refs.length > 5 ? ` and ${c.refs.length - 5} more` : ''}</> : null}
        </div>))}
      {dups.some((c) => c.level === 'error') && <p className="small muted">Blocked rules can’t be cleared: cancel this invoice, or ask your administrator whether the rule should only warn.</p>}
      {d.can.clearDuplicate && <button className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>Not a duplicate…</button>}
      {d.duplicateCleared.length > 0 && <ul className="small muted" style={{ marginTop: 10 }}>{d.duplicateCleared.map((c, i) => <li key={i}>Not a duplicate of <Link to={`${base}/${c.invoiceId}`} className="mono">{c.number}</Link> ({c.rule}) — {c.by}, {fmtDateTime(c.at)}: “{c.note}”</li>)}</ul>}
      {open && (
        <Modal title="Not a duplicate" onClose={() => setOpen(false)} footer={<><button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" disabled={!note.trim()} onClick={clear}>Confirm</button></>}>
          {error && <Alert kind="error">{error}</Alert>}
          <p className="small">The invoices it matched are recorded as checked, with your note, and won’t be raised again for this invoice.</p>
          <div className="field"><label htmlFor="nd-note">Why it isn’t a duplicate</label><textarea id="nd-note" rows={3} value={note} placeholder="e.g. A second delivery on the same order" onChange={(e) => setNote(e.target.value)} /></div>
        </Modal>
      )}
    </section>
  );
}

interface Options { users: { id: string; name: string; email: string }[]; roles: { id: string; name: string; key: string }[] }
export function ForwardModal({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: (x: ApDetail) => void }) {
  const [opts, setOpts] = useState<Options>();
  const [to, setTo] = useState<'user' | 'role'>('user');
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<Options>('/staff/invoices/forward-options').then(setOpts).catch((e) => setError(e.message)); }, []);
  async function send() {
    setBusy(true); setError(undefined);
    try { onDone(await api<ApDetail>(`/staff/invoices/${id}/forward`, { body: { [to === 'user' ? 'userId' : 'roleId']: target, note } })); onClose(); }
    catch (e: any) { setError(e.message); setBusy(false); }
  }
  return (
    <Modal title="Forward for approval" onClose={onClose} footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !target || !note.trim()} onClick={send}>Forward</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <p className="small muted" style={{ marginTop: 0 }}>Ask someone else — Procurement, the department that asked for it, the buyer — to approve first. When they approve it comes back to where it was; if they reject it, the invoice is rejected.</p>
      <div className="field"><label>Forward to</label>
        <label className="radio" style={{ marginInlineEnd: 16 }}><input type="radio" checked={to === 'user'} onChange={() => { setTo('user'); setTarget(''); }} /> A person</label>
        <label className="radio"><input type="radio" checked={to === 'role'} onChange={() => { setTo('role'); setTarget(''); }} /> Everyone with a role</label></div>
      <div className="field"><label htmlFor="fw-to">{to === 'user' ? 'Person' : 'Role'}</label>
        <select id="fw-to" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Choose…</option>
          {to === 'user' ? opts?.users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>) : opts?.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
      <div className="field"><label htmlFor="fw-note">What they should look at</label><textarea id="fw-note" rows={3} value={note} placeholder="e.g. Was the extra quantity on PO 4512 agreed?" onChange={(e) => setNote(e.target.value)} /></div>
    </Modal>
  );
}
