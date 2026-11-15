/**
 * The supplier guide — one set of components for the supplier portal and a buyer filling in for the supplier
 * (server: services/guide.ts, mounted at `${base}/guide`):
 *  - GuidePanel: the next step, the send-back to-do list and a question box;
 *  - SubmitCheck: what approvers would likely ask about, shown before submitting.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { t, getLang } from '../i18n';
import { articlesForQuestion, articlesIn } from '../help/HelpPanel';

export interface GuideItem { text: string; tab?: string; severity: 'high' | 'medium' | 'info' }
export interface Guide {
  editable: boolean; remaining: number; ready: boolean;
  next: GuideItem | null; nextKind: 'sendBack' | 'missing' | 'check' | 'ready';
  beforeSubmit: { approverWouldAsk: GuideItem[]; worthChecking: GuideItem[] };
  sendBack: { remarks: string; by: 'ai' | 'rules'; items: GuideItem[] | { text: string; tab?: string }[] } | null;
  canAsk: boolean;
}

/** The guide for a supplier; `refreshKey` changes whenever the form does (e.g. the checklist), to fetch it again. */
export function useGuide(base: string, refreshKey: string, enabled = true) {
  const [guide, setGuide] = useState<Guide>();
  const load = useCallback(() => { if (enabled) api<Guide>(`${base}/guide`).then(setGuide).catch(() => setGuide(undefined)); }, [base, enabled]);
  useEffect(() => { load(); }, [load, refreshKey]);
  return { guide, reload: load };
}

const ICON = { high: '●', medium: '▲', info: 'ℹ' } as const;

function Items({ items, tabLabel, onJump }: { items: { text: string; tab?: string; severity?: GuideItem['severity'] }[]; tabLabel: (k: string) => string | undefined; onJump: (tab: string) => void }) {
  return (
    <ul className="plain pre-findings guide-items">{items.map((i, n) => (
      <li key={n} className={`sev-${i.severity ?? 'medium'}`}><span className="sev" aria-hidden>{ICON[i.severity ?? 'medium']}</span>
        <span>{i.text}{i.tab && tabLabel(i.tab) && <> · <button type="button" className="link-btn small" onClick={() => onJump(i.tab!)}>{tabLabel(i.tab)}</button></>}</span></li>
    ))}</ul>
  );
}

export function GuidePanel({ guide, base, buyer, tabLabel, onJump }: { guide: Guide; base: string; buyer: string; tabLabel: (k: string) => string | undefined; onJump: (tab: string) => void }) {
  if (!guide.editable) return null;
  const n = guide.next;
  return (
    <div className="card pad guide">
      <h3 className="card-title">{t('guide.title')}</h3>
      {guide.sendBack && guide.sendBack.items.length > 0 ? (
        <div className="guide-sendback">
          <strong className="small">{t('guide.sendBackTitle', { buyer })}</strong>
          <Items items={guide.sendBack.items.map((i) => ({ ...i, severity: 'high' as const }))} tabLabel={tabLabel} onJump={onJump} />
          <p className="small muted">{t('guide.sendBackHint')}{guide.sendBack.by === 'ai' && <> {t('guide.byAi')}</>}</p>
        </div>
      ) : n ? (
        <div className="guide-next">
          <span className="small muted">{t('guide.next')}</span>
          <p className={`guide-next-text sev-${n.severity}`}>{n.text}</p>
          {n.tab && tabLabel(n.tab) && <button type="button" className="btn btn-secondary btn-sm" onClick={() => onJump(n.tab!)}>{t('guide.go', { tab: tabLabel(n.tab)! })}</button>}
        </div>
      ) : (
        <p className="ok-text small">{t('guide.allClear')}</p>
      )}
      {guide.ready && guide.nextKind === 'check' && <p className="small muted">{t('guide.readyCheck')}</p>}
      {guide.canAsk && <Ask base={base} buyer={buyer} />}
    </div>
  );
}

function Ask({ base, buyer }: { base: string; buyer: string }) {
  const [q, setQ] = useState('');
  const [state, setState] = useState<{ busy?: boolean; answer?: string; answered?: boolean; test?: boolean; error?: string }>({});
  async function ask() {
    if (q.trim().length < 3) return;
    setState({ busy: true });
    try {
      const articles = articlesForQuestion(q, articlesIn('supplier', getLang()).filter((a) => a.audience.includes('supplier')));
      setState(await api(`${base}/guide/ask`, { body: { question: q.trim(), articles } }));
    } catch (e: any) { setState({ error: e.message }); }
  }
  return (
    <div className="guide-ask">
      <label className="small strong" htmlFor="guide-q">{t('guide.askTitle')}</label>
      <div className="btn-row">
        <input id="guide-q" className="grow" value={q} maxLength={500} placeholder={t('guide.askPh')} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') ask(); }} />
        <button type="button" className="btn btn-secondary btn-sm" disabled={state.busy || q.trim().length < 3} onClick={ask}>{state.busy ? t('guide.thinking') : t('guide.ask')}</button>
      </div>
      {state.error && <p className="small field-error">{state.error}</p>}
      {state.answer && <div className={`help-answer ${state.answered ? '' : 'unsure'}`}><p>{state.answer}</p><p className="small muted">{t('guide.answerNote', { buyer })}{state.test ? ` ${t('help.testMode')}` : ''}</p></div>}
      <p className="small muted">{t('guide.privacy')}</p>
    </div>
  );
}

/** Inside the submit confirmation: what approvers would likely ask about, with links to fix it first. */
export function SubmitCheck({ guide, tabLabel, onJump }: { guide?: Guide; tabLabel: (k: string) => string | undefined; onJump: (tab: string) => void }) {
  if (!guide) return <p className="small muted">{t('guide.checking')}</p>;
  const { approverWouldAsk, worthChecking } = guide.beforeSubmit;
  if (!approverWouldAsk.length && !worthChecking.length) return <p className="small ok-text">{t('guide.noQueries')}</p>;
  return (
    <div className="submit-check">
      {approverWouldAsk.length > 0 && <><strong className="small">{t('guide.wouldAsk')}</strong><Items items={approverWouldAsk} tabLabel={tabLabel} onJump={onJump} /></>}
      {worthChecking.length > 0 && <><strong className="small">{t('guide.worth')}</strong><Items items={worthChecking} tabLabel={tabLabel} onJump={onJump} /></>}
      <p className="small muted">{t('guide.fixOrSubmit')}</p>
    </div>
  );
}
