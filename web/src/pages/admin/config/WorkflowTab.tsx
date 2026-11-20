import type { ConfigIssue, OnboardingConfig } from '../../../lib/types';
import { fieldCatalog, type EditorMeta, type Update } from './shared';
import { FlowTester, LevelsEditor } from './LevelsEditor';

export function WorkflowTab({ config, update, meta, roles, issues }: { config: OnboardingConfig; update: Update; meta: EditorMeta; roles: { key: string; name: string }[]; issues: ConfigIssue[] }) {
  const catalog = fieldCatalog(config, meta);
  return (
    <div className="workflow-editor">
      <div>
        <LevelsEditor levels={config.workflow.levels} edit={(fn) => update((c) => fn(c.workflow.levels))} roles={roles} catalog={catalog} issues={issues}
          subject="vendors" newCondition={{ field: 'vendor.vendorType', op: 'eq', value: 'IMPORT' }} />
        <ChangeRules config={config} update={update} issues={issues} />
      </div>
      <FlowTester levels={config.workflow.levels} catalog={catalog} subject="vendors" always={['vendor.vendorType']} defaults={{ 'vendor.vendorType': 'DOMESTIC' }} />
    </div>
  );
}

/** Which levels re-approve a change an approved vendor asks for, by the fields it touches. */
function ChangeRules({ config, update, issues }: { config: OnboardingConfig; update: Update; issues: ConfigIssue[] }) {
  const levels = config.workflow.levels;
  const ch = config.workflow.changes ?? { rules: [], defaultLevelIds: [] };
  const targets = [
    { id: 'documents', label: 'Any new / renewed document' },
    ...config.sections.flatMap((s) => [
      { id: `${s.key}.*`, label: `${s.label} — any field` },
      ...s.groups.flatMap((g) => g.fields.map((f) => ({ id: `${s.key}.${f.key}`, label: `${s.label} › ${f.label}` }))),
    ]),
  ];
  const labelOf = (id: string) => targets.find((t) => t.id === id)?.label ?? id;
  const edit = (fn: (c: NonNullable<OnboardingConfig['workflow']['changes']>) => void) =>
    update((c) => { c.workflow.changes ??= { rules: [], defaultLevelIds: [] }; fn(c.workflow.changes); });
  const toggle = (arr: string[], id: string) => { const k = arr.indexOf(id); if (k >= 0) arr.splice(k, 1); else arr.push(id); };
  const bad = issues.filter((x) => x.path === 'workflow.changes');
  return (
    <section className="change-rules">
      <h3>Changes after approval</h3>
      <p className="muted small">When an approved vendor asks to change details, only the levels picked here review it. Rules are checked against every changed field; all matching rules’ levels apply, in flow order. If nothing matches, the default levels review it (or the last level, if none are picked).</p>
      {ch.rules.map((r, ri) => (
        <div key={ri} className="card pad rule-card">
          <div className="row-between"><strong className="small">Rule {ri + 1}</strong>
            <button className="icon-btn" aria-label={`Delete rule ${ri + 1}`} onClick={() => edit((x) => { x.rules.splice(ri, 1); })}>🗑</button></div>
          <div className="small">When these change:</div>
          <div className="chips">
            {r.match.map((m) => <span key={m} className="chip">{labelOf(m)} <button className="chip-x" aria-label={`Remove ${labelOf(m)}`} onClick={() => edit((x) => { x.rules[ri].match = x.rules[ri].match.filter((y) => y !== m); })}>×</button></span>)}
            <select aria-label="Add field" value="" onChange={(e) => e.target.value && edit((x) => { x.rules[ri].match.push(e.target.value); })}>
              <option value="">+ add field…</option>
              {targets.filter((t) => !r.match.includes(t.id)).map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
          <div className="small">…these levels review it:</div>
          <div className="level-checks">
            {levels.map((l) => <label key={l.id} className="checkbox"><input type="checkbox" checked={r.levelIds.includes(l.id)} onChange={() => edit((x) => toggle(x.rules[ri].levelIds, l.id))} /> {l.label}</label>)}
          </div>
        </div>
      ))}
      <button className="btn btn-secondary btn-sm" onClick={() => edit((x) => { x.rules.push({ match: [], levelIds: levels.slice(-1).map((l) => l.id) }); })}>+ Add rule</button>
      <div className="card pad rule-card">
        <div className="small"><strong>Default</strong> — any other change is reviewed by:</div>
        <div className="level-checks">
          {levels.map((l) => <label key={l.id} className="checkbox"><input type="checkbox" checked={ch.defaultLevelIds.includes(l.id)} onChange={() => edit((x) => toggle(x.defaultLevelIds, l.id))} /> {l.label}</label>)}
        </div>
      </div>
      {bad.map((x, k) => <div key={k} className="field-error">{x.message}</div>)}
    </section>
  );
}

