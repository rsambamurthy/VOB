/** Invoices → Reports: ageing of what is approved and unpaid, cycle time, the touchless rate, exceptions and spend. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { money, moneyShort } from '../../lib/format';
import { useHelpContext } from '../../help/HelpPanel';
import { Alert, Empty } from '../../components/ui';
import { HBars } from '../../components/Charts';

interface Amount { key: string; currency: string; amount: number }
interface Report {
  ageing: { currency: string; buckets: { label: string; amount: number; count: number }[] }[];
  topParties: { party: string; currency: string; total: number; overdue: number }[];
  cycle: { approveMedianDays: number | null; approveP90Days: number | null; payMedianDays: number | null; approved: number };
  touchless: { approved: number; touchless: number; rate: number | null };
  exceptions: { code: string; example: string; count: number; approved: number; rejected: number; open: number }[];
  spend: { party: Amount[]; account: Amount[]; costCentre: Amount[]; basis: Amount[] };
}
const days = (n: number | null) => (n === null ? '—' : `${n} day${n === 1 ? '' : 's'}`);
const bars = (rows: Amount[]) => rows.map((x) => ({ label: x.key, value: Math.round(x.amount), note: x.currency, detail: money(x.amount, x.currency) }));

export function ApReports() {
  useHelpContext('ap-reports');
  const [r, setR] = useState<Report>();
  const [error, setError] = useState<string>();
  useEffect(() => { api<Report>('/staff/invoices/reports').then(setR).catch((e) => setError(e.message)); }, []);
  if (!r) return <div className="page">{error ? <Alert kind="error">{error}</Alert> : <div className="spinner" />}</div>;
  const overdue = r.ageing.flatMap((a) => a.buckets.slice(1).map((b) => ({ ...b, currency: a.currency })));
  return (
    <div className="page">
      <header className="page-head"><div><h1>Invoice reports</h1><p className="muted">What is owed and how long invoices take. Figures refresh every minute.</p></div>
        <div className="head-actions"><a className="btn btn-secondary" href="/api/staff/invoices/reports.xlsx">Download Excel</a></div></header>
      <div className="stat-row">
        {r.ageing.map((a) => <Link key={a.currency} className="stat stat-approved" to="/staff/ap/invoices?tab=UNPAID"><span className="stat-n" title={money(a.buckets.reduce((t, b) => t + b.amount, 0), a.currency)}>{moneyShort(a.buckets.reduce((t, b) => t + b.amount, 0), a.currency)}</span><span className="stat-l">Approved, not yet paid</span></Link>)}
        {r.ageing.map((a) => <Link key={`o${a.currency}`} className="stat stat-rejected" to="/staff/ap/invoices?tab=OVERDUE"><span className="stat-n">{moneyShort(overdue.filter((b) => b.currency === a.currency).reduce((t, b) => t + b.amount, 0), a.currency)}</span><span className="stat-l">Overdue</span></Link>)}
        <div className="stat stat-invited"><span className="stat-n">{r.touchless.rate === null ? '—' : `${r.touchless.rate}%`}</span><span className="stat-l">Touchless ({r.touchless.touchless} of {r.touchless.approved}, 12 months)</span></div>
        <div className="stat stat-attention"><span className="stat-n">{days(r.cycle.approveMedianDays)}</span><span className="stat-l">Entered → approved (median)</span></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 16 }}>
        <section className="card pad section-card"><h3>Ageing of unpaid invoices</h3>{!r.ageing.length ? <Empty>Nothing approved is waiting for payment.</Empty> :
          r.ageing.map((a) => <div key={a.currency}><h4>{a.currency}</h4><HBars rows={a.buckets.map((b) => ({ label: b.label, value: Math.round(b.amount), note: `${b.count}`, detail: `${money(b.amount, a.currency)} · ${b.count} invoice${b.count === 1 ? '' : 's'}` }))} /></div>)}</section>
        <section className="card pad section-card"><h3>Owed to suppliers</h3>{!r.topParties.length ? <Empty>Nothing owed.</Empty> :
          <table className="table static compact"><thead><tr><th>Supplier</th><th className="num">Owed</th><th className="num">Overdue</th></tr></thead>
            <tbody>{r.topParties.map((p) => <tr key={p.party + p.currency}><td>{p.party}</td><td className="num">{money(p.total, p.currency)}</td><td className={`num ${p.overdue ? 'err-text' : 'muted'}`}>{p.overdue ? money(p.overdue, p.currency) : '—'}</td></tr>)}</tbody></table>}</section>
        <section className="card pad section-card"><h3>Cycle time (12 months)</h3>
          <table className="table static compact"><tbody>
            <tr><td>Entered → approved, median</td><td className="num">{days(r.cycle.approveMedianDays)}</td></tr>
            <tr><td>Entered → approved, slowest 10% take over</td><td className="num">{days(r.cycle.approveP90Days)}</td></tr>
            <tr><td>Approved → paid, median</td><td className="num">{days(r.cycle.payMedianDays)}</td></tr>
            <tr><td>Invoices approved</td><td className="num">{r.cycle.approved}</td></tr>
          </tbody></table></section>
        <section className="card pad section-card"><h3>Exceptions (90 days)</h3>{!r.exceptions.length ? <p className="muted small">No exceptions in the last 90 days.</p> :
          <table className="table static compact"><thead><tr><th>Check</th><th className="num">Invoices</th><th className="num">Approved</th><th className="num">Rejected</th><th className="num">Open</th></tr></thead>
            <tbody>{r.exceptions.map((e) => <tr key={e.code}><td className="small">{e.example}<div className="muted mono">{e.code}</div></td><td className="num">{e.count}</td><td className="num">{e.approved}</td><td className="num">{e.rejected}</td><td className="num">{e.open}</td></tr>)}</tbody></table>}</section>
        <section className="card pad section-card"><h3>Spend by supplier (12 months)</h3><HBars rows={bars(r.spend.party)} emptyText="No approved invoices yet." /></section>
        <section className="card pad section-card"><h3>Spend by GL account</h3><HBars rows={bars(r.spend.account)} emptyText="No approved invoices yet." /></section>
        <section className="card pad section-card"><h3>Spend by cost centre</h3><HBars rows={bars(r.spend.costCentre)} emptyText="No approved invoices yet." /></section>
        <section className="card pad section-card"><h3>By basis</h3><HBars rows={bars(r.spend.basis)} emptyText="No approved invoices yet." /></section>
      </div>
    </div>
  );
}
