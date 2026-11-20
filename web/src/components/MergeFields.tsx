/** Contract wording with merge fields: one text box with an "Insert field" picker, used by clauses, templates and drafting. */
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';

export interface MergeField { key: string; label: string; group: string }
let cache: Promise<{ fields: MergeField[]; pdf: boolean }> | null = null;
/** The merge field catalogue (fetched once per page load). */
export function useMergeFields() {
  const [data, setData] = useState<{ fields: MergeField[]; pdf: boolean }>();
  useEffect(() => { (cache ??= api<{ fields: MergeField[]; pdf: boolean }>('/staff/contract-library/fields')).then(setData).catch(() => { cache = null; }); }, []);
  return data;
}

export function WordingBox({ id, label, value, onChange, rows = 6, disabled, help }: { id: string; label: string; value: string; onChange: (v: string) => void; rows?: number; disabled?: boolean; help?: string }) {
  const fields = useMergeFields()?.fields ?? [];
  const ref = useRef<HTMLTextAreaElement>(null);
  function insert(key: string) {
    const el = ref.current;
    const tag = `{{${key}}}`;
    if (!el) return onChange(value + tag);
    const [a, b] = [el.selectionStart ?? value.length, el.selectionEnd ?? value.length];
    onChange(value.slice(0, a) + tag + value.slice(b));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + tag.length, a + tag.length); });
  }
  const groups = [...new Set(fields.map((f) => f.group))];
  return (
    <div className="field field-wide">
      <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'end', gap: 8 }}>
        <label htmlFor={id}>{label}</label>
        {!disabled && fields.length > 0 && (
          <select aria-label={`Insert a field into ${label}`} value="" onChange={(e) => e.target.value && insert(e.target.value)} style={{ maxWidth: 220 }}>
            <option value="">Insert a field…</option>
            {groups.map((g) => <optgroup key={g} label={g}>{fields.filter((f) => f.group === g).map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</optgroup>)}
          </select>
        )}
      </span>
      <textarea id={id} ref={ref} rows={rows} disabled={disabled} value={value} onChange={(e) => onChange(e.target.value)} />
      {help && <div className="field-help">{help}</div>}
    </div>
  );
}

/** Wording for reading: merge fields shown as labelled chips. */
export function Wording({ text }: { text: string }) {
  const fields = useMergeFields()?.fields ?? [];
  const label = (k: string) => fields.find((f) => f.key === k)?.label ?? k;
  const parts = text.split(/(\{\{\s*[\w.]+\s*\}\})/g);
  return <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{parts.map((p, i) => {
    const m = p.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
    return m ? <span key={i} className="badge sm" title={`{{${m[1]}}}`} style={{ fontWeight: 500 }}>{label(m[1])}</span> : <span key={i}>{p}</span>;
  })}</div>;
}
