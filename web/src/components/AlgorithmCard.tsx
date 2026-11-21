/**
 * One card for every configurable algorithm (server lib/algorithms.ts): how it works, its settings, and each rule's action
 * (Block / Warn / Off; fixed rules say why). The text comes from the definition the checks run on, and "Download as a
 * document" gives the same definition as Markdown — so the screen, the checks and the document can't drift apart.
 */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Alert } from './ui';

type Action = 'block' | 'warn' | 'off';
interface Param { key: string; label: string; help: string; type: 'number' | 'boolean'; default: number | boolean; min?: number; max?: number; unit?: string }
interface Rule { key: string; label: string; when: string; catches: string; default: Action; actions: Action[]; locked?: string }
export interface AlgorithmView {
  key: string; name: string; module: string; summary: string; runs: string; steps: { title: string; text: string }[]; params: Param[]; rules: Rule[];
  examples?: { before: string; after: string; rule: string; result: string }[]; notes?: string[];
  values: { params: Record<string, number | boolean>; rules: Record<string, Action> };
}
const ACTION: Record<Action, string> = { block: 'Block', warn: 'Warn', off: 'Off' };
const ACTION_HELP: Record<Action, string> = { block: 'an error — it can’t be submitted', warn: 'an exception — a person must look', off: 'not checked' };

export function AlgorithmCard({ algorithmKey }: { algorithmKey: string }) {
  const [a, setA] = useState<AlgorithmView>();
  const [params, setParams] = useState<Record<string, number | boolean | string>>({});
  const [rules, setRules] = useState<Record<string, Action>>({});
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const [busy, setBusy] = useState(false);
  const take = (v: AlgorithmView) => { setA(v); setParams(v.values.params); setRules(v.values.rules); };
  useEffect(() => { api<AlgorithmView>(`/admin/algorithms/${algorithmKey}`).then(take).catch((e) => setMsg({ kind: 'error', text: e.message })); }, [algorithmKey]);
  if (!a) return msg ? <Alert kind="error">{msg.text}</Alert> : null;
  async function save() {
    setBusy(true); setMsg(undefined);
    try {
      const body = { params: Object.fromEntries(a!.params.map((p) => [p.key, p.type === 'number' ? Number(params[p.key]) : !!params[p.key]])), rules: Object.fromEntries(a!.rules.filter((r) => !r.locked).map((r) => [r.key, rules[r.key]])) };
      const r = await api<AlgorithmView & { changes: string[] }>(`/admin/algorithms/${algorithmKey}`, { method: 'PUT', body });
      take(r); setMsg({ kind: 'success', text: r.changes.length ? `Saved: ${r.changes.join('; ')}.` : 'Saved — nothing changed.' });
    } catch (e: any) { setMsg({ kind: 'error', text: e.message }); } finally { setBusy(false); }
  }
  const reset = () => { setParams(Object.fromEntries(a.params.map((p) => [p.key, p.default]))); setRules(Object.fromEntries(a.rules.map((r) => [r.key, r.default]))); };
  return (
    <section className="card pad section-card algo-card" style={{ marginTop: 24 }} aria-label={a.name}>
      <div className="toolbar" style={{ padding: 0 }}><h3 style={{ margin: 0 }}>{a.name}</h3>
        <a className="btn btn-secondary btn-sm" href={`/api/admin/algorithms/${algorithmKey}/document.md`}>Download as a document</a></div>
      <p className="muted small">{a.summary} <span className="muted">Runs: {a.runs}</span></p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <button className="link-btn small" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide how it works' : 'How it works'}</button>
      {open && <>
        <ol className="algo-steps">{a.steps.map((s) => <li key={s.title}><strong>{s.title}</strong> — {s.text}</li>)}</ol>
        {a.examples?.length ? <div className="table-wrap"><table className="table static compact">
          <thead><tr><th>Already in VendorGate</th><th>New</th><th>Rule</th><th>Result</th></tr></thead>
          <tbody>{a.examples.map((e, i) => <tr key={i}><td className="mono small">{e.before}</td><td className="mono small">{e.after}</td><td>{e.rule}</td><td className="small">{e.result}</td></tr>)}</tbody></table></div> : null}
        {a.notes?.length ? <ul className="small">{a.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
      </>}
      {a.params.length > 0 && <>
        <h4>Settings</h4>
        <div className="field-grid">{a.params.map((p) => (
          <div key={p.key} className="field">
            {p.type === 'boolean'
              ? <label className="check-item"><input type="checkbox" checked={!!params[p.key]} onChange={(e) => setParams({ ...params, [p.key]: e.target.checked })} /> <span>{p.label}</span></label>
              : <><label htmlFor={`al-${a.key}-${p.key}`}>{p.label}{p.unit ? ` (${p.unit})` : ''}</label>
                <input id={`al-${a.key}-${p.key}`} inputMode="decimal" value={String(params[p.key] ?? '')} onChange={(e) => setParams({ ...params, [p.key]: e.target.value })} /></>}
            <div className="field-help">{p.help}{p.type === 'number' ? ` Default ${p.default}${p.min !== undefined ? `, ${p.min}–${p.max}` : ''}.` : ` Default ${p.default ? 'on' : 'off'}.`}</div>
          </div>))}</div>
      </>}
      {a.rules.length > 0 && <>
        <h4>Rules</h4>
        <p className="muted small" style={{ marginTop: 0 }}>{(['block', 'warn', 'off'] as Action[]).map((x) => `${ACTION[x]} = ${ACTION_HELP[x]}`).join(' · ')}.</p>
        <div className="table-wrap"><table className="table static compact">
          <thead><tr><th>Rule</th><th>Matches when</th><th style={{ width: 200 }}>Action</th></tr></thead>
          <tbody>{a.rules.map((r) => (
            <tr key={r.key}>
              <td><strong>{r.key}</strong> {r.label}<div className="muted small">{r.catches}</div></td>
              <td className="small">{r.when}</td>
              <td>{r.locked ? <span className="small">{ACTION[r.default]} <span className="muted">— fixed: {r.locked}</span></span>
                : <select aria-label={`${r.key} ${r.label} action`} value={rules[r.key]} onChange={(e) => setRules({ ...rules, [r.key]: e.target.value as Action })}>
                  {r.actions.map((x) => <option key={x} value={x}>{ACTION[x]}{x === r.default ? ' (default)' : ''}</option>)}</select>}</td>
            </tr>))}</tbody>
        </table></div>
      </>}
      <div className="btn-row"><button className="btn btn-ghost" onClick={reset}>Back to defaults</button><button className="btn btn-primary" disabled={busy} onClick={save}>Save {a.name.toLowerCase()}</button></div>
    </section>
  );
}
