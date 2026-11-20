/** Contract watch: what needs a decision. One suggestion row for the Watch list and the "For your review" card. */
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useHelpContext } from '../../help/HelpPanel';
import { Alert, Empty } from '../../components/ui';
import { TabStrip } from '../../components/TabStrip';
import { Pager } from '../../components/Pager';

export interface Suggestion {
  id: string; contractId: string; kind: string; kindLabel: string; severity: 'URGENT' | 'NORMAL'; title: string; reasons: string[]; facts: Record<string, string | number | boolean | null>;
  status: 'OPEN' | 'USED' | 'DISMISSED' | 'SNOOZED' | 'RESOLVED'; action: string | null; actionLabel: string | null; note: string | null; snoozeUntil: string | null;
  decidedByName: string | null; decidedAt: string | null; createdAt: string; owner?: string | null;
}
export type WatchActions = Record<string, Record<string, string>>;
export interface ContractWatch { on: boolean; open: Suggestion[]; decided: Suggestion[]; actions: WatchActions }
/** "Use" choices that are done on the contract's Amendments card. */
const AMENDS = new Set(['renew', 'amend']);
const isoIn = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** One suggestion: why, and Use (what was done) / Dismiss (why not) / Snooze / Reopen. */
export function SuggestionItem({ s, actions, manage, showContract, onDecided }: { s: Suggestion; actions: WatchActions; manage: boolean; showContract?: boolean; onDecided: (s: Suggestion, note?: string) => void }) {
  const [mode, setMode] = useState<'dismiss' | 'snooze'>();
  const [note, setNote] = useState('');
  const [until, setUntil] = useState(isoIn(14));
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function decide(body: Record<string, unknown>) {
    setBusy(true); setErr(undefined);
    try {
      const r = await api<{ suggestion: Suggestion }>(`/staff/contracts/suggestions/${s.id}`, { body });
      setMode(undefined); setNote('');
      onDecided(r.suggestion, body.decision === 'USE' && AMENDS.has(String(body.action)) ? 'Recorded. Start the amendment on the contract’s Amendments card.' : undefined);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  const open = s.status === 'OPEN';
  return (
    <div className="watch-item" style={{ borderTop: '1px solid var(--border, #e6e9f0)', padding: '12px 0' }} data-testid={`watch-${s.kind}`}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        {s.severity === 'URGENT' && open && <span className="badge sm badge-rejected">Urgent</span>}
        <span className="badge sm">{s.kindLabel}</span>
        {showContract ? <Link to={`/staff/contracts/${s.contractId}`}><b>{s.title}</b></Link> : <b>{s.title}</b>}
      </div>
      {showContract && <div className="muted small">{String(s.facts.title ?? '')} · {String(s.facts.party ?? '')}{s.owner !== undefined && ` · owner ${s.owner ?? 'none'}`}</div>}
      <ul className="small" style={{ margin: '6px 0', paddingInlineStart: 18 }}>{s.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
      {s.status === 'SNOOZED' && <p className="small muted">Snoozed until {fmtDate(s.snoozeUntil)}{s.note ? ` — ${s.note}` : ''}.</p>}
      {(s.status === 'USED' || s.status === 'DISMISSED') && <p className="small muted">{s.status === 'USED' ? <>Done: <b>{s.actionLabel}</b></> : 'Dismissed'}{s.note ? ` — ${s.note}` : ''} · {s.decidedByName}, {fmtDateTime(s.decidedAt)}</p>}
      {err && <Alert kind="error">{err}</Alert>}
      {manage && (open || s.status === 'SNOOZED') && !mode && <div className="btn-row" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
        {Object.entries(actions[s.kind] ?? {}).map(([k, l]) => <button key={k} className="btn btn-secondary btn-sm" disabled={busy} onClick={() => decide({ decision: 'USE', action: k })}>{l}</button>)}
        <button className="link-btn small" onClick={() => setMode('dismiss')}>Dismiss</button>
        {open && <button className="link-btn small" onClick={() => setMode('snooze')}>Snooze</button>}
      </div>}
      {mode === 'dismiss' && <div className="field-row" style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: 1 }}><label htmlFor={`dn-${s.id}`}>Why it can be dismissed</label><input id={`dn-${s.id}`} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => decide({ decision: 'DISMISS', note })}>Dismiss</button><button className="btn btn-ghost btn-sm" onClick={() => setMode(undefined)}>Cancel</button></div>}
      {mode === 'snooze' && <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div className="field"><label htmlFor={`su-${s.id}`}>Snooze until</label><input id={`su-${s.id}`} type="date" min={isoIn(1)} max={isoIn(180)} value={until} onChange={(e) => setUntil(e.target.value)} /></div>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => decide({ decision: 'SNOOZE', until })}>Snooze</button><button className="btn btn-ghost btn-sm" onClick={() => setMode(undefined)}>Cancel</button></div>}
      {manage && (s.status === 'USED' || s.status === 'DISMISSED') && <button className="link-btn small" disabled={busy} onClick={() => decide({ decision: 'REOPEN' })}>Reopen</button>}
    </div>
  );
}

/** On a contract: what needs a decision now, and the last few decisions. */
export function ForReviewCard({ watch, manage, onChanged }: { watch: ContractWatch; manage: boolean; onChanged: (text?: string) => void }) {
  const [showDone, setShowDone] = useState(false);
  if (!watch.on || (!watch.open.length && !watch.decided.length)) return null;
  return (
    <section className="card pad section-card" aria-label="For your review" style={watch.open.some((s) => s.severity === 'URGENT' && s.status === 'OPEN') ? { borderInlineStart: '4px solid var(--danger, #c0392b)' } : undefined}>
      <h3 style={{ marginBottom: 2 }}>For your review</h3>
      <p className="muted small" style={{ marginTop: 0 }}>Contract watch found {watch.open.length ? `${watch.open.length} thing${watch.open.length === 1 ? '' : 's'} that need${watch.open.length === 1 ? 's' : ''} a decision` : 'nothing new'}. Record what you did, or dismiss with a reason.</p>
      {watch.open.map((s) => <SuggestionItem key={s.id} s={s} actions={watch.actions} manage={manage} onDecided={(_x, text) => onChanged(text)} />)}
      {watch.decided.length > 0 && <button className="link-btn small" onClick={() => setShowDone(!showDone)}>{showDone ? 'Hide earlier decisions' : `Earlier decisions (${watch.decided.length})`}</button>}
      {showDone && watch.decided.map((s) => <SuggestionItem key={s.id} s={s} actions={watch.actions} manage={manage} onDecided={(_x, text) => onChanged(text)} />)}
    </section>
  );
}

/** Contracts → Watch. */
export function ContractWatchList() {
  useHelpContext('contract-watch');
  const { can } = useSession();
  const manage = can('contracts.manage');
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'open', kind = params.get('kind') ?? '', mine = params.get('mine') === '1';
  const [page, setPage] = useState(1);
  const [d, setD] = useState<{ suggestions: Suggestion[]; total: number; page: number; pageSize: number; counts: { kind: string; severity: string; n: number }[]; kinds: Record<string, string>; actions: WatchActions; on: boolean }>();
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const load = useCallback(() => api<NonNullable<typeof d>>(`/staff/contracts/watch?status=${status}&page=${page}${kind ? `&kind=${kind}` : ''}${mine ? '&mine=1' : ''}`).then(setD).catch((e) => setMsg({ kind: 'error', text: e.message })), [status, kind, mine, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [status, kind, mine]);
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n); };
  const urgent = d?.counts.filter((c) => c.severity === 'URGENT').reduce((a, c) => a + c.n, 0) ?? 0;
  const openN = d?.counts.reduce((a, c) => a + c.n, 0) ?? 0;
  return (
    <div className="page">
      <header className="page-head"><div><h1>Contract watch</h1><p className="muted">Contracts that need a decision — found every night from dates, orders, prices, obligations and supplier health. People decide; nothing is sent to the other party.</p></div>
        <div className="head-actions">
          <label className="check-item"><input type="checkbox" checked={mine} onChange={(e) => set('mine', e.target.checked ? '1' : '')} /> <span>Only mine</span></label>
          {manage && d?.on && <button className="btn btn-secondary" onClick={async () => { try { const r = await api<{ added: number; resolved: number }>('/staff/contracts/watch/run', { method: 'POST' }); setMsg({ kind: 'success', text: `Checked now: ${r.added} new, ${r.resolved} no longer apply.` }); load(); } catch (e: any) { setMsg({ kind: 'error', text: e.message }); } }}>Check now</button>}
        </div></header>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {d && !d.on && <Alert kind="warning">Contract watch is switched off. An administrator can switch it on in Administration → Contracts.</Alert>}
      <div className="stat-row">
        <div className="stat stat-attention"><span className="stat-n">{openN}</span><span className="stat-l">Waiting for a decision</span></div>
        <div className="stat stat-rejected"><span className="stat-n">{urgent}</span><span className="stat-l">Urgent</span></div>
      </div>
      <TabStrip>{([['open', 'Open'], ['snoozed', 'Snoozed'], ['decided', 'Decided']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={status === k} className={status === k ? 'active' : ''} onClick={() => set('status', k === 'open' ? '' : k)}>{l}</button>)}</TabStrip>
      <div className="card pad">
        <div className="field" style={{ maxWidth: 320 }}><label htmlFor="wk">What</label><select id="wk" value={kind} onChange={(e) => set('kind', e.target.value)}><option value="">Everything</option>{Object.entries(d?.kinds ?? {}).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        {!d ? <div className="spinner" /> : !d.suggestions.length ? <Empty>{status === 'open' ? 'Nothing needs a decision.' : 'Nothing here.'}</Empty>
          : d.suggestions.map((s) => <SuggestionItem key={s.id} s={s} actions={d.actions} manage={manage} showContract onDecided={(_x, text) => { setMsg({ kind: 'success', text: text ?? 'Recorded.' }); load(); }} />)}
        {d && <Pager page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} />}
      </div>
    </div>
  );
}
