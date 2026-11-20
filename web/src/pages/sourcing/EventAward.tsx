/**
 * Step 5 — the award: results per lot (live bids or opened sealed prices), choosing a winner or splitting by share,
 * reason when not all to the best price, the award's own approval (FlowPanel), then letters, new-supplier onboarding,
 * ERP award messages and savings.
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { fmtDateTime, money } from '../../lib/format';
import { Alert } from '../../components/ui';
import { MessageStatus } from '../../components/ErpMessage';
import { FlowPanel, type FlowDecision, type FlowViewData } from '../../components/ApprovalFlow';

interface Candidate { bidderId: string; alias: string; vendor: string; vendorId: string; amount: number; rank: number; paymentTerms: string | null; deliveryDays: number | null; taxPct: number | null }
interface AwardRow { bidderId: string; sharePct: number; amount: number; rank: number | null; reason: string | null; erpStatus: string | null; letterSentAt: string | null; status: string }
interface AwardLot { lotId: string; position: number; title: string; startPrice: number | null; target: number | null; candidates: Candidate[]; award: AwardRow[] }
export interface Award {
  source: 'live' | 'sealed'; lots: AwardLot[]; status: string; note: string | null; proposedBy: string | null; awardedAt: string | null; canPropose: boolean; returned: string | null;
  savings: { awardedTotal: number; estimate: number | null; vsEstimatePct: number | null; startTotal: number | null; vsStartPct: number | null } | null;
  approval: FlowViewData;
  winners: { bidderId: string; alias: string; vendor: string; vendorStatus: string; newSupplier: boolean }[];
  erp: { id: string; status: string; vendor: string; target: string | null; error: string | null; sentAt: string | null; createdAt: string }[];
}
type Done = (data: any, msg: string) => void;
type Split = { bidderId: string; share: string };
type Plan = Record<string, { splits: Split[]; reason: string }>;

const ERP_LABEL: Record<string, string> = { WAITING_ONBOARDING: 'Sent once the supplier is approved', NOT_SENT: 'Not sent (award messages are off)' };
const pct = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}%`);
/** Default: everything to the best price. */
const bestPlan = (a: Award): Plan => Object.fromEntries(a.lots.map((l) => [l.lotId, { splits: l.candidates.length ? [{ bidderId: l.candidates[0].bidderId, share: '100' }] : [], reason: '' }]));

export function AwardCard({ a, eventId, currency, canManage, onDone, onError }: { a: Award; eventId: string; currency: string; canManage: boolean; onDone: Done; onError: (m: string) => void }) {
  const [plan, setPlan] = useState<Plan>(() => bestPlan(a));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setPlan(bestPlan(a)); }, [a]);
  const proposing = a.canPropose && canManage;
  const total = useMemo(() => a.lots.reduce((n, l) => n + (plan[l.lotId]?.splits ?? []).reduce((m, s) => m + (l.candidates.find((c) => c.bidderId === s.bidderId)?.amount ?? 0) * (Number(s.share) || 0) / 100, 0), 0), [a, plan]);
  const set = (lotId: string, p: Partial<Plan[string]>) => setPlan({ ...plan, [lotId]: { ...plan[lotId], ...p } });

  async function propose() {
    setBusy(true);
    try {
      const r = await api<{ status: string; levels: string[] }>(`/staff/sourcing/events/${eventId}/award`, { body: { note: note || undefined, lots: a.lots.filter((l) => plan[l.lotId]?.splits.length).map((l) => ({ lotId: l.lotId, reason: plan[l.lotId].reason || undefined, splits: plan[l.lotId].splits.map((s) => ({ bidderId: s.bidderId, sharePct: Number(s.share) })) })) } });
      onDone(r, r.status === 'AWARDED' ? 'Awarded — no approval was needed. Letters and ERP messages have gone.' : `Award proposed. Approval: ${r.levels.join(' → ')}.`);
    } catch (e: any) { onError(e.message); } finally { setBusy(false); }
  }
  async function decide(action: FlowDecision, remarks: string) {
    const r = await api<{ status: string; nextLevel?: string }>(`/staff/sourcing/events/${eventId}/award/decision`, { body: { action, remarks } });
    onDone(r, action === 'APPROVE' ? (r.nextLevel ? `Approved. Next: ${r.nextLevel}.` : 'Award approved. Letters and ERP messages have gone.') : action === 'SEND_BACK' ? 'Award sent back to the owner.' : 'Award rejected.');
  }
  async function withdraw() {
    try { onDone(await api(`/staff/sourcing/events/${eventId}/award/withdraw`, { method: 'POST' }), 'Award withdrawn — you can propose again.'); } catch (e: any) { onError(e.message); }
  }

  return (
    <section className="card pad section-card" id="award">
      <h3>Award</h3>
      <p className="muted small">Results from {a.source === 'live' ? 'the live auction (each bidder’s best valid bid)' : 'the opened offers'}, best price first.
        {proposing && ' Pick the winner for each lot, or split a lot between bidders by share. Not giving everything to the best price needs a reason and may need more approval.'}</p>
      {a.returned && a.canPropose && <Alert kind="warning">The last award proposal was {a.returned === 'REJECTED' ? 'rejected' : 'sent back'}. See the approval history; propose again when ready.</Alert>}
      {a.lots.map((l) => {
        const mine = plan[l.lotId] ?? { splits: [], reason: '' };
        const shown = proposing ? null : l.award;
        const shareSum = mine.splits.reduce((n, s) => n + (Number(s.share) || 0), 0);
        const notBest = mine.splits.some((s) => l.candidates.find((c) => c.bidderId === s.bidderId)?.rank !== 1);
        return (
          <div key={l.lotId} className="award-lot" style={{ marginBottom: 16 }}>
            <h4 style={{ margin: '8px 0' }}>Lot {l.position} · {l.title}{l.startPrice !== null && <span className="muted small"> — start {money(l.startPrice, currency)}</span>}</h4>
            {l.candidates.length === 0 ? <p className="muted small">No valid prices for this lot.</p> : (
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Rank</th><th>Bidder</th><th className="num">Price</th><th>Terms</th>{proposing ? <th className="num">Share %</th> : <th className="num">Awarded</th>}</tr></thead>
                <tbody>{l.candidates.map((c) => {
                  const s = mine.splits.find((x) => x.bidderId === c.bidderId);
                  const got = shown?.find((x) => x.bidderId === c.bidderId);
                  return (
                    <tr key={c.bidderId} className={got || s ? 'selected' : undefined}>
                      <td>L{c.rank}</td>
                      <td>{c.vendor} <span className="muted small">({c.alias})</span></td>
                      <td className="num">{money(c.amount, currency)}</td>
                      <td className="small muted">{[c.paymentTerms, c.deliveryDays !== null ? `${c.deliveryDays} days` : null].filter(Boolean).join(' · ') || '—'}</td>
                      {proposing ? (
                        <td className="num"><input aria-label={`Share for ${c.alias} in lot ${l.position}`} inputMode="decimal" style={{ width: 70, textAlign: 'right' }} value={s?.share ?? ''}
                          onChange={(e) => { const v = e.target.value; const rest = mine.splits.filter((x) => x.bidderId !== c.bidderId); set(l.lotId, { splits: v.trim() === '' || Number(v) === 0 ? rest : [...rest, { bidderId: c.bidderId, share: v }] }); }} /></td>
                      ) : <td className="num">{got ? `${got.sharePct}% · ${money(got.amount, currency)}` : '—'}</td>}
                    </tr>
                  );
                })}</tbody>
              </table></div>
            )}
            {proposing && mine.splits.length > 0 && shareSum !== 100 && <p className="field-error small">Shares add up to {shareSum}% — they must add up to 100%.</p>}
            {proposing && notBest && <div className="field"><label htmlFor={`reason-${l.lotId}`}>Reason for not awarding everything to the best price</label>
              <textarea id={`reason-${l.lotId}`} rows={2} value={mine.reason} onChange={(e) => set(l.lotId, { reason: e.target.value })} /></div>}
            {!proposing && l.award.find((x) => x.reason) && <p className="small"><strong>Reason:</strong> {l.award.find((x) => x.reason)!.reason}</p>}
          </div>
        );
      })}

      {proposing && <>
        <div className="field"><label htmlFor="award-note">Note for the approvers (optional)</label><textarea id="award-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></div>
        <div className="row-between"><span>Award total: <strong>{money(total, currency)}</strong></span>
          <button className="btn btn-primary" disabled={busy} onClick={propose}>Propose award</button></div>
      </>}

      {!a.canPropose && <>
        {a.note && <p className="small"><strong>Note:</strong> {a.note}</p>}
        <p className="muted small">Proposed by {a.proposedBy ?? '—'}{a.awardedAt ? ` · awarded ${fmtDateTime(a.awardedAt)}` : ''}</p>
        {a.savings && <div className="stat-row" style={{ display: 'flex', gap: 24, flexWrap: 'wrap', margin: '8px 0' }}>
          <div><div className="muted small">Award total</div><strong>{money(a.savings.awardedTotal, currency)}</strong></div>
          {a.savings.estimate !== null && <div><div className="muted small">Saving vs estimate</div><strong>{pct(a.savings.vsEstimatePct)}</strong></div>}
          {a.savings.startTotal !== null && <div><div className="muted small">Saving vs start price</div><strong>{pct(a.savings.vsStartPct)}</strong></div>}
        </div>}
        {a.status === 'AWARD_PENDING' && canManage && <button className="btn btn-secondary" onClick={withdraw}>Withdraw award</button>}
      </>}

      {a.status === 'AWARDED' && <>
        <h4>Winners</h4>
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Supplier</th><th>Status</th><th>ERP award message</th></tr></thead>
          <tbody>{a.winners.map((w) => {
            const msg = a.erp.find((m) => m.vendor === w.vendor);
            const waiting = a.lots.flatMap((l) => l.award).find((x) => x.bidderId === w.bidderId)?.erpStatus;
            return (
              <tr key={w.bidderId}><td>{w.vendor}</td>
                <td>{w.newSupplier ? <span className="badge flag-medium">New supplier — onboarding started</span> : <span className="badge badge-approved">Approved supplier</span>}</td>
                <td>{msg ? <MessageStatus status={msg.status} error={msg.error} /> : <span className="muted small">{ERP_LABEL[waiting ?? ''] ?? '—'}</span>}</td></tr>
            );
          })}</tbody>
        </table></div>
      </>}

      {(a.status === 'AWARD_PENDING' || a.approval.steps.length > 0) && <FlowPanel flow={a.approval} onDecide={decide} title="Award approval" empty="No approval was needed." />}
    </section>
  );
}
