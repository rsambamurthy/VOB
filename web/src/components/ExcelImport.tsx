/**
 * Excel import in two goes, for any list: download the template, upload it to check (nothing is saved — rows that
 * would be imported and rows with problems are shown), then import. The server answers both with
 * { ready: [...], errors: [{ row, message }], created: [...] }; `?commit=1` (plus any `options`) imports.
 */
import { useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { Alert, Modal } from './ui';

export interface ImportResult<R> { ready: R[]; errors: { row: number; message: string }[]; created: unknown[] }

export function ExcelImportModal<R extends { row: number }>({ title, intro, templateUrl, endpoint, options = [], columns, onClose, onDone }: {
  title: string; intro: ReactNode; templateUrl: string; endpoint: string;
  /** Tick boxes sent as query flags, e.g. { key: 'createParties', label: 'Create missing parties' }. */
  options?: { key: string; label: string; help?: string }[];
  /** How to show a row that is ready. */
  columns: { label: string; cell: (r: R) => ReactNode }[];
  onClose: () => void; onDone: (created: number) => void;
}) {
  const [file, setFile] = useState<File>();
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [res, setRes] = useState<ImportResult<R>>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const query = (commit: boolean) => new URLSearchParams({ ...(commit ? { commit: '1' } : {}), ...Object.fromEntries(Object.entries(flags).filter(([, v]) => v).map(([k]) => [k, '1'])) }).toString();
  async function send(commit: boolean) {
    if (!file) return;
    setBusy(true); setError(undefined);
    const fd = new FormData(); fd.append('file', file);
    try {
      const r = await api<ImportResult<R>>(`${endpoint}?${query(commit)}`, { body: fd });
      if (commit) onDone(r.created.length); else setRes(r);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal title={title} wide onClose={onClose} footer={<>
      <button className="btn btn-secondary" onClick={onClose}>Close</button>
      {res && res.ready.length > 0 && <button className="btn btn-primary" disabled={busy} onClick={() => send(true)}>Import {res.ready.length} row{res.ready.length === 1 ? '' : 's'}</button>}
    </>}>
      <p className="muted small" style={{ marginTop: 0 }}>{intro}</p>
      <p><a className="btn btn-secondary btn-sm" href={`/api${templateUrl}`}>Download the template</a></p>
      <div className="field"><label htmlFor="import-file">Filled-in template (.xlsx)</label>
        <input id="import-file" type="file" accept=".xlsx" onChange={(e) => { setFile(e.target.files?.[0]); setRes(undefined); }} /></div>
      {options.map((o) => (
        <label key={o.key} className="check-item"><input type="checkbox" checked={!!flags[o.key]} onChange={(e) => { setFlags({ ...flags, [o.key]: e.target.checked }); setRes(undefined); }} />
          <span><strong>{o.label}</strong>{o.help && <span className="muted small block">{o.help}</span>}</span></label>
      ))}
      <div className="btn-row"><button className="btn btn-secondary" disabled={!file || busy} onClick={() => send(false)}>Check the file</button></div>
      {error && <Alert kind="error">{error}</Alert>}
      {res && <>
        <Alert kind={res.errors.length ? 'warning' : 'success'}>{res.ready.length} row{res.ready.length === 1 ? '' : 's'} ready to import{res.errors.length ? `, ${res.errors.length} with problems (they are left out)` : ''}. Nothing has been saved yet.</Alert>
        {res.errors.length > 0 && <ul className="small" aria-label="Rows with problems">{res.errors.map((e, i) => <li key={i}>{e.row ? `Row ${e.row}: ` : ''}{e.message}</li>)}</ul>}
        {res.ready.length > 0 && (
          <div className="table-wrap"><table className="table static compact">
            <thead><tr><th>Row</th>{columns.map((c) => <th key={c.label}>{c.label}</th>)}</tr></thead>
            <tbody>{res.ready.slice(0, 100).map((r) => <tr key={r.row}><td>{r.row}</td>{columns.map((c) => <td key={c.label}>{c.cell(r)}</td>)}</tr>)}</tbody>
          </table></div>
        )}
      </>}
    </Modal>
  );
}
