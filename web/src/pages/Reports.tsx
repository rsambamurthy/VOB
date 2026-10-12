import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { VENDOR_TYPES } from '../lib/meta';
import { fmtDate, fmtDateTime } from '../lib/format';
import { Alert, Empty } from '../components/ui';

interface Column { key: string; label: string; type?: 'date' | 'datetime' | 'number' }
interface ReportMeta { key: string; title: string; description: string; usesRange: boolean; usesDays: boolean; columns: Column[] }
interface ReportData { title: string; columns: Column[]; total: number; rows: Record<string, string | number | null>[] }

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function Reports() {
  const [params, setParams] = useSearchParams();
  const [list, setList] = useState<ReportMeta[]>();
  const [data, setData] = useState<ReportData>();
  const [error, setError] = useState<string>();
  const [from, setFrom] = useState(iso(new Date(Date.now() - 90 * 864e5)));
  const [to, setTo] = useState(iso(new Date()));
  const [vendorType, setVendorType] = useState('');
  const [daysAhead, setDaysAhead] = useState(60);
  const key = params.get('r') ?? 'vendor-register';
  const meta = list?.find((r) => r.key === key);

  useEffect(() => { api<ReportMeta[]>('/reports').then(setList).catch((e) => setError(e.message)); }, []);
  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (meta?.usesRange) { p.set('from', from); p.set('to', to); }
    if (meta?.usesDays) p.set('days', String(daysAhead));
    if (vendorType) p.set('vendorType', vendorType);
    return p.toString();
  }, [meta, from, to, vendorType, daysAhead]);
  useEffect(() => {
    if (!meta) return;
    setData(undefined); setError(undefined);
    api<ReportData>(`/reports/${key}?${qs}`).then(setData).catch((e) => setError(e.message));
  }, [key, qs, meta]);

  const cell = (c: Column, v: string | number | null) => {
    if (v === null || v === '') return <span className="muted">—</span>;
    if (c.type === 'date') return fmtDate(String(v));
    if (c.type === 'datetime') return fmtDateTime(String(v));
    if (v === 'Yes' && c.key === 'overdue') return <span className="badge badge-rejected sm">Overdue</span>;
    return String(v);
  };

  return (
    <div className="page">
      <header className="page-head"><div><h1>Reports</h1><p className="muted">Preview here, download to Excel for the full list. Every download is recorded in the audit log.</p></div></header>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="reports-layout">
        <nav className="card report-nav" aria-label="Reports">
          {list?.map((r) => <button key={r.key} className={r.key === key ? 'active' : ''} onClick={() => setParams({ r: r.key })}><strong>{r.title}</strong><span className="small muted">{r.description}</span></button>)}
        </nav>
        <section className="card">
          <div className="toolbar report-filters">
            {meta?.usesRange && <><label className="small">From <input type="date" className="input-sm" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className="small">To <input type="date" className="input-sm" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label></>}
            {meta?.usesDays && <label className="small">Expiring within <select className="input-sm" value={daysAhead} onChange={(e) => setDaysAhead(Number(e.target.value))}>{[7, 30, 60, 90, 180].map((n) => <option key={n} value={n}>{n} days</option>)}</select></label>}
            <label className="small">Vendor type <select className="input-sm" value={vendorType} onChange={(e) => setVendorType(e.target.value)}><option value="">All</option>{VENDOR_TYPES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}</select></label>
            <span className="grow" />
            {data && <span className="small muted">{data.total} row{data.total === 1 ? '' : 's'}{data.total > data.rows.length ? ` · showing first ${data.rows.length}` : ''}</span>}
            <a className="btn btn-primary btn-sm" href={`/api/reports/${key}?${qs}${qs ? '&' : ''}format=xlsx`} download>Download Excel</a>
          </div>
          {!data ? <div className="pad"><div className="spinner" /></div> : data.rows.length === 0 ? <Empty>Nothing to report for these filters.</Empty> : (
            <div className="table-wrap report-table">
              <table className="table compact">
                <thead><tr>{data.columns.map((c) => <th key={c.key} className={c.type === 'number' ? 'num' : ''}>{c.label}</th>)}</tr></thead>
                <tbody>{data.rows.map((r, i) => <tr key={i} className="no-hover">{data.columns.map((c) => <td key={c.key} className={c.type === 'number' ? 'num' : ''}>{cell(c, r[c.key])}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
