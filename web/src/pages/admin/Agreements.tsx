import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Alert, Empty, Modal } from '../../components/ui';
import { fmtDate } from '../../lib/format';
import { VENDOR_TYPES } from '../../lib/meta';
import { agreementFileUrl } from '../../components/Agreements';

interface Version { id: string; version: number; kind: 'TEXT' | 'PDF'; body: string | null; bodyAr: string | null; fileName: string | null; changeNote: string | null; reaccept: boolean; publishedByName: string; publishedAt: string }
interface Agreement { id: string; title: string; titleAr: string | null; vendorTypes: string[]; required: boolean; status: 'ACTIVE' | 'ARCHIVED'; versions: Version[]; accepted: number; outstanding: number }
interface Content { kind: 'TEXT' | 'PDF'; body: string; bodyAr: string; file?: File; changeNote: string; reaccept: boolean }
interface Settings { title: string; titleAr: string; vendorTypes: string[]; required: boolean }
const blankContent: Content = { kind: 'TEXT', body: '', bodyAr: '', changeNote: '', reaccept: false };
const blankSettings: Settings = { title: '', titleAr: '', vendorTypes: [], required: true };
const appliesLabel = (types: string[]) => (!types.length ? 'All suppliers' : types.map((x) => VENDOR_TYPES.find((v) => v.value === x)?.label ?? x).join(', '));
const contentOk = (c: Content) => (c.kind === 'PDF' ? !!c.file : c.body.trim().length >= 20);

function formData(settings: Partial<Settings> | null, c: Content) {
  const fd = new FormData();
  if (settings) {
    fd.append('title', settings.title ?? ''); if (settings.titleAr) fd.append('titleAr', settings.titleAr);
    fd.append('vendorTypes', (settings.vendorTypes ?? []).join(',')); fd.append('required', String(settings.required));
  }
  fd.append('kind', c.kind); fd.append('reaccept', String(c.reaccept));
  if (c.kind === 'TEXT') { fd.append('body', c.body); if (c.bodyAr.trim()) fd.append('bodyAr', c.bodyAr); }
  else if (c.file) fd.append('file', c.file);
  if (c.changeNote.trim()) fd.append('changeNote', c.changeNote);
  return fd;
}

/** Administration → Agreements: code of conduct, NDA, supplier agreement — what suppliers accept in the portal. */
export function Agreements() {
  const [rows, setRows] = useState<Agreement[]>();
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const [creating, setCreating] = useState(false);
  const [versionFor, setVersionFor] = useState<Agreement>();
  const [settingsFor, setSettingsFor] = useState<Agreement>();
  const [historyFor, setHistoryFor] = useState<Agreement>();
  const load = () => api<Agreement[]>('/agreements').then(setRows).catch((e) => setMsg({ kind: 'error', text: e.message }));
  useEffect(() => { load(); }, []);
  const done = (text: string) => { setMsg({ kind: 'success', text }); setCreating(false); setVersionFor(undefined); setSettingsFor(undefined); load(); };
  async function setStatus(a: Agreement, action: 'archive' | 'restore') {
    try { await api(`/agreements/${a.id}/${action}`, { method: 'POST' }); done(action === 'archive' ? `“${a.title}” archived. Suppliers are no longer asked to accept it; past acceptances are kept.` : `“${a.title}” is active again.`); }
    catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  }
  return (
    <div className="page">
      <header className="page-head"><div><h1>Agreements</h1><p className="muted">What suppliers accept in the portal — code of conduct, NDA, supplier agreement. Required ones must be accepted before a supplier can submit for approval.</p></div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>Add agreement</button></header>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="card">
        {!rows ? <div className="pad"><div className="spinner" /></div> : !rows.length ? <Empty>No agreements yet. Add your supplier code of conduct or NDA — written here or as your own PDF.</Empty> : (
          <table className="table static">
            <thead><tr><th>Agreement</th><th>Applies to</th><th>Current version</th><th>Suppliers</th><th /></tr></thead>
            <tbody>{rows.map((a) => {
              const cur = a.versions[0];
              return (
                <tr key={a.id} className={a.status === 'ARCHIVED' ? 'muted' : ''}>
                  <td><div className="strong">{a.title} {a.status === 'ARCHIVED' && <span className="badge sm">Archived</span>}</div>
                    <div className="small muted">{a.required ? 'Required before submitting' : 'Optional'}{a.titleAr ? ` · ${a.titleAr}` : ''}</div></td>
                  <td className="small">{appliesLabel(a.vendorTypes)}</td>
                  <td className="small">v{cur?.version} · {cur?.kind === 'PDF' ? <a href={agreementFileUrl(cur.id)} target="_blank" rel="noreferrer">{cur.fileName}</a> : 'Text'}{cur?.bodyAr ? ' + Arabic' : ''}
                    <div className="muted">{fmtDate(cur?.publishedAt)} · {cur?.publishedByName}</div></td>
                  <td className="small">{a.accepted} accepted{a.outstanding ? <div className="diff-text">{a.outstanding} to accept</div> : null}</td>
                  <td className="actions small">
                    {a.status === 'ACTIVE' && <><button className="link-btn small" onClick={() => setVersionFor(a)}>New version</button> · </>}
                    <button className="link-btn small" onClick={() => setSettingsFor(a)}>Settings</button> · <button className="link-btn small" onClick={() => setHistoryFor(a)}>History</button> · {a.status === 'ACTIVE'
                      ? <button className="link-btn small danger" onClick={() => setStatus(a, 'archive')}>Archive</button>
                      : <button className="link-btn small" onClick={() => setStatus(a, 'restore')}>Restore</button>}
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
      {creating && <CreateModal onClose={() => setCreating(false)} onDone={done} />}
      {versionFor && <VersionModal a={versionFor} onClose={() => setVersionFor(undefined)} onDone={done} />}
      {settingsFor && <SettingsModal a={settingsFor} onClose={() => setSettingsFor(undefined)} onDone={done} />}
      {historyFor && <HistoryModal a={historyFor} onClose={() => setHistoryFor(undefined)} />}
    </div>
  );
}

function SettingsFields({ s, set }: { s: Settings; set: (s: Settings) => void }) {
  return (<>
    <div className="field-grid">
      <div className="field"><label htmlFor="ag-title">Name</label><input id="ag-title" value={s.title} maxLength={150} placeholder="e.g. Supplier Code of Conduct" onChange={(e) => set({ ...s, title: e.target.value })} autoFocus /></div>
      <div className="field"><label htmlFor="ag-title-ar">Name in Arabic (optional)</label><input id="ag-title-ar" dir="rtl" value={s.titleAr} maxLength={150} onChange={(e) => set({ ...s, titleAr: e.target.value })} /></div>
    </div>
    <div className="field"><label>Applies to</label>
      <div className="btn-row">{VENDOR_TYPES.map((v) => (
        <label key={v.value} className="check-item"><input type="checkbox" checked={s.vendorTypes.includes(v.value)} onChange={(e) => set({ ...s, vendorTypes: e.target.checked ? [...s.vendorTypes, v.value] : s.vendorTypes.filter((x) => x !== v.value) })} /><span>{v.label}</span></label>
      ))}</div>
      <div className="field-help">Tick none for all suppliers.</div></div>
    <label className="check-item"><input type="checkbox" checked={s.required} onChange={(e) => set({ ...s, required: e.target.checked })} /><span><strong>Required</strong><span className="muted small block">Suppliers can’t submit for approval until they accept it. Otherwise it’s offered but optional.</span></span></label>
  </>);
}

function ContentFields({ c, set, first }: { c: Content; set: (c: Content) => void; first: boolean }) {
  return (<>
    <div className="field"><label>Content</label>
      <div className="btn-row">
        <label className="check-item"><input type="radio" name="ag-kind" checked={c.kind === 'TEXT'} onChange={() => set({ ...c, kind: 'TEXT' })} /><span>Write the text</span></label>
        <label className="check-item"><input type="radio" name="ag-kind" checked={c.kind === 'PDF'} onChange={() => set({ ...c, kind: 'PDF' })} /><span>Upload our PDF</span></label>
      </div></div>
    {c.kind === 'TEXT' ? (<>
      <div className="field"><label htmlFor="ag-body">Text</label><textarea id="ag-body" rows={10} value={c.body} onChange={(e) => set({ ...c, body: e.target.value })} />
        <div className="field-help">Plain text; blank line = new paragraph. Suppliers read it in a scroll box, and it’s printed on each acceptance certificate.</div></div>
      <div className="field"><label htmlFor="ag-body-ar">Arabic text (optional)</label><textarea id="ag-body-ar" dir="rtl" rows={5} value={c.bodyAr} onChange={(e) => set({ ...c, bodyAr: e.target.value })} />
        <div className="field-help">Shown to suppliers who use the portal in Arabic.</div></div>
    </>) : (
      <div className="field"><label htmlFor="ag-file">PDF</label><input id="ag-file" type="file" accept=".pdf" onChange={(e) => set({ ...c, file: e.target.files?.[0] })} />
        <div className="field-help">Suppliers open it from the portal before accepting. Each acceptance records a fingerprint of this exact file.</div></div>
    )}
    {!first && <div className="field"><label htmlFor="ag-note">What changed</label><input id="ag-note" value={c.changeNote} maxLength={500} placeholder="e.g. Added a clause on modern slavery" onChange={(e) => set({ ...c, changeNote: e.target.value })} /><div className="field-help">Suppliers asked to accept again see this.</div></div>}
    <label className="check-item"><input type="checkbox" checked={c.reaccept} onChange={(e) => set({ ...c, reaccept: e.target.checked })} />
      <span><strong>{first ? 'Also ask approved suppliers to accept it' : 'Ask suppliers who accepted an earlier version to accept again'}</strong>
        <span className="muted small block">{first ? 'Approved suppliers it applies to are emailed and flagged until they accept. Otherwise only suppliers onboarding from now on are asked.' : 'Approved suppliers are emailed and flagged until they accept this version. Leave it off for small corrections.'}</span></span></label>
  </>);
}

function CreateModal({ onClose, onDone }: { onClose: () => void; onDone: (m: string) => void }) {
  const [s, setS] = useState(blankSettings);
  const [c, setC] = useState(blankContent);
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr(undefined);
    try { await api('/agreements', { body: formData(s, c) }); onDone(`“${s.title}” added. Suppliers it applies to now see it in the portal.`); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title="Add agreement" wide onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || s.title.trim().length < 3 || !contentOk(c)} onClick={save}>{busy ? 'Saving…' : 'Add agreement'}</button></>}>
      {err && <Alert kind="error">{err}</Alert>}
      <SettingsFields s={s} set={setS} />
      <ContentFields c={c} set={setC} first />
    </Modal>
  );
}

function VersionModal({ a, onClose, onDone }: { a: Agreement; onClose: () => void; onDone: (m: string) => void }) {
  const cur = a.versions[0];
  const [c, setC] = useState<Content>({ ...blankContent, kind: cur?.kind ?? 'TEXT', body: cur?.body ?? '', bodyAr: cur?.bodyAr ?? '' });
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr(undefined);
    try { await api(`/agreements/${a.id}/versions`, { body: formData(null, c) }); onDone(`Version ${(cur?.version ?? 0) + 1} of “${a.title}” published.${c.reaccept ? ' Suppliers who accepted an earlier version have been asked to accept again.' : ''}`); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={`New version of ${a.title}`} wide onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !contentOk(c)} onClick={save}>{busy ? 'Publishing…' : `Publish version ${(cur?.version ?? 0) + 1}`}</button></>}>
      {err && <Alert kind="error">{err}</Alert>}
      <p className="small muted">Version {cur?.version} stays on record with everyone who accepted it.</p>
      <ContentFields c={c} set={setC} first={false} />
    </Modal>
  );
}

function SettingsModal({ a, onClose, onDone }: { a: Agreement; onClose: () => void; onDone: (m: string) => void }) {
  const [s, setS] = useState<Settings>({ title: a.title, titleAr: a.titleAr ?? '', vendorTypes: a.vendorTypes, required: a.required });
  const [err, setErr] = useState<string>();
  async function save() {
    try { await api(`/agreements/${a.id}`, { method: 'PUT', body: s }); onDone('Saved.'); } catch (e: any) { setErr(e.message); }
  }
  return (
    <Modal title={`Settings: ${a.title}`} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={s.title.trim().length < 3} onClick={save}>Save</button></>}>
      {err && <Alert kind="error">{err}</Alert>}
      <SettingsFields s={s} set={setS} />
    </Modal>
  );
}

function HistoryModal({ a, onClose }: { a: Agreement; onClose: () => void }) {
  const [open, setOpen] = useState<string>();
  return (
    <Modal title={`${a.title}: versions`} wide onClose={onClose}>
      <ul className="plain">{a.versions.map((v) => (
        <li key={v.id} className="history-row">
          <div className="row-between"><span><strong>Version {v.version}</strong> · {fmtDate(v.publishedAt)} · {v.publishedByName}{v.reaccept && <span className="badge sm flag-medium">accept again</span>}</span>
            {v.kind === 'PDF' ? <a className="small" href={agreementFileUrl(v.id)} target="_blank" rel="noreferrer">{v.fileName}</a> : <button className="link-btn small" onClick={() => setOpen(open === v.id ? undefined : v.id)}>{open === v.id ? 'Hide text' : 'Show text'}</button>}</div>
          {v.changeNote && <div className="small muted">{v.changeNote}</div>}
          {open === v.id && <div className="notice-text agreement-text">{v.body}</div>}
        </li>
      ))}</ul>
    </Modal>
  );
}
