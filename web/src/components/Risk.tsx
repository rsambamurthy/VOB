import { fmtDateTime } from '../lib/format';

export type Band = 'LOW' | 'MEDIUM' | 'HIGH';
export interface RiskSignal { code: string; label: string; points: number; critical?: boolean }
const LABEL: Record<Band, string> = { LOW: 'Low risk', MEDIUM: 'Medium risk', HIGH: 'High risk' };

/** "High risk · 65" — used for supplier risk scores and questionnaire results (staff only). */
export function RiskBadge({ band, percent, score }: { band: string | null | undefined; percent?: number | null; score?: number | null }) {
  if (!band) return null;
  const extra = percent !== null && percent !== undefined ? ` · ${percent}%` : score !== null && score !== undefined ? ` · ${score}` : '';
  return <span className={`badge sm risk-${band.toLowerCase()}`}>{LABEL[band as Band] ?? band}{extra}</span>;
}

/** What makes up a risk score, worst first. */
export function RiskSignals({ signals, limit }: { signals: RiskSignal[]; limit?: number }) {
  const list = [...signals].sort((a, b) => Number(!!b.critical) - Number(!!a.critical) || b.points - a.points);
  const shown = limit ? list.slice(0, limit) : list;
  if (!list.length) return <span className="muted small">Nothing of concern found.</span>;
  return (
    <ul className="plain risk-signals">
      {shown.map((s) => <li key={s.code} className={s.critical ? 'critical' : ''}><span className="pts">+{s.points}</span>{s.label}</li>)}
      {limit && list.length > limit && <li className="muted">and {list.length - limit} more</li>}
    </ul>
  );
}

/** Score, band, signals and when registration and sanctions were last re-checked — the vendor page card. */
export function RiskCard({ risk, onCheck, busy }: { risk: { score: number; band: Band; signals: RiskSignal[]; lastMonitoredAt: string | null } | null; onCheck?: () => void; busy?: boolean }) {
  if (!risk) return null;
  return (
    <div className="card pad risk-card">
      <div className="row-between"><h3 className="card-title">Risk</h3><RiskBadge band={risk.band} score={risk.score} /></div>
      <div className={`risk-meter risk-${risk.band.toLowerCase()}`}><span style={{ width: `${Math.max(3, risk.score)}%` }} /></div>
      <RiskSignals signals={risk.signals} />
      <div className="small muted">Registration and sanctions last re-checked: {risk.lastMonitoredAt ? fmtDateTime(risk.lastMonitoredAt) : 'not yet'}</div>
      {onCheck && <button className="link-btn small" disabled={busy} onClick={onCheck}>{busy ? 'Checking…' : 'Re-check now'}</button>}
    </div>
  );
}
