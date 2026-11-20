/** Staff side of review and signature: send a version to the other party, their comments and proposals, our replies; e-signature. */
import { useState } from 'react';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { Modal } from '../../components/ui';

type Notify = (d: any, text?: string, kind?: 'success' | 'warning' | 'error') => void;
interface Comment { id: string; clauseGroup: string | null; side: 'US' | 'PARTY'; authorName: string; text: string; proposedText: string | null; internal: boolean; status: string; fileId: string | null; createdAt: string }
export interface Negotiation {
  on: boolean; portal: boolean;
  versions: { id: string; number: number; status: string; note: string | null; sentByName: string; sentAt: string; response: string | null; respondedByName: string | null; respondedAt: string | null }[];
  comments: Comment[];
  reviewers: { name: string; email: string; lastSeenAt: string | null }[];
  contacts: { name: string; email: string; signatory: boolean }[];
}
export interface Signing {
  provider: { key: string; label: string; kind: string; methods: string[] } | null;
  request: { id: string; provider: string; kind: string; status: string; error: string | null; sentAt: string; sentByName: string; completedAt: string | null; lastCheckedAt: string | null; signers: { name: string; email: string; side: string; order: number; status: string; signedAt: string | null; method: string | null }[] } | null;
  myTurn: boolean;
  suggested: { name: string; email: string; side: 'US' | 'PARTY' }[];
}
const VSTATUS: Record<string, [string, string]> = { OPEN: ['Waiting for them', 'badge-under_review'], ACCEPTED: ['Accepted', 'badge-approved'], CHANGES_REQUESTED: ['Changes asked for', 'flag-medium'], WITHDRAWN: ['Withdrawn', ''], SUPERSEDED: ['Replaced', ''] };
const SSTATUS: Record<string, string> = { SIGNED: 'badge-approved', DECLINED: 'badge-rejected', SENT: 'badge-under_review', WAITING: '' };
const SLABEL: Record<string, string> = { SIGNED: 'Signed', DECLINED: 'Declined', SENT: 'To sign now', WAITING: 'Waiting' };

async function call(id: string, path: string, body: unknown, onDetail: Notify, ok: string, method = 'POST') {
  try { onDetail(await api(`/staff/contracts/${id}/${path}`, { method, body }), ok); return true; } catch (e: any) { onDetail(undefined, e.message, 'error'); return false; }
}

export function NegotiationCard({ contractId, status, partyName, clauses, n, manage, canShare, onDetail }: {
  contractId: string; status: string; partyName: string; clauses: { group: string; title: string }[]; n: Negotiation; manage: boolean; canShare: boolean; onDetail: Notify;
}) {
  const [sharing, setSharing] = useState(false);
  const [reply, setReply] = useState({ text: '', internal: false });
  if (!n.on || (!n.versions.length && !canShare)) return null;
  const title = (g: string | null) => (g ? clauses.find((c) => c.group === g)?.title ?? g : null);
  const current = n.versions[0];
  return (
    <section className="card pad section-card" aria-label="Review by the other party">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'start' }}>
        <div><h3 style={{ marginBottom: 2 }}>Review by {partyName}</h3>
          <p className="muted small" style={{ marginTop: 0 }}>{n.portal ? 'They see it in their supplier portal and by email link.' : 'They open it from an email link with a one-time code.'}{n.reviewers.length ? ` Shared with ${n.reviewers.map((r) => r.name).join(', ')}.` : ''}</p></div>
        {manage && canShare && <button className="btn btn-primary btn-sm" onClick={() => setSharing(true)}>{n.versions.length ? 'Send the new version' : `Send to ${partyName} for review`}</button>}
      </div>
      {n.versions.length > 0 && <table className="table static compact"><thead><tr><th>Version</th><th>Sent</th><th>Their answer</th></tr></thead>
        <tbody>{n.versions.map((v) => <tr key={v.id}><td>v{v.number}{v.note && <div className="muted small">{v.note}</div>}</td><td className="small">{v.sentByName} · {fmtDateTime(v.sentAt)}</td>
          <td><span className={`badge sm ${VSTATUS[v.status]?.[1] ?? ''}`}>{VSTATUS[v.status]?.[0] ?? v.status}</span>{v.respondedByName && <div className="muted small">{v.respondedByName}{v.response ? ` — ${v.response}` : ''}</div>}</td></tr>)}</tbody></table>}
      {n.comments.length > 0 && <>
        <h4 style={{ margin: '14px 0 6px' }}>Comments</h4>
        {n.comments.map((k) => (
          <div key={k.id} className="card pad" style={{ margin: '6px 0', background: k.internal ? '#fff8e6' : k.side === 'PARTY' ? 'var(--surface-2, #f7f8fb)' : undefined }}>
            <div className="small"><b>{k.side === 'PARTY' ? k.authorName : `${k.authorName} (us)`}</b> · <span className="muted">{fmtDateTime(k.createdAt)}</span>{title(k.clauseGroup) && <> · on <b>{title(k.clauseGroup)}</b></>}
              {k.internal && <span className="badge sm" style={{ marginInlineStart: 6 }}>Internal note</span>}
              {k.status !== 'OPEN' && <span className={`badge sm ${k.status === 'ACCEPTED' ? 'badge-approved' : k.status === 'DECLINED' ? 'badge-rejected' : ''}`} style={{ marginInlineStart: 6 }}>{k.status[0] + k.status.slice(1).toLowerCase()}</span>}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{k.text}</div>
            {k.proposedText && <div className="small" style={{ marginTop: 6, borderInlineStart: '3px solid var(--accent, #3b5bdb)', paddingInlineStart: 8 }}><b>Proposed wording:</b> {k.proposedText}</div>}
            {k.fileId && <a className="small" href={`/api/staff/contracts/files/${k.fileId}`} target="_blank" rel="noreferrer">Their marked-up copy</a>}
            {manage && k.side === 'PARTY' && k.status === 'OPEN' && <div className="btn-row" style={{ justifyContent: 'flex-start' }}>
              {k.proposedText && <button className="btn btn-primary btn-sm" onClick={() => confirm('Take their wording into the draft? The contract goes back to draft: make the document again (and get approval again, if needed) before sending it back.') && call(contractId, `comments/${k.id}`, { status: 'ACCEPTED' }, onDetail, 'Their wording is in the draft. Make the document again, then send the new version.', 'PUT')}>Accept their wording</button>}
              {k.proposedText && <button className="btn btn-secondary btn-sm" onClick={() => call(contractId, `comments/${k.id}`, { status: 'DECLINED' }, onDetail, 'Declined.', 'PUT')}>Decline</button>}
              <button className="btn btn-secondary btn-sm" onClick={() => call(contractId, `comments/${k.id}`, { status: 'RESOLVED' }, onDetail, 'Marked as resolved.', 'PUT')}>Resolved</button>
            </div>}
          </div>))}
      </>}
      {manage && ['WITH_PARTY', 'AGREED', 'DRAFT', 'APPROVED'].includes(status) && n.versions.length > 0 && <div style={{ marginTop: 10 }}>
        <div className="field"><label htmlFor="ng-reply">{status === 'WITH_PARTY' || status === 'AGREED' ? 'Reply or note' : 'Internal note'}</label><textarea id="ng-reply" rows={2} value={reply.text} onChange={(e) => setReply({ ...reply, text: e.target.value })} /></div>
        {(status === 'WITH_PARTY' || status === 'AGREED') && <label className="check-item"><input type="checkbox" checked={reply.internal} onChange={(e) => setReply({ ...reply, internal: e.target.checked })} /> <span>Internal note (not shown to {partyName})</span></label>}
        <div className="btn-row"><button className="btn btn-secondary btn-sm" disabled={reply.text.trim().length < 2} onClick={() => call(contractId, 'comments', reply, onDetail, reply.internal || !['WITH_PARTY', 'AGREED'].includes(status) ? 'Note added.' : `Sent to ${partyName}.`).then((ok) => ok && setReply({ text: '', internal: false }))}>Add</button></div>
      </div>}
      {current?.status === 'CHANGES_REQUESTED' && manage && <p className="small muted">They asked for changes. Accept proposed wording above, or reopen the contract as a draft to change it, then send the new version.</p>}
      {sharing && <ShareModal contractId={contractId} partyName={partyName} contacts={n.contacts} onClose={() => setSharing(false)} onDetail={(d, t, k) => { onDetail(d, t, k); if (d) setSharing(false); }} />}
    </section>
  );
}

function PeoplePicker({ people, onChange, contacts }: { people: { name: string; email: string }[]; onChange: (p: { name: string; email: string }[]) => void; contacts: { name: string; email: string }[] }) {
  return <>
    {contacts.length > 0 && <div className="field"><label>Their contacts</label>{contacts.map((c) => (
      <label key={c.email} className="check-item" style={{ display: 'block' }}><input type="checkbox" checked={people.some((p) => p.email === c.email)} onChange={(e) => onChange(e.target.checked ? [...people, c] : people.filter((p) => p.email !== c.email))} /> <span>{c.name} · {c.email}</span></label>))}</div>}
    {people.filter((p) => !contacts.some((c) => c.email === p.email)).map((p, i) => <div key={i} className="field-grid">
      <div className="field"><label>Name</label><input value={p.name} onChange={(e) => onChange(people.map((x) => (x === p ? { ...x, name: e.target.value } : x)))} /></div>
      <div className="field"><label>Email</label><input type="email" value={p.email} onChange={(e) => onChange(people.map((x) => (x === p ? { ...x, email: e.target.value } : x)))} /></div></div>)}
    <button className="link-btn small" onClick={() => onChange([...people, { name: '', email: '' }])}>+ Someone else</button>
  </>;
}

function ShareModal({ contractId, partyName, contacts, onClose, onDetail }: { contractId: string; partyName: string; contacts: { name: string; email: string }[]; onClose: () => void; onDetail: Notify }) {
  const [people, setPeople] = useState(contacts.slice(0, 1));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Send to ${partyName} for review`} onClose={onClose} footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !people.length} onClick={async () => { setBusy(true); await call(contractId, 'share', { people: people.filter((p) => p.email), note: note || undefined }, onDetail, `Sent to ${people.map((p) => p.name).join(', ')}.`); setBusy(false); }}>Send</button></>}>
      <p className="muted small" style={{ marginTop: 0 }}>Each person gets an email with a link; they sign in with a one-time code, read the document, comment on clauses, propose wording, and accept or ask for changes.</p>
      <PeoplePicker people={people} onChange={setPeople} contacts={contacts} />
      <div className="field"><label htmlFor="sh-note">Message (optional)</label><textarea id="sh-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></div>
    </Modal>
  );
}

export function SigningCard({ contractId, status, partyName, s, contacts, me, manage, canSend, onDetail }: {
  contractId: string; status: string; partyName: string; s: Signing; contacts: { name: string; email: string; signatory: boolean }[]; me: { name: string; email: string }; manage: boolean; canSend: boolean; onDetail: Notify;
}) {
  const [sending, setSending] = useState(false);
  const [cancel, setCancel] = useState(false);
  const r = s.request;
  if (!s.provider && !r) return canSend && manage ? <section className="card pad section-card"><h3>Signature</h3><p className="muted small">E-signature isn’t set up. An administrator can choose a provider in Administration → Contracts — or sign on paper, upload the signed copy and mark it as signed.</p></section> : null;
  if (!r && !canSend) return null;
  return (
    <section className="card pad section-card" aria-label="Signature">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div><h3 style={{ marginBottom: 2 }}>Signature</h3><p className="muted small" style={{ marginTop: 0 }}>{r ? `${r.provider} · sent by ${r.sentByName}, ${fmtDateTime(r.sentAt)}` : `${s.provider!.label} · ${s.provider!.methods.join(', ')}`}</p></div>
        {manage && canSend && <button className="btn btn-primary btn-sm" onClick={() => setSending(true)}>Send for signature</button>}
      </div>
      {r && <>
        {r.status !== 'SENT' && <p><span className={`badge sm ${r.status === 'COMPLETED' ? 'badge-approved' : 'badge-rejected'}`}>{{ COMPLETED: 'Signed by everyone', DECLINED: 'Declined', CANCELLED: 'Cancelled', EXPIRED: 'Expired', FAILED: 'Couldn’t be sent' }[r.status] ?? r.status}</span>{r.completedAt && <span className="muted small"> {fmtDateTime(r.completedAt)}</span>}</p>}
        {r.error && <p className="small" style={{ color: '#9a2a2a' }}>{r.error}</p>}
        <ol className="plain-list">{r.signers.map((x) => <li key={x.email}>{x.name} <span className="muted small">{x.email} · {x.side === 'PARTY' ? partyName : 'us'}</span> — <span className={`badge sm ${SSTATUS[x.status] ?? ''}`}>{SLABEL[x.status] ?? x.status}</span>{x.signedAt && <span className="muted small"> {fmtDateTime(x.signedAt)}{x.method ? ` · ${x.method}` : ''}</span>}</li>)}</ol>
        {r.status === 'SENT' && <div className="btn-row" style={{ justifyContent: 'flex-start' }}>
          {s.myTurn && <button className="btn btn-primary" onClick={async () => { try { window.location.href = (await api<{ url: string }>(`/staff/contracts/${contractId}/signature/start`, { method: 'POST' })).url; } catch (e: any) { onDetail(undefined, e.message, 'error'); } }}>Sign{r.provider.startsWith('Test') ? '' : ` with ${r.provider}`}</button>}
          {manage && r.kind === 'email' && <button className="btn btn-secondary btn-sm" onClick={() => call(contractId, 'signature/refresh', {}, onDetail, 'Status updated.')}>Check status now</button>}
          {manage && <button className="btn btn-secondary btn-sm" onClick={() => setCancel(true)}>Cancel the request</button>}
        </div>}
        {r.status === 'SENT' && r.kind === 'email' && <p className="muted small">{r.provider} emails each signer in turn. VendorGate hears back automatically{r.lastCheckedAt ? ` (last checked ${fmtDateTime(r.lastCheckedAt)})` : ''}.</p>}
      </>}
      {sending && <SendModal contractId={contractId} provider={s.provider!} partyName={partyName} initial={[...contacts.filter((c) => c.signatory).map((c) => ({ ...c, side: 'PARTY' as const })), { name: me.name, email: me.email, side: 'US' as const }]} onClose={() => setSending(false)} onDetail={(d, t, k) => { onDetail(d, t, k); if (d) setSending(false); }} />}
      {cancel && <CancelModal onClose={() => setCancel(false)} onSave={(reason) => call(contractId, 'signature/cancel', { reason }, onDetail, 'Signature request cancelled.').then((ok) => ok && setCancel(false))} />}
    </section>
  );
}

function SendModal({ contractId, provider, partyName, initial, onClose, onDetail }: { contractId: string; provider: NonNullable<Signing['provider']>; partyName: string; initial: { name: string; email: string; side: 'US' | 'PARTY' }[]; onClose: () => void; onDetail: Notify }) {
  const [signers, setSigners] = useState(initial);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (i: number, patch: Partial<(typeof signers)[number]>) => setSigners(signers.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Modal title="Send for signature" wide onClose={onClose} footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={async () => { setBusy(true); await call(contractId, 'signature', { signers, message: message || undefined }, onDetail, provider.kind === 'email' ? `Sent through ${provider.label}.` : 'Out for signature — the first signer has been emailed.'); setBusy(false); }}>Send</button></>}>
      <p className="muted small" style={{ marginTop: 0 }}>{provider.label}: {provider.kind === 'email' ? `${provider.label} emails each signer in turn.` : 'each signer signs from VendorGate in turn.'} {partyName} signs first, then us. The PDF of the current version is sent.</p>
      {signers.map((x, i) => (
        <div key={i} className="field-grid" style={{ gridTemplateColumns: '1fr 1.4fr 1fr auto', alignItems: 'end' }}>
          <div className="field"><label htmlFor={`sg-n-${i}`}>Name</label><input id={`sg-n-${i}`} value={x.name} onChange={(e) => set(i, { name: e.target.value })} /></div>
          <div className="field"><label htmlFor={`sg-e-${i}`}>Email</label><input id={`sg-e-${i}`} type="email" value={x.email} onChange={(e) => set(i, { email: e.target.value })} /></div>
          <div className="field"><label htmlFor={`sg-s-${i}`}>Signs for</label><select id={`sg-s-${i}`} value={x.side} onChange={(e) => set(i, { side: e.target.value as 'US' | 'PARTY' })}><option value="PARTY">{partyName}</option><option value="US">Us</option></select></div>
          <button className="icon-btn" aria-label={`Remove signer ${i + 1}`} style={{ marginBottom: 10 }} onClick={() => setSigners(signers.filter((_, j) => j !== i))}>×</button>
        </div>))}
      <button className="link-btn small" onClick={() => setSigners([...signers, { name: '', email: '', side: 'PARTY' }])}>+ Add a signer</button>
      <div className="field" style={{ marginTop: 10 }}><label htmlFor="sg-msg">Message (optional)</label><textarea id="sg-msg" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} /></div>
    </Modal>
  );
}
function CancelModal({ onClose, onSave }: { onClose: () => void; onSave: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return <Modal title="Cancel the signature request" onClose={onClose} footer={<><button className="btn btn-secondary" onClick={onClose}>Keep it</button><button className="btn btn-danger" disabled={reason.trim().length < 3} onClick={() => onSave(reason)}>Cancel the request</button></>}>
    <p className="muted small" style={{ marginTop: 0 }}>Signers can’t sign any more and the provider is told. The contract goes back to where it was.</p>
    <div className="field"><label htmlFor="sg-why">Why?</label><textarea id="sg-why" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
  </Modal>;
}
