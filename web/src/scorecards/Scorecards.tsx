import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Alert, Modal } from '../components/ui';
import { fmtDate, fmtDateTime } from '../lib/format';
import { t } from '../i18n';
import { Change, LateTable, MetricBars, ScoreBadge, TrendBars, tone, type Card, type Late, type MetricKey } from './ScorecardView';

interface Row extends Card { vendorId: string; name: string; code: string; status: string; change: number | null }
interface List { period: Card['period']; weights: Record<MetricKey, number>; rows: Row[]; metrics: { key: MetricKey; label: string; help: string }[] }
const PERIODS = [30, 90, 180, 365];
const short: Record<MetricKey, string> = { onTime: 'On time', fillRate: 'Fill rate', acknowledgement: 'Ack.', invoiceAccuracy: 'Invoices', asn: 'ASN', rating: 'Rating' };

function Period({ days, onChange }: { days: number; onChange: (d: number) => void }) {
  return <select value={days} onChange={(e) => onChange(Number(e.target.value))} aria-label="Period" style={{ width: 'auto' }}>{PERIODS.map((d) => <option key={d} value={d}>Last {d} days</option>)}</select>;
}

/** All suppliers ranked by score. */
export function Scorecards() {
  const nav = useNavigate();
  const { me } = useSession();
  const [days, setDays] = useState(90);
  const [d, setD] = useState<List>();
  const [err, setErr] = useState<string>();
  const [q, setQ] = useState('');
  const [settings, setSettings] = useState(false);
  const load = () => api<List>(`/scorecards?days=${days}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [days]); // eslint-disable-line react-hooks/exhaustive-deps
  const canSet = me?.permissions.includes('tenant.settings');
  const rows = (d?.rows ?? []).filter((r) => !q || `${r.name} ${r.code}`.toLowerCase().includes(q.toLowerCase()));
  const scored = rows.filter((r) => r.score !== null);
  const avg = scored.length ? scored.reduce((a, r) => a + r.score!, 0) / scored.length : null;
  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Supplier scorecards</h1><p className="muted">Performance worked out from orders, deliveries, invoices and buyer ratings{d && <> · {fmtDate(d.period.from)} – {fmtDate(d.period.to)}</>}.</p></div>
        <div className="head-actions"><Period days={days} onChange={setDays} />
          {me?.permissions.includes('reports.view') && <a className="btn btn-secondary" href={`/api/scorecards/export.xlsx?days=${days}`}>Download Excel</a>}
          {canSet && <button className="btn btn-secondary" onClick={() => setSettings(true)}>Weights &amp; sharing</button>}</div>
      </header>
      {err && <Alert kind="error">{err}</Alert>}
      {d && (<>
        <div className="sc-kpis">
          <div className="card pad"><span className="muted small">Suppliers scored</span><b>{scored.length}<span className="muted small"> / {rows.length}</span></b></div>
          <div className="card pad"><span className="muted small">Average score</span><b>{avg === null ? '—' : Math.round(avg)}</b></div>
          {(['A', 'B', 'C', 'D'] as const).map((g) => <div key={g} className="card pad"><span className="muted small">Grade {g}</span><b>{scored.filter((r) => r.grade === g).length}</b></div>)}
        </div>
        <div className="card">
          <div className="pad" style={{ paddingBottom: 0 }}><input placeholder="Search supplier…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} /></div>
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Supplier</th><th>Score</th><th>Change</th>{d.metrics.map((m) => <th key={m.key} title={`${m.label} (${d.weights[m.key]}%): ${m.help}`}>{short[m.key]}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.vendorId} onClick={() => nav(`/staff/scorecards/${r.vendorId}?days=${days}`)}>
                  <td><strong>{r.name}</strong><div className="muted small mono">{r.code}</div></td>
                  <td><ScoreBadge score={r.score} grade={r.grade} small /></td>
                  <td><Change value={r.change} /></td>
                  {r.metrics.map((m) => <td key={m.key}><span className={`sc-val t-${tone(m.value)}`}>{m.value === null ? '—' : `${Math.round(m.value * 100)}%`}</span></td>)}
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={9} className="muted">No suppliers yet.</td></tr>}
            </tbody>
          </table></div>
        </div>
        <p className="muted small">A measure with no data in the period is left out and the others are re-weighted. A score needs at least 3 data points. Grades: A 90+, B 80+, C 70+, D below 70.</p>
      </>)}
      {settings && <SettingsModal onClose={(saved) => { setSettings(false); if (saved) load(); }} />}
    </div>
  );
}

function SettingsModal({ onClose }: { onClose: (saved: boolean) => void }) {
  const [s, setS] = useState<{ weights: Record<MetricKey, number>; graceDays: number; showToSuppliers: boolean; metrics: { key: MetricKey; label: string; defaultWeight: number }[] }>();
  const [err, setErr] = useState<string>();
  useEffect(() => { api('/scorecards/settings').then(setS).catch((e) => setErr(e.message)); }, []);
  async function save() {
    try { await api('/scorecards/settings', { method: 'PUT', body: { weights: s!.weights, graceDays: s!.graceDays, showToSuppliers: s!.showToSuppliers } }); onClose(true); }
    catch (e: any) { setErr(e.message); }
  }
  const total = s ? Object.values(s.weights).reduce((a, b) => a + b, 0) : 0;
  return (
    <Modal title="Scorecard weights and sharing" onClose={() => onClose(false)} footer={<><button className="btn btn-ghost" onClick={() => onClose(false)}>Cancel</button><button className="btn btn-primary" disabled={!s} onClick={save}>Save</button></>}>
      {err && <Alert kind="error">{err}</Alert>}
      {s && (<div className="stack">
        <p className="muted small">How much each measure counts. They don’t need to add up to 100 — the score uses each one’s share of the total ({total}). Set 0 to leave a measure out.</p>
        {s.metrics.map((m) => (
          <div key={m.key} className="sc-weight"><label htmlFor={`w-${m.key}`}>{m.label}</label>
            <input id={`w-${m.key}`} type="range" min={0} max={50} step={5} value={s.weights[m.key]} onChange={(e) => setS({ ...s, weights: { ...s.weights, [m.key]: Number(e.target.value) } })} />
            <span className="mono">{s.weights[m.key]}</span></div>
        ))}
        <button type="button" className="link-btn small" onClick={() => setS({ ...s, weights: Object.fromEntries(s.metrics.map((m) => [m.key, m.defaultWeight])) as Record<MetricKey, number> })}>Reset to defaults</button>
        <div className="field" style={{ maxWidth: 260 }}><label htmlFor="grace">Grace days for on-time delivery</label><input id="grace" type="number" min={0} max={30} value={s.graceDays} onChange={(e) => setS({ ...s, graceDays: Number(e.target.value) })} /></div>
        <label className="check-item"><input type="checkbox" checked={s.showToSuppliers} onChange={(e) => setS({ ...s, showToSuppliers: e.target.checked })} />
          <span><strong>Let approved suppliers see their own scorecard</strong><span className="muted small block">In their portal, under Performance. They see their measures and late deliveries — never other suppliers, buyer names or rating comments.</span></span></label>
      </div>)}
    </Modal>
  );
}

interface Rating { id: string; quality: number | null; delivery: number | null; service: number | null; communication: number | null; comment: string | null; ratedByName: string; createdAt: string }
interface Detail extends Card { vendor: { id: string; name: string; code: string; status: string }; trend: { month: string; score: number | null }[]; late: (Late & { poId: string })[]; ratings: Rating[] }

/** One supplier's scorecard, with buyer ratings. */
export function ScorecardDetail() {
  const { vendorId = '' } = useParams();
  const { me } = useSession();
  const [days, setDays] = useState(() => Number(new URLSearchParams(window.location.search).get('days')) || 90);
  const [d, setD] = useState<Detail>();
  const [err, setErr] = useState<string>();
  const [rate, setRate] = useState(false);
  const load = () => api<Detail>(`/scorecards/${vendorId}?days=${days}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [vendorId, days]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return <div className="page">{err ? <Alert kind="error">{err}</Alert> : <div className="spinner" />}</div>;
  return (
    <div className="page">
      <header className="page-head">
        <div><h1>{d.vendor.name}</h1><p className="muted"><Link to="/staff/scorecards">Scorecards</Link> · <Link to={`/staff/vendors/${d.vendor.id}`}>Vendor profile</Link> · {fmtDate(d.period.from)} – {fmtDate(d.period.to)}</p></div>
        <div className="head-actions"><Period days={days} onChange={setDays} />{me?.permissions.includes('orders.view') && <button className="btn btn-primary" onClick={() => setRate(true)}>Rate this supplier</button>}</div>
      </header>
      <div className="detail-grid">
        <div className="stack">
          <div className="card pad"><MetricBars metrics={d.metrics} /></div>
          <div className="card pad"><h3 className="card-title">{t('sc.lateTitle')}</h3><LateTable late={d.late} /></div>
        </div>
        <aside className="side-col">
          <div className="card pad center"><span className="muted small">Score</span><div style={{ margin: '6px 0' }}><ScoreBadge score={d.score} grade={d.grade} /></div><span className="muted small">{d.points} data points</span></div>
          <div className="card pad"><h3 className="card-title">Last 6 months</h3><TrendBars trend={d.trend} /></div>
          <div className="card pad"><h3 className="card-title">Buyer ratings</h3>
            {!d.ratings.length ? <p className="muted small">No ratings yet.</p> : d.ratings.map((r) => (
              <div key={r.id} className="sc-rating">
                <div className="small">{(['quality', 'delivery', 'service', 'communication'] as const).filter((k) => r[k]).map((k) => <span key={k} className="sc-chip">{k[0].toUpperCase() + k.slice(1)} {'★'.repeat(r[k]!)}</span>)}</div>
                {r.comment && <p className="small">“{r.comment}”</p>}
                <div className="muted small">{r.ratedByName} · {fmtDateTime(r.createdAt)}</div>
              </div>
            ))}
          </div>
        </aside>
      </div>
      {rate && <RateModal vendorId={vendorId} name={d.vendor.name} onClose={(saved) => { setRate(false); if (saved) load(); }} />}
    </div>
  );
}

function Stars({ value, onChange, label }: { value: number | null; onChange: (v: number | null) => void; label: string }) {
  return (
    <div className="sc-stars-row"><span>{label}</span>
      <span className="sc-stars" role="radiogroup" aria-label={label}>{[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} of 5`} className={value && n <= value ? 'on' : ''} onClick={() => onChange(value === n ? null : n)}>★</button>
      ))}</span></div>
  );
}

function RateModal({ vendorId, name, onClose }: { vendorId: string; name: string; onClose: (saved: boolean) => void }) {
  const [r, setR] = useState<{ quality: number | null; delivery: number | null; service: number | null; communication: number | null; comment: string }>({ quality: null, delivery: null, service: null, communication: null, comment: '' });
  const [err, setErr] = useState<string>();
  async function save() {
    try { await api(`/scorecards/${vendorId}/ratings`, { body: { ...r, comment: r.comment || undefined } }); onClose(true); } catch (e: any) { setErr(e.message); }
  }
  return (
    <Modal title={`Rate ${name}`} onClose={() => onClose(false)} footer={<><button className="btn btn-ghost" onClick={() => onClose(false)}>Cancel</button><button className="btn btn-primary" disabled={!r.quality && !r.delivery && !r.service && !r.communication} onClick={save}>Save rating</button></>}>
      {err && <Alert kind="error">{err}</Alert>}
      <p className="muted small">Rate what you know; leave the rest blank. 5 is excellent, 1 is poor.</p>
      <Stars label="Quality" value={r.quality} onChange={(v) => setR({ ...r, quality: v })} />
      <Stars label="Delivery" value={r.delivery} onChange={(v) => setR({ ...r, delivery: v })} />
      <Stars label="Service" value={r.service} onChange={(v) => setR({ ...r, service: v })} />
      <Stars label="Communication" value={r.communication} onChange={(v) => setR({ ...r, communication: v })} />
      <div className="field" style={{ marginTop: 10 }}><label htmlFor="rc">Comment (internal — the supplier never sees it)</label><textarea id="rc" rows={3} value={r.comment} onChange={(e) => setR({ ...r, comment: e.target.value })} /></div>
    </Modal>
  );
}
