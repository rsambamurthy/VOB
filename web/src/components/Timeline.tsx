import type { Step } from '../lib/types';
import { StepBadge } from './ui';
import { fmtDateTime } from '../lib/format';
import { getLang, t } from '../i18n';

export function ApprovalTimeline({ steps, levels = [] }: { steps: Step[]; levels?: string[] }) {
  if (!steps.length) return <p className="muted small">{t('timeline.notSubmitted')}{levels.length > 0 && <> {t('timeline.levels', { levels: levels.join(getLang() === 'ar' ? ' ← ' : ' → ') })}</>}</p>;
  const cycles = [...new Set(steps.map((s) => s.cycle))].sort((a, b) => b - a);
  return (
    <div className="timeline">
      {cycles.map((c) => (
        <div key={c} className="cycle">
          {cycles.length > 1 && <div className="cycle-label">{t('timeline.submission', { n: c })}{c === cycles[0] ? t('timeline.current') : ''}</div>}
          <ol>
            {steps.filter((s) => s.cycle === c).sort((a, b) => a.level - b.level).map((s) => (
              <li key={s.id} className={`tl-${s.status.toLowerCase()}`}>
                <div className="tl-marker" aria-hidden>{s.level}</div>
                <div className="tl-body">
                  <div className="tl-top"><strong>{s.label}</strong><StepBadge status={s.status} /></div>
                  <div className="muted small">{s.assigneeName ? t('timeline.assignedTo', { name: s.assigneeName }) : s.roleName}{s.actedBy ? ` · ${s.actedBy.name}` : ''}{s.actedAt ? ` · ${fmtDateTime(s.actedAt)}` : ''}</div>
                  {s.status === 'PENDING' && s.dueAt && <div className={`small ${s.overdue ? 'overdue' : 'muted'}`}>{s.overdue ? t('timeline.overdueWasDue') : t('timeline.due')}{fmtDateTime(s.dueAt)}</div>}
                  {s.remarks && <div className="tl-remarks">“{s.remarks}”</div>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}
