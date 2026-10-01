import type { ReactNode } from 'react';
import type { FieldDef, Profile, SectionDef } from '../lib/types';
import { conditionHolds, isRequired } from '../lib/conditions';

interface Props {
  section: SectionDef;
  profile: Profile;                       // full profile (conditions can point at other sections)
  onChange?: (field: string, value: string) => void;
  errors?: Record<string, string>;        // "section.field" -> message
  readOnly?: boolean;
  vendorType?: string;
  extra?: (field: FieldDef) => ReactNode; // e.g. a "Verify" button next to GSTIN
}

export function DynamicSection({ section, profile, onChange, errors = {}, readOnly, extra, vendorType }: Props) {
  const values = profile[section.key] ?? {};
  const ctx = { profile, vendor: { vendorType } };
  return (
    <div className="section-groups">
      {section.groups.map((g) => {
        const fields = g.fields.filter((f) => conditionHolds(f.showIf, ctx));
        if (!fields.length) return null;
        return (
          <fieldset key={g.key} className="group">
            <legend>{g.label}</legend>
            <div className="field-grid">
              {fields.map((f) => {
                const id = `${section.key}.${f.key}`;
                const value = values[f.key] === undefined || values[f.key] === null ? '' : String(values[f.key]);
                const req = isRequired(f.required, ctx);
                const err = errors[id];
                const wide = f.type === 'textarea' || f.type === 'radio' && f.label.length > 45;
                return (
                  <div key={f.key} className={`field ${wide ? 'field-wide' : ''} ${err ? 'has-error' : ''}`}>
                    <label htmlFor={f.type === 'radio' ? undefined : id} id={`${id}-label`}>{f.label}{req && <span className="req" aria-hidden> *</span>}</label>
                    {readOnly ? (
                      <div className="ro-value">{value || <span className="muted">—</span>}</div>
                    ) : (
                      <div className="control-row">
                        <Control f={f} id={id} value={value} onChange={(v) => onChange?.(f.key, v)} invalid={!!err} />
                        {extra?.(f)}
                      </div>
                    )}
                    {err && !readOnly ? <div className="field-error">{err}</div> : f.help && !readOnly ? <div className="field-help">{f.help}</div> : null}
                  </div>
                );
              })}
            </div>
          </fieldset>
        );
      })}
    </div>
  );
}

function Control({ f, id, value, onChange, invalid }: { f: FieldDef; id: string; value: string; onChange: (v: string) => void; invalid: boolean }) {
  const common = { id, name: id, 'aria-invalid': invalid || undefined } as const;
  if (f.type === 'select') {
    return (
      <select {...common} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select…</option>
        {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (f.type === 'radio') {
    return (
      <div className="radio-row" role="radiogroup" aria-labelledby={`${id}-label`} id={id}>
        {f.options?.map((o) => (
          <label key={o} className="radio">
            <input type="radio" name={id} value={o} checked={value === o} onChange={() => onChange(o)} /> {o}
          </label>
        ))}
      </div>
    );
  }
  if (f.type === 'textarea') return <textarea {...common} rows={3} value={value} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />;
  const type = f.type === 'number' ? 'text' : f.type === 'url' ? 'text' : f.type;
  return (
    <input {...common} type={type} inputMode={f.type === 'number' ? 'decimal' : undefined} value={value} placeholder={f.placeholder}
      onChange={(e) => onChange(e.target.value)} autoComplete="off" />
  );
}
