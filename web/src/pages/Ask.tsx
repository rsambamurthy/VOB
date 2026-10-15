/** "Ask VendorGate": a question in plain words → one of the fixed searches → a table of records. */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Alert } from '../components/ui';
import { NavIcon } from '../components/NavIcon';
import { fmtDate, fmtDateTime, num } from '../lib/format';
import { useHelpContext } from '../help/HelpPanel';
import { useSession } from '../lib/session';

interface Column { key: string; label: string; type?: 'date' | 'datetime' | 'money' | 'number' }
interface Answer {
  answered: boolean; message?: string; test: boolean;
  search?: { name: string; params: Record<string, unknown>; title: string };
  result?: { columns: Column[]; rows: (Record<string, string | number | null> & { _link?: string })[]; total: number; truncated: boolean };
}

const EXAMPLES_BASE = [
  'Which approved suppliers have documents expiring in the next 90 days?',
  'Show suppliers waiting for approval for more than 5 days',
  'Who changed their bank details in the last 30 days?',
  'List suppliers on hold',
];
const EXAMPLES_COLLAB = ['Open purchase orders over 1m with no shipment notice yet', 'Invoices in exception this month, by supplier'];
const RECENT_KEY = 'vg.askRecent';
const loadRecent = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); } catch { return []; } };

export function AskPage() {
  useHelpContext('ask');
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  const [busy, setBusy] = useState(false);
  const [a, setA] = useState<Answer>();
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<{ enabled: boolean; live: boolean; searches: string[] }>();
  const [recent, setRecent] = useState(loadRecent);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { api('/ask').then(setInfo).catch(() => {}); input.current?.focus(); }, []);
  useEffect(() => {
    setText(q);
    if (!q) { setA(undefined); return; }
    setBusy(true); setError(undefined);
    api<Answer>('/ask', { body: { question: q } }).then((r) => {
      setA(r);
      const next = [q, ...loadRecent().filter((x) => x !== q)].slice(0, 6);
      try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      setRecent(next);
    }).catch((e) => { setA(undefined); setError(e.message); }).finally(() => setBusy(false));
  }, [q]);

  const ask = (question: string) => { if (question.trim().length >= 3) setParams({ q: question.trim() }); };
  const submit = (e: FormEvent) => { e.preventDefault(); ask(text); };
  const examples = [...EXAMPLES_BASE, ...(info?.searches.includes('invoices') ? EXAMPLES_COLLAB : [])];

  const download = async () => {
    if (!a?.search) return;
    const res = await fetch('/api/ask/export', { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/json' }, body: JSON.stringify(a.search) });
    if (!res.ok) { setError('The download failed. Try again.'); return; }
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a'); link.href = url; link.download = `ask_${new Date().toISOString().slice(0, 10)}.xlsx`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  return (
    <div className="page ask-page">
      <header className="page-head"><div><h1><span className="ask-spark" aria-hidden><NavIcon name="ask" size={20} /></span> Ask {me?.tenant.branding.productName ?? 'VendorGate'}</h1>
        <p className="muted">Ask about your suppliers in plain words. Answers come straight from your records — the AI only reads your question, never your supplier data.</p></div></header>

      {info && !info.enabled && <Alert kind="info">Ask is turned off for this workspace. An administrator can turn it on under Administration → Integrations.</Alert>}

      <form className="ask-box" onSubmit={submit}>
        <NavIcon name="search" size={18} />
        <input ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Which approved suppliers in Riyadh have a CR expiring this quarter?" aria-label="Your question" maxLength={400} />
        <button className="btn btn-primary" disabled={busy || text.trim().length < 3}>{busy ? 'Searching…' : 'Ask'}</button>
      </form>

      {!q && (
        <div className="ask-start">
          <p className="ask-label">Try</p>
          <div className="ask-chips">{examples.map((x) => <button key={x} type="button" className="ask-chip" onClick={() => ask(x)}>{x}</button>)}</div>
          {recent.length > 0 && <><p className="ask-label">Recent</p><div className="ask-chips">{recent.map((x) => <button key={x} type="button" className="ask-chip quiet" onClick={() => ask(x)}>{x}</button>)}</div></>}
        </div>
      )}

      {error && <Alert kind="error">{error}</Alert>}
      {busy && <div className="pad"><div className="spinner" /></div>}

      {!busy && a && !a.answered && <Alert kind="info">{a.message}</Alert>}
      {!busy && a?.answered && a.result && a.search && (
        <div className="card ask-result">
          <div className="ask-result-head">
            <div>
              <h2>{a.search.title}</h2>
              <p className="muted small">{a.result.total === 0 ? 'Nothing matches.' : `${num(a.result.total)}${a.result.truncated ? '+' : ''} ${a.result.total === 1 ? 'record' : 'records'}`}
                {a.test && <> · <span className="tag-test">Test mode — keyword matching, AI is off</span></>}</p>
            </div>
            {a.result.total > 0 && <button className="btn btn-secondary btn-sm" onClick={download}>Download Excel</button>}
          </div>
          {a.result.total > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead><tr>{a.result.columns.map((c) => <th key={c.key} className={c.type === 'money' || c.type === 'number' ? 'num' : ''}>{c.label}</th>)}</tr></thead>
                <tbody>{a.result.rows.map((r, i) => <Row key={i} r={r} cols={a.result!.columns} />)}</tbody>
              </table>
            </div>
          )}
          {a.result.truncated && <p className="small muted pad">Showing the first 500. Download Excel for the same list, or narrow the question.</p>}
        </div>
      )}
      {!busy && a && <p className="small muted ask-foot">Not what you meant? Rephrase the question, or use <Link to="/staff/reports">Reports</Link> for fixed lists.</p>}
    </div>
  );
}

function Row({ r, cols }: { r: Record<string, string | number | null> & { _link?: string }; cols: Column[] }) {
  const nav = useNavigate();
  const cell = (c: Column) => {
    const v = r[c.key];
    if (v === null || v === undefined || v === '') return '—';
    if (c.type === 'date') return fmtDate(String(v));
    if (c.type === 'datetime') return fmtDateTime(String(v));
    if (c.type === 'money') return num(Number(v), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (c.type === 'number') return num(Number(v));
    return String(v);
  };
  return (
    <tr onClick={() => r._link && nav(r._link)} className={r._link ? '' : 'no-link'}>
      {cols.map((c, i) => <td key={c.key} className={c.type === 'money' || c.type === 'number' ? 'num' : ''}>{i === 0 && r._link ? <Link to={r._link} onClick={(e) => e.stopPropagation()}><strong>{cell(c)}</strong></Link> : cell(c)}</td>)}
    </tr>
  );
}

/** The "Ask or search…" box in the top bar. */
export function AskBox() {
  const nav = useNavigate();
  const [v, setV] = useState('');
  return (
    <form className="af-search" role="search" onSubmit={(e) => { e.preventDefault(); if (v.trim().length >= 3) { nav(`/staff/ask?q=${encodeURIComponent(v.trim())}`); setV(''); } else nav('/staff/ask'); }}>
      <NavIcon name="search" size={14} />
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder="Ask about your suppliers…" aria-label="Ask about your suppliers" />
    </form>
  );
}
