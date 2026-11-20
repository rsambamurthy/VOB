/** Reading uploaded contracts (suggested terms, masked before any AI) and Contracts → Reports. */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, money, moneyShort } from '../../lib/format';
import { useHelpContext } from '../../help/HelpPanel';
import { Alert, Empty } from '../../components/ui';

type Notify = (d: any, text?: string, kind?: 'success' | 'warning' | 'error') => void;
export interface Reading { id: string; fileId: string; reader: string; sentToAi: string | null; suggestions: { field: string; value: string | number | boolean; label: string; evidence: string | null }[]; notes: string[]; masked: number; appliedFields: string[]; createdByName: string; createdAt: string }
const show = (s: Reading['suggestions'][number]) => (typeof s.value === 'boolean' ? (s.value ? 'Yes' : 'No') : s.field.endsWith('Date') ? fmtDate(String(s.value)) : s.field === 'value' ? Number(s.value).toLocaleString() : String(s.value));

/** The files that can be read, a Read button each, and the latest reading's suggestions to take into the contract. */
export function ReadingCard({ contractId, files, reading, editable, manage, onDetail }: {
  contractId: string; files: { id: string; fileName: string; kind: string; generated: boolean }[]; reading: { ai: boolean; readings: Reading[] }; editable: string[] | 'all'; manage: boolean; onDetail: Notify;
}) {
  const readable = files.filter((f) => !f.generated && /\.(docx|pdf)$/i.test(f.fileName) && f.kind !== 'SIGNING');
  const r = reading.readings[0];
  const [pick, setPick] = useState<string[]>([]);
  const [busy, setBusy] = useState<string>();
  const [seen, setSeen] = useState(false);
  useEffect(() => { setPick(r ? r.suggestions.filter((s) => !r.appliedFields.includes(s.field) && (editable === 'all' || editable.includes(s.field))).map((s) => s.field) : []); }, [r?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!manage || (!readable.length && !r)) return null;
  const canApply = (f: string) => editable === 'all' || editable.includes(f) || f === 'jurisdiction';
  async function read(fileId: string) {
    setBusy(fileId);
    try { onDetail(await api(`/staff/contracts/${contractId}/files/${fileId}/read`, { method: 'POST' }), 'Read — check the suggestions below.'); } catch (e: any) { onDetail(undefined, e.message, 'error'); } finally { setBusy(undefined); }
  }
  return (
    <section className="card pad section-card" aria-label="Read the contract">
      <h3 style={{ marginBottom: 2 }}>Read the contract</h3>
      <p className="muted small" style={{ marginTop: 0 }}>{reading.ai ? 'VendorGate masks names, numbers, amounts and dates, then the AI finds where the terms are; the values are put back here.' : 'VendorGate’s own rules find the dates, value, notice and renewal terms. Nothing leaves VendorGate.'}</p>
      <div className="btn-row" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>{readable.map((f) => <button key={f.id} className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => read(f.id)}>{busy === f.id ? 'Reading…' : `Read ${f.fileName}`}</button>)}</div>
      {r && <>
        <p className="small muted">{r.reader === 'local' ? 'Read with VendorGate’s rules' : 'Read with AI (privacy mode)'} · {r.createdByName}, {fmtDateTime(r.createdAt)} · {r.masked} values masked</p>
        {!r.suggestions.length ? <p className="small">Nothing was found. Fill the details in by hand.</p> : <table className="table static compact"><thead><tr><th /><th>Term</th><th>Found</th><th>Where</th></tr></thead>
          <tbody>{r.suggestions.map((s) => <tr key={s.field}>
            <td><input type="checkbox" aria-label={`Use ${s.label}`} disabled={!canApply(s.field) || r.appliedFields.includes(s.field)} checked={pick.includes(s.field)} onChange={(e) => setPick(e.target.checked ? [...pick, s.field] : pick.filter((x) => x !== s.field))} /></td>
            <td>{s.label}{r.appliedFields.includes(s.field) && <span className="badge sm badge-approved" style={{ marginInlineStart: 6 }}>Used</span>}</td><td><b>{show(s)}</b></td><td className="small muted">{s.evidence ?? ''}</td></tr>)}</tbody></table>}
        {r.notes.length > 0 && <Alert kind="warning">{r.notes.join(' ')}</Alert>}
        <div className="btn-row" style={{ justifyContent: 'flex-start' }}>
          {pick.length > 0 && <button className="btn btn-primary btn-sm" onClick={async () => { try { onDetail(await api(`/staff/contracts/${contractId}/readings/${r.id}/apply`, { body: { fields: pick } }), 'The contract is updated.'); } catch (e: any) { onDetail(undefined, e.message, 'error'); } }}>Use the ticked values</button>}
          {r.sentToAi && <button className="link-btn small" onClick={() => setSeen(!seen)}>{seen ? 'Hide' : 'What the AI saw'}</button>}
        </div>
        {seen && r.sentToAi && <pre className="small" style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflow: 'auto', background: 'var(--surface-2, #f7f8fb)', padding: 10, borderRadius: 8 }}>{r.sentToAi}</pre>}
      </>}
    </section>
  );
}

/* ---------------- Contracts → Reports ---------------- */

interface Report {
  byDirection: { direction: string; currency: string; n: number; value: number }[];
  byType: { type: string; label: string; n: number; value: number }[];
  topParties: { id: string; name: string; kind: string; n: number; value: number; currency: string }[];
  pipeline: Record<string, number>;
  expiring: { id: string; number: string; title: string; endDate: string; autoRenew: boolean; value: number | null; currency: string; party: string }[];
  obligations: { open: number; overdue: number; soon: number; done90: number; onTimeRate: number | null };
  cycle: { type: string; label: string; n: number; avg: number; median: number }[];
  watch: { open: number; urgent: number; outcomes: { decided: number; dismissed: number; renewalDecisions: number; beforeNotice: number; beforeNoticePct: number | null; ended: number; endedValue: number; pricesRaised: number; priceExcessRaised: number; amendments: number } } | null;
  prices: { checked: number; above: number; excess: number; byContract: { id: string; number: string; above: number; excess: number }[] } | null;
}
const STAGES: [string, string][] = [['DRAFT', 'Draft'], ['IN_APPROVAL', 'In approval'], ['APPROVED', 'Approved'], ['WITH_PARTY', 'With the other party'], ['AGREED', 'Agreed'], ['SIGNING', 'Out for signature'], ['ACTIVE', 'Active'], ['EXPIRED', 'Expired'], ['TERMINATED', 'Terminated']];
const Bar = ({ v, max }: { v: number; max: number }) => <div style={{ background: 'var(--surface-2, #eef1f7)', borderRadius: 4, height: 8, minWidth: 80 }}><div style={{ width: `${max ? Math.max(2, (v / max) * 100) : 0}%`, height: 8, borderRadius: 4, background: 'var(--accent, #3b5bdb)' }} /></div>;

export function ContractReports() {
  useHelpContext('contract-reports');
  const [r, setR] = useState<Report>();
  const [error, setError] = useState<string>();
  useEffect(() => { api<Report>('/staff/contracts/reports').then(setR).catch((e) => setError(e.message)); }, []);
  if (!r) return <div className="page">{error ? <Alert kind="error">{error}</Alert> : <div className="spinner" />}</div>;
  const maxType = Math.max(...r.byType.map((x) => x.value), 0), maxParty = Math.max(...r.topParties.map((x) => x.value), 0);
  return (
    <div className="page">
      <header className="page-head"><div><h1>Contract reports</h1><p className="muted">What is under contract, what ends soon, and how contracts and obligations are going. Figures refresh every minute.</p></div>
        <div className="head-actions"><a className="btn btn-secondary" href="/api/staff/contracts/reports.xlsx">Download Excel</a></div></header>
      <div className="stat-row">
        {r.byDirection.map((x) => <div key={x.direction + x.currency} className="stat stat-approved"><span className="stat-n" title={money(x.value, x.currency)}>{moneyShort(x.value, x.currency)}</span><span className="stat-l">{x.n} active {x.direction === 'SELL' ? 'customer' : 'supplier'} contract{x.n === 1 ? '' : 's'}</span></div>)}
        {r.watch && <Link className="stat stat-rejected" to="/staff/contract-watch"><span className="stat-n">{r.watch.open}</span><span className="stat-l">Waiting for a decision{r.watch.urgent ? ` (${r.watch.urgent} urgent)` : ''}</span></Link>}
        <Link className="stat stat-attention" to="/staff/contracts?tab=expiring"><span className="stat-n">{r.expiring.length}</span><span className="stat-l">Ending in 90 days</span></Link>
        <Link className="stat stat-rejected" to="/staff/contract-obligations?filter=overdue"><span className="stat-n">{r.obligations.overdue}</span><span className="stat-l">Obligations overdue</span></Link>
        <div className="stat stat-invited"><span className="stat-n">{r.obligations.onTimeRate === null ? '—' : `${r.obligations.onTimeRate}%`}</span><span className="stat-l">Obligations done on time (90 days)</span></div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 16 }}>
        <section className="card pad section-card"><h3>Value by type</h3>{!r.byType.length ? <Empty>No active contracts.</Empty> :
          <table className="table static compact"><tbody>{r.byType.map((x) => <tr key={x.type}><td>{x.label}</td><td className="num small">{x.n}</td><td style={{ width: '35%' }}><Bar v={x.value} max={maxType} /></td><td className="num">{money(x.value)}</td></tr>)}</tbody></table>}</section>
        <section className="card pad section-card"><h3>Largest parties</h3>{!r.topParties.length ? <Empty>No active contracts.</Empty> :
          <table className="table static compact"><tbody>{r.topParties.map((x) => <tr key={x.id}><td><Link to={`/staff/parties/${x.id}`}>{x.name}</Link><div className="muted small">{x.kind === 'CUSTOMER' ? 'Customer' : 'Supplier'} · {x.n} contract{x.n === 1 ? '' : 's'}</div></td><td style={{ width: '35%' }}><Bar v={x.value} max={maxParty} /></td><td className="num">{money(x.value, x.currency)}</td></tr>)}</tbody></table>}</section>
        <section className="card pad section-card"><h3>Pipeline</h3><table className="table static compact"><tbody>{STAGES.map(([k, l]) => <tr key={k}><td>{l}</td><td className="num">{r.pipeline[k] ?? 0}</td></tr>)}</tbody></table></section>
        <section className="card pad section-card"><h3>Time to sign (last 12 months)</h3>{!r.cycle.length ? <p className="muted small">No contracts drafted in VendorGate have been signed yet.</p> :
          <table className="table static compact"><thead><tr><th>Type</th><th className="num">Signed</th><th className="num">Average days</th><th className="num">Median days</th></tr></thead><tbody>{r.cycle.map((x) => <tr key={x.type}><td>{x.label}</td><td className="num">{x.n}</td><td className="num">{x.avg}</td><td className="num">{x.median}</td></tr>)}</tbody></table>}</section>
        <section className="card pad section-card"><h3>Ending in the next 90 days</h3>{!r.expiring.length ? <p className="muted small">Nothing ends in the next 90 days.</p> :
          <table className="table static compact"><tbody>{r.expiring.map((x) => <tr key={x.id}><td className="mono small"><Link to={`/staff/contracts/${x.id}`}>{x.number}</Link></td><td>{x.title}<div className="muted small">{x.party}</div></td><td className="small">{fmtDate(x.endDate)}{x.autoRenew && <div className="muted">renews</div>}</td></tr>)}</tbody></table>}</section>
        {r.watch && <section className="card pad section-card"><h3>Contract watch (last 12 months)</h3>
          <table className="table static compact"><tbody>
            <tr><td>Decisions made</td><td className="num">{r.watch.outcomes.decided}</td></tr>
            <tr><td>Renewal decisions made before the notice date</td><td className="num">{r.watch.outcomes.renewalDecisions ? `${r.watch.outcomes.beforeNotice} of ${r.watch.outcomes.renewalDecisions} (${r.watch.outcomes.beforeNoticePct}%)` : '—'}</td></tr>
            <tr><td>Contracts let end instead of renewing</td><td className="num">{r.watch.outcomes.ended}{r.watch.outcomes.endedValue ? ` · ${money(r.watch.outcomes.endedValue)}` : ''}</td></tr>
            <tr><td>Price excess taken up with suppliers</td><td className="num">{r.watch.outcomes.pricesRaised ? `${money(r.watch.outcomes.priceExcessRaised)} (${r.watch.outcomes.pricesRaised})` : '—'}</td></tr>
            <tr><td>Amendments started from watch</td><td className="num">{r.watch.outcomes.amendments}</td></tr>
            <tr><td>Dismissed</td><td className="num">{r.watch.outcomes.dismissed}</td></tr>
          </tbody></table></section>}
        {r.prices && <section className="card pad section-card"><h3>Order prices against contract prices (90 days)</h3>
          <p className="small">{r.prices.checked} order line{r.prices.checked === 1 ? '' : 's'} matched a contract price; <b>{r.prices.above}</b> above it, <b>{money(r.prices.excess)}</b> paid over the contract price.</p>
          {r.prices.byContract.length > 0 && <table className="table static compact"><tbody>{r.prices.byContract.map((x) => <tr key={x.id}><td className="mono small"><Link to={`/staff/contracts/${x.id}`}>{x.number}</Link></td><td className="num small">{x.above} lines</td><td className="num">{money(x.excess)}</td></tr>)}</tbody></table>}</section>}
      </div>
    </div>
  );
}
