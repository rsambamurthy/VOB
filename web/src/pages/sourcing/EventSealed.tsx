/** The buyer's side of step 3: technical scoring sheet (draft), offers received, opening committee, technical evaluation, comparison. */
import { useEffect, useState } from 'react';
import { api, docUrl } from '../../lib/api';
import { fmtDateTime, money } from '../../lib/format';
import { Alert, Empty } from '../../components/ui';

type Env = 'single' | 'technical' | 'commercial';
interface Quote { bidderId: string; alias: string; vendor: string; total: number; rank: string; lines: { lineId: string; unitPrice: number }[] | null; taxPct: number | null; deliveryDays: number | null; validityDays: number | null; paymentTerms: string }
interface ScoreRow { id: string; alias: string; vendor: string; status: string; submitted: boolean; score: number | null; note: string | null; evaluations: { evaluator: string; scores: Record<string, number>; comment: string | null; total: number }[]; mine: { scores: Record<string, number>; comment: string | null } | null }
export interface Sealed {
  envelopes: Env[]; deadline: string | null; deadlinePassed: boolean; opened: Partial<Record<Env, string>>; technicalDoneAt: string | null;
  received: { bidderId: string; alias: string; vendor: string; envelope: Env; version: number; submittedAt: string; withdrawn: boolean; receipt: string; opened: boolean }[];
  opening: { envelope: Env; quorum: number; confirmed: { name: string; at: string }[]; canConfirm: boolean } | null;
  scoring: { criteria: { id: string; label: string; weight: number }[]; passMark: number | null; done: boolean; bidders: ScoreRow[] } | null;
  offers: { technical: { bidderId: string; alias: string; vendor: string; content: { remarks?: string }; attachments: { documentId: string; fileName: string }[] }[]; priced: { bidderId: string; attachments: { documentId: string; fileName: string }[]; content: { remarks?: string } }[];
    comparison: { lotId: string; position: number; title: string; bidMode: string; startPrice: string | null; target: string | null; quotes: Quote[] }[] };
  committee: string[];
}
export type Scoring = { criteria: { id: string; label: string; weight: number }[]; passMark: number } | null;
type Done = (data: any, msg: string) => void;
const ENV_ORDER: Env[] = ['single', 'technical', 'commercial'];
const ENV_LABEL: Record<Env, string> = { single: 'offers', technical: 'technical envelopes', commercial: 'commercial envelopes' };

/** Draft: the technical scoring sheet (weighted criteria and pass mark) used with two envelopes. */
export function ScoringEditor({ eventId, scoring, canEdit, onDone, onError }: { eventId: string; scoring: Scoring; canEdit: boolean; onDone: Done; onError: (m: string) => void }) {
  const [rows, setRows] = useState(scoring?.criteria ?? []);
  const [pass, setPass] = useState(String(scoring?.passMark ?? 60));
  useEffect(() => { setRows(scoring?.criteria ?? []); setPass(String(scoring?.passMark ?? 60)); }, [scoring]);
  const total = rows.reduce((n, r) => n + (Number(r.weight) || 0), 0);
  async function save() {
    try { onDone(await api(`/staff/sourcing/events/${eventId}`, { method: 'PATCH', body: { scoring: rows.length ? { criteria: rows.map((r) => ({ ...r, weight: Number(r.weight) })), passMark: Number(pass) } : null } }), 'Scoring sheet saved.'); }
    catch (e: any) { onError(e.message); }
  }
  return (
    <section className="card pad section-card">
      <h3>Technical scoring</h3>
      <p className="muted small">Used with two envelopes: evaluators score each bidder 0–10 per criterion; bidders at or above the pass mark qualify and only their prices are opened.</p>
      {rows.map((r, i) => (
        <div key={r.id} className="field-grid" style={{ gridTemplateColumns: '1fr 120px 32px', alignItems: 'end' }}>
          <div className="field"><label htmlFor={`cr-${i}`}>Criterion {i + 1}</label><input id={`cr-${i}`} disabled={!canEdit} value={r.label} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))} /></div>
          <div className="field"><label htmlFor={`cw-${i}`}>Weight %</label><input id={`cw-${i}`} inputMode="decimal" disabled={!canEdit} value={r.weight} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, weight: e.target.value as any } : x)))} /></div>
          {canEdit && <button className="icon-btn" aria-label={`Remove criterion ${i + 1}`} onClick={() => setRows(rows.filter((_, k) => k !== i))}>×</button>}
        </div>))}
      {canEdit && <button className="link-btn small" onClick={() => setRows([...rows, { id: `c${Date.now().toString(36)}`, label: '', weight: 0 }])}>+ Add criterion</button>}
      <div className="field" style={{ maxWidth: 200 }}><label htmlFor="pass-mark">Pass mark %</label><input id="pass-mark" inputMode="decimal" disabled={!canEdit} value={pass} onChange={(e) => setPass(e.target.value)} /></div>
      {rows.length > 0 && <p className={`small ${Math.abs(total - 100) < 0.01 ? 'muted' : 'diff-text'}`}>Weights add up to {total}%{Math.abs(total - 100) < 0.01 ? '' : ' — they must add up to 100'}.</p>}
      {canEdit && <div className="btn-row"><button className="btn btn-secondary btn-sm" onClick={save}>Save scoring sheet</button></div>}
    </section>
  );
}

export function SealedCard({ s, eventId, format, currency, perms, onDone, onError }: { s: Sealed; eventId: string; format: string; currency: string; perms: { open: boolean; evaluate: boolean; manage: boolean }; onDone: Done; onError: (m: string) => void }) {
  const post = async (path: string, body: unknown, msg: (r: any) => string) => { try { const r = await api<any>(`/staff/sourcing/events/${eventId}/${path}`, { body }); onDone(r, msg(r)); } catch (e: any) { onError(e.message); } };
  const latest = new Map<string, Sealed['received'][number]>();
  for (const r of s.received) latest.set(`${r.bidderId}:${r.envelope}`, r);
  return (<>
    <section className="card pad section-card">
      <h3>Sealed offers</h3>
      <p className="muted small">{s.envelopes.length === 2 ? 'Two envelopes: technical, then commercial. ' : ''}Bids {s.deadlinePassed ? 'closed' : 'close'} {fmtDateTime(s.deadline)}. Nobody can see an offer until the opening committee opens it after the deadline. Committee: {s.committee.join(', ') || 'nobody has the opening permission yet'}.</p>
      {!s.received.length ? <Empty>No offers received yet.</Empty> : (
        <table className="table static compact">
          <thead><tr><th>Bidder</th><th>Envelope</th><th>Version</th><th>Received</th><th>Receipt</th><th>State</th></tr></thead>
          <tbody>{[...latest.values()].sort((a, b) => a.alias.localeCompare(b.alias, undefined, { numeric: true }) || ENV_ORDER.indexOf(a.envelope) - ENV_ORDER.indexOf(b.envelope)).map((r) => (
            <tr key={`${r.bidderId}:${r.envelope}`} className={r.withdrawn ? 'muted' : ''}><td>{r.alias} <span className="muted small">{r.vendor}</span></td><td className="small">{r.envelope === 'single' ? 'Offer' : r.envelope}</td><td>{r.version}</td><td className="small">{fmtDateTime(r.submittedAt)}</td><td className="mono small">{r.receipt}</td>
              <td>{r.withdrawn ? <span className="badge sm">Withdrawn</span> : r.opened ? <span className="badge badge-approved sm">Opened</span> : <span className="badge sm">🔒 Sealed</span>}</td></tr>))}</tbody>
        </table>)}
      {s.opening && (
        <div className="card pad" style={{ marginTop: 12, background: 'var(--bg-soft, #f7f8fa)' }}>
          <strong>Open the {ENV_LABEL[s.opening.envelope]}</strong>
          <p className="small" style={{ margin: '4px 0' }}>{s.opening.confirmed.length} of {s.opening.quorum} committee members confirmed{s.opening.confirmed.length ? `: ${s.opening.confirmed.map((c) => `${c.name} (${fmtDateTime(c.at)})`).join(', ')}` : ''}.</p>
          {s.opening.canConfirm ? <button className="btn btn-primary btn-sm" onClick={() => post('open', {}, (r) => (r.opened ? `The ${ENV_LABEL[s.opening!.envelope]} are open.` : `Confirmed (${r.confirmations} of ${r.quorum}).`))}>Confirm opening</button>
            : <p className="muted small">{perms.open ? 'You have confirmed. Waiting for the others.' : 'Only opening committee members can confirm.'}</p>}
        </div>)}
      {!s.opening && s.opened.technical && !s.technicalDoneAt && <Alert kind="info">Technical envelopes are open. Score the bidders and finish the evaluation; then the committee opens the commercial envelopes of qualified bidders.</Alert>}
    </section>
    {s.scoring && s.opened.technical && <Technical s={s} eventId={eventId} perms={perms} onDone={onDone} onError={onError} />}
    {s.offers.comparison.some((l) => l.quotes.length) && <Comparison s={s} format={format} currency={currency} canStart={perms.manage && format !== 'rfq'} onStart={() => post('start-prices', {}, (r) => `Start prices set from the best sealed prices: ${r.set.map((x: any) => `lot ${x.lot} ${money(x.price, currency)}`).join(', ')}.`)} />}
  </>);
}

function Technical({ s, eventId, perms, onDone, onError }: { s: Sealed; eventId: string; perms: { evaluate: boolean; manage: boolean }; onDone: Done; onError: (m: string) => void }) {
  const sc = s.scoring!;
  const [mine, setMine] = useState<Record<string, Record<string, string>>>({});
  const [decide, setDecide] = useState<Record<string, { qualified: boolean; note: string }>>({});
  useEffect(() => { setMine(Object.fromEntries(sc.bidders.map((b) => [b.id, Object.fromEntries(sc.criteria.map((c) => [c.id, b.mine?.scores[c.id] !== undefined ? String(b.mine.scores[c.id]) : '']))]))); }, [s]); // eslint-disable-line react-hooks/exhaustive-deps
  const offer = (id: string) => s.offers.technical.find((o) => o.bidderId === id);
  async function save(b: ScoreRow) {
    try { onDone(await api(`/staff/sourcing/events/${eventId}/scores/${b.id}`, { method: 'PUT', body: { scores: Object.fromEntries(Object.entries(mine[b.id] ?? {}).map(([k, v]) => [k, Number(v)])) } }), `Scores saved for ${b.alias}.`); } catch (e: any) { onError(e.message); }
  }
  async function finish() {
    try { onDone(await api(`/staff/sourcing/events/${eventId}/technical/finish`, { body: { decisions: Object.entries(decide).map(([bidderId, d]) => ({ bidderId, ...d })) } }), 'Technical evaluation finished. Bidders were told the result.'); } catch (e: any) { onError(e.message); }
  }
  const byMark = (b: ScoreRow) => (sc.criteria.length && b.score !== null && sc.passMark !== null ? b.score >= sc.passMark : null);
  return (
    <section className="card pad section-card">
      <h3>Technical evaluation{sc.done && <span className="badge badge-approved sm" style={{ marginInlineStart: 6 }}>Finished</span>}</h3>
      {sc.criteria.length > 0 && <p className="muted small">Criteria: {sc.criteria.map((c) => `${c.label} ${c.weight}%`).join(' · ')} · pass mark {sc.passMark}%. Each evaluator scores 0–10; the score is the average of evaluators.</p>}
      {sc.bidders.map((b) => {
        const o = offer(b.id);
        const auto = byMark(b);
        const d = decide[b.id];
        return (
          <div key={b.id} className="card pad" style={{ marginBottom: 10 }}>
            <div className="row-between"><strong>{b.alias} <span className="muted small">{b.vendor}</span></strong>
              <span>{b.score !== null && <strong>{b.score}%</strong>} {sc.done ? <span className={`badge sm ${b.status === 'QUALIFIED' ? 'badge-approved' : 'badge-rejected'}`}>{b.status === 'QUALIFIED' ? 'Qualified' : 'Not qualified'}</span> : !b.submitted ? <span className="badge sm">No technical offer</span> : auto !== null && <span className={`badge sm ${auto ? 'badge-approved' : 'badge-rejected'}`}>{auto ? 'Above pass mark' : 'Below pass mark'}</span>}</span></div>
            {o?.content.remarks && <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{o.content.remarks}</p>}
            {o?.attachments.length ? <div className="small">{o.attachments.map((f) => <a key={f.documentId} href={docUrl(f.documentId)} target="_blank" rel="noreferrer" style={{ marginInlineEnd: 10 }}>📎 {f.fileName}</a>)}</div> : null}
            {b.note && <div className="small muted">Note: {b.note}</div>}
            {b.evaluations.length > 0 && <div className="small muted">{b.evaluations.map((ev) => `${ev.evaluator}: ${ev.total}%${ev.comment ? ` (“${ev.comment}”)` : ''}`).join(' · ')}</div>}
            {!sc.done && b.submitted && perms.evaluate && sc.criteria.length > 0 && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap', marginTop: 6 }}>
                {sc.criteria.map((c) => <div key={c.id} className="field" style={{ width: 120 }}><label htmlFor={`s-${b.id}-${c.id}`}>{c.label}</label><input id={`s-${b.id}-${c.id}`} type="number" min={0} max={10} step={0.5} value={mine[b.id]?.[c.id] ?? ''} onChange={(e) => setMine({ ...mine, [b.id]: { ...mine[b.id], [c.id]: e.target.value } })} /></div>)}
                <button className="btn btn-secondary btn-sm" onClick={() => save(b)}>Save my scores</button>
              </div>)}
            {!sc.done && b.submitted && perms.manage && (
              <div className="small" style={{ marginTop: 6 }}>
                <label className="checkbox"><input type="checkbox" checked={!!d} onChange={(e) => { const n = { ...decide }; if (e.target.checked) n[b.id] = { qualified: !(auto ?? true), note: '' }; else delete n[b.id]; setDecide(n); }} /> {auto === null ? 'Decide' : 'Decide differently from the pass mark'}</label>
                {d && <span style={{ display: 'inline-flex', gap: 6, marginInlineStart: 8 }}>
                  <select aria-label={`Decision for ${b.alias}`} value={d.qualified ? 'yes' : 'no'} onChange={(e) => setDecide({ ...decide, [b.id]: { ...d, qualified: e.target.value === 'yes' } })}><option value="yes">Qualified</option><option value="no">Not qualified</option></select>
                  <input aria-label={`Reason for ${b.alias}`} placeholder="Reason" value={d.note} onChange={(e) => setDecide({ ...decide, [b.id]: { ...d, note: e.target.value } })} /></span>}
              </div>)}
          </div>);
      })}
      {!sc.done && perms.manage && <div className="btn-row"><button className="btn btn-primary" onClick={finish}>Finish technical evaluation</button></div>}
    </section>
  );
}

function Comparison({ s, format, currency, canStart, onStart }: { s: Sealed; format: string; currency: string; canStart: boolean; onStart: () => void }) {
  const files = (id: string) => s.offers.priced.find((p) => p.bidderId === id)?.attachments ?? [];
  const remarks = (id: string) => s.offers.priced.find((p) => p.bidderId === id)?.content.remarks;
  return (
    <section className="card pad section-card">
      <div className="toolbar"><div><h3>Comparison</h3><p className="muted small">Opened prices, best first ({format === 'forward' ? 'H1 = highest' : 'L1 = lowest'}). Totals are before tax.</p></div>
        {canStart && <button className="btn btn-secondary btn-sm" onClick={onStart}>Set auction start prices from the best sealed prices</button>}</div>
      {s.offers.comparison.map((lot) => (
        <div key={lot.lotId} style={{ marginBottom: 12 }}>
          <div className="row-between"><strong>Lot {lot.position}: {lot.title}</strong><span className="muted small">{lot.target ? `Target ${money(lot.target, currency)}` : ''}{lot.startPrice && format !== 'rfq' ? ` · start ${money(lot.startPrice, currency)}` : ''}</span></div>
          {!lot.quotes.length ? <p className="muted small">No prices for this lot.</p> : (
            <table className="table static compact">
              <thead><tr><th>Rank</th><th>Bidder</th><th className="num">Total</th><th className="num">vs target</th><th className="num">Tax</th><th className="num">Delivery</th><th className="num">Valid</th><th>Payment</th><th>Files / remarks</th></tr></thead>
              <tbody>{lot.quotes.map((q) => (
                <tr key={q.bidderId}><td><strong>{q.rank}</strong></td><td>{q.alias} <span className="muted small">{q.vendor}</span></td><td className="num">{money(q.total, currency)}</td>
                  <td className="num small">{lot.target ? `${(((q.total - Number(lot.target)) / Number(lot.target)) * 100).toFixed(1)}%` : '—'}</td>
                  <td className="num small">{q.taxPct ?? '—'}{q.taxPct !== null ? '%' : ''}</td><td className="num small">{q.deliveryDays ?? '—'}{q.deliveryDays !== null ? ' d' : ''}</td><td className="num small">{q.validityDays ?? '—'}{q.validityDays !== null ? ' d' : ''}</td><td className="small">{q.paymentTerms || '—'}</td>
                  <td className="small">{files(q.bidderId).map((f) => <a key={f.documentId} href={docUrl(f.documentId)} target="_blank" rel="noreferrer" style={{ marginInlineEnd: 6 }}>📎 {f.fileName}</a>)}{remarks(q.bidderId) && <div className="muted">{remarks(q.bidderId)}</div>}</td></tr>))}</tbody>
            </table>)}
        </div>))}
    </section>
  );
}
