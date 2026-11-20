/** Administration card for an approval flow other than suppliers (sourcing events and awards, contracts): the onboarding levels editor and tester. */
import { useState } from 'react';
import { api } from '../lib/api';
import { Alert } from './ui';
import { FlowTester, LevelsEditor } from '../pages/admin/config/LevelsEditor';
import type { CatalogEntry } from '../pages/admin/config/shared';
import type { WorkflowLevel } from '../lib/types';

export interface ApprovalSetup { levels: WorkflowLevel[]; catalog: CatalogEntry[]; roles: { key: string; name: string }[] }
export interface ApprovalText { title: string; subject: string; field: string; saved: string; intro: string }

export function ApprovalLevelsCard({ endpoint, setup, text }: { endpoint: string; setup: ApprovalSetup; text: ApprovalText }) {
  const [levels, setLevels] = useState<WorkflowLevel[]>(setup.levels);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const [busy, setBusy] = useState(false);
  const edit = (fn: (ls: WorkflowLevel[]) => void) => setLevels((prev) => { const n = structuredClone(prev); fn(n); return n; });
  async function save() {
    setBusy(true); setMsg(undefined);
    try { const r = await api<{ approval: ApprovalSetup }>(endpoint, { method: 'PUT', body: { levels } }); setLevels(r.approval.levels); setMsg({ kind: 'success', text: text.saved }); }
    catch (e: any) { setMsg({ kind: 'error', text: e.message }); } finally { setBusy(false); }
  }
  return (
    <section className="card pad section-card" style={{ marginTop: 24 }} aria-label={text.title}>
      <h3>{text.title}</h3>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="workflow-editor">
        <LevelsEditor levels={levels} edit={edit} roles={setup.roles} catalog={setup.catalog} subject={text.subject} minLevels={0} issuePath="levels"
          newCondition={{ field: text.field, op: 'gt', value: 1000000 }} intro={text.intro} />
        <FlowTester levels={levels} catalog={setup.catalog} subject={text.subject} always={[text.field]} allowNone />
      </div>
      <div className="btn-row"><button className="btn btn-primary" disabled={busy} onClick={save}>Save {text.title.toLowerCase()} flow</button></div>
    </section>
  );
}
