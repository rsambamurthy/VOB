import type { Meta, Step } from '../lib/types';
import { StepBadge } from './ui';
import { fmtDateTime } from '../lib/format';

export function ApprovalTimeline({ steps, meta }: { steps: Step[]; meta: Meta }) {
  if (!steps.length) return <p className="muted small">Not submitted yet. Approval levels: {meta.workflowLevels.map((l) => l.label).join(' → ')}.</p>;
  const cycles = [...new Set(steps.map((s) => s.cycle))].sort((a, b) => b - a);
  return (
    <div className="timeline">
      {cycles.map((c) => (
        <div key={c} className="cycle">
          {cycles.length > 1 && <div className="cycle-label">Submission {c}{c === cycles[0] ? ' (current)' : ''}</div>}
          <ol>
            {steps.filter((s) => s.cycle === c).sort((a, b) => a.level - b.level).map((s) => (
              <li key={s.id} className={`tl-${s.status.toLowerCase()}`}>
                <div className="tl-marker" aria-hidden>{s.level}</div>
                <div className="tl-body">
                  <div className="tl-top"><strong>{s.label}</strong><StepBadge status={s.status} /></div>
                  <div className="muted small">{s.roleName}{s.actedBy ? ` · ${s.actedBy.name}` : ''}{s.actedAt ? ` · ${fmtDateTime(s.actedAt)}` : ''}</div>
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
