import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert } from '../components/ui';
import { fmtDate, loc } from '../lib/format';
import { PLAN_LABEL, SOURCE_LABEL, papi, relDays } from './session';

interface Overview {
  tenants: { total: number; active: number; suspended: number; byPlan: Record<string, number> };
  vendors: number; users: number; emailsToday: number; signupsLast30: number; pendingSignups: number;
  trialsEndingSoon: { id: string; name: string; slug: string; trialEndsAt: string }[];
  recent: { id: string; name: string; slug: string; plan: string; source: string; createdAt: string }[];
}

export function PlatformOverview() {
  const nav = useNavigate();
  const [d, setD] = useState<Overview>();
  const [error, setError] = useState<string>();
  useEffect(() => { papi('/overview').then(setD).catch((e) => setError(e.message)); }, []);
  return (
    <div className="page">
      <header className="page-head"><div><h1>Overview</h1><p className="muted">All customer workspaces on this VendorGate installation.</p></div>
        <Link to="/platform/tenants?new=1" className="btn btn-primary">New workspace</Link></header>
      {error && <Alert kind="error">{error}</Alert>}
      {d && (
        <>
          <div className="tiles">
            <Tile n={d.tenants.active} label="Active workspaces" to="/platform/tenants?status=ACTIVE" />
            <Tile n={d.tenants.suspended} label="Suspended" to="/platform/tenants?status=SUSPENDED" tone={d.tenants.suspended ? 'warn' : undefined} />
            <Tile n={d.tenants.byPlan.trial ?? 0} label="On trial" to="/platform/tenants?plan=trial" />
            <Tile n={d.signupsLast30} label="Self sign-ups" sub="last 30 days" to="/platform/signups" />
            <Tile n={d.vendors} label="Vendors" sub="all workspaces" />
            <Tile n={d.emailsToday} label="Emails today" sub="all workspaces" />
          </div>
          <div className="dash-grid">
            <section className="card">
              <div className="toolbar"><h3>Trials ending in the next 7 days</h3></div>
              {d.trialsEndingSoon.length ? (
                <table className="table compact">
                  <tbody>{d.trialsEndingSoon.map((t) => (
                    <tr key={t.id} onClick={() => nav(`/platform/tenants/${t.id}`)}>
                      <td><Link to={`/platform/tenants/${t.id}`}>{t.name}</Link> <span className="muted small">{t.slug}</span></td>
                      <td className="num"><span className={`badge ${new Date(t.trialEndsAt) < new Date() ? 'flag-high' : 'flag-medium'}`}>{new Date(t.trialEndsAt) < new Date() ? `Ended ${relDays(t.trialEndsAt)}` : `Ends ${relDays(t.trialEndsAt)}`}</span></td>
                    </tr>))}</tbody>
                </table>
              ) : <p className="muted small pad">None. Good time to check in with active trials anyway.</p>}
            </section>
            <section className="card">
              <div className="toolbar"><h3>Newest workspaces</h3>{d.pendingSignups > 0 && <Link to="/platform/signups" className="small">{d.pendingSignups} sign-up{d.pendingSignups === 1 ? '' : 's'} waiting for email confirmation</Link>}</div>
              <table className="table compact">
                <tbody>{d.recent.map((t) => (
                  <tr key={t.id} onClick={() => nav(`/platform/tenants/${t.id}`)}>
                    <td><Link to={`/platform/tenants/${t.id}`}>{t.name}</Link> <span className="muted small">{t.slug}</span></td>
                    <td><span className={`badge plan-${t.plan}`}>{PLAN_LABEL[t.plan] ?? t.plan}</span></td>
                    <td className="muted small">{SOURCE_LABEL[t.source] ?? t.source}</td>
                    <td className="num muted small">{fmtDate(t.createdAt)}</td>
                  </tr>))}</tbody>
              </table>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function Tile({ n, label, sub, to, tone }: { n: number; label: string; sub?: string; to?: string; tone?: 'warn' }) {
  const body = <><span className={`tile-n ${tone ? `tile-${tone}` : ''}`}>{n.toLocaleString(loc())}</span><span className="tile-l">{label}</span>{sub && <span className="tile-sub">{sub}</span>}</>;
  return to ? <Link className="tile card" to={to}>{body}</Link> : <div className="tile card">{body}</div>;
}
