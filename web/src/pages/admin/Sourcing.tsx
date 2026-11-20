/** Administration → Sourcing: switch the module on, choose formats and sub-features, set rule defaults and lock them. */
import { useState } from 'react';
import { api } from '../../lib/api';
import { Alert } from '../../components/ui';
import { useHelpContext } from '../../help/HelpPanel';
import { ModuleSettings, type KindRow, type ModuleConfig } from '../../components/ModuleSettings';
import { FlowTester, LevelsEditor } from './config/LevelsEditor';
import type { CatalogEntry } from './config/shared';
import type { WorkflowLevel } from '../../lib/types';

interface ApprovalSetup { levels: WorkflowLevel[]; catalog: CatalogEntry[]; roles: { key: string; name: string }[] }
export interface SourcingConfig extends ModuleConfig { formats: KindRow[]; approval?: ApprovalSetup; awardApproval?: ApprovalSetup }

export function SourcingSettings() {
  useHelpContext('sourcing-settings');
  return (
    <ModuleSettings<SourcingConfig> name="Sourcing" endpoint="/admin/sourcing" kindsKey="formats" ruleNoun="event"
      intro="RFQs and e-auctions: what is switched on for your buyers, and the rules every new event starts with."
      switchHelp="When off, there are no Sourcing menus, screens or emails for staff or suppliers. Your choices below are kept."
      kinds={{ title: 'Formats', help: 'Choose which kinds of event buyers can create.' }}>
      {(cfg) => <>
        {cfg.approval && <ApprovalCard kind="event" setup={cfg.approval} />}
        {cfg.awardApproval && <ApprovalCard kind="award" setup={cfg.awardApproval} />}
      </>}
    </ModuleSettings>
  );
}

/** The two sourcing approval flows (events before invitations, awards before letters) — the onboarding levels editor and tester. */
const FLOW_TEXT = {
  event: { title: 'Event approval', subject: 'events', field: 'event.estimatedValue', saved: 'Event approval flow saved. It applies to events submitted from now on.',
    intro: 'Before bidders are invited, an event goes through these levels top to bottom. A level with a rule is skipped for events that don’t match — for example, approval only above a value. If no level applies, the event is approved straight away. The person who owns an event can never approve it.' },
  award: { title: 'Award approval', subject: 'awards', field: 'award.value', saved: 'Award approval flow saved. It applies to awards proposed from now on.',
    intro: 'Before letters go to bidders and the award goes to the ERP, the proposed award goes through these levels. Rules can use the award value and whether everything went to the best price (“not best price”). If no level applies, the award is final straight away. The person who proposed an award can never approve it.' },
} as const;

function ApprovalCard({ kind, setup }: { kind: 'event' | 'award'; setup: ApprovalSetup }) {
  const txt = FLOW_TEXT[kind];
  const [levels, setLevels] = useState<WorkflowLevel[]>(setup.levels);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const [busy, setBusy] = useState(false);
  const edit = (fn: (ls: WorkflowLevel[]) => void) => setLevels((prev) => { const n = structuredClone(prev); fn(n); return n; });
  async function save() {
    setBusy(true); setMsg(undefined);
    try { const r = await api<{ approval: ApprovalSetup }>(`/admin/sourcing/approval${kind === 'award' ? '?kind=award' : ''}`, { method: 'PUT', body: { levels } }); setLevels(r.approval.levels); setMsg({ kind: 'success', text: txt.saved }); }
    catch (e: any) { setMsg({ kind: 'error', text: e.message }); } finally { setBusy(false); }
  }
  return (
    <section className="card pad section-card" style={{ marginTop: 24 }} aria-label={txt.title}>
      <h3>{txt.title}</h3>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="workflow-editor">
        <LevelsEditor levels={levels} edit={edit} roles={setup.roles} catalog={setup.catalog} subject={txt.subject} minLevels={0} issuePath="levels"
          newCondition={{ field: txt.field, op: 'gt', value: 1000000 }} intro={txt.intro} />
        <FlowTester levels={levels} catalog={setup.catalog} subject={txt.subject} always={[txt.field]} allowNone />
      </div>
      <div className="btn-row"><button className="btn btn-primary" disabled={busy} onClick={save}>Save {txt.title.toLowerCase()} flow</button></div>
    </section>
  );
}
