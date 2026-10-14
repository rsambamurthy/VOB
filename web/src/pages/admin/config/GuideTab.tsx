import type { OnboardingConfig } from '../../../lib/types';
import { ArInput, move, setAr, type EditorMeta, type Update } from './shared';

export function GuideTab({ config, update, meta }: { config: OnboardingConfig; update: Update; meta: EditorMeta }) {
  return (
    <div>
      <p className="muted">Shown to vendors in the portal’s “How onboarding works” panel and help window.</p>
      {config.guide.map((g, i) => (
        <div key={i} className="card pad guide-edit">
          <div className="row-between">
            <input value={g.title} aria-label="Step title" onChange={(e) => update((c) => { c.guide[i].title = e.target.value; })} className="strong" />
            <span className="row-tools">
              <button className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => update((c) => move(c.guide, i, -1))}>↑</button>
              <button className="icon-btn" aria-label="Move down" disabled={i === config.guide.length - 1} onClick={() => update((c) => move(c.guide, i, 1))}>↓</button>
              <button className="icon-btn" aria-label="Delete step" onClick={() => update((c) => { c.guide.splice(i, 1); })}>🗑</button>
            </span>
          </div>
          <textarea rows={3} value={g.body} aria-label="Step text" onChange={(e) => update((c) => { c.guide[i].body = e.target.value; })} />
          {meta.arabic && <div className="field-grid ar-group">
            <ArInput id={`gd-ar-t-${i}`} label="Step title" meta={meta} english={g.title} value={g.tr?.ar?.title} onChange={(v) => update((c) => { setAr(c.guide[i], 'title', v); })} />
            <ArInput id={`gd-ar-b-${i}`} label="Step text" meta={meta} english={g.body} value={g.tr?.ar?.body} multiline onChange={(v) => update((c) => { setAr(c.guide[i], 'body', v); })} />
          </div>}
        </div>
      ))}
      <button className="btn btn-secondary btn-sm" onClick={() => update((c) => { c.guide.push({ title: `Step ${c.guide.length + 1}`, body: '' }); })}>+ Add step</button>
    </div>
  );
}
