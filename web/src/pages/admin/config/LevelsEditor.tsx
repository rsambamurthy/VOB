/**
 * Approval levels editor and flow tester — one component for every approval flow:
 * supplier onboarding (Configuration → Approval flow) and sourcing events (Administration → Sourcing).
 */
import { useMemo, useState } from 'react';
import type { Condition, ConfigIssue, Profile, WorkflowLevel } from '../../../lib/types';
import { ruleHolds } from '../../../lib/conditions';
import { ConditionEditor, move, toKey, type CatalogEntry } from './shared';

export type EditLevels = (fn: (levels: WorkflowLevel[]) => void) => void;

export function LevelsEditor({ levels, edit, roles, catalog, issues = [], issuePath = 'workflow.levels', subject, newCondition, minLevels = 1, intro }: {
  levels: WorkflowLevel[]; edit: EditLevels; roles: { key: string; name: string }[]; catalog: CatalogEntry[]; issues?: ConfigIssue[];
  /** Prefix of the issue paths for a level, e.g. "workflow.levels" → "workflow.levels.<id>". */
  issuePath?: string;
  /** Plural noun for what is approved: "vendors", "events". */
  subject: string;
  /** Condition added by "Only … where…" and "+ Add condition". */
  newCondition: Condition;
  /** 0 = the flow may have no levels (nothing needs approval). */
  minLevels?: number;
  intro?: string;
}) {
  return (
    <div>
      <p className="muted">{intro ?? `Levels run top to bottom. Each is handled by everyone holding its role (or a person it’s reassigned to). A level with a rule is skipped for ${subject} that don’t match.`}</p>
      <ol className="level-list">
        {levels.map((l, i) => {
          const bad = issues.filter((x) => x.path === `${issuePath}.${l.id}`);
          return (
            <li key={l.id} className={`card level-card ${bad.length ? 'has-issue' : ''}`}>
              <div className="level-num" aria-hidden>{i + 1}</div>
              <div className="level-body">
                <div className="field-grid">
                  <div className="field"><label htmlFor={`lv-${l.id}`}>Level name</label><input id={`lv-${l.id}`} value={l.label} onChange={(e) => edit((ls) => { ls[i].label = e.target.value; })} /></div>
                  <div className="field"><label htmlFor={`lr-${l.id}`}>Handled by role</label>
                    <select id={`lr-${l.id}`} value={l.roleKey} onChange={(e) => edit((ls) => { ls[i].roleKey = e.target.value; })}>
                      {!roles.some((r) => r.key === l.roleKey) && <option value={l.roleKey}>⚠ {l.roleKey} (missing)</option>}
                      {roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}
                    </select></div>
                  <div className="field"><label htmlFor={`ls-${l.id}`}>Deadline (hours, optional)</label>
                    <input id={`ls-${l.id}`} inputMode="numeric" value={l.slaHours ?? ''} placeholder="e.g. 48" onChange={(e) => edit((ls) => { const n = parseInt(e.target.value, 10); if (Number.isNaN(n)) delete ls[i].slaHours; else ls[i].slaHours = Math.min(1440, Math.max(1, n)); })} /></div>
                </div>
                <div className="level-rule">
                  <label className="radio"><input type="radio" checked={!l.rule} onChange={() => edit((ls) => { delete ls[i].rule; })} /> Every {singular(subject)}</label>
                  <label className="radio"><input type="radio" checked={!!l.rule} onChange={() => edit((ls) => { ls[i].rule = { match: 'all', conditions: [{ ...newCondition }] }; })} /> Only {subject} where…</label>
                  {l.rule && (
                    <div className="rule-box">
                      {l.rule.conditions.length > 1 && (
                        <select aria-label="Match" value={l.rule.match} onChange={(e) => edit((ls) => { ls[i].rule!.match = e.target.value as 'all' | 'any'; })}>
                          <option value="all">all of these are true</option><option value="any">any of these is true</option>
                        </select>
                      )}
                      {l.rule.conditions.map((cond, ci) => (
                        <ConditionEditor key={ci} value={cond} catalog={catalog} onChange={(nc?: Condition) => edit((ls) => {
                          const r = ls[i].rule!;
                          if (nc) r.conditions[ci] = nc; else r.conditions.splice(ci, 1);
                          if (!r.conditions.length) delete ls[i].rule;
                        })} />
                      ))}
                      <button className="link-btn small" onClick={() => edit((ls) => { ls[i].rule!.conditions.push({ ...newCondition }); })}>+ Add condition</button>
                    </div>
                  )}
                </div>
                {bad.map((x, k) => <div key={k} className="field-error">{x.message}</div>)}
              </div>
              <div className="row-tools vertical">
                <button className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => edit((ls) => move(ls, i, -1))}>↑</button>
                <button className="icon-btn" aria-label="Move down" disabled={i === levels.length - 1} onClick={() => edit((ls) => move(ls, i, 1))}>↓</button>
                <button className="icon-btn" aria-label={`Delete ${l.label}`} disabled={levels.length <= minLevels} onClick={() => confirm(`Remove level “${l.label}”? ${cap(subject)} already in review keep their current steps.`) && edit((ls) => { ls.splice(i, 1); })}>🗑</button>
              </div>
            </li>
          );
        })}
      </ol>
      {!levels.length && <p className="muted small">No approval levels — {subject} don’t need approval.</p>}
      <button className="btn btn-secondary btn-sm" disabled={levels.length >= 10 || !roles.length} onClick={() => edit((ls) => { ls.push({ id: toKey('Level ' + (ls.length + 1), ls.map((x) => x.id)), label: 'New review level', roleKey: roles.find((r) => r.key !== 'ADMIN')?.key ?? roles[0].key }); })}>+ Add level</button>
    </div>
  );
}

/** Try sample values and see which levels apply. `always` fields are asked even when no rule uses them. */
export function FlowTester({ levels, catalog, subject, always = [], defaults = {}, allowNone = false }: { levels: WorkflowLevel[]; catalog: CatalogEntry[]; subject: string; always?: string[]; defaults?: Record<string, string>; allowNone?: boolean }) {
  const used = useMemo(() => [...new Set([...always, ...levels.flatMap((l) => l.rule?.conditions.map((c) => c.field) ?? [])])], [levels, always]);
  const [vals, setVals] = useState<Record<string, string>>(defaults);
  const profile: Profile = {};
  for (const [k, v] of Object.entries(vals)) { const [s, f] = k.split('.'); (profile[s] ??= {})[f] = v; }
  const chain = levels.filter((l) => ruleHolds(l.rule, { profile, vendor: profile.vendor as { vendorType?: string } | undefined }));
  return (
    <aside className="card pad tester">
      <h3>Test the flow</h3>
      <p className="muted small">Pick a sample {singular(subject)} to see which levels it would go through.</p>
      {used.map((f) => {
        const entry = catalog.find((c) => c.id === f);
        const opts = entry?.options ?? [];
        return (
          <div key={f} className="field"><label htmlFor={`t-${f}`}>{entry?.label ?? f}</label>
            {opts.length ? (
              <select id={`t-${f}`} value={vals[f] ?? ''} onChange={(e) => setVals({ ...vals, [f]: e.target.value })}><option value="">—</option>{opts.map((o) => <option key={o}>{o}</option>)}</select>
            ) : <input id={`t-${f}`} inputMode={entry?.type === 'number' ? 'decimal' : undefined} value={vals[f] ?? ''} onChange={(e) => setVals({ ...vals, [f]: e.target.value })} />}
          </div>
        );
      })}
      <ol className="chain">{chain.map((l) => <li key={l.id}>{l.label}{l.slaHours ? <span className="muted small"> · {l.slaHours}h</span> : null}</li>)}</ol>
      {!chain.length && <p className={allowNone ? 'muted small' : 'field-error'}>{allowNone ? `No level applies — this ${singular(subject)} needs no approval.` : `No level applies — this ${singular(subject)} couldn’t be approved.`}</p>}
    </aside>
  );
}
const singular = (s: string) => s.replace(/s$/, '');
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
/** Events may need no approval; vendors always need at least one level. */
const minNone = (subject: string) => subject !== 'vendors';
