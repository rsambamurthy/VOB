import { useState } from 'react';
import type { Extraction } from '../lib/types';

/** What the AI read from one document. Vendors pick values to copy into the form; reviewers see mismatches. */
export function ExtractionCard({ ex, docLabel, onApply, readOnly }: { ex: Extraction; docLabel: string; onApply?: (fieldIds: string[]) => Promise<void>; readOnly?: boolean }) {
  const actionable = ex.suggestions.filter((s) => s.state !== 'match');
  const [picked, setPicked] = useState<string[]>(actionable.map((s) => s.fieldId));
  const [busy, setBusy] = useState(false);
  if (ex.status === 'PENDING') return <div className="ai-card pending"><span className="spinner-sm" aria-hidden /> Reading your {docLabel}…</div>;
  if (ex.status === 'SKIPPED') return readOnly ? null : null;
  if (ex.status === 'FAILED') return <div className="ai-card muted small">Couldn’t read this document automatically{readOnly && ex.error ? ` (${ex.error})` : ''}.</div>;
  const differs = ex.suggestions.filter((s) => s.state === 'differs').length;
  return (
    <div className={`ai-card ${differs ? 'has-diff' : ''}`}>
      <div className="ai-head">
        <span className="ai-icon" aria-hidden>✦</span>
        <strong>{readOnly ? `Read from ${docLabel}` : `We read your ${docLabel}`}</strong>
        {ex.test && <span className="vbadge v-test">test mode</span>}
        {readOnly && differs > 0 && <span className="vbadge v-not_found">{differs} mismatch{differs > 1 ? 'es' : ''}</span>}
      </div>
      {ex.summary && <p className="small ai-summary">{ex.summary}</p>}
      {ex.suggestions.length === 0 ? <p className="muted small">No values could be read with confidence.</p> : (
        <table className="ai-table">
          <tbody>
            {ex.suggestions.map((s) => (
              <tr key={s.fieldId} className={`st-${s.state}`}>
                {!readOnly && <td>{s.state !== 'match' && <input type="checkbox" aria-label={`Use ${s.fieldLabel}`} checked={picked.includes(s.fieldId)} onChange={() => setPicked((p) => (p.includes(s.fieldId) ? p.filter((x) => x !== s.fieldId) : [...p, s.fieldId]))} />}</td>}
                <td className="small">{s.fieldLabel}</td>
                <td><span className="mono">{s.value}</span>{s.confidence < 0.8 && <span className="muted small" title="The AI wasn’t fully sure"> (unsure)</span>}</td>
                <td className="small">{s.state === 'match' ? <span className="ok-text">✓ matches</span> : s.state === 'empty' ? <span className="muted">not filled yet</span> : <span className="diff-text">form says “{s.current}”</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!readOnly && onApply && actionable.length > 0 && !ex.appliedAt && (
        <div className="btn-row"><button className="btn btn-primary btn-sm" disabled={busy || !picked.length} onClick={async () => { setBusy(true); try { await onApply(picked); } finally { setBusy(false); } }}>{busy ? 'Applying…' : `Use ${picked.length} value${picked.length === 1 ? '' : 's'} in my form`}</button></div>
      )}
      {!readOnly && ex.appliedAt && <p className="small ok-text">Applied to your form.</p>}
    </div>
  );
}
