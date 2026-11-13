import { t } from '../i18n';
import { fmtDate } from '../lib/format';

export type MetricKey = 'onTime' | 'fillRate' | 'acknowledgement' | 'invoiceAccuracy' | 'asn' | 'rating';
export interface Metric { key: MetricKey; weight: number; value: number | null; numerator: number; denominator: number; note?: string }
export interface Card { score: number | null; grade: 'A' | 'B' | 'C' | 'D' | null; points: number; metrics: Metric[]; period: { from: string; to: string; days: number } }
export interface Late { poNumber: string; lineNo: number; description: string; due: string; receiptDate: string; quantity: string; daysLate: number }

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
export const tone = (v: number | null) => (v === null ? 'none' : v >= 0.9 ? 'good' : v >= 0.75 ? 'ok' : 'bad');
const gradeTone = (g: Card['grade']) => (g === 'A' ? 'good' : g === 'B' ? 'ok' : g === 'C' ? 'warn' : g === 'D' ? 'bad' : 'none');

/** Big score with its grade; "not enough data" when there is no score. */
export function ScoreBadge({ score, grade, small }: { score: number | null; grade: Card['grade']; small?: boolean }) {
  if (score === null) return <span className="muted small">{t('sc.notEnough')}</span>;
  return <span className={`sc-score ${small ? 'small' : ''}`}><b>{Math.round(score)}</b><span className={`sc-grade g-${gradeTone(grade)}`}>{grade}</span></span>;
}

export function Change({ value }: { value: number | null }) {
  const r = value === null ? 0 : Math.round(value);
  if (r === 0) return <span className="muted small">—</span>;
  return <span className={`small ${r > 0 ? 'ok-text' : 'diff-text'}`}>{r > 0 ? '▲' : '▼'} {Math.abs(r)}</span>;
}

export function MetricBars({ metrics }: { metrics: Metric[] }) {
  return (
    <div className="sc-metrics">
      {metrics.map((m) => (
        <div key={m.key} className={`sc-metric ${m.weight === 0 ? 'off' : ''}`}>
          <div className="row-between"><strong>{t(`sc.${m.key}`)}</strong><span className={`sc-val t-${tone(m.value)}`}>{pct(m.value)}</span></div>
          <div className="sc-bar"><i className={`t-${tone(m.value)}`} style={{ width: `${Math.round((m.value ?? 0) * 100)}%` }} /></div>
          <div className="muted small">{t(`sc.${m.key}Help`)}</div>
          <div className="small sc-basis">
            {m.value === null ? t('sc.noData') : m.key === 'rating' ? t('sc.basisRating', { count: Math.ceil(m.denominator / 1) }) : m.key === 'fillRate' ? t('sc.basisQty', { n: fmtN(m.numerator), d: fmtN(m.denominator) }) : t('sc.basis', { n: fmtN(m.numerator), d: fmtN(m.denominator) })}
            {m.note && <> · {m.note}</>} · {t('sc.weight', { w: m.weight })}
          </div>
        </div>
      ))}
    </div>
  );
}
const fmtN = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Six months of scores as a small bar chart. */
export function TrendBars({ trend }: { trend: { month: string; score: number | null }[] }) {
  return (
    <div className="sc-trend" role="img" aria-label={t('sc.trend')}>
      {trend.map((p) => (
        <div key={p.month} className="sc-trend-col">
          <span className="small">{p.score === null ? '—' : Math.round(p.score)}</span>
          <div className="sc-trend-bar"><i style={{ height: `${p.score ?? 0}%` }} className={`t-${tone(p.score === null ? null : p.score / 100)}`} /></div>
          <span className="muted small">{fmtDate(`${p.month}-01`).replace(/^\d+\s/, '')}</span>
        </div>
      ))}
    </div>
  );
}

export function LateTable({ late }: { late: Late[] }) {
  if (!late.length) return <p className="muted small">{t('sc.noLate')}</p>;
  return (
    <table className="table small">
      <thead><tr><th>{t('sc.po')}</th><th>{t('sc.item')}</th><th>{t('sc.due')}</th><th>{t('sc.received')}</th><th>{t('sc.daysLate')}</th></tr></thead>
      <tbody>{late.map((l, i) => <tr key={i} style={{ cursor: 'default' }}><td className="mono">{l.poNumber}/{l.lineNo}</td><td>{l.description}</td><td>{fmtDate(l.due)}</td><td>{fmtDate(l.receiptDate)}</td><td className="diff-text">{l.daysLate}</td></tr>)}</tbody>
    </table>
  );
}
