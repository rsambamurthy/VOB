import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { VENDOR_TYPES } from '../lib/meta';
import { statusLabel, loc } from '../lib/format';
import { Alert } from '../components/ui';
import { HBars, HeatTable, MonthColumns } from '../components/Charts';
import type { VendorStatus } from '../lib/types';

interface Stat { count: number; avg: number | null; median: number | null; p90: number | null }
interface Dash {
  range: { from: string; to: string; vendorType: string | null };
  tiles: { approvedInRange: number; invitedInRange: number; inProgress: number; underReview: number; overdueSteps: number; activeVendors: number; blocked: number; needsAttention: number; medianDaysToApprove: number | null; openChanges: number };
  funnel: { key: string; label: string; count: number }[]; rejected: number;
  turnaround: { total: Stat; review: Stat; vendorSide: Stat };
  byLevel: (Stat & { label: string; lateShare: number; pendingNow: number })[];
  ageing: { buckets: string[]; rows: { stage: VendorStatus; counts: number[]; total: number }[] };
  workload: { userId: string; name: string; pending: number; overdue: number; changes: number; decided: number; medianHours: number | null }[];
  monthly: { month: string; invited: number; approved: number }[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const PRESETS = [
  { key: '30', label: 'Last 30 days', from: () => iso(new Date(Date.now() - 30 * 864e5)) },
  { key: '90', label: 'Last 90 days', from: () => iso(new Date(Date.now() - 90 * 864e5)) },
  { key: 'fy', label: 'This financial year', from: () => { const n = new Date(); const y = n.getMonth() >= 3 ? n.getFullYear() : n.getFullYear() - 1; return `${y}-04-01`; } },
  { key: '365', label: 'Last 12 months', from: () => iso(new Date(Date.now() - 365 * 864e5)) },
];
const days = (n: number | null) => (n === null ? '—' : `${n} d`);
const hours = (n: number | null) => (n === null ? '—' : n >= 48 ? `${Math.round((n / 24) * 10) / 10} d` : `${Math.round(n)} h`);

export function Dashboard() {
  const nav = useNavigate();
  const [preset, setPreset] = useState('90');
  const [from, setFrom] = useState(PRESETS[1].from());
  const [to, setTo] = useState(iso(new Date()));
  const [vendorType, setVendorType] = useState('');
  const [d, setD] = useState<Dash>();
  const [error, setError] = useState<string>();

  const qs = useMemo(() => new URLSearchParams({ from, to, ...(vendorType ? { vendorType } : {}) }).toString(), [from, to, vendorType]);
  useEffect(() => { setError(undefined); api<Dash>(`/reports/dashboard?${qs}`).then(setD).catch((e) => setError(e.message)); }, [qs]);

  function pick(k: string) { setPreset(k); const p = PRESETS.find((x) => x.key === k); if (p) { setFrom(p.from()); setTo(iso(new Date())); } }
  const t = d?.tiles;
  const invited = d?.funnel[0].count ?? 0;

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Dashboard</h1><p className="muted">Onboarding throughput, approval speed and where vendors are waiting</p></div>
        <div className="head-actions"><Link className="btn btn-secondary" to="/staff/reports">Reports & Excel</Link></div>
      </header>

      <div className="filter-bar card">
        <div className="seg">{PRESETS.map((p) => <button key={p.key} className={`seg-btn ${preset === p.key ? 'active' : ''}`} onClick={() => pick(p.key)}>{p.label}</button>)}</div>
        <label className="small">From <input type="date" className="input-sm" value={from} max={to} onChange={(e) => { setPreset('custom'); setFrom(e.target.value); }} /></label>
        <label className="small">To <input type="date" className="input-sm" value={to} min={from} onChange={(e) => { setPreset('custom'); setTo(e.target.value); }} /></label>
        <label className="small">Vendor type <select className="input-sm" value={vendorType} onChange={(e) => setVendorType(e.target.value)}><option value="">All</option>{VENDOR_TYPES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}</select></label>
      </div>
      {error && <Alert kind="error">{error}</Alert>}
      {!d ? <div className="spinner" /> : (
        <>
          <div className="tiles">
            <Tile n={t!.approvedInRange} label="Approved in period" sub={`${t!.invitedInRange} invited`} />
            <Tile n={days(t!.medianDaysToApprove)} label="Median invite → approval" />
            <Tile n={t!.inProgress} label="Open registrations" sub={`${t!.underReview} under review`} to="/staff/vendors" />
            <Tile n={t!.overdueSteps} label="Overdue approval steps" tone={t!.overdueSteps ? 'bad' : undefined} to="/staff/reports?r=pending-approvals" />
            <Tile n={t!.activeVendors} label="Active vendors" sub={t!.blocked ? `${t!.blocked} blocked` : undefined} />
            <Tile n={t!.needsAttention} label="Need attention" sub={t!.openChanges ? `${t!.openChanges} change request${t!.openChanges === 1 ? '' : 's'} open` : undefined} tone={t!.needsAttention ? 'warn' : undefined} to="/staff/vendors" />
          </div>

          <div className="dash-grid">
            <section className="card pad">
              <h3 className="card-title">Onboarding funnel <span className="muted small">vendors invited in the period</span></h3>
              <HBars rows={d.funnel.map((f) => ({ label: f.label, value: f.count, note: invited && f.key !== 'invited' ? `(${Math.round((f.count / invited) * 100)}%)` : undefined, detail: <><strong>{f.label}</strong><div>{f.count} of {invited} invited</div></> }))} emptyText="No vendors invited in this period." />
              {d.rejected > 0 && <p className="small muted">{d.rejected} rejected.</p>}
            </section>

            <section className="card pad">
              <h3 className="card-title">Turnaround <span className="muted small">vendors approved in the period</span></h3>
              {d.turnaround.total.count === 0 ? <p className="muted small">No approvals in this period.</p> : (
                <table className="table compact">
                  <thead><tr><th /><th className="num">Median</th><th className="num">Average</th><th className="num">Slowest 10%</th></tr></thead>
                  <tbody>
                    <tr><td>Vendor filling in the form</td><td className="num">{days(d.turnaround.vendorSide.median)}</td><td className="num">{days(d.turnaround.vendorSide.avg)}</td><td className="num">{days(d.turnaround.vendorSide.p90)}</td></tr>
                    <tr><td>Internal review</td><td className="num">{days(d.turnaround.review.median)}</td><td className="num">{days(d.turnaround.review.avg)}</td><td className="num">{days(d.turnaround.review.p90)}</td></tr>
                    <tr className="strong"><td>Invite → approval</td><td className="num">{days(d.turnaround.total.median)}</td><td className="num">{days(d.turnaround.total.avg)}</td><td className="num">{days(d.turnaround.total.p90)}</td></tr>
                  </tbody>
                </table>
              )}
              <p className="small muted">Based on {d.turnaround.total.count} approval{d.turnaround.total.count === 1 ? '' : 's'}. Review time runs from the last submission.</p>
            </section>

            <section className="card pad span-2">
              <h3 className="card-title">Invited and approved by month <span className="muted small">12 months to {new Date(d.range.to).toLocaleDateString(loc(), { month: 'short', year: 'numeric' })}</span></h3>
              <MonthColumns data={d.monthly} series={[{ key: 'invited', label: 'Invited', cls: 'viz-s1' }, { key: 'approved', label: 'Approved', cls: 'viz-s2' }]} />
            </section>

            <section className="card pad">
              <h3 className="card-title">Time per approval level <span className="muted small">median, decisions in the period</span></h3>
              <HBars rows={d.byLevel.map((l) => ({ label: l.label, value: l.median === null ? null : Math.round(l.median), note: l.pendingNow ? `· ${l.pendingNow} waiting` : undefined,
                detail: <><strong>{l.label}</strong><div>Median {hours(l.median)} · average {hours(l.avg)} · slowest 10% {hours(l.p90)}</div><div>{l.count} decision{l.count === 1 ? '' : 's'}, {l.lateShare}% after the deadline</div><div>{l.pendingNow} waiting now</div></> }))} unit=" h" emptyText="No approval decisions in this period." />
              <p className="small muted">Hours from when a level receives the vendor to its decision. Hover a bar for details.</p>
            </section>

            <section className="card pad">
              <h3 className="card-title">Where vendors are waiting <span className="muted small">open registrations by time in the current stage</span></h3>
              <HeatTable columns={d.ageing.buckets} rows={d.ageing.rows.map((r) => ({ label: statusLabel[r.stage], counts: r.counts }))} onCell={(i) => nav(`/staff/vendors?status=${d.ageing.rows[i].stage}`)} />
              <p className="small muted">Under review counts from when the current level received it; other stages from the last activity. Click a number to open the list.</p>
            </section>

            <section className="card pad span-2">
              <h3 className="card-title">Approver workload</h3>
              {!d.workload.length ? <p className="muted small">Nothing pending and no decisions in this period.</p> : (
                <div className="table-wrap">
                  <table className="table compact">
                    <thead><tr><th>Approver</th><th className="num">Waiting now</th><th className="num">of which changes</th><th className="num">Overdue</th><th className="num">Decided in period</th><th className="num">Median response</th></tr></thead>
                    <tbody>{d.workload.map((w) => (
                      <tr key={w.userId}><td>{w.name}</td><td className="num">{w.pending}</td><td className="num">{w.changes || ''}</td>
                        <td className="num">{w.overdue ? <span className="badge badge-rejected sm">⚠ {w.overdue}</span> : 0}</td><td className="num">{w.decided}</td><td className="num">{hours(w.medianHours)}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
              <p className="small muted">“Waiting now” counts items assigned to the person or to their role (out-of-office cover not included).</p>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ n, label, sub, tone, to }: { n: number | string; label: string; sub?: string; tone?: 'bad' | 'warn'; to?: string }) {
  const body = <><span className={`tile-n ${tone ? `tile-${tone}` : ''}`}>{tone === 'bad' && Number(n) > 0 ? '⚠ ' : ''}{n}</span><span className="tile-l">{label}</span>{sub && <span className="tile-sub">{sub}</span>}</>;
  return to ? <Link className="tile card" to={to}>{body}</Link> : <div className="tile card">{body}</div>;
}
