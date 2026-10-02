import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useConfig, VENDOR_TYPES } from '../lib/meta';
import { DynamicSection } from '../components/DynamicSection';
import { DocumentsPanel } from '../components/DocumentsPanel';
import { ApprovalTimeline } from '../components/Timeline';
import { Checklist } from '../components/Checklist';
import { Alert, Modal, StatusBadge } from '../components/ui';
import { fmtDate, fmtDateTime, humanize } from '../lib/format';
import type { Check, ChecklistItem, DocRequirement, Extraction, VendorFull } from '../lib/types';
import { ChecksPanel } from '../components/Checks';
import { ExtractionCard } from '../components/ExtractionCard';

type Detail = { vendor: VendorFull; checklist: ChecklistItem[]; docRequirements: DocRequirement[]; canAct: boolean; canInvite: boolean; canExport: boolean; canReassign: boolean; checks: Check[]; extractions: Extraction[] };
type Action = 'APPROVE' | 'SEND_BACK' | 'REJECT';

export function VendorDetail() {
  const { id } = useParams();
  const { config } = useConfig();
  const [d, setD] = useState<Detail>();
  const [tab, setTab] = useState('basic');
  const [action, setAction] = useState<Action>();
  const [erp, setErp] = useState<unknown>();
  const [reassigning, setReassigning] = useState(false);
  const [checking, setChecking] = useState<string>();
  const [flash, setFlash] = useState<{ kind: 'success' | 'error'; text: string }>();

  const load = useCallback(() => api<Detail>(`/staff/vendors/${id}`).then(setD).catch((e) => setFlash({ kind: 'error', text: e.message })), [id]);
  useEffect(() => { load(); }, [load]);
  if (!d || !config) return <div className="page"><div className="spinner" /></div>;
  const v = d.vendor;
  const tabs = [...config.sections.map((s) => ({ key: s.key, label: s.label })), { key: 'documents', label: 'Documents' }, { key: 'history', label: 'History' }];
  const mismatches = d.extractions.reduce((n, e) => n + e.suggestions.filter((s) => s.state === 'differs').length, 0);
  const openErrors = d.checklist.filter((c) => !c.ok);

  async function resend() {
    try { await api(`/staff/vendors/${id}/invite`, { method: 'POST' }); setFlash({ kind: 'success', text: 'Invitation re-sent.' }); load(); }
    catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }
  async function exportErp() {
    try { setErp(await api(`/staff/vendors/${id}/erp-export`)); } catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }

  return (
    <div className="page">
      <Link to="/staff/vendors" className="back">← Vendors</Link>
      <header className="page-head">
        <div>
          <h1>{v.name} <StatusBadge status={v.status} /></h1>
          <p className="muted"><span className="mono">{v.code}</span> · {VENDOR_TYPES.find((t) => t.value === v.vendorType)?.label} · {v.contactFirstName} {v.contactLastName} ({v.contactEmail}, {v.contactMobile}) · created {fmtDate(v.createdAt)} by {v.createdBy?.name}</p>
        </div>
        <div className="head-actions">
          {d.canInvite && ['INVITED', 'IN_PROGRESS', 'SENT_BACK'].includes(v.status) && <button className="btn btn-secondary" onClick={resend}>Resend invite</button>}
          {v.status === 'APPROVED' && d.canExport && <button className="btn btn-secondary" onClick={exportErp}>ERP export</button>}
        </div>
      </header>
      {flash && <Alert kind={flash.kind}>{flash.text}</Alert>}

      {d.canAct && (
        <div className="action-bar">
          <div><strong>Your review is needed.</strong> <span className="muted">{v.steps.find((s) => s.status === 'PENDING')?.label} · submitted {fmtDateTime(v.submittedAt)}</span></div>
          <div className="btn-row">
            <button className="btn btn-danger-ghost" onClick={() => setAction('REJECT')}>Reject</button>
            <button className="btn btn-secondary" onClick={() => setAction('SEND_BACK')}>Send back to vendor</button>
            <button className="btn btn-primary" onClick={() => setAction('APPROVE')}>Approve</button>
          </div>
        </div>
      )}
      {v.status === 'UNDER_REVIEW' && openErrors.length > 0 && <Alert kind="warning">Heads-up: {openErrors.length} checklist item(s) are not satisfied under the current rules.</Alert>}

      <div className="detail-grid">
        <div className="card">
          <div className="tabs" role="tablist">
            {tabs.map((t) => <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>{t.label}</button>)}
          </div>
          <div className="pad">
            {config.sections.filter((s) => s.key === tab).map((s) => <DynamicSection key={s.key} section={s} profile={v.profile} vendorType={v.vendorType} readOnly />)}
            {tab === 'documents' && <DocumentsPanel requirements={d.docRequirements} documents={v.documents} />}
            {tab === 'documents' && d.extractions.filter((e) => e.status === 'DONE' || e.status === 'FAILED').map((e) => {
              const doc = v.documents.find((x) => x.id === e.documentId);
              if (!doc) return null;
              return <ExtractionCard key={e.id} ex={e} readOnly docLabel={d.docRequirements.find((r) => r.type === doc.docType)?.label ?? doc.docType} />;
            })}
            {tab === 'history' && (
              <ul className="audit">
                {v.audit?.map((a) => (
                  <li key={a.id}><span className="muted small">{fmtDateTime(a.createdAt)}</span> <strong>{a.actor}</strong> — {humanize(a.action)}
                    {a.detail && Object.keys(a.detail).length > 0 && <span className="muted small"> {Object.entries(a.detail).filter(([, x]) => x !== '' && x != null).map(([k, x]) => `${k}: ${x}`).join(' · ')}</span>}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <aside className="side-col">
          <div className="card pad"><div className="row-between card-title"><h3>Approval flow</h3>{d.canReassign && <button className="link-btn small" onClick={() => setReassigning(true)}>Reassign</button>}</div><ApprovalTimeline steps={v.steps} levels={config.workflow.levels.map((l) => l.label)} /></div>
          <div className="card pad">
            <h3 className="card-title">Verifications</h3>
            <ChecksPanel checks={d.checks} busy={checking} onRun={async (k) => {
              setChecking(k);
              try { const r = await api(`/staff/vendors/${v.id}/verify/${k}`, { method: 'POST' }); setFlash({ kind: r.status === 'VERIFIED' ? 'success' : 'error', text: `${k.toUpperCase()}: ${r.message}` }); await load(); }
              catch (e: any) { setFlash({ kind: 'error', text: e.message }); } finally { setChecking(undefined); }
            }} />
            {mismatches > 0 && <p className="small diff-text">⚠ {mismatches} value{mismatches > 1 ? 's' : ''} on uploaded documents differ from the form — see the Documents tab.</p>}
          </div>
          {v.status !== 'INVITED' && <div className="card pad"><Checklist items={d.checklist} sections={config.sections} onJump={setTab} /></div>}
          {v.inviteLink && ['INVITED', 'IN_PROGRESS', 'SENT_BACK'].includes(v.status) && (
            <div className="card pad"><h3 className="card-title">Vendor portal link <span className="tag-dev">dev</span></h3><p className="small muted">Shown only in development. Open it in another tab to act as the vendor.</p><a className="small break" href={new URL(v.inviteLink).pathname} target="_blank" rel="noreferrer">{v.inviteLink}</a></div>
          )}
        </aside>
      </div>

      {reassigning && <ReassignModal vendorId={v.id} step={v.steps.find((s) => s.status === 'PENDING')!} onClose={() => setReassigning(false)} onDone={(m) => { setReassigning(false); setFlash({ kind: 'success', text: m }); load(); }} />}
      {action && <DecisionModal action={action} vendorId={v.id} onClose={() => setAction(undefined)} onDone={(msg) => { setAction(undefined); setFlash({ kind: 'success', text: msg }); load(); }} />}
      {erp !== undefined && (
        <Modal title="ERP export — Oracle supplier payload" wide onClose={() => setErp(undefined)}
          footer={<><button className="btn btn-ghost" onClick={() => navigator.clipboard?.writeText(JSON.stringify(erp, null, 2))}>Copy</button>
            <a className="btn btn-primary" download={`${v.code}-erp.json`} href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(erp, null, 2))}`}>Download JSON</a></>}>
          <p className="small muted">Same structure as the ERPVendorsData sample. Site and bank lists are always arrays, and SWIFT, IBAN and IFSC go in separate fields.</p>
          <pre className="code">{JSON.stringify(erp, null, 2)}</pre>
        </Modal>
      )}
    </div>
  );
}

function DecisionModal({ action, vendorId, onClose, onDone }: { action: Action; vendorId: string; onClose: () => void; onDone: (msg: string) => void }) {
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const cfg = {
    APPROVE: { title: 'Approve', btn: 'Approve', cls: 'btn-primary', hint: 'Remarks are optional.' },
    SEND_BACK: { title: 'Send back to vendor', btn: 'Send back', cls: 'btn-primary', hint: 'Tell the vendor exactly what to fix. They will see this message.' },
    REJECT: { title: 'Reject vendor', btn: 'Reject', cls: 'btn-danger', hint: 'This ends the registration. The reason is emailed to the vendor.' },
  }[action];
  async function submit() {
    setBusy(true); setError(undefined);
    try {
      const r = await api(`/staff/vendors/${vendorId}/decision`, { body: { action, remarks } });
      onDone(r.status === 'APPROVED' ? 'Final approval done — vendor is active.' : r.nextLevel ? `Approved. Moved to ${r.nextLevel}.` : action === 'SEND_BACK' ? 'Sent back to the vendor.' : 'Vendor rejected.');
    } catch (e: any) { setError(e.message); setBusy(false); }
  }
  return (
    <Modal title={cfg.title} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className={`btn ${cfg.cls}`} disabled={busy} onClick={submit}>{busy ? 'Saving…' : cfg.btn}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="field"><label htmlFor="remarks">Remarks{action !== 'APPROVE' && <span className="req"> *</span>}</label>
        <textarea id="remarks" rows={4} value={remarks} onChange={(e) => setRemarks(e.target.value)} autoFocus /><div className="field-help">{cfg.hint}</div></div>
    </Modal>
  );
}

function ReassignModal({ vendorId, step, onClose, onDone }: { vendorId: string; step: VendorFull['steps'][number]; onClose: () => void; onDone: (msg: string) => void }) {
  const [people, setPeople] = useState<{ id: string; name: string; email: string; holdsRole: boolean }[]>();
  const [choice, setChoice] = useState<string>(step.assigneeName ? '' : '__role');
  const [error, setError] = useState<string>();
  useEffect(() => { api(`/staff/vendors/${vendorId}/assignable`).then(setPeople).catch((e) => setError(e.message)); }, [vendorId]);
  async function save() {
    try {
      const r = await api(`/staff/vendors/${vendorId}/steps/${step.id}/assign`, { body: { userId: choice === '__role' ? null : choice } });
      onDone(`${step.label} is now with ${r.assignee}.`);
    } catch (e: any) { setError(e.message); }
  }
  return (
    <Modal title={`Reassign: ${step.label}`} onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!choice} onClick={save}>Reassign</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <p className="small muted">Currently: {step.assigneeName ? `assigned to ${step.assigneeName}` : `everyone with the ${step.roleName} role`}. The new owner is emailed straight away.</p>
      {!people ? <div className="spinner" /> : (
        <div className="check-list">
          <label className="check-item"><input type="radio" name="asg" checked={choice === '__role'} onChange={() => setChoice('__role')} /><span><strong>Everyone with the {step.roleName} role</strong></span></label>
          {people.map((p) => (
            <label key={p.id} className="check-item"><input type="radio" name="asg" checked={choice === p.id} onChange={() => setChoice(p.id)} /><span><strong>{p.name}</strong>{p.holdsRole && <span className="chip">{step.roleName}</span>}<span className="muted small block">{p.email}</span></span></label>
          ))}
        </div>
      )}
    </Modal>
  );
}
