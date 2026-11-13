import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../../../lib/api';
import { useConfig } from '../../../lib/meta';
import { useHelpContext } from '../../../help/HelpPanel';
import { Alert, Modal } from '../../../components/ui';
import { fmtDateTime } from '../../../lib/format';
import type { ConfigIssue, OnboardingConfig } from '../../../lib/types';
import { IssueList, type EditorMeta } from './shared';
import { FormTab } from './FormTab';
import { DocumentsTab } from './DocumentsTab';
import { WorkflowTab } from './WorkflowTab';
import { GuideTab } from './GuideTab';
import { HistoryTab, type VersionRow } from './HistoryTab';
import { PreviewModal } from './PreviewModal';
import { TabStrip } from '../../../components/TabStrip';

interface State {
  published: { version: number; config: OnboardingConfig };
  draft: { version: number; config: OnboardingConfig; updatedAt: string; issues: ConfigIssue[] } | null;
  versions: VersionRow[];
  roles: { key: string; name: string }[];
  meta: EditorMeta;
}

const TABS = [['form', 'Form fields'], ['documents', 'Documents'], ['workflow', 'Approval flow'], ['guide', 'Portal guide'], ['history', 'History']] as const;
type Tab = (typeof TABS)[number][0];

const allIds = (c: OnboardingConfig) => new Set(c.sections.flatMap((s) => s.groups.flatMap((g) => g.fields.map((f) => `${s.key}.${f.key}`))));

export function ConfigEditor() {
  const { reload: reloadLive } = useConfig();
  const [state, setState] = useState<State>();
  const [working, setWorking] = useState<OnboardingConfig>();
  const [saved, setSaved] = useState('');
  const [issues, setIssues] = useState<ConfigIssue[]>([]);
  const [tab, setTab] = useState<Tab>('form');
  useHelpContext(`config-${tab}`);
  const [sectionKey, setSectionKey] = useState('basic');
  const [flash, setFlash] = useState<{ kind: 'success' | 'error' | 'info'; text: string }>();
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [excel, setExcel] = useState(false);
  const [preview, setPreview] = useState<{ title: string; config: OnboardingConfig }>();
  const top = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const s = await api<State>('/admin/config');
    const base = s.draft?.config ?? s.published.config;
    setState(s); setWorking(structuredClone(base)); setSaved(JSON.stringify(base)); setIssues(s.draft?.issues ?? []);
  }, []);
  useEffect(() => { load().catch((e) => setFlash({ kind: 'error', text: e.message })); }, [load]);

  const dirty = !!working && JSON.stringify(working) !== saved;
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const update = useCallback((fn: (c: OnboardingConfig) => void) => {
    setWorking((w) => { const next = structuredClone(w!); fn(next); return next; });
  }, []);
  const publishedIds = useMemo(() => (state ? allIds(state.published.config) : new Set<string>()), [state]);

  if (!state || !working) return <div className="page"><div className="spinner" /></div>;
  const hasDraft = !!state.draft || dirty;

  async function save(quiet = false) {
    setBusy(true);
    try {
      const r = await api<{ issues: ConfigIssue[] }>('/admin/config/draft', { method: 'PUT', body: { config: working } });
      setIssues(r.issues); setSaved(JSON.stringify(working));
      const fresh = await api<State>('/admin/config'); setState(fresh);
      if (!quiet) setFlash({ kind: 'success', text: r.issues.length ? `Draft saved with ${r.issues.length} problem(s) to fix before publishing.` : 'Draft saved. Publish when you’re ready.' });
      return r.issues;
    } catch (e: any) { setFlash({ kind: 'error', text: e.message }); return null; } finally { setBusy(false); }
  }
  async function discard() {
    if (!confirm('Discard all unpublished changes?')) return;
    await api('/admin/config/draft', { method: 'DELETE' });
    await load(); setFlash({ kind: 'info', text: 'Draft discarded. You’re looking at the live configuration.' });
  }
  async function restore(v: number) {
    if (dirty && !confirm('Replace your unsaved changes with this version?')) return;
    try { await api(`/admin/config/versions/${v}/restore`, { method: 'POST' }); await load(); setTab('form'); setFlash({ kind: 'info', text: `Version ${v} copied into the draft. Review and publish to make it live.` }); }
    catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }
  async function previewVersion(v: number) {
    const r = await api<{ config: OnboardingConfig }>(`/admin/config/versions/${v}`);
    setPreview({ title: `Version ${v} — vendor form`, config: r.config });
  }
  async function startPublish() {
    if (dirty) { const r = await save(true); if (r === null) return; if (r.length) { setFlash({ kind: 'error', text: 'Fix the problems listed below before publishing.' }); top.current?.scrollIntoView(); return; } }
    else if (issues.length) { setFlash({ kind: 'error', text: 'Fix the problems listed below before publishing.' }); return; }
    setPublishing(true);
  }
  function jump(path: string) {
    const [head, key] = path.split('.');
    if (head === 'documents') setTab('documents');
    else if (head === 'workflow') setTab('workflow');
    else { setTab('form'); setSectionKey(head === 'sections' ? key : head); }
  }

  return (
    <div className="page" ref={top}>
      <header className="page-head">
        <div><h1>Onboarding configuration</h1><p className="muted">What vendors fill in, which documents they upload, and who approves them. Changes go live only when you publish.</p></div>
        <button className="btn btn-secondary" onClick={() => setPreview({ title: hasDraft ? 'Draft — vendor form preview' : 'Live vendor form', config: working })}>Preview form</button>
      </header>

      <div className={`draft-bar ${hasDraft ? 'is-draft' : ''}`}>
        <div>
          {hasDraft ? <><span className="badge badge-under_review">Draft v{state.draft?.version ?? state.published.version + 1}</span> <span className="small">{dirty ? 'Unsaved changes' : `Saved ${fmtDateTime(state.draft?.updatedAt)}`} · live version is v{state.published.version}</span></>
            : <><span className="badge badge-approved">Live v{state.published.version}</span> <span className="small muted">Edit anything below to start a draft.</span></>}
        </div>
        <div className="btn-row">
          <a className={`btn btn-ghost btn-sm ${dirty ? 'disabled' : ''}`} href={dirty ? undefined : '/api/admin/config/excel'} title={dirty ? 'Save the draft first' : 'Tabs, fields and documents as an Excel workbook'}>Download as Excel</a>
          <button className="btn btn-ghost btn-sm" onClick={() => setExcel(true)} disabled={busy || dirty} title={dirty ? 'Save the draft first' : undefined}>Upload Excel…</button>
          {hasDraft && <button className="btn btn-ghost btn-sm" onClick={discard} disabled={busy}>Discard draft</button>}
          <button className="btn btn-secondary btn-sm" onClick={() => save()} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save draft'}</button>
          <button className="btn btn-primary btn-sm" onClick={startPublish} disabled={busy || !hasDraft}>Publish…</button>
        </div>
      </div>

      {flash && <Alert kind={flash.kind}>{flash.text}</Alert>}
      <IssueList issues={issues} onPick={jump} />

      <TabStrip className="page-tabs">
        {TABS.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>)}
      </TabStrip>
      <div className="tab-panel">
        {tab === 'form' && <FormTab config={working} update={update} meta={state.meta} publishedIds={publishedIds} issues={issues} sectionKey={sectionKey} setSectionKey={setSectionKey} />}
        {tab === 'documents' && <DocumentsTab config={working} update={update} meta={state.meta} issues={issues} />}
        {tab === 'workflow' && <WorkflowTab config={working} update={update} meta={state.meta} roles={state.roles} issues={issues} />}
        {tab === 'guide' && <GuideTab config={working} update={update} meta={state.meta} />}
        {tab === 'history' && <HistoryTab versions={state.versions} onRestore={restore} onPreview={previewVersion} />}
      </div>

      {preview && <PreviewModal config={preview.config} meta={state.meta} title={preview.title} onClose={() => setPreview(undefined)} />}
      {excel && <ExcelImportModal onClose={() => setExcel(false)} onApplied={async (n) => { setExcel(false); await load(); setFlash({ kind: 'success', text: `${n} change${n === 1 ? '' : 's'} from Excel saved to the draft. Check them here, then Publish.` }); }} />}
      {publishing && <PublishModal published={state.published.config} draft={working} onClose={() => setPublishing(false)} onDone={async (v) => {
        setPublishing(false); await load(); await reloadLive(); setFlash({ kind: 'success', text: `Version ${v} is now live. New submissions use it immediately; vendors already under review keep their current approval steps.` });
      }} />}
    </div>
  );
}

function PublishModal({ published, draft, onClose, onDone }: { published: OnboardingConfig; draft: OnboardingConfig; onClose: () => void; onDone: (v: number) => void }) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const a = allIds(published), b = allIds(draft);
  const added = [...b].filter((x) => !a.has(x)), removed = [...a].filter((x) => !b.has(x));
  const da = new Set(published.documents.map((d) => d.type)), dbs = new Set(draft.documents.map((d) => d.type));
  const docsAdded = [...dbs].filter((x) => !da.has(x)), docsRemoved = [...da].filter((x) => !dbs.has(x));
  const flowBefore = published.workflow.levels.map((l) => l.label).join(' → '), flowAfter = draft.workflow.levels.map((l) => l.label).join(' → ');
  const labelOf = (cfg: OnboardingConfig, id: string) => { const [s, f] = id.split('.'); const sec = cfg.sections.find((x) => x.key === s); return `${sec?.label} › ${sec?.groups.flatMap((g) => g.fields).find((x) => x.key === f)?.label ?? f}`; };
  async function go() {
    setBusy(true); setError(undefined);
    try { const r = await api<{ version: number }>('/admin/config/publish', { body: { note } }); onDone(r.version); }
    catch (e) { setError(e instanceof ApiError ? e.message : String(e)); setBusy(false); }
  }
  const nothing = !added.length && !removed.length && !docsAdded.length && !docsRemoved.length && flowBefore === flowAfter;
  return (
    <Modal title="Publish configuration" onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={go}>{busy ? 'Publishing…' : 'Publish now'}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <ul className="diff-list">
        {added.map((x) => <li key={x} className="add">+ Field: {labelOf(draft, x)}</li>)}
        {removed.map((x) => <li key={x} className="rem">− Field: {labelOf(published, x)}</li>)}
        {docsAdded.map((x) => <li key={x} className="add">+ Document: {draft.documents.find((d) => d.type === x)?.label}</li>)}
        {docsRemoved.map((x) => <li key={x} className="rem">− Document: {published.documents.find((d) => d.type === x)?.label}</li>)}
        {flowBefore !== flowAfter && <li className="chg">Approval flow: {flowBefore} <strong>→</strong> {flowAfter}</li>}
        {nothing && <li className="muted">Wording, rules or order changes only.</li>}
      </ul>
      <p className="small muted">Vendors filling in the form see the change immediately. Vendors already under review keep the approval steps they have.</p>
      <div className="field"><label htmlFor="pub-note">Note for the history (optional)</label><input id="pub-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Added ESG questions" /></div>
    </Modal>
  );
}

interface ExcelResult { ok: boolean; applied?: boolean; nothing?: boolean; errors?: { sheet: string; row: number; message: string }[]; issues?: ConfigIssue[];
  changes: Record<'tabsAdded' | 'tabsUpdated' | 'tabsRemoved' | 'fieldsAdded' | 'fieldsUpdated' | 'fieldsRemoved' | 'documentsAdded' | 'documentsUpdated' | 'documentsRemoved', string[]> | null }
const CHANGE_LABELS: [keyof NonNullable<ExcelResult['changes']>, string][] = [
  ['tabsAdded', 'Tabs added'], ['tabsUpdated', 'Tabs changed'], ['tabsRemoved', 'Tabs removed'],
  ['fieldsAdded', 'Fields added'], ['fieldsUpdated', 'Fields changed'], ['fieldsRemoved', 'Fields removed'],
  ['documentsAdded', 'Documents added'], ['documentsUpdated', 'Documents changed'], ['documentsRemoved', 'Documents removed'],
];

/** Upload the form as Excel: preview what would change, then save it to the draft. */
function ExcelImportModal({ onClose, onApplied }: { onClose: () => void; onApplied: (count: number) => void }) {
  const [file, setFile] = useState<File>();
  const [r, setR] = useState<ExcelResult>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  async function send(f: File, apply: boolean) {
    setBusy(true); setErr(undefined);
    const fd = new FormData(); fd.append('file', f);
    try {
      const res = await api<ExcelResult>(`/admin/config/excel${apply ? '?apply=1' : ''}`, { body: fd });
      if (apply && res.applied) onApplied(Object.values(res.changes ?? {}).reduce((a, x) => a + x.length, 0)); else setR(res);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  const total = r?.changes ? Object.values(r.changes).reduce((a, x) => a + x.length, 0) : 0;
  return (
    <Modal wide title="Upload the form from Excel" onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !file || !r?.ok || r.nothing} onClick={() => file && send(file, true)}>{busy && r ? 'Saving…' : r?.ok && total ? `Save ${total} change${total === 1 ? '' : 's'} to the draft` : 'Save to the draft'}</button>
    </>}>
      <p className="muted small">Start from <strong>Download as Excel</strong>, edit the Tabs, Fields and Documents sheets, and upload the file here. You’ll see what changes before anything is saved; suppliers see nothing until you Publish.</p>
      <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => { const f = e.target.files?.[0]; setFile(f); setR(undefined); if (f) send(f, false); }} />
      {busy && !r && <p className="small muted">Reading the file…</p>}
      {err && <Alert kind="error">{err}</Alert>}
      {r && !r.ok && r.errors && (<>
        <Alert kind="error">Nothing was changed. Fix these in the file and upload it again:</Alert>
        <table className="table small"><thead><tr><th>Sheet</th><th>Row</th><th>Problem</th></tr></thead>
          <tbody>{r.errors.map((e, i) => <tr key={i} style={{ cursor: 'default' }}><td>{e.sheet}</td><td>{e.row || ''}</td><td>{e.message}</td></tr>)}</tbody></table>
      </>)}
      {r?.ok && r.nothing && <Alert kind="info">The file matches the current form — nothing to change.</Alert>}
      {r?.ok && !r.nothing && r.changes && (<>
        <Alert kind="success">{total} change{total === 1 ? '' : 's'} found. Check them, then save to the draft.</Alert>
        <div className="excel-changes">
          {CHANGE_LABELS.filter(([k]) => r.changes![k].length).map(([k, label]) => (
            <div key={k}><strong className="small">{label} ({r.changes![k].length})</strong><ul className="small">{r.changes![k].map((x) => <li key={x}>{x}</li>)}</ul></div>
          ))}
        </div>
        {!!r.issues?.length && <Alert kind="warning">After this upload the draft would have {r.issues.length} problem(s) to fix before publishing: {r.issues.slice(0, 3).map((i) => i.message).join('; ')}{r.issues.length > 3 ? '…' : ''}</Alert>}
      </>)}
    </Modal>
  );
}
