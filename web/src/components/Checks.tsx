import type { Check } from '../lib/types';
import { fmtDateTime } from '../lib/format';
import { t } from '../i18n';

/** An online check the workspace can run (from the country packs). */
export interface CheckDefinition { kind: string; label: string; home?: boolean; country?: string; resultLabels?: { ok: string; fail: string } | null }

export function CheckBadge({ c, compact, labels }: { c: Check; compact?: boolean; labels?: { ok: string; fail: string } | null }) {
  const cls = c.status === 'VERIFIED' ? 'v-verified' : c.status === 'ERROR' ? 'v-error' : 'v-not_found';
  const text = c.status === 'VERIFIED' ? `✓ ${labels?.ok ?? t('check.verified')}` : c.status === 'NOT_FOUND' ? labels?.fail ?? t('check.notFound') : c.status === 'INVALID_FORMAT' ? t('check.invalid') : t('check.tryAgain');
  const weakName = c.status === 'VERIFIED' && c.nameMatch !== null && c.nameMatch < 70;
  return (
    <span className="check-badge" title={c.message}>
      <span className={`vbadge ${cls}`}>{text}</span>
      {weakName && <span className="vbadge v-warn" title={t('check.nameOnRecord', { name: c.nameOnRecord })}>{t('check.nameMatch', { pct: c.nameMatch })}</span>}
      {c.test && !compact && <span className="vbadge v-test">{t('check.test')}</span>}
    </span>
  );
}

/** Reviewer view: latest result per check, with name-on-record comparison and a re-run button. */
export function ChecksPanel({ checks, defs, supplierCountry, onRun, busy }: { checks: Check[]; defs: CheckDefinition[]; supplierCountry?: string; onRun?: (kind: string) => void; busy?: string }) {
  // The workspace's own checks, another country's checks for suppliers from that country, and any check that already has a result.
  const relevant = defs.filter((d) => d.home !== false || d.country === supplierCountry || checks.some((c) => c.kind === d.kind));
  const all: CheckDefinition[] = [...relevant, ...checks.filter((c) => !defs.some((d) => d.kind === c.kind)).map((c) => ({ kind: c.kind, label: c.kind.toUpperCase() }))];
  return (
    <ul className="verif">
      {all.map(({ kind: k, label, resultLabels }) => {
        const c = checks.find((x) => x.kind === k);
        return (
          <li key={k}>
            <div className="verif-row">
              <strong>{label}</strong>
              {c ? <CheckBadge c={c} labels={resultLabels} /> : <span className="muted small">Not checked</span>}
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
