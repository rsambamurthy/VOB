import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { Alert, Empty, Modal } from '../../components/ui';
import { fmtDate } from '../../lib/format';
import type { Condition, OnboardingConfig } from '../../lib/types';
import { fieldCatalog, move, ruleSummary, RulePicker, toKey, type CatalogEntry, type EditorMeta } from './config/shared';
import { TEMPLATES, type QDraft } from './questionnaireTemplates';

interface Questionnaire { id: string; title: string; titleAr: string | null; description: string | null; descriptionAr: string | null; appliesIf: Condition | null; required: boolean; questions: QDraft[]; bands: { low: number; medium: number }; status: 'ACTIVE' | 'ARCHIVED'; updatedAt: string; updatedByName: string; submitted: number; highRisk: number }
type Draft = Omit<Questionnaire, 'id' | 'status' | 'updatedAt' | 'updatedByName' | 'submitted' | 'highRisk'> & { id?: string };
const TYPE_LABEL: Record<QDraft['type'], string> = { yesno: 'Yes / No', choice: 'One choice', multi: 'Several choices', text: 'Text answer', number: 'Number', file: 'File upload' };
const blank = (): Draft => ({ title: '', titleAr: '', description: '', descriptionAr: '', appliesIf: null, required: true, questions: [], bands: { low: 75, medium: 50 } });

/** Maximum points a supplier can get (follow-ups counted as shown). */
function maxPoints(qs: QDraft[]) {
  return qs.reduce((n, q) => n + (q.type === 'multi' ? (q.options ?? []).reduce((m, o) => m + Math.max(0, o.points), 0) : q.type === 'file' ? q.points ?? 0 : Math.max(0, ...(q.options ?? []).map((o) => o.points))), 0);
}

/** Administration → Questionnaires: ESG, information security, quality… asked of suppliers by category, scored into a risk band. */
export function Questionnaires() {
  const [rows, setRows] = useState<Questionnaire[]>();
  const [cfg, setCfg] = useState<{ config: OnboardingConfig; meta: EditorMeta }>();
  const [edit, setEdit] = useState<Draft | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const load = () => api<Questionnaire[]>('/questionnaires').then(setRows).catch((e) => setMsg({ kind: 'error', text: e.message }));
  useEffect(() => { load(); api<{ published: { config: OnboardingConfig }; meta: EditorMeta }>('/admin/config').then((s) => setCfg({ config: s.published.config, meta: s.meta })).catch(() => {}); }, []);
  const catalog = useMemo(() => (cfg ? fieldCatalog(cfg.config, cfg.meta) : []), [cfg]);
  async function setStatus(q: Questionnaire, action: 'archive' | 'restore') {
    try { await api(`/questionnaires/${q.id}/${action}`, { method: 'POST' }); setMsg({ kind: 'success', text: action === 'archive' ? `“${q.title}” archived. Past answers are kept.` : `“${q.title}” is active again.` }); load(); }
    catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  }
  return (
    <div className="page">
      <header className="page-head"><div><h1>Questionnaires</h1><p className="muted">Questions suppliers answer in the portal — ESG, information security, quality, anti-bribery — asked by category. Each answer can carry points; the score gives a Low / Medium / High risk that only your staff see.</p></div>
        <button className="btn btn-primary" onClick={() => setEdit(blank())}>Add questionnaire</button></header>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="card">
        {!rows ? <div className="pad"><div className="spinner" /></div> : !rows.length ? <Empty>No questionnaires yet. Start from a template — ESG, information security, anti-bribery or quality.</Empty> : (
          <table className="table static">
            <thead><tr><th>Questionnaire</th><th>Asked of</th><th>Questions</th><th>Answers</th><th /></tr></thead>
            <tbody>{rows.map((q) => (
              <tr key={q.id} className={q.status === 'ARCHIVED' ? 'muted' : ''}>
                <td><div className="strong">{q.title} {q.status === 'ARCHIVED' && <span className="badge sm">Archived</span>}</div><div className="small muted">{q.required ? 'Required before submitting' : 'Optional'} · updated {fmtDate(q.updatedAt)} by {q.updatedByName}</div></td>
                <td className="small">{q.appliesIf ? ruleSummary(q.appliesIf, catalog) : 'All suppliers'}</td>
                <td className="small">{q.questions.length} · max {maxPoints(q.questions)} points</td>
                <td className="small">{q.submitted} submitted{q.highRisk ? <div className="diff-text">{q.highRisk} high risk</div> : null}</td>
                <td className="actions small"><button className="link-btn small" onClick={() => setEdit({ ...q, titleAr: q.titleAr ?? '', description: q.description ?? '', descriptionAr: q.descriptionAr ?? '' })}>Edit</button> · {q.status === 'ACTIVE'
                  ? <button className="link-btn small danger" onClick={() => setStatus(q, 'archive')}>Archive</button> : <button className="link-btn small" onClick={() => setStatus(q, 'restore')}>Restore</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      {edit && <Builder draft={edit} catalog={catalog} onClose={() => setEdit(null)} onSaved={(t) => { setEdit(null); setMsg({ kind: 'success', text: t }); load(); }} />}
    </div>
  );
}

function Builder({ draft, catalog, onClose, onSaved }: { draft: Draft; catalog: CatalogEntry[]; onClose: () => void; onSaved: (msg: string) => void }) {
  const [d, setD] = useState<Draft>(structuredClone(draft));
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const up = (fn: (x: Draft) => void) => setD((x) => { const y = structuredClone(x); fn(y); return y; });
  const ids = d.questions.map((q) => q.id);
  function addQuestion(type: QDraft['type']) {
    up((x) => { x.questions.push({ id: toKey('question', ids), text: '', type, required: true, ...(type === 'choice' || type === 'multi' ? { options: [{ label: '', points: 10 }, { label: '', points: 0 }] } : type === 'yesno' ? { options: [{ label: 'Yes', labelAr: 'نعم', points: 10 }, { label: 'No', labelAr: 'لا', points: 0 }] } : type === 'file' ? { points: 5 } : {}) }); });
  }
  async function save() {
    setBusy(true); setErr(undefined);
    const body = { ...d, titleAr: d.titleAr || undefined, description: d.description || undefined, descriptionAr: d.descriptionAr || undefined,
      questions: d.questions.map((q) => ({ ...q, id: q.id || toKey(q.text, ids), textAr: q.textAr || undefined, help: q.help || undefined, helpAr: q.helpAr || undefined, options: q.options?.map((o) => ({ ...o, labelAr: o.labelAr || undefined })) })) };
    try { await api(d.id ? `/questionnaires/${d.id}` : '/questionnaires', { method: d.id ? 'PUT' : 'POST', body }); onSaved(d.id ? `“${d.title}” saved. New answers use these questions; earlier answers keep theirs.` : `“${d.title}” added. Suppliers it applies to see it in the portal.`); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  }
  return (
    <Modal title={d.id ? `Edit: ${draft.title}` : 'New questionnaire'} wide onClose={onClose}
      footer={<><span className="muted small grow">{d.questions.length} question{d.questions.length === 1 ? '' : 's'} · max {maxPoints(d.questions)} points</span><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || d.title.trim().length < 3 || !d.questions.length || (!!d.appliesIf && !['empty', 'notEmpty'].includes(d.appliesIf.op) && (d.appliesIf.value === undefined || d.appliesIf.value === '' || (Array.isArray(d.appliesIf.value) && !d.appliesIf.value.length)))} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}>
      {err && <Alert kind="error">{err}</Alert>}
      {!d.id && !d.questions.length && (
        <div className="template-pick"><span className="small muted">Start from a template:</span>
          {TEMPLATES.map((t) => <button key={t.key} className="btn btn-secondary btn-sm" onClick={() => up((x) => { x.title = t.title; x.titleAr = t.titleAr; x.description = t.description; x.questions = structuredClone(t.questions); })}>{t.title}</button>)}</div>
      )}
      <div className="field-grid">
        <div className="field"><label htmlFor="qq-title">Name</label><input id="qq-title" value={d.title} maxLength={150} onChange={(e) => up((x) => { x.title = e.target.value; })} placeholder="e.g. ESG self-assessment" /></div>
        <div className="field"><label htmlFor="qq-title-ar">Name in Arabic (optional)</label><input id="qq-title-ar" dir="rtl" value={d.titleAr ?? ''} maxLength={150} onChange={(e) => up((x) => { x.titleAr = e.target.value; })} /></div>
      </div>
      <div className="field"><label htmlFor="qq-desc">Introduction for suppliers (optional)</label><textarea id="qq-desc" rows={2} value={d.description ?? ''} onChange={(e) => up((x) => { x.description = e.target.value; })} /></div>
      <RulePicker label="Asked of" value={d.appliesIf ?? undefined} onChange={(v) => up((x) => { x.appliesIf = v && typeof v === 'object' ? v : null; })} catalog={catalog} />
      <div className="field-help">For example “Category of Supply is Services”, or a vendor type. A buyer can also send any questionnaire to a supplier from their page.</div>
      <label className="check-item"><input type="checkbox" checked={d.required} onChange={(e) => up((x) => { x.required = e.target.checked; })} /><span><strong>Required during onboarding</strong><span className="muted small block">Suppliers it applies to can’t submit for approval until they answer it.</span></span></label>
      <fieldset className="group"><legend>Risk bands (by score, % of the maximum)</legend>
        <div className="btn-row small">Low risk at <input className="num-in" type="number" min={1} max={100} value={d.bands.low} onChange={(e) => up((x) => { x.bands.low = Number(e.target.value); })} />% or more · Medium at <input className="num-in" type="number" min={0} max={100} value={d.bands.medium} onChange={(e) => up((x) => { x.bands.medium = Number(e.target.value); })} />% or more · High below. A knock-out answer is always High.</div>
      </fieldset>

      <h4>Questions</h4>
      <ol className="qb-list">
        {d.questions.map((q, i) => {
          const earlier = d.questions.slice(0, i).filter((p) => p.type === 'yesno' || p.type === 'choice');
          return (
            <li key={i} className="qb-q">
              <div className="row-between"><span className="small muted">{TYPE_LABEL[q.type]}</span>
                <span className="btn-row"><button type="button" className="icon-btn" aria-label="Move up" onClick={() => up((x) => move(x.questions, i, -1))}>↑</button><button type="button" className="icon-btn" aria-label="Move down" onClick={() => up((x) => move(x.questions, i, 1))}>↓</button><button type="button" className="icon-btn" aria-label="Remove question" onClick={() => up((x) => { x.questions.splice(i, 1); })}>✕</button></span></div>
              <div className="field-grid">
                <div className="field"><label>Question</label><input value={q.text} maxLength={500} onChange={(e) => up((x) => { x.questions[i].text = e.target.value; })} /></div>
                <div className="field"><label>In Arabic (optional)</label><input dir="rtl" value={q.textAr ?? ''} maxLength={500} onChange={(e) => up((x) => { x.questions[i].textAr = e.target.value; })} /></div>
              </div>
              <div className="field"><label>Help text (optional)</label><input value={q.help ?? ''} maxLength={500} onChange={(e) => up((x) => { x.questions[i].help = e.target.value; })} /></div>
              {q.options && (
                <table className="table static small qb-opts"><thead><tr><th>Answer</th><th>In Arabic</th><th>Points</th><th>Knock-out</th><th /></tr></thead>
                  <tbody>{q.options.map((o, j) => (
                    <tr key={j}>
                      <td><input value={o.label} maxLength={200} disabled={q.type === 'yesno'} onChange={(e) => up((x) => { x.questions[i].options![j].label = e.target.value; })} /></td>
                      <td><input dir="rtl" value={o.labelAr ?? ''} maxLength={200} onChange={(e) => up((x) => { x.questions[i].options![j].labelAr = e.target.value; })} /></td>
                      <td><input className="num-in" type="number" min={-100} max={100} value={o.points} onChange={(e) => up((x) => { x.questions[i].options![j].points = Number(e.target.value); })} /></td>
                      <td><input type="checkbox" checked={!!o.knockout} title="This answer makes the supplier High risk whatever the score" onChange={(e) => up((x) => { x.questions[i].options![j].knockout = e.target.checked; })} /></td>
                      <td>{q.type !== 'yesno' && q.options!.length > 2 && <button type="button" className="icon-btn" aria-label="Remove answer" onClick={() => up((x) => { x.questions[i].options!.splice(j, 1); })}>✕</button>}</td>
                    </tr>
                  ))}</tbody></table>
              )}
              {q.options && q.type !== 'yesno' && <button type="button" className="link-btn small" onClick={() => up((x) => { x.questions[i].options!.push({ label: '', points: 0 }); })}>+ Add answer</button>}
              {q.type === 'file' && <div className="btn-row small">Points for attaching a file <input className="num-in" type="number" min={0} max={100} value={q.points ?? 0} onChange={(e) => up((x) => { x.questions[i].points = Number(e.target.value); })} /></div>}
              <div className="btn-row small">
                <label className="check-item"><input type="checkbox" checked={q.required} onChange={(e) => up((x) => { x.questions[i].required = e.target.checked; })} /><span>Required</span></label>
                {earlier.length > 0 && (<>
                  <span className="muted">Show only when</span>
                  <select value={q.showIf?.questionId ?? ''} onChange={(e) => up((x) => { const p = earlier.find((y) => y.id === e.target.value); x.questions[i].showIf = p ? { questionId: p.id, equals: p.options?.[0]?.label ?? '' } : undefined; })}>
                    <option value="">— always shown —</option>{earlier.map((p) => <option key={p.id} value={p.id}>{p.text || '(untitled)'}</option>)}</select>
                  {q.showIf && <><span className="muted">is</span><select value={q.showIf.equals} onChange={(e) => up((x) => { x.questions[i].showIf!.equals = e.target.value; })}>{d.questions.find((p) => p.id === q.showIf!.questionId)?.options?.map((o) => <option key={o.label} value={o.label}>{o.label}</option>)}</select></>}
                </>)}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="btn-row"><span className="small muted">Add:</span>{(Object.keys(TYPE_LABEL) as QDraft['type'][]).map((t) => <button key={t} type="button" className="btn btn-secondary btn-sm" onClick={() => addQuestion(t)}>{TYPE_LABEL[t]}</button>)}</div>
    </Modal>
  );
}
