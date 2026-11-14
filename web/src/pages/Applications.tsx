import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Alert, Empty, Modal } from '../components/ui';
import { TabStrip } from '../components/TabStrip';
import { fmtDateTime } from '../lib/format';
import { VENDOR_TYPES } from '../lib/meta';
import { useSession } from '../lib/session';

type VT = 'DOMESTIC' | 'IMPORT' | 'GOVERNMENT';
type Status = 'PENDING' | 'ACCEPTED' | 'DECLINED';
interface Application {
  id: string; status: Status; companyName: string; vendorType: VT; contactFirstName: string; contactLastName: string; email: string; mobile: string;
  registrationId: string | null; registrationLabel: string; website: string | null; supplies: string | null; message: string | null; linkName: string;
  createdAt: string; verifiedAt: string | null; decidedAt: string | null; decidedByName: string | null; declineReason: string | null; vendorId: string | null;
  hints: { kind: 'vendor' | 'application'; text: string; vendorId?: string }[];
}
interface RegLink { id: string; slug: string; url: string; name: string; vendorType: VT | null; intro: string | null; notifyEmails: string | null; active: boolean; createdByName: string; createdAt: string; applications: number; pending: number; accepted: number }
const typeLabel = (v: string | null) => VENDOR_TYPES.find((x) => x.value === v)?.label ?? 'Supplier chooses';

/** Vendors → Applications: suppliers who applied through a "Become a supplier" link, and the links themselves. */
export function Applications() {
  const { can } = useSession();
  const [tab, setTab] = useState<Status | 'links'>('PENDING');
  const [rows, setRows] = useState<Application[]>();
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string; vendorId?: string }>();
  const [accepting, setAccepting] = useState<Application>();
  const [declining, setDeclining] = useState<Application>();
  const load = useCallback(() => { if (tab !== 'links') { setRows(undefined); api<Application[]>(`/staff/applications?status=${tab}`).then(setRows).catch((e) => setMsg({ kind: 'error', text: e.message })); } }, [tab]);
  useEffect(() => { load(); }, [load]);
  const tabs: { key: Status | 'links'; label: string }[] = [{ key: 'PENDING', label: 'To review' }, { key: 'ACCEPTED', label: 'Accepted' }, { key: 'DECLINED', label: 'Declined' }, ...(can('config.manage') ? [{ key: 'links' as const, label: 'Registration links' }] : [])];
  return (
    <div className="page">
      <header className="page-head"><div><h1>Applications</h1><p className="muted">Suppliers who applied through a “Become a supplier” link. Accept to invite them to complete registration, or decline.</p></div></header>
      {msg && <Alert kind={msg.kind}>{msg.text} {msg.vendorId && <Link to={`/staff/vendors/${msg.vendorId}`}>Open supplier</Link>}</Alert>}
      <div className="card">
        <TabStrip>{tabs.map((x) => <button key={x.key} role="tab" aria-selected={tab === x.key} className={tab === x.key ? 'active' : ''} onClick={() => { setTab(x.key); setMsg(undefined); }}>{x.label}</button>)}</TabStrip>
        {tab === 'links' ? <Links onMsg={setMsg} /> : !rows ? <div className="pad"><div className="spinner" /></div> : !rows.length
          ? <Empty>{tab === 'PENDING' ? (can('config.manage') ? <>No applications waiting. Share a link from <button className="link-btn" onClick={() => setTab('links')}>Registration links</button>.</> : 'No applications waiting.') : 'None yet.'}</Empty>
          : <div className="pad stack">{rows.map((a) => <ApplicationCard key={a.id} a={a} onAccept={() => setAccepting(a)} onDecline={() => setDeclining(a)} />)}</div>}
      </div>
      {accepting && <AcceptModal a={accepting} onClose={() => setAccepting(undefined)} onDone={(v) => { setAccepting(undefined); setMsg({ kind: 'success', text: `${v.name} (${v.code}) created and invited to complete registration.`, vendorId: v.id }); load(); }} />}
      {declining && <DeclineModal a={declining} onClose={() => setDeclining(undefined)} onDone={() => { setDeclining(undefined); setMsg({ kind: 'success', text: `Application from ${declining.companyName} declined.` }); load(); }} />}
    </div>
  );
}

function ApplicationCard({ a, onAccept, onDecline }: { a: Application; onAccept: () => void; onDecline: () => void }) {
  return (
    <div className="application-card">
      <div className="row-between">
        <div><strong>{a.companyName}</strong> <span className="muted small">· {typeLabel(a.vendorType)} · via “{a.linkName}” · {fmtDateTime(a.verifiedAt ?? a.createdAt)}</span></div>
        {a.status === 'PENDING' && <div className="btn-row"><button className="btn btn-danger-ghost btn-sm" onClick={onDecline}>Decline…</button><button className="btn btn-primary btn-sm" onClick={onAccept}>Accept…</button></div>}
        {a.status === 'ACCEPTED' && a.vendorId && <Link className="btn btn-secondary btn-sm" to={`/staff/vendors/${a.vendorId}`}>Open supplier</Link>}
      </div>
      <dl className="kv small app-kv">
        <dt>Contact</dt><dd>{a.contactFirstName} {a.contactLastName} · <span className="ltr">{a.email}</span> · <span className="ltr">{a.mobile}</span> <span className="ok-text" title="Email confirmed with a code">✓ email confirmed</span></dd>
        {a.registrationId && <><dt>{a.registrationLabel}</dt><dd className="mono">{a.registrationId}</dd></>}
        {a.website && <><dt>Website</dt><dd>{a.website}</dd></>}
        {a.supplies && <><dt>Supplies</dt><dd>{a.supplies}</dd></>}
        {a.message && <><dt>Message</dt><dd>“{a.message}”</dd></>}
        {a.status !== 'PENDING' && <><dt>Decided</dt><dd>{a.status === 'ACCEPTED' ? 'Accepted' : 'Declined'} by {a.decidedByName} · {fmtDateTime(a.decidedAt)}{a.declineReason ? ` — “${a.declineReason}”` : ''}</dd></>}
      </dl>
      {a.hints.length > 0 && (
        <Alert kind="warning"><strong>Check before accepting:</strong>
          <ul className="plain">{a.hints.map((h, i) => <li key={i}>{h.vendorId ? <Link to={`/staff/vendors/${h.vendorId}`}>{h.text}</Link> : h.text}</li>)}</ul></Alert>
      )}
    </div>
  );
}

function AcceptModal({ a, onClose, onDone }: { a: Application; onClose: () => void; onDone: (v: { id: string; code: string; name: string }) => void }) {
  const [name, setName] = useState(a.companyName);
  const [vendorType, setVendorType] = useState<VT>(a.vendorType);
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true); setErr(undefined);
    try { onDone((await api<{ vendor: { id: string; code: string; name: string } }>(`/staff/applications/${a.id}/accept`, { body: { name, vendorType } })).vendor); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={`Accept ${a.companyName}`} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || name.trim().length < 2} onClick={go}>{busy ? 'Creating…' : 'Accept and invite'}</button></>}>
      {err && <Alert kind="error">{err}</Alert>}
      <p className="small muted">The supplier is created with what they gave{a.registrationId ? ` (${a.registrationLabel}, website, what they supply)` : ''} and emailed a link to complete registration. Then it follows your normal onboarding and approval.</p>
      <div className="field"><label htmlFor="acc-name">Supplier name</label><input id="acc-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} /></div>
      <div className="field"><label htmlFor="acc-type">Vendor type</label><select id="acc-type" value={vendorType} onChange={(e) => setVendorType(e.target.value as VT)}>{VENDOR_TYPES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}</select></div>
    </Modal>
  );
}

function DeclineModal({ a, onClose, onDone }: { a: Application; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);
  const [err, setErr] = useState<string>();
  async function go() {
    try { await api(`/staff/applications/${a.id}/decline`, { body: { reason, notify } }); onDone(); } catch (e: any) { setErr(e.message); }
  }
  return (
    <Modal title={`Decline ${a.companyName}`} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-danger" onClick={go}>Decline</button></>}>
      {err && <Alert kind="error">{err}</Alert>}
      <div className="field"><label htmlFor="dec-reason">Reason</label><textarea id="dec-reason" rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. We already have enough suppliers for this category" />
        <div className="field-help">Kept with the application{notify ? ' and included in the email' : ''}.</div></div>
      <label className="check-item"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /><span>Email {a.contactFirstName} that the application was declined</span></label>
    </Modal>
  );
}

/* ---------- Registration links ---------- */

const blankLink = { name: '', vendorType: '' as VT | '', intro: '', notifyEmails: '' };

function Links({ onMsg }: { onMsg: (m: { kind: 'success' | 'error'; text: string }) => void }) {
  const [links, setLinks] = useState<RegLink[]>();
  const [edit, setEdit] = useState<(typeof blankLink & { id?: string }) | null>(null);
  const [qr, setQr] = useState<RegLink>();
  const load = () => api<RegLink[]>('/staff/registration-links').then(setLinks).catch((e) => onMsg({ kind: 'error', text: e.message }));
  useEffect(() => { load(); }, []);
  async function save() {
    if (!edit) return;
    const body = { name: edit.name, vendorType: edit.vendorType || null, intro: edit.intro || null, notifyEmails: edit.notifyEmails || null };
    try { await api(edit.id ? `/staff/registration-links/${edit.id}` : '/staff/registration-links', { method: edit.id ? 'PUT' : 'POST', body }); setEdit(null); onMsg({ kind: 'success', text: 'Saved.' }); load(); }
    catch (e: any) { onMsg({ kind: 'error', text: e.message }); }
  }
  async function toggle(l: RegLink) {
    try { await api(`/staff/registration-links/${l.id}`, { method: 'PUT', body: { active: !l.active } }); onMsg({ kind: 'success', text: l.active ? `“${l.name}” turned off — the page now says it is closed.` : `“${l.name}” is open again.` }); load(); }
    catch (e: any) { onMsg({ kind: 'error', text: e.message }); }
  }
  const copy = (l: RegLink) => { navigator.clipboard?.writeText(l.url).then(() => onMsg({ kind: 'success', text: `Link copied: ${l.url}` })).catch(() => {}); };
  return (
    <div className="pad stack">
      <div className="row-between"><p className="muted small">Put a link on your website, in an email signature or on a QR code at a trade fair. Each link shows where applications came from.</p>
        <button className="btn btn-primary btn-sm" onClick={() => setEdit({ ...blankLink })}>New link</button></div>
      {!links ? <div className="spinner" /> : !links.length ? <Empty>No links yet.</Empty> : (
        <table className="table static">
          <thead><tr><th>Link</th><th>Vendor type</th><th>Applications</th><th /></tr></thead>
          <tbody>{links.map((l) => (
            <tr key={l.id} className={l.active ? '' : 'muted'}>
              <td><div className="strong">{l.name} {!l.active && <span className="badge sm">Off</span>}</div><div className="small mono ltr">{l.url}</div></td>
              <td className="small">{typeLabel(l.vendorType)}</td>
              <td className="small">{l.applications} · {l.accepted} accepted{l.pending ? <div className="diff-text">{l.pending} to review</div> : null}</td>
              <td className="actions small"><button className="link-btn small" onClick={() => copy(l)}>Copy link</button> · <button className="link-btn small" onClick={() => setQr(l)}>QR code</button> · <a href={l.url} target="_blank" rel="noreferrer">Open</a> · <button className="link-btn small" onClick={() => setEdit({ id: l.id, name: l.name, vendorType: l.vendorType ?? '', intro: l.intro ?? '', notifyEmails: l.notifyEmails ?? '' })}>Edit</button> · <button className={`link-btn small${l.active ? ' danger' : ''}`} onClick={() => toggle(l)}>{l.active ? 'Turn off' : 'Turn on'}</button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {edit && (
        <Modal title={edit.id ? 'Edit link' : 'New registration link'} onClose={() => setEdit(null)} footer={<><button className="btn btn-ghost" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" disabled={edit.name.trim().length < 2} onClick={save}>Save</button></>}>
          <div className="field"><label htmlFor="ln-name">Name (for you)</label><input id="ln-name" value={edit.name} maxLength={100} placeholder="e.g. Website, Trade fair Mumbai" onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus /></div>
          <div className="field"><label htmlFor="ln-type">Vendor type</label><select id="ln-type" value={edit.vendorType} onChange={(e) => setEdit({ ...edit, vendorType: e.target.value as VT | '' })}><option value="">Supplier chooses</option>{VENDOR_TYPES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}</select></div>
          <div className="field"><label htmlFor="ln-intro">Message on the page (optional)</label><textarea id="ln-intro" rows={2} maxLength={1000} value={edit.intro} onChange={(e) => setEdit({ ...edit, intro: e.target.value })} placeholder="e.g. Thanks for visiting our stand at the trade fair." /></div>
          <div className="field"><label htmlFor="ln-notify">Email new applications to (optional)</label><input id="ln-notify" value={edit.notifyEmails} maxLength={500} placeholder="name@company.com, other@company.com" onChange={(e) => setEdit({ ...edit, notifyEmails: e.target.value })} />
            <div className="field-help">Leave empty to tell everyone who can invite suppliers.</div></div>
        </Modal>
      )}
      {qr && (
        <Modal title={`QR code: ${qr.name}`} onClose={() => setQr(undefined)} footer={<><a className="btn btn-ghost" href={`/api/staff/registration-links/${qr.id}/qr?format=svg`}>Download SVG (for print)</a><a className="btn btn-primary" href={`/api/staff/registration-links/${qr.id}/qr?download=1`}>Download PNG</a></>}>
          <div className="qr-box"><img src={`/api/staff/registration-links/${qr.id}/qr`} alt={`QR code for ${qr.url}`} width={260} height={260} /><div className="small mono ltr">{qr.url}</div></div>
        </Modal>
      )}
    </div>
  );
}
