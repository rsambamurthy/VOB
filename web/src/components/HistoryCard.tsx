/** The History card on a record (sourcing events, contracts, parties): audit entries with who, when and any reason. */
import { fmtDateTime, humanize } from '../lib/format';

export interface HistoryRow { actor: string; action: string; detail: Record<string, unknown> | null; createdAt: string }

export function HistoryCard({ rows, actions, extra }: { rows: HistoryRow[]; actions: Record<string, string>; extra?: (h: HistoryRow) => string | null }) {
  return (
    <section className="card pad section-card">
      <h3>History</h3>
      {rows.length ? <ul className="history-list small" style={{ listStyle: 'none', padding: 0, margin: 0 }}>{rows.map((h, i) => (
        <li key={i} style={{ padding: '6px 0', borderBottom: '1px solid var(--line, #e5e7eb)' }}>
          <strong>{actions[h.action] ?? humanize(h.action)}</strong>{typeof h.detail?.label === 'string' ? ` — ${h.detail.label}` : ''}{extra?.(h) ? ` — ${extra(h)}` : ''}
          <div className="muted">{h.actor} · {fmtDateTime(h.createdAt)}{typeof h.detail?.remarks === 'string' ? ` · “${h.detail.remarks}”` : ''}{typeof h.detail?.reason === 'string' ? ` · “${h.detail.reason}”` : ''}{h.detail?.from === 'excel' ? ' · from Excel' : ''}</div>
        </li>))}</ul> : <p className="muted small">Nothing yet.</p>}
    </section>
  );
}
