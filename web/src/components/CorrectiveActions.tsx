/**
 * Corrective actions — one panel for the supplier (answer with a note and files) and for staff (review, change,
 * cancel), plus the staff wrapper that loads a supplier's actions and raises new ones from VendorGate's suggestions.
 * Server: services/correctiveActions.ts.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, docUrl } from '../lib/api';
import { fmtDate } from '../lib/format';
import { t } from '../i18n';
import { Alert, Modal } from './ui';

export type Priority = 'HIGH' | 'MEDIUM' | 'LOW';
export interface ActionView {
  id: string; title: string; description: string | null; priority: Priority; dueOn: string; status: 'OPEN' | 'SUBMITTED' | 'ACCEPTED' | 'CANCELLED';
  overdue: boolean; condition: boolean; rejected: boolean; reviewRemarks: string | null; responseNote: string | null; evidence: { documentId: string; fileName: string }[];
  submittedAt: string | null; reviewedAt: string | null; reviewedByName: string | null; raisedByName: string; createdAt: string;
  sourceLabel?: string | null; submittedByName?: string | null; canReview?: boolean;
}
export interface Suggestion { source: string; sourceLabel: string; title: string; description: string; priority: Priority; dueInDays: number }

const PRIO_CLS: Record<Priority, string> = { HIGH: 'flag-high', MEDIUM: 'flag-medium', LOW: '' };

/** Supplier: onSave/onUpload/onRemoveFile/onSubmit. Staff: onReview/onUpdate (shown on actions they may review). */
export function ActionsPanel({ items, buyer, onSave, onUpload, onRemoveFile, onSubmit, onReview, onUpdate }: {
  items: ActionView[]; buyer?: string;
  onSave?: (a: ActionView, note: string) => Promise<void>;
  onUpload?: (a: ActionView, file: File) => Promise<void>;
  onRemoveFile?: (a: ActionView, documentId: string) => Promise<void>;
  onSubmit?: (a: ActionView, note: string) => Promise<void>;
  onReview?: (a: ActionView, decision: 'ACCEPT' | 'REJECT', remarks: string) => Promise<void>;
  onUpdate?: (a: ActionView, change: { dueOn?: string; cancel?: boolean; reason?: string }) => Promise<void>;
}) {
  const supplier = !!onSubmit;
  if (!items.length) return <p className="muted">{supplier ? t('ca.none') : 'No corrective actions yet.'}</p>;
  return (
    <div className="stack">
      {supplier && buyer && <p className="muted">{t('ca.intro', { buyer })}</p>}
      {items.map((a) => <ActionCard key={`${a.id}-${a.status}-${a.reviewedAt ?? ''}-${a.evidence.length}`} a={a} supplier={supplier} {...{ onSave, onUpload, onRemoveFile, onSubmit, onReview, onUpdate }} />)}
    </div>
  );
}

function ActionCard({ a, supplier, onSave, onUpload, onRemoveFile, onSubmit, onReview, onUpdate }: { a: ActionView; supplier: boolean } & Omit<Parameters<typeof ActionsPanel>[0], 'items' | 'buyer'>) {
  const [note, setNote] = useState(a.responseNote ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [rejecting, setRejecting] = useState(false);
  const [remarks, setRemarks] = useState('');
  const [due, setDue] = useState<string>();
  const [cancelling, setCancelling] = useState(false);
  const answering = supplier && a.status === 'OPEN';
  async function run(fn: () => Promise<void>) { setBusy(true); setErr(undefined); try { await fn(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } }
  const statusText = supplier
    ? { OPEN: a.rejected ? t('ca.statusMore') : t('ca.statusOpen'), SUBMITTED: t('ca.statusSent'), ACCEPTED: t('ca.statusAccepted'), CANCELLED: '' }[a.status]
    : { OPEN: a.rejected ? 'Evidence rejected — waiting for more' : 'Waiting for the supplier', SUBMITTED: 'Evidence to review', ACCEPTED: 'Accepted — closed', CANCELLED: 'Cancelled' }[a.status];
  return (
    <div className={`action-card status-${a.status.toLowerCase()}${a.overdue ? ' overdue' : ''}`}>
      <div className="row-between">
        <strong>{a.title}</strong>
        <div className="btn-row">
          <span className={`badge sm ${PRIO_CLS[a.priority]}`}>{supplier ? t(`ca.prio${a.priority}`) : `${a.priority[0]}${a.priority.slice(1).toLowerCase()} priority`}</span>
          <span className={`badge sm ${a.status === 'ACCEPTED' ? 'badge-approved' : a.status === 'SUBMITTED' ? 'v-test' : a.overdue ? 'flag-high' : ''}`}>{statusText}</span>
        </div>
      </div>
      <div className="small muted">
        {a.status === 'OPEN' || a.status === 'SUBMITTED' ? (a.overdue ? <strong className="diff-text">{supplier ? t('ca.overdue', { date: fmtDate(a.dueOn) }) : `Overdue — was due ${fmtDate(a.dueOn)}`}</strong> : supplier ? t('ca.due', { date: fmtDate(a.dueOn) }) : `Due ${fmtDate(a.dueOn)}`) : null}
        {!supplier && <> · raised by {a.raisedByName}{a.sourceLabel ? ` · from: ${a.sourceLabel}` : ''}{a.condition ? ' · condition of approval' : ''}</>}
      </div>
      {a.description && <p className="notice-text small">{a.description}</p>}
      {a.rejected && a.reviewRemarks && <Alert kind="warning">{supplier ? t('ca.moreNeeded', { remarks: a.reviewRemarks }) : `Rejected by ${a.reviewedByName}: “${a.reviewRemarks}”`}</Alert>}
      {a.status === 'CANCELLED' && a.reviewRemarks && <p className="small muted">Cancelled by {a.reviewedByName}: “{a.reviewRemarks}”</p>}
      {err && <Alert kind="error">{err}</Alert>}

      {/* The supplier's answer */}
      {answering ? (
        <div className="action-answer">
          <label className="small strong" htmlFor={`ca-${a.id}`}>{t('ca.note')}</label>
          <textarea id={`ca-${a.id}`} rows={3} maxLength={4000} value={note} placeholder={t('ca.notePh')} onChange={(e) => setNote(e.target.value)} onBlur={() => note !== (a.responseNote ?? '') && onSave && run(() => onSave(a, note))} />
          <Files a={a} onRemove={onRemoveFile ? (id) => run(() => onRemoveFile(a, id)) : undefined} />
          <div className="btn-row">
            {onUpload && <label className="btn btn-secondary btn-sm">{t('ca.attach')}<input type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.xlsx,.docx" onChange={(e) => { const f = e.target.files?.[0]; if (f) run(() => onUpload(a, f)); e.target.value = ''; }} /></label>}
            <button className="btn btn-primary btn-sm" disabled={busy || (!note.trim() && !a.evidence.length)} onClick={() => run(() => onSubmit!(a, note))}>{t('ca.send')}</button>
          </div>
        </div>
      ) : (a.responseNote || a.evidence.length > 0) && (
        <div className="action-answer">
          <span className="small muted">{supplier ? t('ca.yourAnswer') : `Supplier's answer${a.submittedAt ? ` (${fmtDate(a.submittedAt)})` : ''}`}</span>
          {a.responseNote && <div className="notice-text small">{a.responseNote}</div>}
          <Files a={a} />
        </div>
      )}

      {/* Staff: review and manage */}
      {!supplier && a.canReview && (<>
        {a.status === 'SUBMITTED' && onReview && (rejecting ? (
          <div className="action-answer">
            <label className="small strong" htmlFor={`rj-${a.id}`}>What is still missing?</label>
            <textarea id={`rj-${a.id}`} rows={2} maxLength={1000} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            <div className="btn-row"><button className="btn btn-ghost btn-sm" onClick={() => setRejecting(false)}>Cancel</button>
              <button className="btn btn-danger btn-sm" disabled={busy || !remarks.trim()} onClick={() => run(() => onReview(a, 'REJECT', remarks))}>Send back to the supplier</button></div>
          </div>
        ) : (
          <div className="btn-row"><button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(() => onReview(a, 'ACCEPT', ''))}>Accept and close</button>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setRejecting(true)}>Ask for more…</button></div>
        ))}
        {(a.status === 'OPEN' || a.status === 'SUBMITTED') && onUpdate && (
          <div className="btn-row small">
            {due === undefined ? <button className="link-btn small" onClick={() => setDue(a.dueOn)}>Change due date</button>
              : <><input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="New due date" /><button className="btn btn-secondary btn-sm" disabled={busy || !due} onClick={() => run(async () => { await onUpdate(a, { dueOn: due }); setDue(undefined); })}>Save</button></>}
            {!cancelling && <button className="link-btn small" onClick={() => setCancelling(true)}>Cancel action</button>}
          </div>
        )}
        {cancelling && onUpdate && (
          <div className="action-answer">
            <label className="small strong" htmlFor={`cx-${a.id}`}>Why is this action no longer needed?</label>
            <textarea id={`cx-${a.id}`} rows={2} maxLength={500} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            <div className="btn-row"><button className="btn btn-ghost btn-sm" onClick={() => setCancelling(false)}>Keep it</button>
              <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => run(() => onUpdate(a, { cancel: true, reason: remarks }))}>Cancel the action</button></div>
          </div>
        )}
      </>)}
    </div>
  );
}

function Files({ a, onRemove }: { a: ActionView; onRemove?: (documentId: string) => void }) {
  if (!a.evidence.length) return null;
  return <ul className="plain small action-files">{a.evidence.map((f) => <li key={f.documentId}><a href={docUrl(f.documentId)} target="_blank" rel="noreferrer">{f.fileName}</a>{onRemove && <> <button className="link-btn small" onClick={() => onRemove(f.documentId)}>{t('ca.remove')}</button></>}</li>)}</ul>;
}

/* ---------------- Staff ---------------- */

interface StaffData { actions: ActionView[]; canRaise: boolean; condition: boolean; suggestions: Suggestion[] }

/** Staff: a supplier's corrective actions, with raising (from suggestions or your own) and review. */
export function StaffActions({ vendorId, vendorName, onChanged }: { vendorId: string; vendorName: string; onChanged?: () => void }) {
  const [d, setD] = useState<StaffData>();
  const [raising, setRaising] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const load = useCallback(() => api<StaffData>(`/staff/actions/vendor/${vendorId}`).then(setD).catch((e) => setMsg({ kind: 'error', text: e.message })), [vendorId]);
  useEffect(() => { load(); }, [load]);
  const done = async (text: string) => { setMsg({ kind: 'success', text }); await load(); onChanged?.(); };
  if (!d) return <div className="spinner" />;
  return (
    <div className="stack">
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="row-between">
        <p className="muted small grow">{d.condition ? `Actions raised now are conditions of approval: ${vendorName} can be approved, and must still complete them.` : `Ask ${vendorName} to fix something, with a due date. They answer with a note and evidence; you accept or ask for more.`}</p>
        {d.canRaise && <button className="btn btn-primary btn-sm" onClick={() => setRaising(true)}>Raise corrective actions{d.suggestions.length ? ` (${d.suggestions.length} suggested)` : ''}</button>}
      </div>
      <ActionsPanel items={d.actions}
        onReview={async (a, decision, remarks) => { await api(`/staff/actions/${a.id}/review`, { body: { decision, remarks } }); await done(decision === 'ACCEPT' ? `Accepted: ${a.title}.` : `Sent back to ${vendorName} for more.`); }}
        onUpdate={async (a, change) => { await api(`/staff/actions/${a.id}`, { method: 'PATCH', body: change }); await done(change.cancel ? `Cancelled: ${a.title}.` : 'Due date changed.'); }} />
      {raising && <RaiseActionsModal vendorName={vendorName} suggestions={d.suggestions} condition={d.condition} onClose={() => setRaising(false)}
        onRaise={async (items) => { await api(`/staff/actions/vendor/${vendorId}`, { body: { items } }); setRaising(false); await done(`${items.length} corrective action${items.length > 1 ? 's' : ''} sent to ${vendorName}.`); }} />}
    </div>
  );
}

type Draft = { key: string; on: boolean; title: string; description: string; priority: Priority; dueOn: string; source?: string; sourceLabel?: string };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export function RaiseActionsModal({ vendorName, suggestions, condition, onClose, onRaise }: { vendorName: string; suggestions: Suggestion[]; condition: boolean; onClose: () => void; onRaise: (items: Omit<Draft, 'key' | 'on'>[]) => Promise<void> }) {
  const [rows, setRows] = useState<Draft[]>(() => suggestions.length
    ? suggestions.map((s, i) => ({ key: `s${i}`, on: s.priority !== 'LOW', title: s.title, description: s.description, priority: s.priority, dueOn: inDays(s.dueInDays), source: s.source, sourceLabel: s.sourceLabel }))
    : [{ key: 'm0', on: true, title: '', description: '', priority: 'MEDIUM', dueOn: inDays(30) }]);
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: string, patch: Partial<Draft>) => setRows((r) => r.map((x) => (x.key === k ? { ...x, ...patch } : x)));
  const picked = rows.filter((r) => r.on && r.title.trim()); // empty rows are ignored
  async function send() {
    setBusy(true); setErr(undefined);
    try { await onRaise(picked.map(({ key: _k, on: _o, ...r }) => ({ ...r, description: r.description.trim() || undefined } as any))); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Corrective actions for ${vendorName}`} wide onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !picked.length || picked.some((r) => r.title.trim().length < 3)} onClick={send}>{busy ? 'Sending…' : `Send ${picked.length} to the supplier`}</button></>}>
      {err && <Alert kind="error">{err}</Alert>}
      <p className="small muted">{suggestions.length ? 'Suggested by VendorGate from what it found — tick the ones to send, and edit the wording or due date.' : 'Nothing to suggest from the findings — write your own.'}{condition ? ' The supplier is under review: these become conditions of approval.' : ''} The supplier is emailed once with all of them.</p>
      <div className="stack">
        {rows.map((r) => (
          <div key={r.key} className={`raise-row${r.on ? '' : ' off'}`}>
            <label className="check-item"><input type="checkbox" checked={r.on} onChange={(e) => set(r.key, { on: e.target.checked })} />
              <span className="small muted">{r.sourceLabel ?? 'Your own action'}</span></label>
            <input aria-label="Title" value={r.title} maxLength={200} placeholder="What should the supplier do?" disabled={!r.on} onChange={(e) => set(r.key, { title: e.target.value })} />
            <textarea aria-label="Details" rows={2} maxLength={2000} value={r.description} placeholder="Details for the supplier (optional)" disabled={!r.on} onChange={(e) => set(r.key, { description: e.target.value })} />
            <div className="btn-row">
              <select aria-label="Priority" value={r.priority} disabled={!r.on} onChange={(e) => set(r.key, { priority: e.target.value as Priority })}><option value="HIGH">High priority</option><option value="MEDIUM">Medium priority</option><option value="LOW">Low priority</option></select>
              <label className="small">Due <input type="date" value={r.dueOn} disabled={!r.on} onChange={(e) => set(r.key, { dueOn: e.target.value })} /></label>
            </div>
          </div>
        ))}
        <button className="link-btn" onClick={() => setRows((x) => [...x, { key: `m${x.length}`, on: true, title: '', description: '', priority: 'MEDIUM', dueOn: inDays(30) }])}>+ Add your own action</button>
      </div>
    </Modal>
  );
}
