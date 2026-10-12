import type { Check } from '../lib/types';
import { fmtDateTime } from '../lib/format';

export const CHECK_LABEL: Record<string, string> = { gstin: 'GSTIN', pan: 'PAN', bank: 'Bank account', cin: 'CIN / MCA' };

export function CheckBadge({ c, compact }: { c: Check; compact?: boolean }) {
  const cls = c.status === 'VERIFIED' ? 'v-verified' : c.status === 'ERROR' ? 'v-error' : 'v-not_found';
  const text = c.status === 'VERIFIED' ? '✓ Verified' : c.status === 'NOT_FOUND' ? 'Not found' : c.status === 'INVALID_FORMAT' ? 'Invalid' : 'Try again';
  const weakName = c.status === 'VERIFIED' && c.nameMatch !== null && c.nameMatch < 70;
  return (
    <span className="check-badge" title={c.message}>
      <span className={`vbadge ${cls}`}>{text}</span>
      {weakName && <span className="vbadge v-warn" title={`Name on record: ${c.nameOnRecord}`}>Name {c.nameMatch}% match</span>}
      {c.test && !compact && <span className="vbadge v-test">test</span>}
    </span>
  );
}

/** Reviewer view: latest result per check, with name-on-record comparison and a re-run button. */
export function ChecksPanel({ checks, onRun, busy }: { checks: Check[]; onRun?: (kind: string) => void; busy?: string }) {
  const kinds = ['gstin', 'pan', 'bank', 'cin'];
  return (
    <ul className="verif">
      {kinds.map((k) => {
        const c = checks.find((x) => x.kind === k);
        return (
          <li key={k}>
            <div className="verif-row">
              <strong>{CHECK_LABEL[k]}</strong>
              {c ? <CheckBadge c={c} /> : <span className="muted small">Not checked</span>}
              {onRun && <button className="link-btn small" disabled={busy === k} onClick={() => onRun(k)}>{busy === k ? 'Checking…' : c ? 'Re-run' : 'Run'}</button>}
            </div>
            {c && (
              <div className="muted small">
                {c.inputMasked} · {c.message}
                {c.nameOnRecord && <> · on record: <strong>{c.nameOnRecord}</strong>{c.nameMatch !== null && ` (${c.nameMatch}% match)`}</>}
                {c.data && Object.keys(c.data).length > 0 && <> · {Object.entries(c.data).map(([dk, dv]) => `${dk}: ${dv}`).join(' · ')}</>}
                <span className="block">{fmtDateTime(c.checkedAt)}{c.requestedBy ? ` by ${c.requestedBy}` : ''}</span>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
