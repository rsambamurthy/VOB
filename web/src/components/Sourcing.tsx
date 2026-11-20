/** Shared sourcing pieces: labels, status badge and one rule input (Administration → Sourcing and the event page). */
export const FORMAT_LABEL: Record<string, string> = { rfq: 'Sealed bid / RFQ', reverse: 'Reverse auction', forward: 'Forward auction', japanese: 'Japanese auction', dutch: 'Dutch auction' };
export const EVENT_STATUS: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'Draft', cls: 'badge-invited' }, PENDING_APPROVAL: { label: 'Waiting for approval', cls: 'badge-under_review' }, APPROVED: { label: 'Approved', cls: 'badge-approved' },
  REJECTED: { label: 'Rejected', cls: 'badge-rejected' }, CANCELLED: { label: 'Cancelled', cls: '' },
  PUBLISHED: { label: 'Published', cls: 'badge-approved' }, BIDDING: { label: 'Taking bids', cls: 'badge-under_review' }, OPENING: { label: 'Opening', cls: 'badge-under_review' }, EVALUATION: { label: 'Evaluation', cls: 'badge-under_review' },
  LIVE: { label: 'Live', cls: 'badge-under_review' }, CLOSED: { label: 'Closed', cls: '' }, AWARD_PENDING: { label: 'Award waiting for approval', cls: 'badge-under_review' }, AWARDED: { label: 'Awarded', cls: 'badge-approved' },
};
export function EventStatus({ status, template }: { status: string; template?: boolean }) {
  if (template) return <span className="badge sm">Template</span>;
  const s = EVENT_STATUS[status] ?? { label: status, cls: '' };
  return <span className={`badge sm ${s.cls}`}>{s.label}</span>;
}

export interface RuleRow { key: string; kind: 'choice' | 'number'; label: string; help: string; options?: Record<string, string>; min?: number; max?: number; step?: number; unit?: string; nullable?: boolean; requires?: string; value: string | number | null; locked: boolean }

/** One rule's input (a list or a number with its unit). `value` is text: '' = empty. */
export function RuleInput({ rule, value, onChange, disabled, currency }: { rule: RuleRow; value: string; onChange: (v: string) => void; disabled?: boolean; currency: string }) {
  const id = `rule-${rule.key}`;
  if (rule.kind === 'choice') return <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>{Object.entries(rule.options ?? {}).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>;
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <input id={id} type="number" style={{ width: 130 }} min={rule.min} max={rule.max} step={rule.step} value={value} disabled={disabled} placeholder={rule.nullable ? 'Not required' : undefined} onChange={(e) => onChange(e.target.value)} />
      <span className="muted small">{rule.unit === 'currency' ? currency : rule.unit}</span>
    </span>
  );
}
/** Text of an input back to the value sent to the server. */
export const ruleValue = (rule: RuleRow, text: string) => (rule.kind === 'choice' ? text : text === '' ? (rule.nullable ? null : undefined) : Number(text));
export const ruleText = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v));
