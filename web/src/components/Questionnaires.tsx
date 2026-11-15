import { useState } from 'react';
import type { QuestionnaireView } from '../lib/types';
import { Alert } from './ui';
import { t } from '../i18n';
import { fmtDate } from '../lib/format';
import { docUrl } from '../lib/api';
import { RiskBadge } from './Risk';
export { RiskBadge };

type Answers = Record<string, unknown>;
type FileAnswer = { documentId: string; fileName: string };
const visible = (q: QuestionnaireView['questions'][number], a: Answers) => !q.showIf || String(a[q.showIf.questionId] ?? '') === q.showIf.equals;

/**
 * Questionnaires on a supplier — one component for everyone:
 *  - the supplier in the portal, and a buyer filling in for the supplier (onSave / onSubmit / onUpload);
 *  - reviewers (none of those: answers read-only, with the score and risk when `result` is there).
 */
export function QuestionnairesPanel({ items, buyer, onSave, onSubmit, onUpload }: {
  items: QuestionnaireView[]; buyer?: string;
  onSave?: (q: QuestionnaireView, answers: Answers) => Promise<void>;
  onSubmit?: (q: QuestionnaireView, answers: Answers) => Promise<void>;
  onUpload?: (q: QuestionnaireView, file: File) => Promise<FileAnswer>;
}) {
  if (!items.length) return null;
  return (
    <div className="stack">
      {buyer && onSubmit && <p className="muted">{t('qn.intro', { buyer })}</p>}
      {items.map((q) => <QuestionnaireCard key={`${q.id}-${q.status}-${q.submittedAt ?? ''}`} q={q} onSave={onSave} onSubmit={onSubmit} onUpload={onUpload} />)}
    </div>
  );
}

function QuestionnaireCard({ q, onSave, onSubmit, onUpload }: { q: QuestionnaireView; onSave?: (q: QuestionnaireView, a: Answers) => Promise<void>; onSubmit?: (q: QuestionnaireView, a: Answers) => Promise<void>; onUpload?: (q: QuestionnaireView, f: File) => Promise<FileAnswer> }) {
  const editable = !!onSubmit;
  const [answers, setAnswers] = useState<Answers>(q.answers ?? {});
  const [open, setOpen] = useState(editable ? q.outstanding || q.status === 'DRAFT' : false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const set = (id: string, v: unknown) => { setAnswers((a) => ({ ...a, [id]: v })); setDirty(true); setMissing((m) => { const n = new Set(m); n.delete(id); return n; }); };
  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr(undefined);
    try { await fn(); setDirty(false); }
    catch (e: any) { setErr(e.message); if (Array.isArray(e.details)) setMissing(new Set(e.details.map((d: { id: string }) => d.id))); }
    finally { setBusy(false); }
  }
  const knock = new Set(q.result?.knockouts ?? []);
  return (
    <div className={`questionnaire-card ${q.outstanding ? 'open' : ''}`}>
      <div className="row-between">
        <button type="button" className="link-btn qn-title" aria-expanded={open} onClick={() => setOpen(!open)}><strong>{q.title}</strong> <span className="muted">{open ? '▾' : '▸'}</span></button>
        <div className="btn-row">
          <span className={`badge sm ${q.required ? 'flag-medium' : ''}`}>{q.required ? t('qn.required') : t('qn.optional')}</span>
          {q.result && <RiskBadge band={q.result.band} percent={q.result.percent} />}
          {q.outstanding ? <span className="badge sm flag-high">{t('qn.toAnswer')}</span> : q.status === 'SUBMITTED' && <span className="ok-text">✓</span>}
        </div>
      </div>
      <div className="small muted">
        {q.status === 'SUBMITTED' && q.submittedAt && t('qn.submitted', { date: fmtDate(q.submittedAt) })}
        {q.status === 'SUBMITTED' && q.submittedByName && <> · {q.submittedByName}</>}
        {q.status === 'DRAFT' && !q.requested && t('qn.inProgress')}
        {q.requested && q.dueOn && <> {t('qn.due', { date: fmtDate(q.dueOn) })}</>}
      </div>
      {open && (<>
        {q.description && <p className="notice-text small">{q.description}</p>}
        {err && <Alert kind="error">{err}</Alert>}
        <ol className="qn-questions">
          {q.questions.filter((x) => visible(x, answers)).map((x) => {
            const v = answers[x.id];
            const ro = !editable;
            return (
              <li key={x.id} className={`qn-q${missing.has(x.id) ? ' has-error' : ''}${knock.has(x.id) ? ' qn-knockout' : ''}`}>
                <div className="qn-text">{x.text}{x.required && editable && <span className="req"> *</span>}</div>
                {x.help && <div className="field-help">{x.help}</div>}
                {(x.type === 'yesno' || x.type === 'choice') && (
                  <div className="radio-row">{x.options?.map((o) => (
                    <label key={o.value} className="radio"><input type="radio" name={`${q.id}-${x.id}`} disabled={ro} checked={v === o.value} onChange={() => set(x.id, o.value)} />
                      {o.label}{o.points !== undefined && <span className="muted small"> ({o.points}{o.knockout ? ', knock-out' : ''})</span>}</label>
                  ))}</div>
                )}
                {x.type === 'multi' && (
                  <div className="radio-row">{x.options?.map((o) => {
                    const list = Array.isArray(v) ? (v as string[]) : [];
                    return <label key={o.value} className="radio"><input type="checkbox" disabled={ro} checked={list.includes(o.value)} onChange={() => set(x.id, list.includes(o.value) ? list.filter((y) => y !== o.value) : [...list, o.value])} />{o.label}{o.points !== undefined && <span className="muted small"> ({o.points})</span>}</label>;
                  })}</div>
                )}
                {x.type === 'text' && (ro ? <div className="notice-text">{String(v ?? '—')}</div> : <textarea rows={2} maxLength={4000} value={String(v ?? '')} onChange={(e) => set(x.id, e.target.value)} />)}
                {x.type === 'number' && (ro ? <div>{String(v ?? '—')}</div> : <input inputMode="decimal" value={String(v ?? '')} onChange={(e) => set(x.id, e.target.value)} />)}
                {x.type === 'file' && (
                  <div className="btn-row">
                    {(v as FileAnswer | undefined)?.documentId && <a href={docUrl((v as FileAnswer).documentId)} target="_blank" rel="noreferrer">{(v as FileAnswer).fileName}</a>}
                    {!ro && onUpload && <label className="btn btn-secondary btn-sm">{(v as FileAnswer | undefined)?.documentId ? t('qn.replace') : t('qn.attach')}
                      <input type="file" hidden accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => { const f = e.target.files?.[0]; if (f) run(async () => { set(x.id, await onUpload(q, f)); }); }} /></label>}
                    {ro && !(v as FileAnswer | undefined)?.documentId && <span className="muted">—</span>}
                  </div>
                )}
                {missing.has(x.id) && <div className="field-error">{t('qn.answerThis')}</div>}
              </li>
            );
          })}
        </ol>
        {editable && (
          <div className="form-foot">
            {onSave && <button className="btn btn-ghost" disabled={busy || !dirty} onClick={() => run(() => onSave(q, answers))}>{t('qn.saveDraft')}</button>}
            <button className="btn btn-primary" disabled={busy} onClick={() => run(() => onSubmit!(q, answers))}>{q.status === 'SUBMITTED' && !q.outstanding ? t('qn.update') : t('qn.submit')}</button>
          </div>
        )}
      </>)}
    </div>
  );
}
