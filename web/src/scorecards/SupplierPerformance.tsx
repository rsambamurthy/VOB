import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Alert } from '../components/ui';
import { fmtDate } from '../lib/format';
import { t, useLang } from '../i18n';
import { LateTable, MetricBars, ScoreBadge, TrendBars, type Card, type Late } from './ScorecardView';

/** Supplier portal: their own scorecard, when the buyer shares it. */
export function SupplierPerformance() {
  useLang();
  const [days, setDays] = useState(90);
  const [d, setD] = useState<Card & { trend: { month: string; score: number | null }[]; late: Late[] }>();
  const [err, setErr] = useState<string>();
  useEffect(() => { api(`/vendor/scorecard?days=${days}`).then(setD).catch((e) => setErr(e.message)); }, [days]);
  return (
    <div className="page">
      <header className="page-head">
        <div><h1>{t('sc.myTitle')}</h1><p className="muted">{t('sc.myIntro')}{d && <> · {fmtDate(d.period.from)} – {fmtDate(d.period.to)}</>}</p></div>
        <div className="head-actions"><select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }} aria-label={t('sc.period')}>{[30, 90, 180, 365].map((n) => <option key={n} value={n}>{t('sc.lastDays', { count: n })}</option>)}</select></div>
      </header>
      {err && <Alert kind="error">{err}</Alert>}
      {d && (
        <div className="detail-grid">
          <div className="stack">
            <div className="card pad"><MetricBars metrics={d.metrics} /></div>
            <div className="card pad"><h3 className="card-title">{t('sc.lateTitle')}</h3><LateTable late={d.late} /></div>
          </div>
          <aside className="side-col">
            <div className="card pad center"><span className="muted small">{t('sc.score')}</span><div style={{ margin: '6px 0' }}><ScoreBadge score={d.score} grade={d.grade} /></div><span className="muted small">{t('sc.gradesKey')}</span></div>
            <div className="card pad"><h3 className="card-title">{t('sc.trend')}</h3><TrendBars trend={d.trend} /></div>
          </aside>
        </div>
      )}
    </div>
  );
}
