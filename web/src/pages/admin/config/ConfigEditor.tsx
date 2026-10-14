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
          {hasDraft && <button className="btn btn-ghost btn-sm" onClick={discard} disabled={busy}>Discard draft</button>}
          <button className="btn btn-secondary btn-sm" onClick={() => save()} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save draft'}</button>
          <button className="btn btn-primary btn-sm" onClick={startPublish} disabled={busy || !hasDraft}>Publish…</button>
        </div>
      </div>

      {flash && <Alert kind={flash.kind}>{flash.text}</Alert>}
      <IssueList issues={issues} onPick={jump} />

      <div className="tabs page-tabs" role="tablist">
        {TABS.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      <div className="tab-panel">
        {tab === 'form' && <FormTab config={working} update={update} meta={state.meta} publishedIds={publishedIds} issues={issues} sectionKey={sectionKey} setSectionKey={setSectionKey} />}
        {tab === 'documents' && <DocumentsTab config={working} update={update} meta={state.meta} issues={issues} />}
        {tab === 'workflow' && <WorkflowTab config={working} update={update} meta={state.meta} roles={state.roles} issues={issues} />}
        {tab === 'guide' && <GuideTab config={working} update={update} meta={state.meta} />}
        {tab === 'history' && <HistoryTab versions={state.versions} onRestore={restore} onPreview={previewVersion} />}
      </div>

      {preview && <PreviewModal config={preview.config} meta={state.meta} title={preview.title} onClose={() => setPreview(undefined)} />}
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
