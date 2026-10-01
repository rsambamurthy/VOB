import { useMemo, useState } from 'react';
import type { Condition, ConfigIssue, OnboardingConfig, Profile } from '../../../lib/types';
import { ruleHolds } from '../../../lib/conditions';
import { ConditionEditor, fieldCatalog, move, toKey, type EditorMeta, type Update } from './shared';

export function WorkflowTab({ config, update, meta, roles, issues }: { config: OnboardingConfig; update: Update; meta: EditorMeta; roles: { key: string; name: string }[]; issues: ConfigIssue[] }) {
  const catalog = fieldCatalog(config, meta);
  const levels = config.workflow.levels;
  return (
    <div className="workflow-editor">
      <div>
        <p className="muted">Levels run top to bottom. Each is handled by everyone holding its role (or a person it’s reassigned to). A level with a rule is skipped for vendors that don’t match.</p>
        <ol className="level-list">
          {levels.map((l, i) => {
            const bad = issues.filter((x) => x.path === `workflow.levels.${l.id}`);
            return (
              <li key={l.id} className={`card level-card ${bad.length ? 'has-issue' : ''}`}>
                <div className="level-num" aria-hidden>{i + 1}</div>
                <div className="level-body">
                  <div className="field-grid">
                    <div className="field"><label htmlFor={`lv-${l.id}`}>Level name</label><input id={`lv-${l.id}`} value={l.label} onChange={(e) => update((c) => { c.workflow.levels[i].label = e.target.value; })} /></div>
                    <div className="field"><label htmlFor={`lr-${l.id}`}>Handled by role</label>
                      <select id={`lr-${l.id}`} value={l.roleKey} onChange={(e) => update((c) => { c.workflow.levels[i].roleKey = e.target.value; })}>
                        {!roles.some((r) => r.key === l.roleKey) && <option value={l.roleKey}>⚠ {l.roleKey} (missing)</option>}
                        {roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                      </select></div>
                    <div className="field"><label htmlFor={`ls-${l.id}`}>Deadline (hours, optional)</label>
                      <input id={`ls-${l.id}`} inputMode="numeric" value={l.slaHours ?? ''} placeholder="e.g. 48" onChange={(e) => update((c) => { const n = parseInt(e.target.value, 10); if (Number.isNaN(n)) delete c.workflow.levels[i].slaHours; else c.workflow.levels[i].slaHours = Math.min(1440, Math.max(1, n)); })} /></div>
                  </div>
                  <div className="level-rule">
                    <label className="radio"><input type="radio" checked={!l.rule} onChange={() => update((c) => { delete c.workflow.levels[i].rule; })} /> Every vendor</label>
                    <label className="radio"><input type="radio" checked={!!l.rule} onChange={() => update((c) => { c.workflow.levels[i].rule = { match: 'all', conditions: [{ field: 'vendor.vendorType', op: 'eq', value: 'IMPORT' }] }; })} /> Only vendors where…</label>
                    {l.rule && (
                      <div className="rule-box">
                        {l.rule.conditions.length > 1 && (
                          <select aria-label="Match" value={l.rule.match} onChange={(e) => update((c) => { c.workflow.levels[i].rule!.match = e.target.value as 'all' | 'any'; })}>
                            <option value="all">all of these are true</option><option value="any">any of these is true</option>
                          </select>
                        )}
                        {l.rule.conditions.map((cond, ci) => (
                          <ConditionEditor key={ci} value={cond} catalog={catalog} onChange={(nc?: Condition) => update((c) => {
                            const r = c.workflow.levels[i].rule!;
                            if (nc) r.conditions[ci] = nc; else r.conditions.splice(ci, 1);
                            if (!r.conditions.length) delete c.workflow.levels[i].rule;
                          })} />
                        ))}
                        <button className="link-btn small" onClick={() => update((c) => { c.workflow.levels[i].rule!.conditions.push({ field: 'risk.annualTurnover', op: 'gt', value: 50000000 }); })}>+ Add condition</button>
                      </div>
                    )}
                  </div>
                  {bad.map((x, k) => <div key={k} className="field-error">{x.message}</div>)}
                </div>
                <div className="row-tools vertical">
                  <button className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => update((c) => move(c.workflow.levels, i, -1))}>↑</button>
                  <button className="icon-btn" aria-label="Move down" disabled={i === levels.length - 1} onClick={() => update((c) => move(c.workflow.levels, i, 1))}>↓</button>
                  <button className="icon-btn" aria-label={`Delete ${l.label}`} disabled={levels.length === 1} onClick={() => confirm(`Remove level “${l.label}”? Vendors already in review keep their current steps.`) && update((c) => { c.workflow.levels.splice(i, 1); })}>🗑</button>
                </div>
              </li>
            );
          })}
        </ol>
        <button className="btn btn-secondary btn-sm" disabled={levels.length >= 10} onClick={() => update((c) => { c.workflow.levels.push({ id: toKey('Level ' + (levels.length + 1), levels.map((x) => x.id)), label: 'New review level', roleKey: roles.find((r) => r.key !== 'ADMIN')?.key ?? roles[0].key }); })}>+ Add level</button>
      </div>
      <FlowTester config={config} meta={meta} />
    </div>
  );
}

/** Try a vendor profile and see which levels apply. */
function FlowTester({ config, meta }: { config: OnboardingConfig; meta: EditorMeta }) {
  const catalog = fieldCatalog(config, meta);
  const used = useMemo(() => [...new Set(config.workflow.levels.flatMap((l) => l.rule?.conditions.map((c) => c.field) ?? []))].filter((f) => f !== 'vendor.vendorType'), [config]);
  const [vendorType, setVendorType] = useState('DOMESTIC');
  const [vals, setVals] = useState<Record<string, string>>({});
  const profile: Profile = {};
  for (const [k, v] of Object.entries(vals)) { const [s, f] = k.split('.'); (profile[s] ??= {})[f] = v; }
  const chain = config.workflow.levels.filter((l) => ruleHolds(l.rule, { profile, vendor: { vendorType } }));
  return (
    <aside className="card pad tester">
      <h3>Test the flow</h3>
      <p className="muted small">Pick a sample vendor to see which levels it would go through.</p>
      <div className="field"><label htmlFor="t-vt">Vendor type</label>
        <select id="t-vt" value={vendorType} onChange={(e) => setVendorType(e.target.value)}>{meta.vendorTypes.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
      {used.map((f) => {
        const entry = catalog.find((c) => c.id === f);
        return (
          <div key={f} className="field"><label htmlFor={`t-${f}`}>{entry?.label ?? f}</label>
            {entry?.options?.length ? (
              <select id={`t-${f}`} value={vals[f] ?? ''} onChange={(e) => setVals({ ...vals, [f]: e.target.value })}><option value="">—</option>{entry.options.map((o) => <option key={o}>{o}</option>)}</select>
            ) : <input id={`t-${f}`} value={vals[f] ?? ''} onChange={(e) => setVals({ ...vals, [f]: e.target.value })} />}
          </div>
        );
      })}
      <ol className="chain">{chain.map((l) => <li key={l.id}>{l.label}{l.slaHours ? <span className="muted small"> · {l.slaHours}h</span> : null}</li>)}</ol>
      {!chain.length && <p className="field-error">No level applies — this vendor couldn’t be approved.</p>}
    </aside>
  );
}
