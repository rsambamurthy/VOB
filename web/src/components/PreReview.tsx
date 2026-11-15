import { useState } from 'react';
import { fmtDateTime } from '../lib/format';
import { Modal } from './ui';

export type Recommendation = 'APPROVE' | 'REVIEW' | 'SEND_BACK';
export interface PreReview {
  id: string; status: 'PENDING' | 'READY' | 'FAILED'; provider: string; live: boolean; createdAt: string; requestedBy: string; stale: boolean; aiOn: boolean;
  /** Exactly what was sent to the AI provider (no names, numbers or free text). */ sentToAi: unknown;
  result: { summary: string; recommendation: Recommendation; findings: { severity: 'high' | 'medium' | 'info'; text: string; tab?: string; source: 'checks' | 'ai' }[]; questions: string[] } | null;
}
const RECO: Record<Recommendation, { label: string; cls: string }> = {
  APPROVE: { label: 'Looks ready to approve', cls: 'risk-low' },
  REVIEW: { label: 'Check before approving', cls: 'risk-medium' },
  SEND_BACK: { label: 'Send back to the supplier', cls: 'risk-high' },
};
const ICON = { high: '●', medium: '▲', info: 'ℹ' } as const;

/** What VendorGate (and, when switched on, the AI) found about a submission — advisory, for approvers. */
export function PreReviewCard({ pr, tabLabel, onJump, onRefresh, refreshing, onUseQuestions }: {
  pr: PreReview; tabLabel: (key: string) => string | undefined; onJump: (tab: string) => void;
  onRefresh?: () => void; refreshing?: boolean; onUseQuestions?: (text: string) => void;
}) {
  const r = pr.result;
  const [showSent, setShowSent] = useState(false);
  return (
    <div className="card pad pre-review">
      <div className="row-between">
        <div><h3 className="card-title">Pre-review <span className={`badge sm ${pr.live ? 'v-test' : ''}`}>{pr.live ? 'AI' : 'Checks'}</span></h3>
          <span className="small muted">{fmtDateTime(pr.createdAt)}{pr.stale && <> · <strong className="diff-text">out of date — the supplier’s details changed</strong></>}</span></div>
        <div className="btn-row">{r && <span className={`badge ${RECO[r.recommendation].cls}`}>{RECO[r.recommendation].label}</span>}
          {onRefresh && <button className="link-btn small" disabled={refreshing} onClick={onRefresh}>{refreshing ? 'Working…' : pr.stale ? 'Refresh' : 'Run again'}</button>}</div>
      </div>
      {pr.status === 'PENDING' && <p className="muted small">Preparing…</p>}
      {pr.status === 'FAILED' && <p className="muted small">The pre-review couldn’t be made. Try again.</p>}
      {r && (<>
        <p className="pre-summary">{r.summary}</p>
        {r.findings.length > 0 && (
          <ul className="plain pre-findings">{r.findings.map((f, i) => (
            <li key={i} className={`sev-${f.severity}`}><span className="sev" aria-label={f.severity}>{ICON[f.severity]}</span>
              <span>{f.text}{f.source === 'ai' && <span className="muted small"> (AI)</span>}{f.tab && tabLabel(f.tab) && <> · <button className="link-btn small" onClick={() => onJump(f.tab!)}>{tabLabel(f.tab)}</button></>}</span></li>
          ))}</ul>
        )}
        {r.questions.length > 0 && (
          <div className="pre-questions"><strong className="small">Questions for the supplier</strong>
            <ol className="small">{r.questions.map((q, i) => <li key={i}>{q}</li>)}</ol>
            {onUseQuestions && <button className="btn btn-secondary btn-sm" onClick={() => onUseQuestions(r.questions.map((q, i) => `${i + 1}. ${q}`).join('\n'))}>Send back with these questions…</button>}
          </div>
        )}
      </>)}
      <p className="small muted">Advisory — you decide. {pr.live
        ? <>Privacy mode: the AI saw no names, registration or bank numbers, addresses, emails or free text — only general facts and yes/no comparisons, with the supplier as [SUPPLIER]. Names were put back here. {pr.sentToAi != null && <button className="link-btn small" onClick={() => setShowSent(true)}>What the AI saw</button>}</>
        : pr.aiOn ? 'Nothing was sent to the AI this time — the findings come from VendorGate’s own checks.' : 'An AI summary can be switched on under Administration → Integrations.'}</p>
      {showSent && (
        <Modal title="What the AI saw" wide onClose={() => setShowSent(false)} footer={<button className="btn btn-primary" onClick={() => setShowSent(false)}>Close</button>}>
          <p className="small muted">This is exactly what was sent to the AI provider for this pre-review. The supplier is [SUPPLIER] and other suppliers [OTHER-1], [OTHER-2]…; VendorGate checks that no name, number, address, email or typed-in text from the supplier's record is in it before sending (an exact turnover is allowed only if your workspace chose exact amounts).</p>
          <pre className="code-block sent-to-ai">{JSON.stringify(pr.sentToAi, null, 2)}</pre>
        </Modal>
      )}
    </div>
  );
}
