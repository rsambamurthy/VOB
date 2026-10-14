import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
import { fmtDate, setLocaleInfo, type LocaleInfo } from '../lib/format';
import { CheckBadge } from '../components/Checks';
import { ExtractionCard } from '../components/ExtractionCard';
import { useHelp, useHelpExtra } from '../help/HelpPanel';
import { rememberWorkspace, saveLanguage, SupplierFrame, supplierSignOut } from '../orders/SupplierShell';
import { PoweredBy } from '../components/Brand';
import { setLang, t, useLang, type Lang } from '../i18n';
import { Rich } from '../i18n/Rich';
import { TabStrip } from '../components/TabStrip';

type Me = { config: { sections: SectionDef[]; guide: { title: string; body: string }[]; levels: string[] }; vendor: VendorFull; checklist: ChecklistItem[]; docRequirements: DocRequirement[]; editable: boolean; sendBackRemarks?: string; buyer: { name: string; branding: Branding; workspace?: string; languages?: Lang[] } & Partial<LocaleInfo>; language?: Lang; verifiable: Verifiable[]; orders: { enabled: boolean; pending: number }; signedInAs?: string; checks: Check[]; extractions: Extraction[]; lifecycle: Lifecycle | null; privacy: Privacy };
type Privacy = { version: number; text: string; contactEmail: string | null; needsConsent: boolean; consentAt: string | null; consentVersion: number | null; erasureRequestedAt: string | null };
type Lifecycle = { blocked: boolean; hold: { reason: string | null } | null; flags: Flag[]; lastConfirmedAt: string | null; nextReviewAt: string | null; changeRequests: ChangeRequest[] };



/** An online check from the country packs: which field gets the "Verify" button and which fields it sends. */
interface Verifiable { kind: string; label: string; anchor: string; buttonLabel: string; inputs: Record<string, string>; home: boolean; country: string; resultLabels: { ok: string; fail: string } | null }
const inputsFrom = (c: Verifiable, p: Profile) => Object.fromEntries(Object.entries(c.inputs).map(([k, id]) => { const [sec, f] = id.split('.'); return [k, String(p[sec]?.[f] ?? '')]; }));

export function VendorPortal() {
  const nav = useNavigate();
  const lang = useLang();
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
  useHelpExtra(me ? [{ id: 'buyer-guide', title: t('portal.guideTopicTitle', { buyer: me.buyer.name }), summary: t('portal.guideTopicSummary'), audience: ['supplier'], screens: ['^/vendor'],
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
      setMe(r); setLocaleInfo(r.buyer); setLang(r.language ?? 'en'); rememberWorkspace(r.buyer.workspace); setProfile((p) => (!reset && Object.keys(p).length && dirtyRef.current.size ? p : r.vendor.profile)); applyBranding(r.buyer.branding);
    } catch (e) { if (e instanceof ApiError && e.status === 401) nav('/vendor/expired'); }
  }, [nav]);
  useEffect(() => { load(); }, [load, lang]);
  const pending = me?.extractions.some((e) => e.status === 'PENDING');
  useEffect(() => { if (!pending) return; const iv = setInterval(load, 3000); return () => clearInterval(iv); }, [pending, load]);

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
  // On hold because a document lapsed: the supplier can still send the renewal.
  const canChange = approved && (!lc!.blocked || !!lc!.hold) && !openCr;
  const editable = me.editable || (changeMode && canChange);
  const docsEditable = me.editable || canChange;
  const newDocs = v.documents.filter((d) => d.status === 'PENDING' && !d.changeRequestId);
  const fieldChanges = approved ? diffProfiles(cfg.sections, v.profile, profile) : [];
  // Asked to confirm after each periodic re-check, until they do.
  const reviewRequested = approved && !!v.lastReviewAt && (!v.lastConfirmedAt || v.lastConfirmedAt < v.lastReviewAt);
  const docFlags = lc?.flags.filter((f) => f.code === 'DOC_EXPIRED' || f.code === 'DOC_EXPIRING') ?? [];
  const tabs = [...cfg.sections.map((s) => ({ key: s.key, label: s.label })), { key: 'documents', label: t('portal.documentsTab') }];
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
      if (!quiet) setFlash({ kind: 'success', text: t('portal.saved') });
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
      if (approved) setFlash({ kind: 'info', text: t('portal.uploadedPendingCr') });
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
      setFlash({ kind: 'success', text: t('portal.valuesCopied', { count: r.applied.length }) });
      await load();
    } catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }

  // The workspace's own checks, and another country's only for suppliers from that country.
  const verifierFor = (f: FieldDef) => me?.verifiable.find((c) => c.anchor === `${tab}.${f.key}` && (c.home || c.country === String(profile.basic?.supplierCountry ?? '')));
  async function runVerify(f: FieldDef) {
    const cfg = verifierFor(f);
    if (!cfg) return;
    await save(tab, true);
    try {
      const r = await api<Check>(`/vendor/verify/${cfg.kind}`, { body: inputsFrom(cfg, profile) });
      setMe((m) => m && { ...m, checks: [r, ...m.checks.filter((c) => c.kind !== r.kind)] });
      if (r.status !== 'VERIFIED') setFlash({ kind: r.status === 'ERROR' ? 'error' : 'info', text: `${r.message}` });
    } catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }
  async function submit() {
    setConfirmSubmit(false);
    for (const s of [...dirty]) if (!(await save(s, true))) return;
    try {
      await api('/vendor/submit', { method: 'POST' });
      setFlash({ kind: 'success', text: t('portal.submitted') });
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
      setFlash({ kind: 'success', text: t('portal.crSubmitted') });
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
    try { await api(`/vendor/change-requests/${id}/cancel`, { method: 'POST' }); setFlash({ kind: 'info', text: t('portal.crWithdrawn') }); await load(true); }
    catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }
  async function confirmDetails() {
    try { await api('/vendor/confirm-details', { method: 'POST' }); setFlash({ kind: 'success', text: t('portal.detailsConfirmed') }); await load(); }
    catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }

  const blocking = me.checklist.filter((c) => !c.ok && c.severity === 'error').length;
  const extra = (f: FieldDef) => {
    const cfg = editable ? verifierFor(f) : undefined;
    if (!cfg) return null;
    const r = me?.checks.find((c) => c.kind === cfg.kind);
    return (
      <span className="verify">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => runVerify(f)}>{cfg.buttonLabel}</button>
        {r && <CheckBadge c={r} compact labels={cfg.resultLabels} />}
      </span>
    );
  };

  return (
    <SupplierFrame info={me} onLanguage={saveLanguage}>

      <div className="page">
        <header className="page-head">
          <div><h1>{approved ? t('portal.titleApproved') : t('portal.title')}</h1>
            <p className="muted"><Rich text={t('portal.vendorCode')} values={{ code: <span className="mono">{v.code}</span> }} /> {approved ? t('portal.introApproved') : t('portal.intro')}</p></div>
          {approved && !changeMode && <div className="head-actions"><button className="btn btn-secondary" disabled={!canChange} title={!canChange ? (lc!.blocked ? t('portal.onHoldTitle') : t('portal.crUnderReviewTitle')) : undefined} onClick={() => { setChangeMode(true); setFlash(undefined); }}>{t('portal.requestChanges')}</button></div>}
        </header>

        {v.status === 'SENT_BACK' && <Alert kind="warning"><strong>{t('portal.changesRequested')}</strong> “{me.sendBackRemarks}”. {t('portal.changesRequestedTail')}</Alert>}
        {v.status === 'UNDER_REVIEW' && <Alert kind="info">{t('portal.underReview')}</Alert>}
        {approved && lc!.blocked && (lc!.hold
          ? <Alert kind="error"><strong>{t('portal.holdExpiry', { document: lang === 'ar' ? lc!.hold.reason?.replace(/^Expired: /, '') : lc!.hold.reason?.replace(/^Expired: /, '').toLowerCase() })}</strong> {t('portal.holdExpiryTail')}</Alert>
          : <Alert kind="error"><strong>{t('portal.hold')}</strong> {t('portal.holdTail', { buyer: me.buyer.name })}</Alert>)}
        {approved && openCr && (
          <Alert kind="info"><strong>{openCr.byBuyer ? t('portal.buyerUpdating', { buyer: me.buyer.name }) : t('portal.crUnderReview')}</strong> ({openCr.steps.filter((s) => s.status === 'PENDING' || s.status === 'WAITING').map((s) => s.label).join(lang === 'ar' ? ' ← ' : ' → ') || t('portal.review')}). {t('portal.crInEffect')}{' '}
            {!openCr.byBuyer && <button className="link-btn" onClick={() => cancelCr(openCr.id)}>{t('portal.withdrawRequest')}</button>}</Alert>
        )}
        {approved && reviewRequested && !changeMode && (
          <Alert kind="warning"><strong>{t('portal.periodicReview')}</strong> {t('portal.periodicReviewText')}{' '}
            <button className="btn btn-primary btn-sm" onClick={confirmDetails}>{t('portal.theyAreCorrect')}</button>{' '}
            {canChange && <button className="btn btn-ghost btn-sm" onClick={() => setChangeMode(true)}>{t('portal.somethingChanged')}</button>}</Alert>
        )}
        {approved && docFlags.length > 0 && <Alert kind="warning"><strong>{docFlags.map((f) => f.label).join(' · ')}.</strong> {t('portal.uploadRenewedA')} <button className="link-btn" onClick={() => goTo('documents')}>{t('portal.documentsTab')}</button> {t('portal.uploadRenewedB')}</Alert>}
        {approved && changeMode && <Alert kind="info"><strong>{t('portal.editing')}</strong> {t('portal.editingText')}</Alert>}
        {approved && !changeMode && !lc!.flags.length && !reviewRequested && <Alert kind="success">{t('portal.approvedActive')}</Alert>}
        {v.status === 'REJECTED' && <Alert kind="error">{t('portal.rejected')}</Alert>}
        {flash && <Alert kind={flash.kind}>{flash.text}</Alert>}
        {editable && tab !== 'documents' && me.extractions.some((e) => e.status === 'DONE' && !e.appliedAt && e.suggestions.some((x) => x.state !== 'match')) && (
          <Alert kind="info">{t('portal.extractionsReady')} <button className="link-btn" onClick={() => goTo('documents')}>{t('portal.reviewSuggested')} {lang === 'ar' ? '←' : '→'}</button></Alert>
        )}

        <div className="detail-grid">
          <div className="card">
            <TabStrip>
              {tabs.map((tb) => {
                const n = sectionErrors(tb.key);
                return <button key={tb.key} role="tab" aria-selected={tab === tb.key} className={tab === tb.key ? 'active' : ''} onClick={() => goTo(tb.key)}>
                  {tb.label}{editable && revealed.has(tb.key) && n > 0 && <span className="tab-count">{n}</span>}{dirty.has(tb.key) && <span className="dirty" title={t('portal.unsaved')}>•</span>}
                </button>;
              })}
            </TabStrip>
            <div className="pad">
              {cfg.sections.filter((s) => s.key === tab).map((s) => (
                <DynamicSection key={s.key} section={s} profile={profile} vendorType={v.vendorType} errors={errors} readOnly={!editable} onChange={(f, val) => change(s.key, f, val)} extra={extra} />
              ))}
              {tab === 'documents' && <DocumentsPanel requirements={me.docRequirements} documents={v.documents} editable={docsEditable} onUpload={upload} onDelete={remove}
                canDelete={approved ? (d) => d.status === 'PENDING' && !d.changeRequestId : undefined} uploadLabel={approved ? t('portal.uploadRenewal') : undefined} />}
              {tab === 'documents' && me.editable && me.extractions.filter((e) => e.status !== 'SKIPPED' && v.documents.some((d) => d.id === e.documentId)).map((e) => {
                const doc = v.documents.find((d) => d.id === e.documentId)!;
                const label = me.docRequirements.find((r) => r.type === doc.docType)?.label ?? doc.docType;
                return <ExtractionCard key={e.id} ex={e} docLabel={label} onApply={(ids) => applyExtraction(e.id, ids)} />;
              })}
            </div>
            {approved && (changeMode || newDocs.length > 0) && (
              <div className="form-foot">
                {changeMode && <button className="btn btn-ghost" onClick={discardChanges}>{t('portal.discardChanges')}</button>}
                <span className="muted small grow">{t('portal.fieldsChanged', { count: fieldChanges.length })}{newDocs.length ? ` · ${t('portal.newDocs', { count: newDocs.length })}` : ''}</span>
                <button className="btn btn-primary" disabled={!fieldChanges.length && !newDocs.length} onClick={() => setCrOpen(true)}>{t('portal.reviewSubmitChange')}</button>
              </div>
            )}
            {me.editable && (
              <div className="form-foot">
                <button className="btn btn-ghost" disabled={saving || !dirty.has(tab)} onClick={() => save()}>{saving ? t('common.saving') : t('common.save')}</button>
                {tabs.findIndex((tb) => tb.key === tab) < tabs.length - 1
                  ? <button className="btn btn-primary" onClick={() => goTo(tabs[tabs.findIndex((tb) => tb.key === tab) + 1].key)}>{t('portal.saveNext')} {lang === 'ar' ? '←' : '→'}</button>
                  : <button className="btn btn-primary" onClick={() => setConfirmSubmit(true)}>{t('portal.reviewSubmit')}</button>}
              </div>
            )}
          </div>
          <aside className="side-col">
            {approved ? (
              <>
                <div className="card pad">
                  <h3 className="card-title">{t('portal.yourAccount')}</h3>
                  <dl className="kv small">
                    <dt>{t('common.status')}</dt><dd>{lc!.blocked ? <span className="badge flag-high">{t('portal.onHold')}</span> : <span className="badge badge-approved">{t('portal.active')}</span>}</dd>
                    <dt>{t('portal.lastConfirmed')}</dt><dd>{fmtDate(v.lastConfirmedAt ?? v.decidedAt)}</dd>
                    <dt>{t('portal.nextReview')}</dt><dd>{fmtDate(lc!.nextReviewAt)}</dd>
                  </dl>
                  <FlagBadges flags={lc!.flags.filter((f) => f.code !== 'BLOCKED')} />
                  {!reviewRequested && <button className="link-btn small" onClick={confirmDetails}>{t('portal.confirmCurrent')}</button>}
                </div>
                <div className="card pad"><h3 className="card-title">{t('portal.changeRequests')}</h3><CrHistory items={lc!.changeRequests} onCancel={cancelCr} /></div>
              </>
            ) : me.editable ? (
              <div className="card pad">
                <Checklist items={me.checklist} sections={cfg.sections} onJump={(s) => { setRevealed((r) => new Set(r).add(s)); goTo(s); }} />
                <button className="btn btn-primary btn-block" onClick={() => setConfirmSubmit(true)} disabled={saving}>{t('portal.submitForReview')}</button>
                {blocking > 0 && <p className="small muted center">{t('portal.submitWhenDone')}</p>}
              </div>
            ) : (
              <div className="card pad"><h3 className="card-title">{t('portal.approvalProgress')}</h3><ApprovalTimeline steps={v.steps} levels={cfg.levels} /></div>
            )}
            <div className="card pad">
              <h3 className="card-title">{t('portal.yourData')}</h3>
              <p className="small muted">{me.privacy.consentAt ? t('portal.acceptedNoticeOn', { date: fmtDate(me.privacy.consentAt) }) : t('portal.noticeNotAccepted')}</p>
              <div className="link-list">
                <button className="link-btn small" onClick={() => setShowNotice(true)}>{t('portal.readNotice')}</button>
                <a className="link-btn small" href="/api/vendor/my-data" download>{t('portal.downloadData')}</a>
                {me.privacy.erasureRequestedAt
                  ? <span className="small muted">{t('portal.deletionRequested', { date: fmtDate(me.privacy.erasureRequestedAt) })}</span>
                  : <button className="link-btn small danger" onClick={() => setErasureOpen(true)}>{t('portal.requestDeletion')}</button>}
              </div>
            </div>
            <div className="card pad">
              <h3 className="card-title">{t('portal.howItWorks')}</h3>
              <ol className="guide-mini">{cfg.guide.map((g) => <li key={g.title}>{g.title.replace(/^(Step \d+|الخطوة \d+): /, '')}</li>)}</ol>
              <button className="link-btn small" onClick={() => openHelp('buyer-guide')}>{t('portal.readGuide')}</button>
            </div>
          </aside>
        </div>
      </div>

      {me.privacy.needsConsent && <ConsentModal buyer={me.buyer.name} privacy={me.privacy} onDone={() => load()} />}
      {showNotice && <Modal title={t('portal.noticeTitle', { buyer: me.buyer.name })} wide onClose={() => setShowNotice(false)}><div className="notice-text">{me.privacy.text}</div></Modal>}
      {erasureOpen && <ErasureModal onClose={() => setErasureOpen(false)} onDone={() => { setErasureOpen(false); setFlash({ kind: 'info', text: t('portal.deletionSent') }); load(); }} />}
      {crOpen && (
        <Modal title={t('portal.crConfirmTitle')} wide onClose={() => setCrOpen(false)}
          footer={<><button className="btn btn-ghost" onClick={() => setCrOpen(false)}>{t('portal.keepEditing')}</button><button className="btn btn-primary" disabled={crBusy} onClick={submitChange}>{crBusy ? t('portal.submitting') : t('portal.submitForReview')}</button></>}>
          <ChangeDiff changes={fieldChanges} docCount={newDocs.length} />
          <label className="field"><span>{t('portal.crReason')}</span>
            <textarea className="input" rows={2} maxLength={1000} value={crNote} onChange={(e) => setCrNote(e.target.value)} placeholder={t('portal.crReasonPlaceholder')} /></label>
          <p className="small muted">{t('portal.crInEffect')}</p>
        </Modal>
      )}
      {confirmSubmit && (
        <Modal title={t('portal.submitConfirmTitle')} onClose={() => setConfirmSubmit(false)}
          footer={<><button className="btn btn-ghost" onClick={() => setConfirmSubmit(false)}>{t('portal.keepEditing')}</button><button className="btn btn-primary" disabled={blocking > 0 && dirty.size === 0} onClick={submit}>{t('portal.submit')}</button></>}>
          {blocking > 0
            ? <Alert kind="warning">{t('portal.itemsNeedAttention', { count: blocking })} {dirty.size > 0 && t('portal.unsavedWillSave')}</Alert>
            : <p>{t('portal.reviewedBy')} <strong>{cfg.levels.join(lang === 'ar' ? ' ← ' : ' → ')}</strong>. {t('portal.lockedWhileReview')}</p>}
        </Modal>
      )}
    </SupplierFrame>
  );
}

export function VendorSignedOut() {
  const [sp] = useSearchParams();
  const next = sp.get('next');
  const [ws, setWs] = useState<string>();
  // Where a supplier who used the email sign-in page can sign in again (remembered on this device).
  useEffect(() => { try { setWs(localStorage.getItem('vg.supplierWorkspace') ?? undefined); } catch { /* ignore */ } }, []);
  return (
    <div className="center-page login-bg"><div className="card pad login-card">
      <h2>{t('portal.signedOutTitle')}</h2>
      <p className="muted">{t('portal.signedOutText')}</p>
      {ws && <a className="btn btn-primary btn-block" href={`/s/${ws}${next ? `?next=${encodeURIComponent(next)}` : ''}`}>{t('portal.signInWithEmail')}</a>}
      <div className="auth-foot"><PoweredBy /></div>
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
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-label={t('portal.privacyNotice')}>
        <div className="modal-head"><h3>{privacy.consentVersion ? t('portal.noticeChanged') : t('portal.beforeYouStart', { buyer })}</h3></div>
        <div className="modal-body">
          {error && <Alert kind="error">{error}</Alert>}
          <div className="notice-text notice-scroll">{privacy.text}</div>
          <label className="check-item"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>{t('portal.consentAgree', { buyer })}</span></label>
        </div>
        <div className="modal-foot">
          <a className="btn btn-ghost" href="/api/vendor-auth/logout" onClick={(e) => { e.preventDefault(); supplierSignOut(); }}>{t('portal.notNow')}</a>
          <button className="btn btn-primary" disabled={!agree || busy} onClick={accept}>{busy ? t('common.saving') : t('portal.acceptContinue')}</button>
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
    <Modal title={t('portal.erasureTitle')} onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-danger" onClick={send}>{t('portal.sendRequest')}</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <p>{t('portal.erasureText')}</p>
      <p className="small muted">{t('portal.erasureTip')}</p>
      <div className="field"><label htmlFor="er-reason">{t('portal.reasonOptional')}</label><textarea id="er-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
    </Modal>
  );
}
