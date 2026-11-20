/** The buyer's live auction monitor: time, controls (pause, extend, message), rankings, savings, bid log with strike-outs. */
import { useState } from 'react';
import { api } from '../../lib/api';
import { fmtDateTime, money } from '../../lib/format';
import { Alert, Empty, Modal } from '../../components/ui';
import { clock, useCountdown, useLive } from '../../lib/live';

interface LiveView {
  phase: 'upcoming' | 'live' | 'paused' | 'closed'; serverTime: string; startsAt: string; endsAt: string; pausedAt: string | null; extensionsUsed: number; maxExtensions: number; extensionMinutes: number; minStepPct: number; confirmDropPct: number;
  eligible: { alias: string; vendor: string; bids: number }[];
  lots: { id: string; position: number; title: string; startPrice: number | null; target: number | null; best: number | null; savingPct: number | null; ranking: { rank: number; alias: string; vendor: string; amount: number; at: string; bids: number }[] }[];
  log: { id: string; seq: number; lot: number; alias: string; vendor: string; amount: number; at: string; by: string | null; hash: string; struck: { reason: string; by: string; requestedBy: string } | null; strikeRequest: { by: string; reason: string; mine: boolean } | null }[];
  totalBids: number;
}
const PHASE: Record<LiveView['phase'], { label: string; cls: string }> = { upcoming: { label: 'Starts in', cls: 'badge-invited' }, live: { label: 'Live — ends in', cls: 'badge-approved' }, paused: { label: 'Paused', cls: 'badge-under_review' }, closed: { label: 'Closed', cls: '' } };

export function LiveMonitor({ eventId, currency, canControl, onPhase }: { eventId: string; currency: string; canControl: boolean; onPhase?: () => void }) {
  const { data, setData, reload, offset, connected } = useLive<LiveView>(`/staff/sourcing/events/${eventId}/live`, `/staff/sourcing/events/${eventId}/stream`, (r) => r.live);
  const [dialog, setDialog] = useState<'pause' | 'extend' | 'message' | { strike: string } | null>(null);
  const [text, setText] = useState('');
  const [minutes, setMinutes] = useState('10');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const [chain, setChain] = useState<{ ok: boolean; bids: number; brokenAt: number | null }>();
  const left = useCountdown(data?.phase === 'upcoming' ? data.startsAt : data?.phase === 'live' ? data.endsAt : null, offset, () => { reload(); onPhase?.(); });
  if (data === undefined) return <div className="spinner" />;
  if (!data) return null;
  const act = async (path: string, body: unknown, ok: string) => {
    setMsg(undefined);
    try { const r = await api<{ live: LiveView }>(`/staff/sourcing/events/${eventId}/${path}`, { body }); setData(r.live); setMsg({ kind: 'success', text: ok }); setDialog(null); setText(''); }
    catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  };
  const ph = PHASE[data.phase];
  return (
    <section className="card pad section-card">
      <div className="toolbar"><div><h3>Live auction</h3>
        <p className="muted small">{fmtDateTime(data.startsAt)} – {fmtDateTime(data.endsAt)} · step {data.minStepPct}% below own last bid{data.extensionMinutes ? ` · auto-extension ${data.extensionMinutes} min (${data.extensionsUsed}/${data.maxExtensions} used)` : ''} · {data.eligible.length} bidder{data.eligible.length === 1 ? '' : 's'} · {connected ? 'live updates on' : 'refreshing every few seconds'}</p></div>
        <div style={{ textAlign: 'end' }}><span className={`badge ${ph.cls}`}>{ph.label}</span>{(data.phase === 'live' || data.phase === 'upcoming') && <div style={{ fontSize: 28, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{clock(left)}</div>}</div></div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {canControl && data.phase !== 'closed' && <div className="btn-row" style={{ marginBottom: 10 }}>
        {data.phase === 'live' && <button className="btn btn-secondary btn-sm" onClick={() => setDialog('pause')}>Pause</button>}
        {data.phase === 'paused' && <button className="btn btn-primary btn-sm" onClick={() => act('resume', {}, 'Resumed. The end time moved out by the pause.')}>Resume</button>}
        <button className="btn btn-secondary btn-sm" onClick={() => setDialog('extend')}>Extend</button>
        <button className="btn btn-secondary btn-sm" onClick={() => setDialog('message')}>Message all bidders</button>
      </div>}
      {!data.eligible.length && <Alert kind="warning">No bidder can bid yet — they must accept the invitation (and qualify, if there was a sealed round).</Alert>}
      {data.lots.map((l) => (
        <div key={l.id} style={{ marginBottom: 12 }}>
          <div className="row-between"><strong>Lot {l.position}: {l.title}</strong>
            <span className="small">{l.best !== null ? <>Best <strong>{money(l.best, currency)}</strong></> : 'No bids yet'}{l.startPrice ? ` · start ${money(l.startPrice, currency)}` : ''}{l.savingPct !== null ? ` · saving ${l.savingPct}%` : ''}{l.target ? ` · target ${money(l.target, currency)}${l.best !== null ? (l.best <= l.target ? ' ✓ reached' : ' not reached') : ''}` : ''}</span></div>
          {l.ranking.length ? <table className="table static compact">
            <thead><tr><th>Rank</th><th>Bidder</th><th className="num">Best bid</th><th>When</th><th className="num">Bids</th></tr></thead>
            <tbody>{l.ranking.map((r) => <tr key={r.alias}><td><strong>L{r.rank}</strong></td><td>{r.alias} <span className="muted small">{r.vendor}</span></td><td className="num">{money(r.amount, currency)}</td><td className="small">{fmtDateTime(r.at)}</td><td className="num">{r.bids}</td></tr>)}</tbody>
          </table> : null}
        </div>))}
      <details>
        <summary className="small"><strong>Bid history</strong> ({data.totalBids}) · tamper-evident (each bid’s hash includes the one before)</summary>
        <div className="btn-row" style={{ margin: '8px 0' }}>
          <a className="btn btn-secondary btn-sm" href={`/api/staff/sourcing/events/${eventId}/bids.csv`}>Download CSV</a>
          <button className="btn btn-secondary btn-sm" onClick={async () => setChain(await api(`/staff/sourcing/events/${eventId}/verify`))}>Verify history</button>
          {chain && <span className={`small ${chain.ok ? '' : 'diff-text'}`}>{chain.ok ? `✓ All ${chain.bids} bids verified — nothing changed.` : `✗ The history was changed at bid #${chain.brokenAt}.`}</span>}
        </div>
        {!data.log.length ? <Empty>No bids yet.</Empty> : <table className="table static compact">
          <thead><tr><th>#</th><th>Time</th><th>Lot</th><th>Bidder</th><th className="num">Amount</th><th>Hash</th><th /></tr></thead>
          <tbody>{data.log.map((b) => (
            <tr key={b.id} className={b.struck ? 'muted' : ''}>
              <td>{b.seq}</td><td className="small">{new Date(b.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.{String(new Date(b.at).getMilliseconds()).padStart(3, '0')}</td><td>{b.lot}</td>
              <td>{b.alias} <span className="muted small">{b.vendor}{b.by ? ` · ${b.by}` : ''}</span></td>
              <td className="num" style={b.struck ? { textDecoration: 'line-through' } : undefined}>{money(b.amount, currency)}</td><td className="mono small">{b.hash}</td>
              <td className="small">{b.struck ? <span title={`Asked by ${b.struck.requestedBy}, confirmed by ${b.struck.by}`}>Struck out: {b.struck.reason}</span>
                : b.strikeRequest ? <>Strike-out asked by {b.strikeRequest.by}: “{b.strikeRequest.reason}” {canControl && (b.strikeRequest.mine ? <button className="link-btn small" onClick={() => api<{ live: LiveView }>(`/staff/sourcing/events/${eventId}/bids/${b.id}/strike`, { method: 'DELETE' }).then((r) => setData(r.live))}>Cancel</button>
                  : <button className="link-btn small" onClick={() => act(`bids/${b.id}/strike/confirm`, {}, `Bid #${b.seq} struck out.`)}>Confirm strike-out</button>)}</>
                : canControl && <button className="link-btn small" onClick={() => setDialog({ strike: b.id })}>Strike out…</button>}</td>
            </tr>))}</tbody>
        </table>}
      </details>
      {dialog && (
        <Modal title={dialog === 'pause' ? 'Pause the auction' : dialog === 'extend' ? 'Extend the auction' : dialog === 'message' ? 'Message all bidders' : 'Strike out a mistaken bid'} onClose={() => setDialog(null)}
          footer={<><button className="btn btn-secondary" onClick={() => setDialog(null)}>Close</button>
            <button className="btn btn-primary" disabled={!text.trim()} onClick={() => dialog === 'pause' ? act('pause', { reason: text }, 'Paused. Bidders see that the auction is paused.')
              : dialog === 'extend' ? act('extend', { minutes: Number(minutes), reason: text }, `Extended by ${minutes} minutes.`)
              : dialog === 'message' ? act('message', { message: text }, 'Sent to every bidder.')
              : act(`bids/${dialog.strike}/strike`, { reason: text }, 'Asked. Another person with live-auction control must confirm.')}>
              {dialog === 'pause' ? 'Pause' : dialog === 'extend' ? 'Extend' : dialog === 'message' ? 'Send' : 'Ask to strike out'}</button></>}>
          {dialog === 'extend' && <div className="field"><label htmlFor="ext-min">Minutes</label><input id="ext-min" type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} /></div>}
          <div className="field"><label htmlFor="live-text">{dialog === 'message' ? 'Message' : 'Reason'}</label><textarea id="live-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="field-help">{dialog === 'message' ? 'Shown on every bidder’s auction screen and emailed. Bidders never see each other’s names.' : typeof dialog === 'object' ? 'For an obvious typing mistake only. The bid stays in the history, marked as struck out; a second person must confirm.' : 'Recorded in the history.'}</div></div>
        </Modal>)}
    </section>
  );
}
