import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Alert } from '../components/ui';
import { TabStrip } from '../components/TabStrip';

type Mode = 'invite' | 'approved';
interface Row { row: number; name: string; errors: string[]; warnings: string[] }
interface Result { ok: boolean; applied: boolean; mode: Mode; summary: { rows: number; withErrors: number; withWarnings: number; invitations: number }; limitError: string | null; rows: Row[]; created?: { id: string; code: string; name: string }[] }

const COPY: Record<Mode, { title: string; intro: string; steps: string[] }> = {
  invite: {
    title: 'Invite suppliers',
    intro: 'Invite many suppliers at once. Each gets the usual invitation to register and fills in the form themselves (or you fill it in for them from their page).',
    steps: ['Download the template', 'One row per supplier: name, type and contact. Choose per row whether to send the invitation now.', 'Upload it — every row is checked first; nothing is created until the whole file is clean.'],
  },
  approved: {
    title: 'Import approved suppliers',
    intro: 'Bring in your existing supplier master. Each row becomes an approved supplier straight away — no onboarding and no approval steps.',
    steps: ['Download the template — it has a column for every field on your current form', 'Fill in what you have; leave the rest blank. Add each supplier’s ERP code so purchase orders link to them.', 'Upload it. Wrong values (e.g. a GSTIN that doesn’t check out) stop the import with their row; missing details and documents are listed as warnings.'],
  },
};

/** Suppliers from Excel: invite a list, or import the existing supplier master as approved. */
export function VendorImport() {
  const [mode, setMode] = useState<Mode>('invite');
  const [file, setFile] = useState<File>();
  const [r, setR] = useState<Result>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [notify, setNotify] = useState(true);
  function switchMode(m: Mode) { setMode(m); setFile(undefined); setR(undefined); setErr(undefined); }
  async function send(f: File, apply: boolean) {
    setBusy(true); setErr(undefined);
    const fd = new FormData(); fd.append('file', f);
    try { setR(await api<Result>(`/staff/vendor-import?mode=${mode}${apply ? `&apply=1${mode === 'approved' && notify ? '&notify=1' : ''}` : ''}`, { body: fd })); }
    catch (e: any) { setErr(e.message); setR(undefined); } finally { setBusy(false); }
  }
  const c = COPY[mode];
  const problemRows = r?.rows.filter((x) => x.errors.length || x.warnings.length) ?? [];
  return (
    <div className="page">
      <header className="page-head"><div><h1>Suppliers from Excel</h1><p className="muted"><Link to="/staff/vendors">Vendors</Link> · invite a list of suppliers, or import your existing suppliers as approved.</p></div></header>
      <div className="card">
        <TabStrip>
          {(['invite', 'approved'] as Mode[]).map((m) => <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? 'active' : ''} onClick={() => switchMode(m)}>{COPY[m].title}</button>)}
        </TabStrip>
        <div className="pad stack">
          <p>{c.intro}</p>
          <ol className="import-steps">
            <li><a className="btn btn-secondary btn-sm" href={`/api/staff/vendor-import/template.xlsx?mode=${mode}`}>{c.steps[0]}</a></li>
            <li className="small">{c.steps[1]}</li>
            <li className="small">{c.steps[2]}
              <div style={{ marginTop: 8 }}><input type="file" accept=".xlsx" onChange={(e) => { const f = e.target.files?.[0]; setFile(f); setR(undefined); if (f) send(f, false); }} /></div></li>
          </ol>
          {busy && !r && <p className="muted small">Checking the file…</p>}
          {err && <Alert kind="error">{err}</Alert>}

          {r?.applied && r.created && (
            <Alert kind="success">{r.created.length} supplier{r.created.length === 1 ? '' : 's'} {mode === 'invite' ? `created${r.summary.invitations ? `, ${r.summary.invitations} invitation${r.summary.invitations === 1 ? '' : 's'} sent` : ''}` : `imported as approved${notify ? ' and emailed to check their details' : ''}`}. <Link to="/staff/vendors">See them in Vendors</Link>.</Alert>
          )}
          {r && !r.applied && (<>
            {r.limitError && <Alert kind="error">{r.limitError}</Alert>}
            {r.ok
              ? <Alert kind="success">All {r.summary.rows} row{r.summary.rows === 1 ? '' : 's'} are ready{r.summary.withWarnings ? ` (${r.summary.withWarnings} with warnings — they can still be imported)` : ''}.{mode === 'invite' ? ` ${r.summary.invitations} invitation${r.summary.invitations === 1 ? '' : 's'} will be sent.` : ''}</Alert>
              : !r.limitError && <Alert kind="error">{r.summary.withErrors} of {r.summary.rows} row{r.summary.rows === 1 ? '' : 's'} need fixing. Nothing was created — fix them in the file and upload it again.</Alert>}
            {problemRows.length > 0 && (
              <div className="table-wrap"><table className="table small">
                <thead><tr><th>Row</th><th>Supplier</th><th>Problems</th><th>Warnings</th></tr></thead>
                <tbody>{problemRows.map((x) => (
                  <tr key={x.row} style={{ cursor: 'default' }}><td>{x.row}</td><td>{x.name || '—'}</td>
                    <td>{x.errors.length ? <ul className="plain diff-text">{x.errors.map((e) => <li key={e}>{e}</li>)}</ul> : <span className="ok-text">✓</span>}</td>
                    <td>{x.warnings.length ? <ul className="plain muted">{x.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : '—'}</td></tr>
                ))}</tbody>
              </table></div>
            )}
            {r.ok && (
              <div className="row-between">
                {mode === 'approved' ? <label className="check-item"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                  <span className="small"><strong>Email each supplier to sign in, check their details and upload missing documents</strong></span></label> : <span />}
                <button className="btn btn-primary" disabled={busy || !file} onClick={() => file && send(file, true)}>{busy ? 'Working…' : mode === 'invite' ? `Create ${r.summary.rows} supplier${r.summary.rows === 1 ? '' : 's'}` : `Import ${r.summary.rows} approved supplier${r.summary.rows === 1 ? '' : 's'}`}</button>
              </div>
            )}
          </>)}
        </div>
      </div>
    </div>
  );
}
