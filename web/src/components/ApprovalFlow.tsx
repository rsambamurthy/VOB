/**
 * Approval panel for the generic approval flow (sourcing events and awards): the timeline of the current
 * cycle and — for whoever can act — Approve / Send back / Reject with remarks.
 */
import { useState } from 'react';
import type { Step } from '../lib/types';
import { ApprovalTimeline } from './Timeline';
import { Modal } from './ui';

export type FlowDecision = 'APPROVE' | 'SEND_BACK' | 'REJECT';
export interface FlowViewData { cycle: number; steps: Step[]; current: { id: string; label: string } | null; canAct: boolean }

const TEXT: Record<FlowDecision, { title: string; btn: string; hint: string; cls: string }> = {
  APPROVE: { title: 'Approve', btn: 'Approve', hint: 'Remarks are optional.', cls: 'btn-primary' },
  SEND_BACK: { title: 'Send back for changes', btn: 'Send back', hint: 'Say what to change. The owner is emailed your remarks.', cls: 'btn-primary' },
  REJECT: { title: 'Reject', btn: 'Reject', hint: 'Say why. This ends the approval.', cls: 'btn-danger' },
};

export function FlowPanel({ flow, onDecide, empty = 'Not submitted for approval yet.', title = 'Approval' }: {
  flow: FlowViewData; onDecide: (action: FlowDecision, remarks: string) => Promise<void>; empty?: string; title?: string;
}) {
  const [action, setAction] = useState<FlowDecision>();
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function go() {
    if (!action) return;
    setBusy(true); setError(undefined);
    try { await onDecide(action, remarks); setAction(undefined); setRemarks(''); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  return (
    <section className="card pad section-card">
      <h3>{title}</h3>
      {flow.steps.length ? <ApprovalTimeline steps={flow.steps} /> : <p className="muted small">{empty}</p>}
      {flow.canAct && flow.current && (
        <div className="btn-row">
          <button className="btn btn-danger btn-sm" onClick={() => setAction('REJECT')}>Reject</button>
          <button className="btn btn-secondary btn-sm" onClick={() => setAction('SEND_BACK')}>Send back</button>
          <button className="btn btn-primary btn-sm" onClick={() => setAction('APPROVE')}>Approve — {flow.current.label}</button>
        </div>
      )}
      {action && (
        <Modal title={TEXT[action].title} onClose={() => setAction(undefined)} footer={<>
          <button className="btn btn-secondary" onClick={() => setAction(undefined)}>Close</button>
          <button className={`btn ${TEXT[action].cls}`} disabled={busy || (action !== 'APPROVE' && !remarks.trim())} onClick={go}>{TEXT[action].btn}</button></>}>
          {error && <div className="alert alert-error">{error}</div>}
          <div className="field"><label htmlFor="flow-remarks">Remarks</label><textarea id="flow-remarks" rows={4} value={remarks} onChange={(e) => setRemarks(e.target.value)} /><div className="field-help">{TEXT[action].hint}</div></div>
        </Modal>
      )}
    </section>
  );
}
