import { useState } from 'react';
import { Modal } from '../../../components/ui';
import type { ConfigIssue, DocRequirement, OnboardingConfig } from '../../../lib/types';
import { RulePicker, fieldCatalog, move, ruleSummary, toKey, type EditorMeta, type Update } from './shared';

export function DocumentsTab({ config, update, meta, issues }: { config: OnboardingConfig; update: Update; meta: EditorMeta; issues: ConfigIssue[] }) {
  const [editing, setEditing] = useState<number | 'new'>();
  const catalog = fieldCatalog(config, meta);
  return (
    <div>
      <p className="muted">Documents vendors upload. Each can be always required, optional, or required only when an answer matches — e.g. GST certificate only if the vendor holds a GSTIN.</p>
      <div className="card">
        <div className="table-wrap">
          <table className="table static">
            <thead><tr><th>Document</th><th>Required</th><th>Shown</th><th>Expiry</th><th /></tr></thead>
            <tbody>
              {config.documents.map((d, i) => {
                const bad = issues.filter((x) => x.path === `documents.${d.type}`);
                return (
                  <tr key={d.type} className={bad.length ? 'has-issue' : ''}>
                    <td><button className="link-btn strong" onClick={() => setEditing(i)}>{d.label}</button><div className="muted small mono">{d.type}</div>{bad.map((x, k) => <div key={k} className="field-error">{x.message}</div>)}</td>
                    <td className="small">{d.required === undefined ? <span className="muted">Optional</span> : ruleSummary(d.required, catalog)}</td>
                    <td className="small">{d.showIf ? ruleSummary(d.showIf, catalog) : 'Always'}</td>
                    <td>{d.hasExpiry ? '✓' : <span className="muted">—</span>}</td>
                    <td className="actions">
                      <button className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => update((c) => move(c.documents, i, -1))}>↑</button>
                      <button className="icon-btn" aria-label="Move down" disabled={i === config.documents.length - 1} onClick={() => update((c) => move(c.documents, i, 1))}>↓</button>
                      <button className="icon-btn" aria-label={`Delete ${d.label}`} onClick={() => confirm(`Remove “${d.label}”? Files already uploaded are kept.`) && update((c) => { c.documents.splice(i, 1); })}>🗑</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="pad-sm"><button className="btn btn-secondary btn-sm" onClick={() => setEditing('new')}>+ Add document</button></div>
      </div>
      {editing !== undefined && (
        <DocModal doc={editing === 'new' ? undefined : config.documents[editing]} taken={config.documents.map((d) => d.type)} catalog={catalog}
          onClose={() => setEditing(undefined)}
          onSave={(d) => { update((c) => { if (editing === 'new') c.documents.push(d); else c.documents[editing] = d; }); setEditing(undefined); }} />
      )}
    </div>
  );
}

function DocModal({ doc, taken, catalog, onClose, onSave }: { doc?: DocRequirement; taken: string[]; catalog: ReturnType<typeof fieldCatalog>; onClose: () => void; onSave: (d: DocRequirement) => void }) {
  const [d, setD] = useState<DocRequirement>(doc ? structuredClone(doc) : { type: '', label: '' });
  const [error, setError] = useState<string>();
  const others = taken.filter((t) => t !== doc?.type);
  function save() {
    if (!d.label.trim()) return setError('Give the document a name');
    const type = doc?.type ?? (d.type || toKey(d.label, others, true));
    if (others.includes(type)) return setError('That code is already used');
    const out: DocRequirement = { ...d, type, label: d.label.trim() };
    if (!out.help) delete out.help;
    if (!out.hasExpiry) delete out.hasExpiry;
    delete out.isRequired;
    onSave(out);
  }
  return (
    <Modal title={doc ? `Edit “${doc.label}”` : 'New document'} onClose={onClose} wide
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save}>{doc ? 'Apply' : 'Add document'}</button></>}>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="field-grid">
        <div className="field"><label htmlFor="de-label">Document name</label><input id="de-label" autoFocus value={d.label} onChange={(e) => setD({ ...d, label: e.target.value })} /></div>
        <div className="field"><label htmlFor="de-code">Code</label><input id="de-code" className="mono" disabled={!!doc} placeholder={toKey(d.label || 'Document', others, true)} value={d.type} onChange={(e) => setD({ ...d, type: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })} /></div>
        <div className="field field-wide"><label htmlFor="de-help">Help text</label><input id="de-help" value={d.help ?? ''} onChange={(e) => setD({ ...d, help: e.target.value })} /></div>
        <label className="check-item field-wide"><input type="checkbox" checked={!!d.hasExpiry} onChange={(e) => setD({ ...d, hasExpiry: e.target.checked })} /><span><strong>Track expiry date</strong><span className="muted small block">Vendors enter a valid-until date; reminders arrive before it lapses.</span></span></label>
      </div>
      <RulePicker label="Required" value={d.required} allowNever onChange={(v) => setD({ ...d, required: v })} catalog={catalog} />
      <RulePicker label="Show this document" value={d.showIf} onChange={(v) => setD({ ...d, showIf: v && typeof v === 'object' ? v : undefined })} catalog={catalog} />
    </Modal>
  );
}
