import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, docUrl } from '../lib/api';
import { useConfig, VENDOR_TYPES } from '../lib/meta';
import { DynamicSection } from '../components/DynamicSection';
import { DocumentsPanel } from '../components/DocumentsPanel';
import { ApprovalTimeline } from '../components/Timeline';
import { Checklist } from '../components/Checklist';
import { Alert, Modal, StatusBadge } from '../components/ui';
import { fmtDate, fmtDateTime, humanize } from '../lib/format';
import type { ChangeRequest, Check, Profile, ChecklistItem, DocRequirement, Extraction, Flag, Step, VendorFull } from '../lib/types';
import { ChangeDiff, CrBadge, diffProfiles, FlagBadges, isMasked, MASKED_FIELDS } from '../components/Lifecycle';
import { ErpCard } from '../components/Erp';
import { SupplierAccessCard } from '../components/SupplierAccess';
import { useSession } from '../lib/session';
import { ChecksPanel } from '../components/Checks';
import { ExtractionCard } from '../components/ExtractionCard';
import { TabStrip } from '../components/TabStrip';

type Detail = { vendor: VendorFull; checklist: ChecklistItem[]; docRequirements: DocRequirement[]; canAct: boolean; canInvite: boolean; canExport: boolean; canReassign: boolean; checks: Check[]; extractions: Extraction[]; canBlock: boolean; canPropose: boolean; canEditContact?: boolean; me: string;
  privacy: { consentAt: string | null; consentVersion: number | null; currentVersion: number; erasureRequestedAt: string | null; erasureReason: string | null; erasedAt: string | null; canErase: boolean; canExport: boolean }; flags: Flag[]; changeRequests: ChangeRequest[] };
type Action = 'APPROVE' | 'SEND_BACK' | 'REJECT';

export function VendorDetail() {
  const { id } = useParams();
  const { config, checks: checkDefs } = useConfig();
  const { can, me } = useSession();
  const [d, setD] = useState<Detail>();
  const [tab, setTab] = useState('basic');
  const [action, setAction] = useState<Action>();
  const [erp, setErp] = useState<unknown>();
  const [reassigning, setReassigning] = useState(false);
  const [checking, setChecking] = useState<string>();
  const [blockMode, setBlockMode] = useState<'block' | 'unblock'>();
  const [contactOpen, setContactOpen] = useState(false);
  const [crAction, setCrAction] = useState<{ cr: ChangeRequest; action: 'APPROVE' | 'REJECT' }>();
  const [crReassign, setCrReassign] = useState<ChangeRequest>();
  const [reviewing, setReviewing] = useState(false);
  // Staff proposing a change on the vendor's behalf (vendors.edit)
  const [draft, setDraft] = useState<Profile>();
  const [propErrors, setPropErrors] = useState<Record<string, string>>({});
  const [proposeOpen, setProposeOpen] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [privacyAction, setPrivacyAction] = useState<'erase' | 'decline'>();
  const [flash, setFlash] = useState<{ kind: 'success' | 'error'; text: string }>();

  const load = useCallback(() => api<Detail>(`/staff/vendors/${id}`).then(setD).catch((e) => setFlash({ kind: 'error', text: e.message })), [id]);
  useEffect(() => { load(); }, [load]);
  if (!d || !config) return <div className="page"><div className="spinner" /></div>;
  const v = d.vendor;
  const openCrs = d.changeRequests.filter((c) => c.status === 'PENDING');
  const myCr = openCrs.find((c) => c.canAct);
  const tabs = [...config.sections.map((s) => ({ key: s.key, label: s.label })), { key: 'documents', label: 'Documents' },
    ...(d.changeRequests.length ? [{ key: 'changes', label: `Changes${openCrs.length ? ` (${openCrs.length})` : ''}` }] : []), { key: 'history', label: 'History' }];
  const approved = v.status === 'APPROVED';
  const shownProfile = Object.keys(revealed).length ? Object.fromEntries(Object.entries(v.profile).map(([sec, vals]) => [sec, { ...vals, ...Object.fromEntries(Object.entries(revealed).filter(([k]) => k.startsWith(`${sec}.`)).map(([k, x]) => [k.split('.')[1], x])) }])) : v.profile;
  async function reveal(fieldId: string, changeRequestId?: string) {
    try { return await api<{ value?: string; old?: string; new?: string }>(`/staff/vendors/${id}/reveal`, { body: { fieldId, changeRequestId } }); }
    catch (e: any) { setFlash({ kind: 'error', text: e.message }); throw e; }
  }
  const revealExtra = (sectionKey: string) => (f: { key: string }) => {
    const fid = `${sectionKey}.${f.key}`;
    if (proposing || !MASKED_FIELDS.includes(fid) || revealed[fid] !== undefined || !isMasked(v.profile[sectionKey]?.[f.key])) return null;
    return <button type="button" className="link-btn small" title="Shows the full value. Each reveal is recorded in the audit log." onClick={async () => { const r = await reveal(fid); setRevealed((x) => ({ ...x, [fid]: r.value ?? '' })); }}>Reveal</button>;
  };
  const proposing = !!draft;
  const myStaged = v.documents.filter((x) => x.status === 'PENDING' && !x.changeRequestId && x.uploadedById === d.me);
  const proposedChanges = draft ? diffProfiles(config.sections, v.profile, draft) : [];
  const canStartProposal = d.canPropose && !openCrs.length && !proposing;

  function startProposal() { setDraft(structuredClone(v.profile)); setPropErrors({}); setFlash(undefined); }
  async function discardProposal() {
    for (const x of myStaged) await api(`/staff/vendors/${id}/documents/${x.id}`, { method: 'DELETE' }).catch(() => {});
    setDraft(undefined); setPropErrors({}); await load();
  }
  async function stageUpload(docType: string, file: File, expiresOn?: string) {
    const fd = new FormData(); fd.append('docType', docType); if (expiresOn) fd.append('expiresOn', expiresOn); fd.append('file', file);
    try { await api(`/staff/vendors/${id}/documents`, { body: fd }); await load(); } catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }
  async function unstage(docId: string) {
    try { await api(`/staff/vendors/${id}/documents/${docId}`, { method: 'DELETE' }); await load(); } catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }
  async function submitProposal(note: string) {
    // Only the fields that changed (untouched masked values must never be sent back as "new" values).
    const changes: Record<string, Record<string, string>> = {};
    for (const c of proposedChanges) { const [sec, key] = c.fieldId.split('.'); (changes[sec] ??= {})[key] = c.new; }
    try {
      await api(`/staff/vendors/${id}/change-requests`, { body: { changes, note } });
      setProposeOpen(false); setDraft(undefined); setPropErrors({});
      setFlash({ kind: 'success', text: 'Change proposed and sent for approval. The vendor’s contact has been emailed. Someone other than you has to approve it.' });
      setTab('changes'); await load();
    } catch (e: any) {
      if (e instanceof ApiError && Array.isArray(e.details)) setPropErrors(Object.fromEntries((e.details as ChecklistItem[]).filter((c) => c.message).map((c) => [c.id.replace(/^cross\./, ''), c.message!])));
      setProposeOpen(false); setFlash({ kind: 'error', text: e.message });
    }
  }
  const mismatches = d.extractions.reduce((n, e) => n + e.suggestions.filter((s) => s.state === 'differs').length, 0);
  const openErrors = d.checklist.filter((c) => !c.ok);

  async function resend() {
    try { await api(`/staff/vendors/${id}/invite`, { method: 'POST' }); setFlash({ kind: 'success', text: 'Invitation re-sent.' }); load(); }
    catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }
  async function runReview() {
    setReviewing(true);
    try {
      const r = await api<{ status: string; problems: string[] }>(`/staff/vendors/${id}/review`, { method: 'POST' });
      setFlash(r.problems?.length ? { kind: 'error', text: `Re-check found: ${r.problems.join('; ')}` } : { kind: 'success', text: 'Re-check passed. The vendor was asked to confirm their details.' });
      await load();
    } catch (e: any) { setFlash({ kind: 'error', text: e.message }); } finally { setReviewing(false); }
  }
  async function exportErp() {
    try { setErp(await api(`/staff/vendors/${id}/erp-export`)); } catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }

  return (
    <div className="page">
      <Link to="/staff/vendors" className="back">← Vendors</Link>
      <header className="page-head">
        <div>
          <h1>{v.name} <StatusBadge status={v.status} /> <FlagBadges flags={d.flags} /></h1>
          <p className="muted"><span className="mono">{v.code}</span> · {VENDOR_TYPES.find((t) => t.value === v.vendorType)?.label} · {v.contactFirstName} {v.contactLastName} ({v.contactEmail}{d.canEditContact && <> <button className="link-btn small" onClick={() => setContactOpen(true)}>change</button></>}, {v.contactMobile}) · created {fmtDate(v.createdAt)} by {v.createdBy?.name}</p>
        </div>
        <div className="head-actions">
          {d.canInvite && ['INVITED', 'IN_PROGRESS', 'SENT_BACK'].includes(v.status) && <button className="btn btn-secondary" onClick={resend}>Resend invite</button>}
          {canStartProposal && <button className="btn btn-secondary" onClick={startProposal} title="Update details or documents on the vendor’s behalf (needs approval)">Propose change</button>}
          {approved && d.canBlock && <button className="btn btn-secondary" disabled={reviewing} onClick={runReview}>{reviewing ? 'Checking…' : 'Run re-check'}</button>}
          {approved && d.canBlock && (v.blockedAt
            ? <button className="btn btn-secondary" onClick={() => setBlockMode('unblock')}>Unblock</button>
            : <button className="btn btn-danger-ghost" onClick={() => setBlockMode('block')}>Block</button>)}
          {approved && d.canExport && <button className="btn btn-secondary" onClick={exportErp}>ERP export</button>}
        </div>
      </header>
      {flash && <Alert kind={flash.kind}>{flash.text}</Alert>}
      {d.privacy.erasedAt && <Alert kind="info"><strong>Personal data erased</strong> on {fmtDateTime(d.privacy.erasedAt)}. Only the code, status and dates are kept for reporting and the audit trail.</Alert>}
      {d.privacy.erasureRequestedAt && (
        <Alert kind="warning"><strong>The vendor asked for their data to be deleted</strong> on {fmtDateTime(d.privacy.erasureRequestedAt)}{d.privacy.erasureReason ? ` — “${d.privacy.erasureReason}”` : ''}. Under DPDP, respond without undue delay.
          {d.privacy.canErase && <div className="btn-row" style={{ marginTop: 8 }}><button className="btn btn-danger btn-sm" onClick={() => setPrivacyAction('erase')}>Erase data…</button><button className="btn btn-secondary btn-sm" onClick={() => setPrivacyAction('decline')}>Decline with reason…</button></div>}</Alert>
      )}
      {approved && v.blockedAt && <Alert kind="error"><strong>Blocked</strong> since {fmtDateTime(v.blockedAt)}{v.blockedReason ? ` — “${v.blockedReason}”` : ''}. Payments and new POs are on hold in the ERP export.</Alert>}
      {approved && v.reviewStatus === 'ATTENTION' && <Alert kind="warning"><strong>Re-check needs attention:</strong> {v.reviewNote}</Alert>}
      {proposing && (
        <div className="action-bar">
          <div><strong>Proposing a change for {v.name}.</strong> <span className="muted">Edit fields on any tab and attach documents on the Documents tab · {proposedChanges.length} field{proposedChanges.length === 1 ? '' : 's'} changed{myStaged.length ? ` · ${myStaged.length} document${myStaged.length === 1 ? '' : 's'}` : ''}</span></div>
          <div className="btn-row">
            <button className="btn btn-ghost" onClick={discardProposal}>Discard</button>
            <button className="btn btn-primary" disabled={!proposedChanges.length && !myStaged.length} onClick={() => setProposeOpen(true)}>Review & submit</button>
          </div>
        </div>
      )}
      {myCr && (
        <div className="action-bar">
          <div><strong>A change request needs your review.</strong> <span className="muted">{myCr.steps.find((s) => s.status === 'PENDING')?.label} · {myCr.changes.length} field{myCr.changes.length === 1 ? '' : 's'}{myCr.documentIds.length ? `, ${myCr.documentIds.length} document(s)` : ''} · {fmtDateTime(myCr.createdAt)}</span></div>
          <div className="btn-row"><button className="btn btn-primary" onClick={() => setTab('changes')}>Review change</button></div>
        </div>
      )}

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
          <TabStrip>
            {tabs.map((t) => <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>{t.label}</button>)}
          </TabStrip>
          <div className="pad">
            {config.sections.filter((s) => s.key === tab).map((s) => <DynamicSection key={s.key} section={s} profile={draft ?? shownProfile} vendorType={v.vendorType} readOnly={!proposing} errors={propErrors} extra={revealExtra(s.key)}
              onChange={(f, val) => setDraft((p) => p && ({ ...p, [s.key]: { ...(p[s.key] ?? {}), [f]: val } }))} />)}
            {tab === 'documents' && <DocumentsPanel requirements={d.docRequirements} documents={v.documents} showHistory editable={proposing} onUpload={stageUpload} onDelete={unstage}
              canDelete={(x) => x.status === 'PENDING' && !x.changeRequestId && x.uploadedById === d.me} uploadLabel="Attach replacement" />}
            {tab === 'changes' && d.changeRequests.map((cr) => (
              <div key={cr.id} className={`cr-card ${cr.status === 'PENDING' ? 'cr-open' : ''}`}>
                <div className="row-between">
                  <div><CrBadge status={cr.status} /> <span className="muted small">{cr.raisedBy ? `proposed by ${cr.raisedBy.id === d.me ? 'you' : cr.raisedBy.name}` : 'requested by the vendor'} · {fmtDateTime(cr.createdAt)}{cr.decidedAt ? ` · decided ${fmtDateTime(cr.decidedAt)}` : ''}</span></div>
                  {cr.canWithdraw && <button className="btn btn-ghost btn-sm" onClick={async () => { try { await api(`/staff/change-requests/${cr.id}/cancel`, { method: 'POST' }); setFlash({ kind: 'success', text: 'Proposal withdrawn.' }); load(); } catch (e: any) { setFlash({ kind: 'error', text: e.message }); } }}>Withdraw</button>}
                  {cr.canAct && <div className="btn-row">
                    <button className="btn btn-danger-ghost btn-sm" onClick={() => setCrAction({ cr, action: 'REJECT' })}>Reject</button>
                    <button className="btn btn-primary btn-sm" onClick={() => setCrAction({ cr, action: 'APPROVE' })}>Approve</button></div>}
                </div>
                {cr.sensitive && cr.status === 'PENDING' && <Alert kind="warning">Includes sensitive fields. For bank changes, confirm the account holder name on the bank check under Verifications and, if in doubt, call the vendor on their registered number before approving.</Alert>}
                {cr.note && <p className="small">{cr.raisedBy ? 'Reason' : 'Vendor’s note'}: “{cr.note}”</p>}
                {cr.status === 'PENDING' && cr.raisedBy?.id === d.me && <p className="small muted">You proposed this change, so another approver has to decide each step. An approvals manager can reassign a step if you’re the only one in that role.</p>}
                <ChangeDiff changes={cr.changes} onReveal={(fid) => reveal(fid, cr.id)} />
                {cr.documentIds.length > 0 && (
                  <div className="small"><strong>New documents:</strong> {cr.documentIds.map((did) => { const doc = v.documents.find((x) => x.id === did); return doc ? <a key={did} className="cr-doc" href={docUrl(did)} target="_blank" rel="noreferrer">{d.docRequirements.find((r) => r.type === doc.docType)?.label ?? doc.docType} ({doc.fileName})</a> : null; })}</div>
                )}
                <div className="row-between"><h4 className="small">Approvals</h4>{cr.canReassign && <button className="link-btn small" onClick={() => setCrReassign(cr)}>Reassign</button>}</div>
                <ApprovalTimeline steps={cr.steps.map((s) => ({ ...s, cycle: 1 }))} />
                {cr.remarks && cr.status !== 'PENDING' && <p className="small muted">Decision remarks: “{cr.remarks}”</p>}
              </div>
            ))}
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
          {approved && (
            <div className="card pad">
              <h3 className="card-title">Lifecycle</h3>
              <dl className="kv small">
                <dt>Status</dt><dd>{v.blockedAt ? <span className="badge flag-high">Blocked</span> : <span className="badge badge-approved">Active</span>}</dd>
                <dt>Approved</dt><dd>{fmtDate(v.decidedAt)}</dd>
                <dt>Last re-check</dt><dd>{v.lastReviewAt ? <>{fmtDate(v.lastReviewAt)} {v.reviewStatus === 'ATTENTION' ? <span className="badge flag-high sm">attention</span> : <span className="badge step-approved sm">ok</span>}</> : '—'}</dd>
                <dt>Next re-check</dt><dd>{fmtDate(v.nextReviewAt)}</dd>
                <dt>Vendor confirmed</dt><dd>{fmtDate(v.lastConfirmedAt)}</dd>
              </dl>
            </div>
          )}
          {approved && <ErpCard key={`${v.id}-${v.updatedAt}`} vendorId={v.id} onFlash={setFlash} canConfigure={can('tenant.settings')} />}
          {approved && me?.plan?.features.collab && can('orders.view') && <SupplierAccessCard vendorId={v.id} canManage={can('orders.manage')} onFlash={setFlash} />}
          {!d.privacy.erasedAt && (
            <div className="card pad">
              <h3 className="card-title">Privacy</h3>
              <dl className="kv small">
                <dt>Consent</dt><dd>{d.privacy.consentAt ? <>v{d.privacy.consentVersion} on {fmtDate(d.privacy.consentAt)}{d.privacy.consentVersion !== d.privacy.currentVersion && <span className="badge sm flag-medium">old notice</span>}</> : <span className="muted">Not yet given</span>}</dd>
              </dl>
              <div className="link-list">
                {d.privacy.canExport && <a className="link-btn small" href={`/api/staff/vendors/${v.id}/data-export`} download>Download personal data (access request)</a>}
                {d.privacy.canErase && !d.privacy.erasureRequestedAt && <button className="link-btn small danger" onClick={() => setPrivacyAction('erase')}>Erase personal data…</button>}
              </div>
            </div>
          )}
          <div className="card pad"><div className="row-between card-title"><h3>Approval flow</h3>{d.canReassign && <button className="link-btn small" onClick={() => setReassigning(true)}>Reassign</button>}</div><ApprovalTimeline steps={v.steps} levels={config.workflow.levels.map((l) => l.label)} /></div>
          <div className="card pad">
            <h3 className="card-title">Verifications</h3>
            <ChecksPanel checks={d.checks} defs={checkDefs} supplierCountry={String((v.profile as any)?.basic?.supplierCountry ?? '')} busy={checking} onRun={async (k) => {
              setChecking(k);
              try { const r = await api(`/staff/vendors/${v.id}/verify/${k}`, { method: 'POST' }); setFlash({ kind: r.status === 'VERIFIED' ? 'success' : 'error', text: `${checkDefs.find((c) => c.kind === k)?.label ?? k.toUpperCase()}: ${r.message}` }); await load(); }
              catch (e: any) { setFlash({ kind: 'error', text: e.message }); } finally { setChecking(undefined); }
            }} />
            {mismatches > 0 && <p className="small diff-text">⚠ {mismatches} value{mismatches > 1 ? 's' : ''} on uploaded documents differ from the form — see the Documents tab.</p>}
          </div>
          {v.status !== 'INVITED' && <div className="card pad"><Checklist items={d.checklist} sections={config.sections} onJump={setTab} /></div>}
          {v.inviteLink && ['INVITED', 'IN_PROGRESS', 'SENT_BACK', 'APPROVED'].includes(v.status) && (
            <div className="card pad"><h3 className="card-title">Vendor portal link <span className="tag-dev">dev</span></h3><p className="small muted">Shown only in development. Open it in another tab (or a private window) to act as the vendor{v.status === 'APPROVED' ? ' — e.g. to request a change' : ''}.</p><a className="small break" href={new URL(v.inviteLink).pathname} target="_blank" rel="noreferrer">{v.inviteLink}</a></div>
          )}
        </aside>
      </div>

      {contactOpen && <ContactModal vendorId={v.id} current={v.contactEmail} onClose={() => setContactOpen(false)} onDone={(m) => { setContactOpen(false); setFlash({ kind: 'success', text: m }); load(); }} />}
      {privacyAction && <PrivacyModal mode={privacyAction} vendor={v} onClose={() => setPrivacyAction(undefined)} onDone={(m) => { setPrivacyAction(undefined); setFlash({ kind: 'success', text: m }); load(); }} />}
      {blockMode && <BlockModal mode={blockMode} vendorId={v.id} onClose={() => setBlockMode(undefined)} onDone={(m) => { setBlockMode(undefined); setFlash({ kind: 'success', text: m }); load(); }} />}
      {proposeOpen && <ProposeModal changes={proposedChanges} docCount={myStaged.length} onClose={() => setProposeOpen(false)} onSubmit={submitProposal} />}
      {crAction && <CrDecisionModal {...crAction} onClose={() => setCrAction(undefined)} onDone={(m) => { setCrAction(undefined); setFlash({ kind: 'success', text: m }); load(); }} />}
      {crReassign && <ReassignModal listUrl={`/staff/change-requests/${crReassign.id}/assignable`} assignUrl={`/staff/change-requests/${crReassign.id}/steps/${crReassign.steps.find((s) => s.status === 'PENDING')!.id}/assign`}
        step={crReassign.steps.find((s) => s.status === 'PENDING')!} onClose={() => setCrReassign(undefined)} onDone={(m) => { setCrReassign(undefined); setFlash({ kind: 'success', text: m }); load(); }} />}
      {reassigning && <ReassignModal listUrl={`/staff/vendors/${v.id}/assignable`} assignUrl={`/staff/vendors/${v.id}/steps/${v.steps.find((s) => s.status === 'PENDING')!.id}/assign`} step={v.steps.find((s) => s.status === 'PENDING')!} onClose={() => setReassigning(false)} onDone={(m) => { setReassigning(false); setFlash({ kind: 'success', text: m }); load(); }} />}
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

function ReassignModal({ listUrl, assignUrl, step, onClose, onDone }: { listUrl: string; assignUrl: string; step: Step; onClose: () => void; onDone: (msg: string) => void }) {
  const [people, setPeople] = useState<{ id: string; name: string; email: string; holdsRole: boolean }[]>();
  const [choice, setChoice] = useState<string>(step.assigneeName ? '' : '__role');
  const [error, setError] = useState<string>();
  useEffect(() => { api(listUrl).then(setPeople).catch((e) => setError(e.message)); }, [listUrl]);
  async function save() {
    try {
      const r = await api(assignUrl, { body: { userId: choice === '__role' ? null : choice } });
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

function ContactModal({ vendorId, current, onClose, onDone }: { vendorId: string; current: string; onClose: () => void; onDone: (msg: string) => void }) {
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError(undefined);
    try { await api(`/staff/vendors/${vendorId}/contact`, { body: { email, reason } }); onDone(`Contact email changed to ${email}. ${current} was told about the change.`); }
    catch (e: any) { setError(e.message); setBusy(false); }
  }
  return (
    <Modal title="Change contact email" onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !email || reason.trim().length < 3} onClick={submit}>{busy ? 'Saving…' : 'Change'}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <p className="small muted">Sign-in codes and all emails go to this address. The current address (<strong>{current}</strong>) gets a security notice. Only change it on the supplier’s confirmed instructions.</p>
      <div className="field"><label htmlFor="ct-email">New contact email</label><input id="ct-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></div>
      <div className="field"><label htmlFor="ct-reason">Reason and source<span className="req"> *</span></label><input id="ct-reason" value={reason} maxLength={300} placeholder="e.g. old address bounced; new one confirmed by phone on 14 Oct" onChange={(e) => setReason(e.target.value)} /></div>
    </Modal>
  );
}

function BlockModal({ mode, vendorId, onClose, onDone }: { mode: 'block' | 'unblock'; vendorId: string; onClose: () => void; onDone: (msg: string) => void }) {
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(mode === 'unblock');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!reason.trim()) { setError('Give a reason — it is kept in the audit trail.'); return; }
    setBusy(true);
    try { await api(`/staff/vendors/${vendorId}/${mode}`, { body: { reason, notifyVendor: notify } }); onDone(mode === 'block' ? 'Vendor blocked. The ERP export now carries payment and PO holds.' : 'Vendor unblocked.'); }
    catch (e: any) { setError(e.message); setBusy(false); }
  }
  return (
    <Modal title={mode === 'block' ? 'Block vendor' : 'Unblock vendor'} onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className={`btn ${mode === 'block' ? 'btn-danger' : 'btn-primary'}`} disabled={busy} onClick={submit}>{busy ? 'Saving…' : mode === 'block' ? 'Block' : 'Unblock'}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      {mode === 'block' && <p className="small muted">Blocking puts payments and new purchase orders on hold (HOLD flags in the ERP export) and stops the vendor requesting changes. Their portal access stays so they can see the notice.</p>}
      <div className="field"><label htmlFor="block-reason">Reason<span className="req"> *</span></label>
        <textarea id="block-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></div>
      <label className="check-item"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /><span>Email the vendor{mode === 'block' ? ' (the reason is not included)' : ''}</span></label>
    </Modal>
  );
}

function CrDecisionModal({ cr, action, onClose, onDone }: { cr: ChangeRequest; action: 'APPROVE' | 'REJECT'; onClose: () => void; onDone: (msg: string) => void }) {
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true); setError(undefined);
    try {
      const r = await api(`/staff/change-requests/${cr.id}/decision`, { body: { action, remarks } });
      onDone(r.status === 'APPROVED' ? 'Change approved and applied to the vendor record.' : r.nextLevel ? `Approved. Moved to ${r.nextLevel}.` : 'Change request rejected. The vendor has been told why.');
    } catch (e: any) { setError(e.message); setBusy(false); }
  }
  return (
    <Modal title={action === 'APPROVE' ? 'Approve change' : 'Reject change'} wide onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className={`btn ${action === 'APPROVE' ? 'btn-primary' : 'btn-danger'}`} disabled={busy} onClick={submit}>{busy ? 'Saving…' : action === 'APPROVE' ? 'Approve' : 'Reject'}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <ChangeDiff changes={cr.changes} docCount={cr.documentIds.length} />
      <div className="field"><label htmlFor="cr-remarks">Remarks{action === 'REJECT' && <span className="req"> *</span>}</label>
        <textarea id="cr-remarks" rows={3} value={remarks} onChange={(e) => setRemarks(e.target.value)} autoFocus />
        <div className="field-help">{action === 'REJECT' ? 'The vendor sees this reason. Their current details stay in effect.' : 'Optional.'}</div></div>
    </Modal>
  );
}

function ProposeModal({ changes, docCount, onClose, onSubmit }: { changes: ChangeRequest['changes']; docCount: number; onClose: () => void; onSubmit: (note: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function go() {
    if (!note.trim()) { setError('Give the reason and the source, e.g. “Vendor emailed a new cancelled cheque on 3 Oct”.'); return; }
    setBusy(true); await onSubmit(note); setBusy(false);
  }
  return (
    <Modal title="Submit proposed change?" wide onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Keep editing</button><button className="btn btn-primary" disabled={busy} onClick={go}>{busy ? 'Submitting…' : 'Send for approval'}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <ChangeDiff changes={changes} docCount={docCount} />
      <div className="field"><label htmlFor="prop-note">Reason and source<span className="req"> *</span></label>
        <textarea id="prop-note" rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} autoFocus placeholder="e.g. Vendor emailed a new cancelled cheque on 3 Oct (ticket #1234)" />
        <div className="field-help">Kept in the audit trail and shown to approvers. The vendor’s contact is emailed that their details are being updated; bank changes also get a penny-drop check.</div></div>
    </Modal>
  );
}

function PrivacyModal({ mode, vendor, onClose, onDone }: { mode: 'erase' | 'decline'; vendor: VendorFull; onClose: () => void; onDone: (msg: string) => void }) {
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true); setError(undefined);
    try {
      if (mode === 'erase') { await api(`/staff/vendors/${vendor.id}/erase`, { body: { reason, confirm } }); onDone('Personal data erased.'); }
      else { await api(`/staff/vendors/${vendor.id}/erasure-request/decline`, { body: { reason } }); onDone('Request declined. The vendor has been emailed the reason.'); }
    } catch (e: any) { setError(e.message); setBusy(false); }
  }
  const erase = mode === 'erase';
  return (
    <Modal title={erase ? `Erase personal data — ${vendor.name}` : 'Decline the deletion request'} onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className={`btn ${erase ? 'btn-danger' : 'btn-primary'}`} disabled={busy || (erase && confirm.trim().toUpperCase() !== vendor.code)} onClick={go}>{busy ? 'Working…' : erase ? 'Erase permanently' : 'Decline'}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      {erase ? (
        <>
          <Alert kind="warning">This permanently removes the name, contacts, profile, bank and tax details, documents, verification results and emails. It cannot be undone. Dates, status and the audit trail (without personal details) are kept.</Alert>
          {vendor.status === 'APPROVED' && <p className="small">Approved suppliers must be <strong>blocked</strong> first, and tax law usually requires keeping supplier records for about 8 years — check with finance.</p>}
          <div className="field"><label htmlFor="pv-reason">Reason<span className="req"> *</span></label><textarea id="pv-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Vendor’s deletion request of 5 Oct" /></div>
          <div className="field"><label htmlFor="pv-confirm">Type <strong className="mono">{vendor.code}</strong> to confirm</label><input id="pv-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" /></div>
        </>
      ) : (
        <div className="field"><label htmlFor="pv-reason">Reason (sent to the vendor)<span className="req"> *</span></label><textarea id="pv-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. You are an active supplier; invoices and payment records must be kept for 8 years under the GST and Income-tax Acts." /></div>
      )}
    </Modal>
  );
}
