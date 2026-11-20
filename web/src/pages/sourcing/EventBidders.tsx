/** The buyer's side of step 2: choosing bidders (suggestions, outside bidders), sending invitations, clarifications. */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { Alert, Empty, Modal } from '../../components/ui';
import { RiskBadge } from '../../components/Risk';
import { SupplierContactModal } from '../../components/SupplierContactModal';

export interface Bidder {
  id: string; alias: string; status: string; outside: boolean; sentAt: string | null; respondedAt: string | null; invitedByName: string | null; declineReason: string | null;
  declaration: { acceptedTermsVersion?: number; noConflict?: boolean; conflictNote?: string; at: string; by: string } | null;
  vendor: { id: string; code: string; name: string; status: string; riskBand: string | null; contactEmail: string; bidderOnly: boolean; registered: boolean };
  duplicates: string | null;
}
export interface Question { id: string; question: string | null; answer: string | null; askedBy: string | null; askedByName: string | null; answeredByName: string | null; publishedAt: string | null; createdAt: string }
interface Suggestion { id: string; code: string; name: string; category: string | null; categoryMatch: boolean; riskBand: string | null; score: number | null; overdueActions: number; invited: boolean; blocked: string | null }

const STATUS: Record<string, { label: string; cls: string }> = {
  INVITED: { label: 'Invited', cls: 'badge-invited' }, ACCEPTED: { label: 'Accepted', cls: 'badge-approved' }, DECLINED: { label: 'Declined', cls: 'badge-rejected' }, REMOVED: { label: 'Invitation withdrawn', cls: '' },
};
const bidderStatus = (b: Bidder) => (!b.sentAt ? { label: 'Not sent yet', cls: '' } : STATUS[b.status] ?? { label: b.status, cls: '' });

type Props = { eventId: string; status: string; closesAt: string | null; canManage: boolean; outsideAllowed: boolean; category: string | null; onChanged: (data: any, msg: string) => void; onError: (m: string) => void };

export function BiddersCard({ bidders, ...p }: Props & { bidders: Bidder[] }) {
  const [adding, setAdding] = useState(false);
  const [outside, setOutside] = useState(false);
  const open = !p.closesAt || new Date(p.closesAt) > new Date();
  const changeable = p.canManage && open && ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED'].includes(p.status);
  const unsent = bidders.filter((b) => !b.sentAt && b.status === 'INVITED').length;
  const canSend = changeable && unsent > 0 && ['APPROVED', 'PUBLISHED'].includes(p.status);
  const counts = useMemo(() => ({ accepted: bidders.filter((b) => b.status === 'ACCEPTED').length, declined: bidders.filter((b) => b.status === 'DECLINED').length }), [bidders]);
  async function send() {
    try { const r = await api<any>(`/staff/sourcing/events/${p.eventId}/invitations`, { method: 'POST' }); p.onChanged(r, `Invitations sent to ${r.sent} bidder${r.sent === 1 ? '' : 's'}.`); } catch (e: any) { p.onError(e.message); }
  }
  async function remove(b: Bidder) {
    if (!confirm(b.sentAt ? `Withdraw the invitation to ${b.vendor.name}? They are emailed.` : `Take ${b.vendor.name} off the list?`)) return;
    try { p.onChanged(await api(`/staff/sourcing/events/${p.eventId}/bidders/${b.id}`, { method: 'DELETE' }), b.sentAt ? 'Invitation withdrawn.' : 'Removed from the list.'); } catch (e: any) { p.onError(e.message); }
  }
  return (
    <section className="card pad section-card">
      <div className="toolbar"><div><h3>Bidders</h3>
        <p className="muted small">{bidders.length ? `${bidders.length} on the list · ${counts.accepted} accepted${counts.declined ? ` · ${counts.declined} declined` : ''}. ` : ''}Bidders never see each other’s names; they appear to each other as “Bidder 1”, “Bidder 2”…{p.closesAt ? ` Invitations close ${fmtDateTime(p.closesAt)}.` : ''}</p></div>
        {changeable && <div className="head-actions">
          <button className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>+ Add suppliers</button>
          {p.outsideAllowed && <button className="btn btn-secondary btn-sm" onClick={() => setOutside(true)}>+ Outside bidder</button>}
        </div>}</div>
      {!bidders.length ? <Empty>No bidders yet. Add approved suppliers{p.outsideAllowed ? ', or invite a company that isn’t a supplier yet' : ''}.</Empty> : (
        <table className="table static">
          <thead><tr><th>Bidder</th><th>Supplier</th><th>Status</th><th>Declaration</th>{changeable && <th />}</tr></thead>
          <tbody>{bidders.map((b) => {
            const st = bidderStatus(b);
            return (
              <tr key={b.id} className={b.status === 'REMOVED' ? 'muted' : ''}>
                <td className="small">{b.alias}</td>
                <td><Link to={`/staff/vendors/${b.vendor.id}`}>{b.vendor.name}</Link> <span className="muted small mono">{b.vendor.code}</span>
                  {b.outside && <span className="badge sm" style={{ marginInlineStart: 6 }}>Outside bidder</span>}{b.vendor.riskBand && <> <RiskBadge band={b.vendor.riskBand as any} /></>}
                  {b.outside && !b.vendor.registered && b.sentAt && <div className="muted small">Hasn’t completed the bidder registration yet</div>}
                  {b.duplicates && <div className="small diff-text">Possible duplicate: {b.duplicates}</div>}</td>
                <td><span className={`badge sm ${st.cls}`}>{st.label}</span>{b.respondedAt && <div className="muted small">{fmtDateTime(b.respondedAt)}</div>}{b.declineReason && <div className="small">“{b.declineReason}”</div>}</td>
                <td className="small">{b.declaration ? (b.declaration.conflictNote ? <span className="diff-text">⚠ Conflict declared: {b.declaration.conflictNote}</span> : <>Terms accepted{b.declaration.acceptedTermsVersion ? ` (v${b.declaration.acceptedTermsVersion})` : ''} · no conflict</>) : <span className="muted">—</span>}</td>
                {changeable && <td className="actions">{b.status !== 'REMOVED' && <button className="link-btn small" onClick={() => remove(b)}>{b.sentAt ? 'Withdraw' : 'Remove'}</button>}</td>}
              </tr>);
          })}</tbody>
        </table>)}
      {p.canManage && unsent > 0 && !canSend && p.status !== 'CANCELLED' && <p className="muted small">{unsent} not invited yet — invitations can be sent once the event is approved.</p>}
      {canSend && <div className="btn-row"><button className="btn btn-primary" onClick={send}>Send invitations ({unsent})</button></div>}
      {adding && <SuggestModal eventId={p.eventId} category={p.category} onClose={() => setAdding(false)} onAdded={(r) => { setAdding(false); p.onChanged(r, `${r.added} supplier${r.added === 1 ? '' : 's'} added.`); }} />}
      {outside && <SupplierContactModal endpoint={`/staff/sourcing/events/${p.eventId}/outside-bidders`} notify={false} title="Invite an outside bidder" submitLabel="Add to bidders"
        intro="For a company that isn’t a supplier yet. They confirm their email with a code, give their registration number and what they supply, then take part. Full onboarding is asked for only if they win."
        onClose={() => setOutside(false)} onCreated={(r) => { setOutside(false); p.onChanged(r, 'Outside bidder added.'); }} />}
    </section>
  );
}

function SuggestModal({ eventId, category, onClose, onAdded }: { eventId: string; category: string | null; onClose: () => void; onAdded: (r: any) => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Suggestion[]>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  useEffect(() => { const t = setTimeout(() => api<{ suppliers: Suggestion[] }>(`/staff/sourcing/events/${eventId}/suggestions?q=${encodeURIComponent(q)}`).then((r) => setRows(r.suppliers)).catch((e) => setError(e.message)), 200); return () => clearTimeout(t); }, [eventId, q]);
  async function add() {
    try { onAdded(await api(`/staff/sourcing/events/${eventId}/bidders`, { body: { vendorIds: [...picked] } })); } catch (e: any) { setError(e.message); }
  }
  const toggle = (id: string) => { const n = new Set(picked); if (n.has(id)) n.delete(id); else n.add(id); setPicked(n); };
  return (
    <Modal title="Add approved suppliers" wide onClose={onClose} footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!picked.size} onClick={add}>Add {picked.size || ''} to bidders</button></>}>
      <p className="muted small">Approved suppliers{category ? `, those in “${category}” first,` : ''} then by lower risk and better scorecard. Suppliers on hold can’t be invited.</p>
      <div className="field"><input aria-label="Search suppliers" placeholder="Search by name or code" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {error && <Alert kind="error">{error}</Alert>}
      {!rows ? <div className="spinner" /> : !rows.length ? <Empty>No approved suppliers match.</Empty> : (
        <div style={{ maxHeight: 420, overflow: 'auto' }}>
          <table className="table static compact">
            <thead><tr><th /><th>Supplier</th><th>Category</th><th>Risk</th><th className="num">Scorecard</th><th>Notes</th></tr></thead>
            <tbody>{rows.map((s) => (
              <tr key={s.id} className={s.invited || s.blocked ? 'muted' : ''}>
                <td><input type="checkbox" aria-label={`Pick ${s.name}`} disabled={s.invited || !!s.blocked} checked={picked.has(s.id)} onChange={() => toggle(s.id)} /></td>
                <td>{s.name} <span className="muted small mono">{s.code}</span></td>
                <td className="small">{s.category ?? '—'}{s.categoryMatch && <span className="badge badge-approved sm" style={{ marginInlineStart: 6 }}>match</span>}</td>
                <td>{s.riskBand ? <RiskBadge band={s.riskBand as any} /> : <span className="muted small">—</span>}</td>
                <td className="num small">{s.score === null ? '—' : `${Math.round(s.score)}%`}</td>
                <td className="small">{s.invited ? 'Already on the list' : s.blocked ?? (s.overdueActions ? `${s.overdueActions} overdue action${s.overdueActions === 1 ? '' : 's'}` : '')}</td>
              </tr>))}</tbody>
          </table>
        </div>)}
    </Modal>
  );
}

export function ClarificationsCard({ questions, eventId, canAnswer, onChanged, onError }: { questions: Question[]; eventId: string; canAnswer: boolean; onChanged: (data: any, msg: string) => void; onError: (m: string) => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [announcing, setAnnouncing] = useState(false);
  async function publish(questionId: string | null) {
    const answer = drafts[questionId ?? 'new'] ?? '';
    try { const r = await api<any>(`/staff/sourcing/events/${eventId}/clarifications`, { body: { questionId, answer } }); setDrafts({ ...drafts, [questionId ?? 'new']: '' }); setAnnouncing(false); onChanged(r, `Shared with ${r.told} bidder${r.told === 1 ? '' : 's'}.`); }
    catch (e: any) { onError(e.message); }
  }
  const waiting = questions.filter((q) => !q.publishedAt).length;
  return (
    <section className="card pad section-card">
      <div className="toolbar"><div><h3>Clarifications{waiting ? <span className="badge badge-under_review sm" style={{ marginInlineStart: 6 }}>{waiting} to answer</span> : null}</h3>
        <p className="muted small">Answers and announcements go to every bidder, without saying who asked.</p></div>
        {canAnswer && <button className="btn btn-secondary btn-sm" onClick={() => setAnnouncing(true)}>+ Announcement</button>}</div>
      {announcing && <div className="card pad" style={{ marginBottom: 10 }}>
        <div className="field"><label htmlFor="ann">Announcement to all bidders</label><textarea id="ann" rows={3} value={drafts.new ?? ''} onChange={(e) => setDrafts({ ...drafts, new: e.target.value })} /></div>
        <div className="btn-row"><button className="btn btn-secondary btn-sm" onClick={() => setAnnouncing(false)}>Cancel</button><button className="btn btn-primary btn-sm" disabled={!(drafts.new ?? '').trim()} onClick={() => publish(null)}>Send to all bidders</button></div></div>}
      {!questions.length ? <p className="muted small">No questions yet.</p> : questions.map((q) => (
        <div key={q.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line, #e5e7eb)' }}>
          {q.question ? <><div className="small"><strong>Q:</strong> {q.question}</div><div className="muted small">{q.askedBy} · {fmtDateTime(q.createdAt)}</div></> : <div className="small"><strong>Announcement</strong></div>}
          {q.publishedAt ? <div className="small" style={{ marginTop: 4 }}><strong>A:</strong> {q.answer}<div className="muted">{q.answeredByName} · shared {fmtDateTime(q.publishedAt)}</div></div>
            : canAnswer ? <div style={{ marginTop: 6 }}><textarea aria-label={`Answer to: ${q.question}`} rows={2} style={{ width: '100%' }} value={drafts[q.id] ?? ''} onChange={(e) => setDrafts({ ...drafts, [q.id]: e.target.value })} />
              <div className="btn-row"><button className="btn btn-primary btn-sm" disabled={!(drafts[q.id] ?? '').trim()} onClick={() => publish(q.id)}>Answer all bidders</button></div></div>
            : <div className="muted small">Not answered yet.</div>}
        </div>))}
    </section>
  );
}
