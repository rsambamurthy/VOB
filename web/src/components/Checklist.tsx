import type { ChecklistItem, SectionDef } from '../lib/types';
import { t } from '../i18n';

export function Checklist({ items, sections, onJump }: { items: ChecklistItem[]; sections: SectionDef[]; onJump?: (section: string) => void }) {
  const errors = items.filter((i) => !i.ok && i.severity === 'error');
  const warnings = items.filter((i) => !i.ok && i.severity === 'warning');
  const done = items.filter((i) => i.ok).length;
  const pct = items.length ? Math.round((done / (done + errors.length)) * 100) : 0;
  const sectionLabel = (k: string) => (k === 'documents' ? t('checklist.documents') : sections.find((s) => s.key === k)?.label ?? k);
  return (
    <div className="checklist">
      <div className="checklist-head">
        <strong>{t('checklist.required')}</strong>
        <span className="muted">{errors.length ? t('checklist.toGo', { n: errors.length, count: errors.length }) : t('checklist.complete')}</span>
      </div>
      <div className="progress" aria-label={t('checklist.pctComplete', { pct })}><div style={{ width: `${pct}%` }} /></div>
      {errors.length === 0 && warnings.length === 0 && <p className="ok-text">{t('checklist.allDone')}</p>}
      <ul>
        {[...errors, ...warnings].slice(0, 40).map((i) => (
          <li key={i.id} className={i.severity}>
            <button type="button" className="link-btn" onClick={() => onJump?.(i.section)}>
              <span className="dot" aria-hidden />
              <span><span className="cl-label">{i.message ?? i.label}</span><span className="cl-sec">{sectionLabel(i.section)}</span></span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
