/** Contract watch: what needs a decision. One suggestion row for the Watch list and the "For your review" card. */
import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, money } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useHelpContext } from '../../help/HelpPanel';
import { Alert, Empty, Modal } from '../../components/ui';
import { TabStrip } from '../../components/TabStrip';
import { Pager } from '../../components/Pager';

export interface Suggestion {
  id: string; contractId: string; kind: string; kindLabel: string; severity: 'URGENT' | 'NORMAL'; title: string; reasons: string[]; facts: Record<string, string | number | boolean | null>;
  status: 'OPEN' | 'USED' | 'DISMISSED' | 'SNOOZED' | 'RESOLVED'; action: string | null; actionLabel: string | null; note: string | null; snoozeUntil: string | null;
  decidedByName: string | null; decidedAt: string | null; createdAt: string; owner?: string | null;
  summary: string | null; summaryBy: string | null; packAt: string | null;
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
  const [pack, setPack] = useState(false);
  return (
    <div className="watch-item" style={{ borderTop: '1px solid var(--border, #e6e9f0)', padding: '12px 0' }} data-testid={`watch-${s.kind}`}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        {s.severity === 'URGENT' && open && <span className="badge sm badge-rejected">Urgent</span>}
        <span className="badge sm">{s.kindLabel}</span>
        {showContract ? <Link to={`/staff/contracts/${s.contractId}`}><b>{s.title}</b></Link> : <b>{s.title}</b>}
      </div>
      {showContract && <div className="muted small">{String(s.facts.title ?? '')} · {String(s.facts.party ?? '')}{s.owner !== undefined && ` · owner ${s.owner ?? 'none'}`}</div>}
      <ul className="small" style={{ margin: '6px 0', paddingInlineStart: 18 }}>{s.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
      {s.summary && !pack && <p className="small" style={{ margin: '4px 0' }}><b>Summary:</b> {s.summary.split('\n')[0]}</p>}
      {s.status !== 'RESOLVED' && <button className="link-btn small" onClick={() => setPack(!pack)}>{pack ? 'Hide the decision pack' : 'Decision pack'}</button>}
      {pack && <DecisionPack id={s.id} manage={manage} />}
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

/* ---------------- decision pack (step 2) ---------------- */

interface PackView {
  pack: {
    contract: { number: string; title: string; type: string; party: string; startDate: string | null; endDate: string | null; noticeBy: string | null; autoRenew: boolean; renewalTermMonths: number | null; value: number | null; currency: string; daysToNotice: number | null };
    orders: { spend: number; spend12: number; count: number; last: string | null; pctOfValue: number | null } | null;
    prices: { linesAbove: number; linesChecked: number; excess: number } | null;
    obligations: { done12: number; onTime12: number; onTimePct: number | null; overdueTheirs: number; overdueOurs: number };
    supplier: { linked: boolean; riskBand: string | null; riskScore: number | null; onHold: boolean; holdReason: string | null; scorecard: number | null; grade: string | null } | null;
    amendments: number; earlier: { kind: string; title: string; did: string | null; note: string | null; when: string | null }[];
    recommendation: 'RENEW' | 'RENEGOTIATE' | 'END' | 'ACT'; reasons: string[];
  };
  summary: string; points: string[]; summaryBy: 'rules' | 'anthropic'; sentToAi: string | null; drafts: { key: string; label: string }[];
}
const RECO: Record<PackView['pack']['recommendation'], [string, string]> = { RENEW: ['Renew', 'badge-approved'], RENEGOTIATE: ['Renegotiate', 'badge-attention'], END: ['Let it end', 'badge-rejected'], ACT: ['Act on it', 'badge-attention'] };

/** What an owner needs to decide: the facts, VendorGate's recommendation and reasons, a summary, and drafts. */
export function DecisionPack({ id, manage }: { id: string; manage: boolean }) {
  const [v, setV] = useState<PackView>();
  const [err, setErr] = useState<string>();
  const [seen, setSeen] = useState(false);
  const [draft, setDraft] = useState<string>();
  const load = useCallback(() => { setV(undefined); api<PackView>(`/staff/contracts/suggestions/${id}/pack`, { method: 'POST' }).then(setV).catch((e) => setErr(e.message)); }, [id]);
  useEffect(() => { load(); }, [load]);
  if (err) return <Alert kind="error">{err}</Alert>;
  if (!v) return <div className="spinner" />;
  const p = v.pack, c = p.contract, cur = c.currency;
  const rows: [string, string][] = [
    ['Term', `${fmtDate(c.startDate)} – ${c.endDate ? fmtDate(c.endDate) : 'no fixed end'}${c.autoRenew ? ` · renews for ${c.renewalTermMonths ?? 12} months` : ''}`],
    ...(c.noticeBy ? [['Notice by', `${fmtDate(c.noticeBy)} (${c.daysToNotice! < 0 ? 'passed' : `${c.daysToNotice} days left`})`] as [string, string]] : []),
    ['Value', c.value === null ? '—' : money(c.value, cur)],
    ...(p.orders ? [['Orders', `${p.orders.count} so far, ${money(p.orders.spend, cur)}${p.orders.pctOfValue !== null ? ` (${p.orders.pctOfValue}% of the value)` : ''} · ${money(p.orders.spend12, cur)} in 12 months${p.orders.last ? ` · last ${fmtDate(p.orders.last)}` : ''}`] as [string, string]] : []),
    ...(p.prices ? [['Prices', `${p.prices.linesAbove} of ${p.prices.linesChecked} lines above the contract price · ${money(p.prices.excess, cur)} over`] as [string, string]] : []),
    ['Obligations', `${p.obligations.onTimePct === null ? 'none done in 12 months' : `${p.obligations.onTimePct}% on time (${p.obligations.onTime12} of ${p.obligations.done12})`}${p.obligations.overdueTheirs ? ` · ${p.obligations.overdueTheirs} of theirs overdue` : ''}${p.obligations.overdueOurs ? ` · ${p.obligations.overdueOurs} of ours overdue` : ''}`],
    ...(p.supplier ? [['Supplier', [p.supplier.riskBand ? `risk ${p.supplier.riskBand.toLowerCase()}` : 'risk not rated', p.supplier.onHold ? `on hold (${p.supplier.holdReason})` : null, p.supplier.scorecard !== null ? `scorecard ${Math.round(p.supplier.scorecard)} (${p.supplier.grade})` : null, p.supplier.linked ? null : 'not an onboarded supplier'].filter(Boolean).join(' · ')] as [string, string]] : []),
    ['Amendments', String(p.amendments)],
  ];
  return (
    <div className="decision-pack" style={{ background: 'var(--surface-2, #f7f8fb)', borderRadius: 8, padding: 12, margin: '8px 0' }} data-testid="decision-pack">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className={`badge ${RECO[p.recommendation][1]}`}>{RECO[p.recommendation][0]}</span><b>{v.summary}</b></div>
      {v.points.length > 0 && <ul className="small" style={{ margin: '6px 0', paddingInlineStart: 18 }}>{v.points.map((x, i) => <li key={i}>{x}</li>)}</ul>}
      <p className="muted small" style={{ margin: '4px 0' }}>{v.summaryBy === 'anthropic' ? 'Summary written by AI from general facts only — no names, numbers or amounts.' : 'Summary written by VendorGate’s rules.'} {v.sentToAi && <button className="link-btn small" onClick={() => setSeen(!seen)}>{seen ? 'Hide' : 'What the AI saw'}</button>} <button className="link-btn small" onClick={load}>Refresh</button></p>
      {seen && v.sentToAi && <pre className="small" style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto' }}>{JSON.stringify(JSON.parse(v.sentToAi), null, 2)}</pre>}
      <h4 style={{ margin: '10px 0 4px' }}>Why</h4>
      <ul className="small" style={{ margin: 0, paddingInlineStart: 18 }}>{p.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
      <table className="table static compact" style={{ marginTop: 8 }}><tbody>{rows.map(([k, val]) => <tr key={k}><td className="muted small" style={{ width: 120 }}>{k}</td><td className="small">{val}</td></tr>)}</tbody></table>
      {p.earlier.length > 0 && <p className="small muted">Earlier: {p.earlier.map((e) => `${e.did ?? ''} (${fmtDate(e.when)})`).join(' · ')}</p>}
      {manage && v.drafts.length > 0 && <div className="btn-row" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>{v.drafts.map((d) => <button key={d.key} className="btn btn-ghost btn-sm" onClick={() => setDraft(d.key)}>Draft: {d.label}</button>)}</div>}
      {draft && <DraftModal id={id} draftKey={draft} onClose={() => setDraft(undefined)} />}
    </div>
  );
}

/** A letter to the other party, written by VendorGate with the real names — edited and sent by a person from their own email. */
function DraftModal({ id, draftKey, onClose }: { id: string; draftKey: string; onClose: () => void }) {
  const [d, setD] = useState<{ to: string; toName: string; subject: string; body: string; label: string }>();
  const [err, setErr] = useState<string>();
  const [copied, setCopied] = useState(false);
  useEffect(() => { api<NonNullable<typeof d>>(`/staff/contracts/suggestions/${id}/drafts/${draftKey}`, { method: 'POST' }).then(setD).catch((e) => setErr(e.message)); }, [id, draftKey]);
  const mailto = d ? `mailto:${encodeURIComponent(d.to)}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}` : '#';
  return (
    <Modal title={d?.label ?? 'Draft'} onClose={onClose} wide footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Close</button>
      {d && <button className="btn btn-secondary" onClick={() => navigator.clipboard?.writeText(`${d.subject}\n\n${d.body}`).then(() => setCopied(true)).catch(() => {})}>{copied ? 'Copied' : 'Copy'}</button>}
      {d && <a className="btn btn-primary" href={mailto}>Open in my email</a>}</>}>
      {err && <Alert kind="error">{err}</Alert>}
      {!d ? <div className="spinner" /> : <>
        <p className="muted small">VendorGate doesn’t send this. Check it, change what you need, and send it from your own email.</p>
        <div className="field"><label htmlFor="dr-to">To</label><input id="dr-to" value={d.to} onChange={(e) => setD({ ...d, to: e.target.value })} placeholder="Their email address" /></div>
        <div className="field"><label htmlFor="dr-sub">Subject</label><input id="dr-sub" value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} /></div>
        <div className="field"><label htmlFor="dr-body">Message</label><textarea id="dr-body" rows={14} value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} /></div>
      </>}
    </Modal>
  );
}
