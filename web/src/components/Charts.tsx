/**
 * Small, dependency-free charts for the dashboard. Colours come from CSS custom properties
 * (--viz-*) defined in styles.css; the palette was checked with the dataviz validator
 * (blue/orange, CVD ΔE 24.7, both ≥ 3:1 on white). Every chart has a hover tooltip and
 * readable labels, so colour never carries meaning alone.
 */
import { useState, type ReactNode } from 'react';

function Tip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return <div className="viz-tip" style={{ left: x, top: y }} role="status">{children}</div>;
}

/** Horizontal bars, one series. Label left, value right; the bar length carries magnitude. */
export function HBars({ rows, unit = '', max, emptyText = 'No data in this period.' }: {
  rows: { label: string; value: number | null; note?: string; detail?: ReactNode }[]; unit?: string; max?: number; emptyText?: string;
}) {
  const [tip, setTip] = useState<{ i: number; x: number; y: number }>();
  const vals = rows.map((r) => r.value ?? 0);
  const top = max ?? Math.max(1, ...vals);
  if (!rows.length) return <p className="muted small">{emptyText}</p>;
  return (
    <div className="hbars" onMouseLeave={() => setTip(undefined)}>
      {rows.map((r, i) => (
        <div key={r.label} className="hbar-row" onMouseMove={(e) => { const b = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect(); setTip({ i, x: e.clientX - b.left + 12, y: e.clientY - b.top + 12 }); }}>
          <span className="hbar-label">{r.label}</span>
          <span className="hbar-track"><span className="hbar-fill" style={{ width: `${r.value ? Math.max(1.5, (r.value / top) * 100) : 0}%` }} /></span>
          <span className="hbar-value">{r.value === null ? '—' : `${r.value}${unit}`}{r.note && <span className="muted small"> {r.note}</span>}</span>
        </div>
      ))}
      {tip && rows[tip.i].detail && <Tip x={tip.x} y={tip.y}>{rows[tip.i].detail}</Tip>}
    </div>
  );
}

/** Grouped columns per month, two series. Legend + hover tooltip with both values. */
export function MonthColumns({ data, series }: { data: { month: string; [k: string]: number | string }[]; series: { key: string; label: string; cls: string }[] }) {
  const [hover, setHover] = useState<number>();
  const W = 1000, H = 240, padL = 30, padB = 26, padT = 10;
  const max = Math.max(1, ...data.flatMap((d) => series.map((s) => Number(d[s.key]))));
  const step = max <= 5 ? 1 : Math.ceil(max / 4);
  const ticks = Array.from({ length: Math.floor(max / step) + 1 }, (_, i) => i * step);
  const top = ticks[ticks.length - 1] < max ? ticks[ticks.length - 1] + step : ticks[ticks.length - 1];
  if (ticks[ticks.length - 1] < top) ticks.push(top);
  const plotW = W - padL, plotH = H - padB - padT;
  const band = plotW / data.length, barW = Math.min(14, (band - 10) / series.length);
  const y = (v: number) => padT + plotH - (v / top) * plotH;
  const mLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' });
  return (
    <div className="viz-wrap">
      <div className="viz-legend">{series.map((s) => <span key={s.key}><i className={`sw ${s.cls}`} />{s.label}</span>)}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="viz-svg" role="img" aria-label={`${series.map((s) => s.label).join(' and ')} by month`} onMouseLeave={() => setHover(undefined)}>
        {ticks.map((t) => <g key={t}><line x1={padL} x2={W} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-base' : 'viz-grid'} /><text x={padL - 6} y={y(t) + 4} className="viz-axis" textAnchor="end">{t}</text></g>)}
        {data.map((d, i) => {
          const x0 = padL + i * band + (band - barW * series.length - 2 * (series.length - 1)) / 2;
          return (
            <g key={d.month} onMouseEnter={() => setHover(i)}>
              <rect x={padL + i * band} y={padT} width={band} height={plotH} className={`viz-hit ${hover === i ? 'on' : ''}`} />
              {series.map((s, k) => {
                const v = Number(d[s.key]); const h = Math.max(0, y(0) - y(v));
                const x = x0 + k * (barW + 2);
                // 4px rounded data-end, square at the baseline
                return v > 0 ? <path key={s.key} className={s.cls} d={`M${x},${y(0)} V${y(v) + Math.min(4, h)} Q${x},${y(v)} ${x + Math.min(4, barW / 2)},${y(v)} H${x + barW - Math.min(4, barW / 2)} Q${x + barW},${y(v)} ${x + barW},${y(v) + Math.min(4, h)} V${y(0)} Z`} /> : null;
              })}
              <text x={padL + i * band + band / 2} y={H - 6} className="viz-axis" textAnchor="middle">{mLabel(d.month)}</text>
            </g>
          );
        })}
      </svg>
      {hover !== undefined && (
        <div className="viz-tip viz-tip-fixed" style={{ left: `${((padL + hover * band + band / 2) / W) * 100}%` }}>
          <strong>{new Date(`${data[hover].month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</strong>
          {series.map((s) => <div key={s.key}><i className={`sw ${s.cls}`} />{s.label}: {data[hover][s.key]}</div>)}
        </div>
      )}
    </div>
  );
}

/** Count table shaded by magnitude (one blue ramp); the numbers stay visible. */
export function HeatTable({ rows, columns, onCell }: { rows: { label: string; counts: number[] }[]; columns: string[]; onCell?: (row: number, col: number) => void }) {
  const max = Math.max(1, ...rows.flatMap((r) => r.counts));
  const STEPS = ['heat-0', 'heat-1', 'heat-2', 'heat-3', 'heat-4'];
  const cls = (n: number) => (n === 0 ? STEPS[0] : STEPS[Math.min(4, 1 + Math.floor((n / max) * 3.999))]);
  return (
    <table className="table heat">
      <thead><tr><th>Stage</th>{columns.map((c) => <th key={c} className="num">{c}</th>)}<th className="num">Total</th></tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.label}>
            <td>{r.label}</td>
            {r.counts.map((n, j) => <td key={j} className={`num ${cls(n)} ${j === 3 && n > 0 ? 'heat-alert' : ''}`} title={`${r.label}: ${n} vendor${n === 1 ? '' : 's'} waiting ${columns[j]}`} onClick={() => onCell?.(i, j)}>{n}</td>)}
            <td className="num strong">{r.counts.reduce((a, b) => a + b, 0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
