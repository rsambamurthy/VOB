import { useState } from 'react';
import { Modal } from '../../../components/ui';
import type { ConfigIssue, FieldDef, FieldType, OnboardingConfig } from '../../../lib/types';
import { ArInput, FIELD_TYPE_LABELS, setAr, validatorLabel, RulePicker, fieldCatalog, issuesFor, move, ruleSummary, toKey, type EditorMeta, type Update } from './shared';

interface Props { config: OnboardingConfig; update: Update; meta: EditorMeta; publishedIds: Set<string>; issues: ConfigIssue[]; sectionKey: string; setSectionKey: (k: string) => void }

export function FormTab({ config, update, meta, publishedIds, issues, sectionKey, setSectionKey }: Props) {
  const [editing, setEditing] = useState<{ s: number; g: number; f: number | 'new' }>();
  const [renaming, setRenaming] = useState<number>();
  const si = Math.max(0, config.sections.findIndex((s) => s.key === sectionKey));
  const section = config.sections[si];
  const catalog = fieldCatalog(config, meta);
  const isCore = (id: string) => meta.coreFields.includes(id);
  const coreSection = meta.coreSections.includes(section.key);
  const groupHasCore = (gi: number) => section.groups[gi].fields.some((f) => isCore(`${section.key}.${f.key}`));

  function addSection() {
    const label = prompt('Name of the new tab (e.g. “Quality & Compliance”)');
    if (!label?.trim()) return;
    const key = toKey(label, config.sections.map((s) => s.key));
    update((c) => { c.sections.push({ key, label: label.trim(), groups: [{ key: 'general', label: 'General', fields: [] }] }); });
    setSectionKey(key);
  }

  return (
    <div className="form-editor">
      <aside className="section-list card">
        <div className="list-head">Tabs shown to vendors</div>
        <ol>
          {config.sections.map((s, i) => {
            const n = issuesFor(issues, `sections.${s.key}`).length + issues.filter((x) => x.path.startsWith(`${s.key}.`)).length;
            return (
              <li key={s.key} className={i === si ? 'active' : ''}>
                <button className="sec-btn" onClick={() => setSectionKey(s.key)}>{s.label}{n > 0 && <span className="tab-count">{n}</span>}</button>
                <span className="row-tools">
                  <button className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => update((c) => move(c.sections, i, -1))}>↑</button>
                  <button className="icon-btn" aria-label="Move down" disabled={i === config.sections.length - 1} onClick={() => update((c) => move(c.sections, i, 1))}>↓</button>
                </span>
              </li>
            );
          })}
        </ol>
        <button className="btn btn-secondary btn-sm btn-block" onClick={addSection}>+ Add tab</button>
      </aside>

      <div className="section-body">
        <div className="row-between section-title">
          {renaming === si ? (
            <input autoFocus defaultValue={section.label} onBlur={(e) => { const v = e.target.value.trim(); if (v) update((c) => { c.sections[si].label = v; }); setRenaming(undefined); }} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} aria-label="Tab name" />
          ) : <h2>{section.label} <button className="link-btn small" onClick={() => setRenaming(si)}>Rename</button></h2>}
          {meta.arabic && <div className="ar-inline"><ArInput id={`sec-ar-${section.key}`} meta={meta} english={section.label} value={section.tr?.ar?.label} onChange={(v) => update((c) => { setAr(c.sections[si], 'label', v); })} /></div>}
          {!coreSection && <button className="btn btn-ghost btn-sm" onClick={() => { if (confirm(`Delete the “${section.label}” tab and all its fields?`)) { update((c) => { c.sections.splice(si, 1); }); setSectionKey(config.sections[0].key); } }}>Delete tab</button>}
        </div>

        {section.groups.map((g, gi) => (
          <div key={g.key} className="card group-card">
            <div className="group-head">
              <input className="group-title" value={g.label} aria-label="Group name" onChange={(e) => update((c) => { c.sections[si].groups[gi].label = e.target.value; })} />
              {meta.arabic && <div className="ar-inline"><ArInput id={`grp-ar-${g.key}`} meta={meta} english={g.label} value={g.tr?.ar?.label} onChange={(v) => update((c) => { setAr(c.sections[si].groups[gi], 'label', v); })} /></div>}
              <span className="row-tools">
                <button className="icon-btn" aria-label="Move group up" disabled={gi === 0} onClick={() => update((c) => move(c.sections[si].groups, gi, -1))}>↑</button>
                <button className="icon-btn" aria-label="Move group down" disabled={gi === section.groups.length - 1} onClick={() => update((c) => move(c.sections[si].groups, gi, 1))}>↓</button>
                {!groupHasCore(gi) && <button className="icon-btn" aria-label="Delete group" onClick={() => confirm(`Delete group “${g.label}”${g.fields.length ? ` and its ${g.fields.length} field(s)` : ''}?`) && update((c) => { c.sections[si].groups.splice(gi, 1); })}>🗑</button>}
              </span>
            </div>
            {g.fields.length === 0 && <p className="muted small pad-x">No fields yet.</p>}
            <ul className="field-rows">
              {g.fields.map((f, fi) => {
                const id = `${section.key}.${f.key}`;
                const fieldIssues = issues.filter((x) => x.path === id);
                return (
                  <li key={f.key} className={fieldIssues.length ? 'has-issue' : ''}>
                    <div className="fr-main" onClick={() => setEditing({ s: si, g: gi, f: fi })} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setEditing({ s: si, g: gi, f: fi })}>
                      <div className="fr-label">{f.label}{f.required === true && <span className="req"> *</span>}{isCore(id) && <span className="core-tag" title="Built-in field used by the platform">built-in</span>}</div>
                      <div className="fr-meta">
                        <span>{FIELD_TYPE_LABELS[f.type]}</span>
                        {f.validator && <span>✓ {validatorLabel(meta, f.validator)}</span>}
                        {typeof f.required === 'object' && <span>Required: {ruleSummary(f.required, catalog)}</span>}
                        {f.showIf && <span>Shown: {ruleSummary(f.showIf, catalog)}</span>}
                        <span className="mono muted">{f.key}</span>
                      </div>
                      {fieldIssues.map((x, k) => <div key={k} className="field-error">{x.message}</div>)}
                    </div>
                    <span className="row-tools">
                      <button className="icon-btn" aria-label="Move up" disabled={fi === 0} onClick={() => update((c) => move(c.sections[si].groups[gi].fields, fi, -1))}>↑</button>
                      <button className="icon-btn" aria-label="Move down" disabled={fi === g.fields.length - 1} onClick={() => update((c) => move(c.sections[si].groups[gi].fields, fi, 1))}>↓</button>
                      {!isCore(id) && <button className="icon-btn" aria-label={`Delete ${f.label}`} onClick={() => confirm(`Delete “${f.label}”? Answers vendors already gave are kept but no longer shown.`) && update((c) => { c.sections[si].groups[gi].fields.splice(fi, 1); })}>🗑</button>}
                    </span>
                  </li>
                );
              })}
            </ul>
            <button className="btn btn-ghost btn-sm add-field" onClick={() => setEditing({ s: si, g: gi, f: 'new' })}>+ Add field</button>
          </div>
        ))}
        <button className="btn btn-secondary btn-sm" onClick={() => {
          const label = prompt('Group name (e.g. “Certifications”)');
          if (label?.trim()) update((c) => { c.sections[si].groups.push({ key: toKey(label, c.sections[si].groups.map((x) => x.key)), label: label.trim(), fields: [] }); });
        }}>+ Add group</button>
      </div>

      {editing && (
        <FieldModal
          config={config} meta={meta} sectionIndex={editing.s} groupIndex={editing.g}
          field={editing.f === 'new' ? undefined : config.sections[editing.s].groups[editing.g].fields[editing.f]}
          keyLocked={editing.f !== 'new' && (publishedIds.has(`${config.sections[editing.s].key}.${config.sections[editing.s].groups[editing.g].fields[editing.f].key}`))}
          onClose={() => setEditing(undefined)}
          onSave={(f, targetGroup) => {
            update((c) => {
              const grp = c.sections[editing.s].groups;
              if (editing.f === 'new') grp[targetGroup].fields.push(f);
              else if (targetGroup === editing.g) grp[editing.g].fields[editing.f as number] = f;
              else { grp[editing.g].fields.splice(editing.f as number, 1); grp[targetGroup].fields.push(f); }
            });
            setEditing(undefined);
          }}
        />
      )}
    </div>
  );
}

function FieldModal({ config, meta, sectionIndex, groupIndex, field, keyLocked, onClose, onSave }: {
  config: OnboardingConfig; meta: EditorMeta; sectionIndex: number; groupIndex: number; field?: FieldDef; keyLocked: boolean;
  onClose: () => void; onSave: (f: FieldDef, group: number) => void;
}) {
  const section = config.sections[sectionIndex];
  const taken = section.groups.flatMap((g) => g.fields.map((f) => f.key)).filter((k) => k !== field?.key);
  const [f, setF] = useState<FieldDef>(field ? structuredClone(field) : { key: '', label: '', type: 'text' });
  const [group, setGroup] = useState(groupIndex);
  const [keyTouched, setKeyTouched] = useState(!!field);
  const [error, setError] = useState<string>();
  const core = !!field && meta.coreFields.includes(`${section.key}.${field.key}`);
  const id = `${section.key}.${f.key}`;
  const catalog = fieldCatalog(config, meta);
  const needsOptions = f.type === 'select' || f.type === 'radio';

  function save() {
    if (!f.label.trim()) return setError('Give the field a label');
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(f.key)) return setError('Key must start with a letter and use letters, digits or _');
    if (taken.includes(f.key)) return setError('Another field in this tab already uses that key');
    if (needsOptions && !f.options?.length) return setError('Add at least one option');
    const clean: FieldDef = { ...f, label: f.label.trim() };
    if (!needsOptions) delete clean.options;
    for (const k of ['placeholder', 'help', 'validator'] as const) if (!clean[k]) delete clean[k];
    if (clean.tr?.ar?.options) { const n = clean.options?.length ?? 0; clean.tr = { ...clean.tr, ar: { ...clean.tr.ar, options: Array.from({ length: n }, (_, i) => clean.tr!.ar!.options![i] ?? '') } }; if (!needsOptions) setAr(clean, 'options', undefined); }
    onSave(clean, group);
  }

  return (
    <Modal title={field ? `Edit “${field.label}”` : 'New field'} onClose={onClose} wide
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save}>{field ? 'Apply' : 'Add field'}</button></>}>
      {error && <div className="alert alert-error">{error}</div>}
      {core && <div className="alert alert-info">This is a built-in field used by the ERP export and verification checks. You can change its label, help text and rules, but not delete it or change its key or type.</div>}
      <div className="field-grid">
        <div className="field"><label htmlFor="fe-label">Label</label><input id="fe-label" autoFocus value={f.label} onChange={(e) => setF({ ...f, label: e.target.value, ...(keyTouched ? {} : { key: toKey(e.target.value, taken) }) })} /></div>
        <div className="field"><label htmlFor="fe-key">Key</label><input id="fe-key" className="mono" value={f.key} disabled={keyLocked || core} onChange={(e) => { setKeyTouched(true); setF({ ...f, key: e.target.value }); }} />
          <div className="field-help">{keyLocked || core ? 'Locked — vendors’ saved answers are stored under this key.' : 'Used to store the answer. Can’t be changed after publishing.'}</div></div>
        <div className="field"><label htmlFor="fe-type">Type</label>
          <select id="fe-type" value={f.type} disabled={core} onChange={(e) => setF({ ...f, type: e.target.value as FieldType, ...(e.target.value === 'radio' && !f.options?.length ? { options: ['Yes', 'No'] } : {}) })}>
            {meta.fieldTypes.map((t) => <option key={t} value={t}>{FIELD_TYPE_LABELS[t] ?? t}</option>)}
          </select></div>
        <div className="field"><label htmlFor="fe-group">Group</label>
          <select id="fe-group" value={group} onChange={(e) => setGroup(Number(e.target.value))}>{section.groups.map((g, i) => <option key={g.key} value={i}>{g.label}</option>)}</select></div>
        {needsOptions && (
          <div className="field field-wide"><label htmlFor="fe-opts">Options (one per line)</label>
            <textarea id="fe-opts" rows={4} value={(f.options ?? []).join('\n')} onChange={(e) => setF({ ...f, options: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) })} /></div>
        )}
        <div className="field"><label htmlFor="fe-val">Format check</label>
          <select id="fe-val" value={f.validator ?? ''} onChange={(e) => setF({ ...f, validator: e.target.value || undefined })}>
            <option value="">None</option>{meta.validators.map((v) => <option key={v.key} value={v.key}>{v.label}{v.country ? ` (${v.country})` : ''}</option>)}
          </select></div>
        <div className="field"><label htmlFor="fe-ph">Placeholder</label><input id="fe-ph" value={f.placeholder ?? ''} onChange={(e) => setF({ ...f, placeholder: e.target.value })} /></div>
        <div className="field field-wide"><label htmlFor="fe-help">Help text</label><input id="fe-help" value={f.help ?? ''} onChange={(e) => setF({ ...f, help: e.target.value })} /></div>
      </div>
      {meta.arabic && (
        <fieldset className="group ar-group"><legend>Arabic (supplier portal)</legend>
          <p className="small muted">Suppliers using the portal in Arabic see these. Left empty, they see the built-in translation shown in grey — or the English if there is none.</p>
          <div className="field-grid">
            <ArInput id="fe-ar-label" label="Label" meta={meta} english={f.label} value={f.tr?.ar?.label} onChange={(v) => setF(setAr({ ...f }, 'label', v))} />
            <ArInput id="fe-ar-ph" label="Placeholder" meta={meta} english={f.placeholder} value={f.tr?.ar?.placeholder} onChange={(v) => setF(setAr({ ...f }, 'placeholder', v))} />
            <div className="field-wide"><ArInput id="fe-ar-help" label="Help text" meta={meta} english={f.help} value={f.tr?.ar?.help} onChange={(v) => setF(setAr({ ...f }, 'help', v))} /></div>
            {needsOptions && <div className="field field-wide ar-field"><label htmlFor="fe-ar-opts">Options, same order (one per line) <span className="muted small">عربي</span></label>
              <textarea id="fe-ar-opts" dir="rtl" lang="ar" rows={4} value={(f.tr?.ar?.options ?? []).join('\n')} placeholder={(f.options ?? []).map((o) => meta.arabic!.defaults[o] ?? o).join('\n')}
                onChange={(e) => setF(setAr({ ...f }, 'options', e.target.value ? e.target.value.split('\n').map((x) => x.trim()) : undefined))} />
              <div className="field-help">The stored answer stays the English option; only what suppliers see changes.</div></div>}
          </div>
        </fieldset>
      )}
      <RulePicker label="Required" value={f.required} allowNever onChange={(v) => setF({ ...f, required: v })} catalog={catalog} excludeId={id} />
      <RulePicker label="Show this field" value={f.showIf} onChange={(v) => setF({ ...f, showIf: v && typeof v === 'object' ? v : undefined })} catalog={catalog} excludeId={id} />
    </Modal>
  );
}
