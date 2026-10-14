import type { ArabicText, Condition, ConfigIssue, FieldDef, OnboardingConfig, Op } from '../../../lib/types';
import { OP_LABELS } from '../../../lib/conditions';

export interface EditorMeta {
  fieldTypes: string[]; validators: { key: string; label: string; country: string | null }[]; ops: Op[]; coreFields: string[]; coreSections: string[];
  vendorAttributes: { key: string; label: string; options: string[] }[];
  vendorTypes: { value: string; label: string }[];
  /** Set when the workspace's suppliers can use the portal in Arabic. */
  arabic?: { defaults: Record<string, string> } | null;
}
export interface CatalogEntry { id: string; label: string; type: string; options?: string[] }
export type Update = (fn: (c: OnboardingConfig) => void) => void;

export const FIELD_TYPE_LABELS: Record<string, string> = {
  text: 'Short text', textarea: 'Long text', select: 'Dropdown', radio: 'Yes/No or choice buttons', number: 'Number', email: 'Email', tel: 'Phone', date: 'Date', url: 'Website',
};
/** Label for a format check, from the server's list (country packs). */
export const validatorLabel = (meta: EditorMeta, key: string) => meta.validators.find((v) => v.key === key)?.label ?? key;

/** Every field (and vendor attribute) a condition can point at. */
export function fieldCatalog(cfg: OnboardingConfig, meta: EditorMeta): CatalogEntry[] {
  const fields = cfg.sections.flatMap((s) => s.groups.flatMap((g) => g.fields.map((f) => ({ id: `${s.key}.${f.key}`, label: `${s.label} › ${f.label}`, type: f.type, options: f.options }))));
  return [...meta.vendorAttributes.map((a) => ({ id: a.key, label: a.label, type: 'select', options: a.options })), ...fields];
}

export function toKey(label: string, taken: string[], upper = false) {
  const words = label.normalize('NFKD').replace(/[^\w\s]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 5);
  let base = upper ? words.join('_').toUpperCase() : words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
  if (!base || !/^[a-zA-Z]/.test(base)) base = (upper ? 'DOC_' : 'field') + base;
  base = base.slice(0, 36);
  let k = base, n = 2;
  while (taken.includes(k)) k = `${base}${upper ? '_' : ''}${n++}`;
  return k;
}

export function move<T>(arr: T[], i: number, dir: -1 | 1) {
  const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

export function ruleSummary(c: Condition | boolean | undefined, catalog: CatalogEntry[]) {
  if (c === true) return 'Always';
  if (!c) return '—';
  const label = catalog.find((x) => x.id === c.field)?.label ?? c.field;
  const v = Array.isArray(c.value) ? c.value.join(' / ') : c.value;
  return `When ${label} ${OP_LABELS[c.op]}${c.op === 'empty' || c.op === 'notEmpty' ? '' : ` “${v ?? ''}”`}`;
}

export function issuesFor(issues: ConfigIssue[], prefix: string) {
  return issues.filter((i) => i.path === prefix || i.path.startsWith(`${prefix}.`));
}

/** Pick a field, an operator and a value. */
export function ConditionEditor({ value, onChange, catalog, excludeId, allowClear = true }: { value?: Condition; onChange: (c?: Condition) => void; catalog: CatalogEntry[]; excludeId?: string; allowClear?: boolean }) {
  const options = catalog.filter((c) => c.id !== excludeId);
  const target = options.find((o) => o.id === value?.field);
  const ops: Op[] = target?.type === 'number' ? ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'empty', 'notEmpty'] : ['eq', 'neq', 'in', 'notIn', 'empty', 'notEmpty'];
  const set = (patch: Partial<Condition>) => onChange({ field: value?.field ?? options[0]?.id, op: value?.op ?? 'eq', value: value?.value, ...patch } as Condition);
  const multi = value?.op === 'in' || value?.op === 'notIn';
  const noValue = value?.op === 'empty' || value?.op === 'notEmpty';
  const listVal = Array.isArray(value?.value) ? value!.value as string[] : value?.value !== undefined && value.value !== '' ? [String(value.value)] : [];
  return (
    <div className="cond-row">
      <select aria-label="Field" value={value?.field ?? ''} onChange={(e) => onChange({ field: e.target.value, op: 'eq', value: '' })}>
        <option value="" disabled>Choose a field…</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <select aria-label="Operator" value={value?.op ?? 'eq'} disabled={!value} onChange={(e) => {
        const op = e.target.value as Op;
        set({ op, value: op === 'in' || op === 'notIn' ? listVal : op === 'empty' || op === 'notEmpty' ? undefined : listVal[0] ?? '' });
      }}>
        {ops.map((o) => <option key={o} value={o}>{OP_LABELS[o]}</option>)}
      </select>
      {value && !noValue && (multi ? (
        target?.options?.length ? (
          <div className="multi-pick">
            {target.options.map((o) => (
              <label key={o} className="radio"><input type="checkbox" checked={listVal.includes(o)} onChange={() => set({ value: listVal.includes(o) ? listVal.filter((x) => x !== o) : [...listVal, o] })} />{o}</label>
            ))}
          </div>
        ) : <input aria-label="Values (comma separated)" placeholder="value 1, value 2" value={listVal.join(', ')} onChange={(e) => set({ value: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
      ) : target?.options?.length ? (
        <select aria-label="Value" value={String(value.value ?? '')} onChange={(e) => set({ value: e.target.value })}>
          <option value="">Select…</option>
          {target.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input aria-label="Value" inputMode={target?.type === 'number' ? 'decimal' : undefined} value={String(value.value ?? '')}
          onChange={(e) => set({ value: target?.type === 'number' && e.target.value !== '' && !Number.isNaN(Number(e.target.value)) ? Number(e.target.value) : e.target.value })} />
      ))}
      {allowClear && value && <button type="button" className="icon-btn" aria-label="Remove condition" onClick={() => onChange(undefined)}>✕</button>}
    </div>
  );
}

/** "Always / Never / When…" (required) or "Always / When…" (show). */
export function RulePicker({ label, value, onChange, catalog, excludeId, allowNever }: { label: string; value: boolean | Condition | undefined; onChange: (v: boolean | Condition | undefined) => void; catalog: CatalogEntry[]; excludeId?: string; allowNever?: boolean }) {
  const mode = value === true ? 'always' : value && typeof value === 'object' ? 'when' : allowNever ? 'never' : 'always';
  return (
    <fieldset className="group rule-picker">
      <legend>{label}</legend>
      <div className="radio-row">
        {allowNever && <label className="radio"><input type="radio" checked={mode === 'never'} onChange={() => onChange(undefined)} /> {allowNever ? 'Optional' : 'Never'}</label>}
        <label className="radio"><input type="radio" checked={mode === 'always'} onChange={() => onChange(allowNever ? true : undefined)} /> Always</label>
        <label className="radio"><input type="radio" checked={mode === 'when'} onChange={() => onChange({ field: catalog.find((c) => c.id !== excludeId)?.id ?? '', op: 'eq', value: '' })} /> Only when…</label>
      </div>
      {mode === 'when' && <ConditionEditor value={value as Condition} onChange={(c) => onChange(c ?? (allowNever ? undefined : undefined))} catalog={catalog} excludeId={excludeId} allowClear={false} />}
    </fieldset>
  );
}

export function IssueList({ issues, onPick }: { issues: ConfigIssue[]; onPick?: (path: string) => void }) {
  if (!issues.length) return null;
  return (
    <div className="alert alert-warning issue-list" role="status">
      <strong>{issues.length} problem{issues.length > 1 ? 's' : ''} to fix before publishing</strong>
      <ul>{issues.slice(0, 12).map((i, k) => <li key={k}>{onPick ? <button type="button" className="link-btn" onClick={() => onPick(i.path)}>{i.message}</button> : i.message}</li>)}</ul>
    </div>
  );
}

export type { FieldDef };

/** An Arabic version of a piece of form text. Left empty, suppliers see the built-in translation (the hint) or the English. */
export function ArInput({ id, value, english, meta, onChange, multiline, label }: { id: string; value?: string; english?: string; meta: EditorMeta; onChange: (v: string | undefined) => void; multiline?: boolean; label?: string }) {
  if (!meta.arabic) return null;
  const hint = (english && meta.arabic.defaults[english]) || '';
  const props = { id, dir: 'rtl' as const, lang: 'ar', value: value ?? '', placeholder: hint || (english ? 'English is shown when empty' : ''), onChange: (e: { target: { value: string } }) => onChange(e.target.value.trim() ? e.target.value : undefined) };
  return (
    <div className="field ar-field">
      {label && <label htmlFor={id}>{label} <span className="muted small">عربي</span></label>}
      {multiline ? <textarea rows={3} {...props} /> : <input {...props} />}
    </div>
  );
}

/** Set (or clear) one piece of Arabic text on a config object. */
export function setAr<T extends { tr?: { ar?: ArabicText } }>(o: T, k: keyof ArabicText, v: unknown): T {
  const ar = { ...(o.tr?.ar ?? {}) } as Record<string, unknown>;
  if (v === undefined || (Array.isArray(v) && !v.some(Boolean))) delete ar[k]; else ar[k] = v;
  if (Object.keys(ar).length) o.tr = { ...(o.tr ?? {}), ar: ar as ArabicText }; else if (o.tr) { delete o.tr.ar; if (!Object.keys(o.tr).length) delete o.tr; }
  return o;
}
