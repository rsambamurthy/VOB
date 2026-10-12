import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { applyBranding } from '../lib/session';
import { monogram } from '../lib/format';
import { DynamicSection } from '../components/DynamicSection';
import { DocumentsPanel } from '../components/DocumentsPanel';
import { Checklist } from '../components/Checklist';
import { ApprovalTimeline } from '../components/Timeline';
import { Alert, Modal, StatusBadge } from '../components/ui';
import type { Branding, ChangeRequest, Check, ChecklistItem, DocRequirement, Extraction, FieldDef, Flag, Profile, SectionDef, VendorFull } from '../lib/types';
import { ChangeDiff, CrHistory, diffProfiles, FlagBadges } from '../components/Lifecycle';
import { fmtDate } from '../lib/format';
import { CheckBadge } from '../components/Checks';
import { ExtractionCard } from '../components/ExtractionCard';
import { useHelp, useHelpExtra } from '../help/HelpPanel';

type Me = { config: { sections: SectionDef[]; guide: { title: string; body: string }[]; levels: string[] }; vendor: VendorFull; checklist: ChecklistItem[]; docRequirements: DocRequirement[]; editable: boolean; sendBackRemarks?: string; buyer: { name: string; branding: Branding }; checks: Check[]; extractions: Extraction[]; lifecycle: Lifecycle | null; privacy: Privacy };
type Privacy = { version: number; text: string; contactEmail: string | null; needsConsent: boolean; consentAt: string | null; consentVersion: number | null; erasureRequestedAt: string | null };
type Lifecycle = { blocked: boolean; flags: Flag[]; lastConfirmedAt: string | null; nextReviewAt: string | null; changeRequests: ChangeRequest[] };



/** Fields that get an online "Verify" button: field key -> [check kind, fields to send]. */
const VERIFY: Record<string, { kind: string; label: string; from: (p: Profile) => Record<string, string> }> = {
  gstin: { kind: 'gstin', label: 'Verify', from: (p) => ({ gstin: String(p.tax?.gstin ?? '') }) },
  pan: { kind: 'pan', label: 'Verify', from: (p) => ({ pan: String(p.tax?.pan ?? '') }) },
  cin: { kind: 'cin', label: 'Verify', from: (p) => ({ cin: String(p.tax?.cin ?? '') }) },
  ifsc: { kind: 'bank', label: 'Verify account', from: (p) => ({ accountNumber: String(p.bank?.accountNumber ?? ''), ifsc: String(p.bank?.ifsc ?? ''), accountHolderName: String(p.bank?.accountHolderName ?? '') }) },
};

export function VendorPortal() {
  const nav = useNavigate();
  const [me, setMe] = useState<Me>();
  const [profile, setProfile] = useState<Profile>({});
  const [tab, setTab] = useState('basic');
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [flash, setFlash] = useState<{ kind: 'success' | 'error' | 'info'; text: string }>();
  const [saving, setSaving] = useState(false);
  const { openHelp } = useHelp();
  // The buyer's own "How onboarding works" steps become the first help topic for suppliers.
  useHelpExtra(me ? [{ id: 'buyer-guide', title: `How onboarding works at ${me.buyer.name}`, summary: 'The steps your buyer has set out for registering as a supplier.', audience: ['supplier'], screens: ['^/vendor'],
    keywords: 'guide steps how onboarding works instructions', body: me.config.guide.map((g) => `## ${g.title}\n${g.body.replace(/\s*\n\s*/g, ' ')}`).join('\n\n') }] : null);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  // Approved vendors: edits are collected locally and sent as one change request.
  const [changeMode, setChangeMode] = useState(false);
  const [crOpen, setCrOpen] = useState(false);
  const [crNote, setCrNote] = useState('');
  const [crErrors, setCrErrors] = useState<Record<string, string>>({});
  const [crBusy, setCrBusy] = useState(false);
  const [showNotice, setShowNotice] = useState(false);
  const [erasureOpen, setErasureOpen] = useState(false);

  const load = useCallback(async (reset = false) => {
    try {
      const r = await api<Me>('/vendor');
      setMe(r); setProfile((p) => (!reset && Object.keys(p).length && dirtyRef.current.size ? p : r.vendor.profile)); applyBranding(r.buyer.branding);
    } catch (e) { if (e instanceof ApiError && e.status === 401) nav('/vendor/expired'); }
  }, [nav]);
  useEffect(() => { load(); }, [load]);
  const pending = me?.extractions.some((e) => e.status === 'PENDING');
  useEffect(() => { if (!pending) return; const t = setInterval(load, 3000); return () => clearInterval(t); }, [pending, load]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty.size) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const errors = useMemo(() => {
    const m: Record<string, string> = { ...crErrors };
    for (const c of me?.checklist ?? []) if (!c.ok && c.message && revealed.has(c.section)) m[c.id.replace(/^cross\./, '')] = c.message;
    return m;
  }, [me, revealed, crErrors]);

  if (!me) return <div className="center-page"><div className="spinner" /></div>;
  const v = me.vendor;
  const cfg = me.config;
  const lc = me.lifecycle;
  const approved = v.status === 'APPROVED' && !!lc;
  const openCr = lc?.changeRequests.find((c) => c.status === 'PENDING');
  const canChange = approved && !lc!.blocked && !openCr;
  const editable = me.editable || (changeMode && canChange);
  const docsEditable = me.editable || canChange;
  const newDocs = v.documents.filter((d) => d.status === 'PENDING' && !d.changeRequestId);
  const fieldChanges = approved ? diffProfiles(cfg.sections, v.profile, profile) : [];
  // Asked to confirm after each periodic re-check, until they do.
  const reviewRequested = approved && !!v.lastReviewAt && (!v.lastConfirmedAt || v.lastConfirmedAt < v.lastReviewAt);
  const docFlags = lc?.flags.filter((f) => f.code === 'DOC_EXPIRED' || f.code === 'DOC_EXPIRING') ?? [];
  const tabs = [...cfg.sections.map((s) => ({ key: s.key, label: s.label })), { key: 'documents', label: 'Documents' }];
  const sectionErrors = (k: string) => me.checklist.filter((c) => c.section === k && !c.ok && c.severity === 'error').length;

  function change(section: string, field: string, value: string) {
    setProfile((p) => ({ ...p, [section]: { ...(p[section] ?? {}), [field]: value } }));
    setDirty((d) => new Set(d).add(section));
  }

  async function save(section = tab, quiet = false) {
    if (!me!.editable || !dirty.has(section) || section === 'documents') { setRevealed((r) => new Set(r).add(section)); return true; }
    setSaving(true);
    try {
      const r = await api<{ checklist: ChecklistItem[]; docRequirements: DocRequirement[] }>(`/vendor/profile/${section}`, { method: 'PUT', body: profile[section] ?? {} });
      setMe((m) => m && { ...m, checklist: r.checklist, docRequirements: r.docRequirements, vendor: { ...m.vendor, profile, status: m.vendor.status === 'INVITED' ? 'IN_PROGRESS' : m.vendor.status } });
      setDirty((d) => { const n = new Set(d); n.delete(section); return n; });
      setRevealed((rv) => new Set(rv).add(section));
      if (!quiet) setFlash({ kind: 'success', text: 'Saved.' });
      return true;
    } catch (e: any) { setFlash({ kind: 'error', text: e.message }); return false; } finally { setSaving(false); }
  }

  async function goTo(next: string) {
    if (next === tab) return;
    await save(tab, true);
    setTab(next); setFlash(undefined);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function upload(docType: string, file: File, expiresOn?: string) {
    const fd = new FormData(); fd.append('docType', docType); if (expiresOn) fd.append('expiresOn', expiresOn); fd.append('file', file);
    try {
      await api('/vendor/documents', { body: fd }); await load(); setRevealed((r) => new Set(r).add('documents'));
      if (approved) setFlash({ kind: 'info', text: 'Uploaded. New documents take effect once you submit a change request and it is approved.' });
    }
    catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }
  async function remove(id: string) {
    try { await api(`/vendor/documents/${id}`, { method: 'DELETE' }); await load(); } catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }
  async function applyExtraction(id: string, fieldIds: string[]) {
    for (const sec of [...dirty]) if (!(await save(sec, true))) return;
    try {
      const r = await api<{ applied: string[]; profile: Profile; checklist: ChecklistItem[] }>(`/vendor/extractions/${id}/apply`, { body: { fieldIds } });
      setProfile(r.profile);
      setFlash({ kind: 'success', text: `${r.applied.length} value${r.applied.length === 1 ? '' : 's'} copied into your form. Please check them before submitting.` });
      await load();
    } catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }

  async function runVerify(f: FieldDef) {
    const cfg = VERIFY[f.key];
    await save(tab, true);
    try {
      const r = await api<Check>(`/vendor/verify/${cfg.kind}`, { body: cfg.from(profile) });
      setMe((m) => m && { ...m, checks: [r, ...m.checks.filter((c) => c.kind !== r.kind)] });
      if (r.status !== 'VERIFIED') setFlash({ kind: r.status === 'ERROR' ? 'error' : 'info', text: `${r.message}` });
    } catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }
  async function submit() {
    setConfirmSubmit(false);
    for (const s of [...dirty]) if (!(await save(s, true))) return;
    try {
      await api('/vendor/submit', { method: 'POST' });
      setFlash({ kind: 'success', text: 'Submitted for review. We’ll email you when there’s an update.' });
      await load();
    } catch (e: any) {
      setRevealed(new Set([...cfg.sections.map((s) => s.key), 'documents']));
      setFlash({ kind: 'error', text: e.message });
      await load();
    }
  }

  function discardChanges() {
    setProfile(v.profile); setDirty(new Set()); setChangeMode(false); setCrErrors({}); setFlash(undefined);
  }
  async function submitChange() {
    setCrBusy(true);
    try {
      const changes = Object.fromEntries([...new Set(fieldChanges.map((c) => c.fieldId.split('.')[0]))].map((sec) => [sec, profile[sec] ?? {}]));
      await api('/vendor/change-requests', { body: { changes, note: crNote || undefined } });
      setCrOpen(false); setCrNote(''); setChangeMode(false); setDirty(new Set()); setCrErrors({});
      setFlash({ kind: 'success', text: 'Change request submitted. Your current details stay in effect until it is approved — we’ll email you the outcome.' });
      await load(true);
    } catch (e: any) {
      if (e instanceof ApiError && Array.isArray(e.details)) {
        setCrErrors(Object.fromEntries((e.details as ChecklistItem[]).filter((c) => c.message).map((c) => [c.id.replace(/^cross\./, ''), c.message!])));
        setChangeMode(true);
      }
      setCrOpen(false); setFlash({ kind: 'error', text: e.message });
    } finally { setCrBusy(false); }
  }
  async function cancelCr(id: string) {
    try { await api(`/vendor/change-requests/${id}/cancel`, { method: 'POST' }); setFlash({ kind: 'info', text: 'Change request withdrawn.' }); await load(true); }
    catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }
  async function confirmDetails() {
    try { await api('/vendor/confirm-details', { method: 'POST' }); setFlash({ kind: 'success', text: 'Thanks — your details are confirmed as current.' }); await load(); }
    catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }

  const blocking = me.checklist.filter((c) => !c.ok && c.severity === 'error').length;
  const extra = (f: FieldDef) => {
    const cfg = editable ? VERIFY[f.key] : undefined;
    if (!cfg) return null;
    const r = me?.checks.find((c) => c.kind === cfg.kind);
    return (
      <span className="verify">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => runVerify(f)}>{cfg.label}</button>
        {r && <CheckBadge c={r} compact />}
      </span>
    );
  };

  return (
    <div className="vendor-app">
      <header className="topbar">
        <div className="brand">
          {me.buyer.branding.logoUrl ? <img src={me.buyer.branding.logoUrl} alt="" className="brand-logo" /> : <span className="brand-mark">{monogram(me.buyer.branding.productName)}</span>}
          <span>{me.buyer.name}</span><span className="muted small hide-sm">· Supplier portal</span>
        </div>
        <div className="topbar-right">
          <span className="hide-sm">{v.name}</span><StatusBadge status={v.status} />
          <button className="btn btn-ghost btn-sm" onClick={() => openHelp()} title="Help (F1)">Help</button>
          <button className="btn btn-ghost btn-sm" onClick={async () => { await api('/vendor-auth/logout', { method: 'POST' }).catch(() => {}); nav('/vendor/expired'); }}>Sign out</button>
        </div>
      </header>

      <div className="page">
        <header className="page-head">
          <div><h1>{approved ? 'Registered details' : 'Business profile'}</h1>
            <p className="muted">Vendor code <span className="mono">{v.code}</span>. {approved ? 'To update anything, request a change — it takes effect once approved.' : 'Complete each tab, upload documents, then submit for review.'}</p></div>
          {approved && !changeMode && <div className="head-actions"><button className="btn btn-secondary" disabled={!canChange} title={!canChange ? (lc!.blocked ? 'Your account is on hold' : 'A change request is already under review') : undefined} onClick={() => { setChangeMode(true); setFlash(undefined); }}>Request changes</button></div>}
        </header>

        {v.status === 'SENT_BACK' && <Alert kind="warning"><strong>Changes requested:</strong> “{me.sendBackRemarks}”. Update the form and submit again.</Alert>}
        {v.status === 'UNDER_REVIEW' && <Alert kind="info">Submitted — your registration is being reviewed. Editing is locked until a decision is made.</Alert>}
        {approved && lc!.blocked && <Alert kind="error"><strong>Your vendor account is on hold.</strong> Please contact {me.buyer.name} for details. Changes can’t be requested while on hold.</Alert>}
        {approved && openCr && (
          <Alert kind="info"><strong>{openCr.byBuyer ? `${me.buyer.name} is updating your details` : 'Change request under review'}</strong> ({openCr.steps.filter((s) => s.status === 'PENDING' || s.status === 'WAITING').map((s) => s.label).join(' → ') || 'review'}). Your current details stay in effect until it’s approved.{' '}
            {!openCr.byBuyer && <button className="link-btn" onClick={() => cancelCr(openCr.id)}>Withdraw request</button>}</Alert>
        )}
        {approved && reviewRequested && !changeMode && (
          <Alert kind="warning"><strong>Periodic review:</strong> please check that your registered details are still correct.{' '}
            <button className="btn btn-primary btn-sm" onClick={confirmDetails}>Yes, they’re correct</button>{' '}
            {canChange && <button className="btn btn-ghost btn-sm" onClick={() => setChangeMode(true)}>Something changed</button>}</Alert>
        )}
        {approved && docFlags.length > 0 && <Alert kind="warning"><strong>{docFlags.map((f) => f.label).join(' · ')}.</strong> Upload renewed documents on the <button className="link-btn" onClick={() => goTo('documents')}>Documents</button> tab and submit them as a change request.</Alert>}
        {approved && changeMode && <Alert kind="info"><strong>Editing</strong> — change the values you need to update, then submit the request for review. Bank details changes are verified and we’ll email your registered contact as a precaution.</Alert>}
        {approved && !changeMode && !lc!.flags.length && !reviewRequested && <Alert kind="success">You’re approved and active as a vendor. 🎉</Alert>}
        {v.status === 'REJECTED' && <Alert kind="error">This registration was not approved. Check your email for the reason.</Alert>}
        {flash && <Alert kind={flash.kind}>{flash.text}</Alert>}
        {editable && tab !== 'documents' && me.extractions.some((e) => e.status === 'DONE' && !e.appliedAt && e.suggestions.some((x) => x.state !== 'match')) && (
          <Alert kind="info">✦ We read details from your uploaded documents. <button className="link-btn" onClick={() => goTo('documents')}>Review suggested values →</button></Alert>
        )}

        <div className="detail-grid">
          <div className="card">
            <div className="tabs" role="tablist">
              {tabs.map((t) => {
                const n = sectionErrors(t.key);
                return <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'active' : ''} onClick={() => goTo(t.key)}>
                  {t.label}{editable && revealed.has(t.key) && n > 0 && <span className="tab-count">{n}</span>}{dirty.has(t.key) && <span className="dirty" title="Unsaved changes">•</span>}
                </button>;
              })}
            </div>
            <div className="pad">
              {cfg.sections.filter((s) => s.key === tab).map((s) => (
                <DynamicSection key={s.key} section={s} profile={profile} vendorType={v.vendorType} errors={errors} readOnly={!editable} onChange={(f, val) => change(s.key, f, val)} extra={extra} />
              ))}
              {tab === 'documents' && <DocumentsPanel requirements={me.docRequirements} documents={v.documents} editable={docsEditable} onUpload={upload} onDelete={remove}
                canDelete={approved ? (d) => d.status === 'PENDING' && !d.changeRequestId : undefined} uploadLabel={approved ? 'Upload renewal' : undefined} />}
              {tab === 'documents' && me.editable && me.extractions.filter((e) => e.status !== 'SKIPPED' && v.documents.some((d) => d.id === e.documentId)).map((e) => {
                const doc = v.documents.find((d) => d.id === e.documentId)!;
                const label = me.docRequirements.find((r) => r.type === doc.docType)?.label ?? doc.docType;
                return <ExtractionCard key={e.id} ex={e} docLabel={label} onApply={(ids) => applyExtraction(e.id, ids)} />;
              })}
            </div>
            {approved && (changeMode || newDocs.length > 0) && (
              <div className="form-foot">
                {changeMode && <button className="btn btn-ghost" onClick={discardChanges}>Discard changes</button>}
                <span className="muted small grow">{fieldChanges.length} field{fieldChanges.length === 1 ? '' : 's'} changed{newDocs.length ? ` · ${newDocs.length} new document${newDocs.length === 1 ? '' : 's'}` : ''}</span>
                <button className="btn btn-primary" disabled={!fieldChanges.length && !newDocs.length} onClick={() => setCrOpen(true)}>Review & submit change</button>
              </div>
            )}
            {me.editable && (
              <div className="form-foot">
                <button className="btn btn-ghost" disabled={saving || !dirty.has(tab)} onClick={() => save()}>{saving ? 'Saving…' : 'Save'}</button>
                {tabs.findIndex((t) => t.key === tab) < tabs.length - 1
                  ? <button className="btn btn-primary" onClick={() => goTo(tabs[tabs.findIndex((t) => t.key === tab) + 1].key)}>Save & next →</button>
                  : <button className="btn btn-primary" onClick={() => setConfirmSubmit(true)}>Review & submit</button>}
              </div>
            )}
          </div>
          <aside className="side-col">
            {approved ? (
              <>
                <div className="card pad">
                  <h3 className="card-title">Your account</h3>
                  <dl className="kv small">
                    <dt>Status</dt><dd>{lc!.blocked ? <span className="badge flag-high">On hold</span> : <span className="badge badge-approved">Active</span>}</dd>
                    <dt>Last confirmed</dt><dd>{fmtDate(v.lastConfirmedAt ?? v.decidedAt)}</dd>
                    <dt>Next review</dt><dd>{fmtDate(lc!.nextReviewAt)}</dd>
                  </dl>
                  <FlagBadges flags={lc!.flags.filter((f) => f.code !== 'BLOCKED')} />
                  {!reviewRequested && <button className="link-btn small" onClick={confirmDetails}>Confirm my details are current</button>}
                </div>
                <div className="card pad"><h3 className="card-title">Change requests</h3><CrHistory items={lc!.changeRequests} onCancel={cancelCr} /></div>
              </>
            ) : me.editable ? (
              <div className="card pad">
                <Checklist items={me.checklist} sections={cfg.sections} onJump={(s) => { setRevealed((r) => new Set(r).add(s)); goTo(s); }} />
                <button className="btn btn-primary btn-block" onClick={() => setConfirmSubmit(true)} disabled={saving}>Submit for review</button>
                {blocking > 0 && <p className="small muted center">You can submit once all required items are done.</p>}
              </div>
            ) : (
              <div className="card pad"><h3 className="card-title">Approval progress</h3><ApprovalTimeline steps={v.steps} levels={cfg.levels} /></div>
            )}
            <div className="card pad">
              <h3 className="card-title">Your data</h3>
              <p className="small muted">{me.privacy.consentAt ? <>You accepted the privacy notice on {fmtDate(me.privacy.consentAt)}.</> : 'Privacy notice not yet accepted.'}</p>
              <div className="link-list">
                <button className="link-btn small" onClick={() => setShowNotice(true)}>Read the privacy notice</button>
                <a className="link-btn small" href="/api/vendor/my-data" download>Download my data</a>
                {me.privacy.erasureRequestedAt
                  ? <span className="small muted">Deletion requested on {fmtDate(me.privacy.erasureRequestedAt)} — we’ll email you.</span>
                  : <button className="link-btn small danger" onClick={() => setErasureOpen(true)}>Withdraw consent & request deletion</button>}
              </div>
            </div>
            <div className="card pad">
              <h3 className="card-title">How onboarding works</h3>
              <ol className="guide-mini">{cfg.guide.map((g) => <li key={g.title}>{g.title.replace(/^Step \d+: /, '')}</li>)}</ol>
              <button className="link-btn small" onClick={() => openHelp('buyer-guide')}>Read the full guide</button>
            </div>
          </aside>
        </div>
      </div>

      {me.privacy.needsConsent && <ConsentModal buyer={me.buyer.name} privacy={me.privacy} onDone={() => load()} />}
      {showNotice && <Modal title={`Privacy notice — ${me.buyer.name}`} wide onClose={() => setShowNotice(false)}><div className="notice-text">{me.privacy.text}</div></Modal>}
      {erasureOpen && <ErasureModal onClose={() => setErasureOpen(false)} onDone={() => { setErasureOpen(false); setFlash({ kind: 'info', text: 'Your deletion request has been sent. We’ll email you when it has been handled.' }); load(); }} />}
      {crOpen && (
        <Modal title="Submit change request?" wide onClose={() => setCrOpen(false)}
          footer={<><button className="btn btn-ghost" onClick={() => setCrOpen(false)}>Keep editing</button><button className="btn btn-primary" disabled={crBusy} onClick={submitChange}>{crBusy ? 'Submitting…' : 'Submit for review'}</button></>}>
          <ChangeDiff changes={fieldChanges} docCount={newDocs.length} />
          <label className="field"><span>Reason for the change (optional)</span>
            <textarea className="input" rows={2} maxLength={1000} value={crNote} onChange={(e) => setCrNote(e.target.value)} placeholder="e.g. We moved our account to a new bank" /></label>
          <p className="small muted">Your current details stay in effect until the change is approved.</p>
        </Modal>
      )}
      {confirmSubmit && (
        <Modal title="Submit for review?" onClose={() => setConfirmSubmit(false)}
          footer={<><button className="btn btn-ghost" onClick={() => setConfirmSubmit(false)}>Keep editing</button><button className="btn btn-primary" disabled={blocking > 0 && dirty.size === 0} onClick={submit}>Submit</button></>}>
          {blocking > 0
            ? <Alert kind="warning">{blocking} required item(s) still need attention — see the checklist. {dirty.size > 0 && 'You have unsaved changes; submitting will save them and re-check.'}</Alert>
            : <p>Your details will be reviewed by: <strong>{cfg.levels.join(' → ')}</strong>. You won’t be able to edit while it’s under review.</p>}
        </Modal>
      )}
    </div>
  );
}

export function VendorSignedOut() {
  return (
    <div className="center-page login-bg"><div className="card pad login-card">
      <h2>You’re signed out</h2>
      <p className="muted">To continue your registration, open the invitation link from your email again. You’ll get a new one-time code.</p>
    </div></div>
  );
}

/** DPDP: shown before anything is collected and whenever the notice changes. Cannot be dismissed. */
function ConsentModal({ buyer, privacy, onDone }: { buyer: string; privacy: Privacy; onDone: () => void }) {
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function accept() {
    setBusy(true);
    try { await api('/vendor/consent', { body: { version: privacy.version } }); onDone(); }
    catch (e: any) { setError(e.message); setBusy(false); }
  }
  return (
    <div className="modal-backdrop">
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label="Privacy notice">
        <div className="modal-head"><h3>{privacy.consentVersion ? 'Our privacy notice has changed' : `Before you start: how ${buyer} uses your data`}</h3></div>
        <div className="modal-body">
          {error && <Alert kind="error">{error}</Alert>}
          <div className="notice-text notice-scroll">{privacy.text}</div>
          <label className="check-item"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>I have read the privacy notice and agree to {buyer} processing this information for supplier registration, payments and legal compliance.</span></label>
        </div>
        <div className="modal-foot">
          <a className="btn btn-ghost" href="/api/vendor-auth/logout" onClick={async (e) => { e.preventDefault(); await api('/vendor-auth/logout', { method: 'POST' }).catch(() => {}); window.location.href = '/vendor/expired'; }}>Not now</a>
          <button className="btn btn-primary" disabled={!agree || busy} onClick={accept}>{busy ? 'Saving…' : 'Accept and continue'}</button>
        </div>
      </div>
    </div>
  );
}

function ErasureModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  async function send() {
    try { await api('/vendor/erasure-request', { body: { reason } }); onDone(); } catch (e: any) { setError(e.message); }
  }
  return (
    <Modal title="Withdraw consent and request deletion" onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-danger" onClick={send}>Send request</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <p>We will delete the personal data held for your registration. If you are an active supplier, some records (for example, those needed for tax and payments) may have to be kept for the period the law requires; we will tell you if so.</p>
      <p className="small muted">Tip: download your data first if you want a copy.</p>
      <div className="field"><label htmlFor="er-reason">Reason (optional)</label><textarea id="er-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
    </Modal>
  );
}
