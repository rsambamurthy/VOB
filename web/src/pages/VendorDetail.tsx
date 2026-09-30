import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useMeta } from '../lib/meta';
import { useStaff } from '../components/StaffShell';
import { DynamicSection } from '../components/DynamicSection';
import { DocumentsPanel } from '../components/DocumentsPanel';
import { ApprovalTimeline } from '../components/Timeline';
import { Checklist } from '../components/Checklist';
import { Alert, Modal, StatusBadge } from '../components/ui';
import { fmtDate, fmtDateTime, humanize } from '../lib/format';
import type { ChecklistItem, DocRequirement, VendorFull } from '../lib/types';

type Detail = { vendor: VendorFull; checklist: ChecklistItem[]; docRequirements: DocRequirement[]; canAct: boolean };
type Action = 'APPROVE' | 'SEND_BACK' | 'REJECT';

export function VendorDetail() {
  const { id } = useParams();
  const meta = useMeta();
  const me = useStaff()!;
  const [d, setD] = useState<Detail>();
  const [tab, setTab] = useState('basic');
  const [action, setAction] = useState<Action>();
  const [erp, setErp] = useState<unknown>();
  const [flash, setFlash] = useState<{ kind: 'success' | 'error'; text: string }>();

  const load = useCallback(() => api<Detail>(`/staff/vendors/${id}`, { session: 'staff' }).then(setD).catch((e) => setFlash({ kind: 'error', text: e.message })), [id]);
  useEffect(() => { load(); }, [load]);
  if (!d) return <div className="page"><div className="spinner" /></div>;
  const v = d.vendor;
  const tabs = [...meta.formSchema.map((s) => ({ key: s.key, label: s.label })), { key: 'documents', label: 'Documents' }, { key: 'history', label: 'History' }];
  const verifications = (v.profile._verifications ?? {}) as Record<string, { status: string; message: string; checkedAt: string }>;
  const openErrors = d.checklist.filter((c) => !c.ok);

  async function resend() {
    try { await api(`/staff/vendors/${id}/invite`, { session: 'staff', method: 'POST' }); setFlash({ kind: 'success', text: 'Invite re-sent. See Mailbox.' }); load(); }
    catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }
  async function exportErp() {
    try { setErp(await api(`/staff/vendors/${id}/erp-export`, { session: 'staff' })); } catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }

  return (
    <div className="page">
      <Link to="/staff/vendors" className="back">← Vendors</Link>
      <header className="page-head">
        <div>
          <h1>{v.name} <StatusBadge status={v.status} /></h1>
          <p className="muted"><span className="mono">{v.code}</span> · {meta.vendorTypes.find((t) => t.value === v.vendorType)?.label} · {v.contactFirstName} {v.contactLastName} ({v.contactEmail}, {v.contactMobile}) · created {fmtDate(v.createdAt)} by {v.createdBy?.name}</p>
        </div>
        <div className="head-actions">
          {me.role === 'ADMIN' && ['INVITED', 'IN_PROGRESS', 'SENT_BACK'].includes(v.status) && <button className="btn btn-secondary" onClick={resend}>Resend invite</button>}
          {v.status === 'APPROVED' && <button className="btn btn-secondary" onClick={exportErp}>ERP export</button>}
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
            {meta.formSchema.filter((s) => s.key === tab).map((s) => <DynamicSection key={s.key} section={s} profile={v.profile} readOnly />)}
            {tab === 'documents' && <DocumentsPanel requirements={d.docRequirements} documents={v.documents} session="staff" />}
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
          <div className="card pad"><h3 className="card-title">Approval flow</h3><ApprovalTimeline steps={v.steps} meta={meta} /></div>
          <div className="card pad">
            <h3 className="card-title">Verifications</h3>
            {Object.keys(verifications).length === 0 ? <p className="muted small">The vendor has not run any online checks.</p> : (
              <ul className="verif">
                {Object.entries(verifications).map(([k, r]) => (
                  <li key={k}><span className={`vbadge v-${r.status.toLowerCase()}`}>{r.status === 'VERIFIED' ? '✓' : '!'}</span><span><strong>{k.toUpperCase()}</strong> — {r.message}<span className="muted small block">{fmtDateTime(r.checkedAt)}</span></span></li>
                ))}
              </ul>
            )}
          </div>
          {v.status !== 'INVITED' && <div className="card pad"><Checklist items={d.checklist} sections={meta.formSchema} onJump={setTab} /></div>}
          {me.role === 'ADMIN' && v.inviteLink && ['INVITED', 'IN_PROGRESS', 'SENT_BACK'].includes(v.status) && (
            <div className="card pad"><h3 className="card-title">Vendor portal link</h3><p className="small muted">Open in another browser/tab to act as the vendor.</p><a className="small break" href={new URL(v.inviteLink).pathname} target="_blank" rel="noreferrer">{v.inviteLink}</a></div>
          )}
        </aside>
      </div>

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
      const r = await api(`/staff/vendors/${vendorId}/decision`, { session: 'staff', body: { action, remarks } });
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
