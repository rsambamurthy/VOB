import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Modal } from './ui';

interface Access {
  mainContact: { name: string; email: string };
  codes: { id: string; code: string }[];
  contacts: { id: string; name: string; email: string; active: boolean }[];
  orders: number; signInUrl: string;
}

/** Vendor sidebar card: who at the supplier can sign in, and which ERP supplier codes are theirs. */
export function SupplierAccessCard({ vendorId, canManage, onFlash }: { vendorId: string; canManage: boolean; onFlash: (f: { kind: 'success' | 'error'; text: string }) => void }) {
  const [d, setD] = useState<Access>();
  const [adding, setAdding] = useState<'code' | 'contact'>();
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => api<Access>(`/purchasing/vendors/${vendorId}/access`).then(setD).catch(() => {}), [vendorId]);
  useEffect(() => { load(); }, [load]);
  if (!d) return null;
  const url = `${window.location.origin}${d.signInUrl}`;
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); onFlash({ kind: 'success', text: ok }); load(); } catch (e: any) { onFlash({ kind: 'error', text: e.message }); } };

  return (
    <div className="card pad">
      <h3 className="card-title">Supplier portal</h3>
      <div className="sub-head">ERP supplier codes</div>
      {d.codes.length ? <ul className="chip-list">{d.codes.map((c) => <li key={c.id} className="chip"><span className="mono">{c.code}</span>
        {canManage && <button className="chip-x" aria-label={`Remove ${c.code}`} title="Remove" onClick={() => run(() => api(`/purchasing/vendors/${vendorId}/codes/${c.id}`, { method: 'DELETE' }), `Removed ${c.code}. New orders for it won’t be linked to this vendor.`)}>✕</button>}</li>)}</ul>
        : <p className="muted small">None yet. The vendor code is used when the ERP sends no other code.</p>}
      {canManage && <button className="link-btn small" onClick={() => setAdding('code')}>+ Add ERP supplier code</button>}

      <div className="sub-head">Who can sign in</div>
      <ul className="plain-list small">
        <li><strong>{d.mainContact.name || d.mainContact.email}</strong> <span className="muted">· main contact</span><div className="muted">{d.mainContact.email}</div></li>
        {d.contacts.map((c) => <li key={c.id} className={c.active ? '' : 'muted'}><strong>{c.name}</strong>{!c.active && <span className="badge badge-invited sm">access removed</span>}<div className="muted">{c.email}</div>
          {canManage && <button className="link-btn small" onClick={() => run(() => api(`/purchasing/vendors/${vendorId}/contacts/${c.id}`, { method: 'PATCH', body: { active: !c.active } }), c.active ? `${c.name} can no longer sign in.` : `${c.name} can sign in again.`)}>{c.active ? 'Remove access' : 'Restore access'}</button>}</li>)}
      </ul>
      {canManage && <button className="link-btn small" onClick={() => setAdding('contact')}>+ Add a person</button>}

      <div className="sub-head">Sign-in link</div>
      <div className="key-row"><span className="icode small break">{url}</span><button className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(url).then(() => setCopied(true)).catch(() => {})}>{copied ? 'Copied' : 'Copy'}</button></div>
      {d.orders > 0 && <p className="small"><Link to={`/staff/orders?vendor=${vendorId}&f=ALL`}>{d.orders} purchase order{d.orders === 1 ? '' : 's'}</Link></p>}
      {adding && <AddModal kind={adding} onClose={() => setAdding(undefined)} onSave={async (v) => {
        try {
          if (adding === 'code') { const r = await api<{ attached: number }>(`/purchasing/vendors/${vendorId}/codes`, { body: { code: v.code } }); onFlash({ kind: 'success', text: `Added ${v.code}.${r.attached ? ` ${r.attached} waiting order${r.attached === 1 ? ' was' : 's were'} linked to this vendor.` : ''}` }); }
          else { await api(`/purchasing/vendors/${vendorId}/contacts`, { body: { name: v.name, email: v.email } }); onFlash({ kind: 'success', text: `${v.name} can now sign in at the supplier portal with ${v.email}.` }); }
          setAdding(undefined); load(); return undefined;
        } catch (e: any) { return e.message as string; }
      }} />}
    </div>
  );
}

function AddModal({ kind, onClose, onSave }: { kind: 'code' | 'contact'; onClose: () => void; onSave: (v: { code: string; name: string; email: string }) => Promise<string | undefined> }) {
  const [v, setV] = useState({ code: '', name: '', email: '' });
  const [err, setErr] = useState<string>();
  const ok = kind === 'code' ? v.code.trim() : v.name.trim().length >= 2 && v.email.includes('@');
  return (
    <Modal title={kind === 'code' ? 'Add ERP supplier code' : 'Give a person access'} onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!ok} onClick={async () => setErr(await onSave(v))}>Add</button></>}>
      {err && <div className="alert alert-error">{err}</div>}
      {kind === 'code' ? (
        <div className="field"><label htmlFor="sa-code">Supplier code in the ERP</label><input id="sa-code" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} placeholder="e.g. Oracle supplier number 10452" />
          <p className="field-help">Orders the ERP sends with this supplier code are shown to this vendor. Orders already waiting under it are linked straight away.</p></div>
      ) : (
        <>
          <div className="field"><label htmlFor="sa-name">Name</label><input id="sa-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></div>
          <div className="field"><label htmlFor="sa-email">Work email</label><input id="sa-email" type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
            <p className="field-help">They sign in with this email and a one-time code. They see this vendor’s purchase orders and company details, and get new-order emails.</p></div>
        </>
      )}
    </Modal>
  );
}
