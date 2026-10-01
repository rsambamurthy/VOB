import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { applyBranding } from '../lib/session';
import { monogram } from '../lib/format';
import { DynamicSection } from '../components/DynamicSection';
import { DocumentsPanel } from '../components/DocumentsPanel';
import { Checklist } from '../components/Checklist';
import { ApprovalTimeline } from '../components/Timeline';
import { Alert, Modal, StatusBadge } from '../components/ui';
import type { Branding, ChecklistItem, DocRequirement, FieldDef, Profile, SectionDef, VendorFull } from '../lib/types';

type Me = { config: { sections: SectionDef[]; guide: { title: string; body: string }[]; levels: string[] }; vendor: VendorFull; checklist: ChecklistItem[]; docRequirements: DocRequirement[]; editable: boolean; sendBackRemarks?: string; buyer: { name: string; branding: Branding } };
type VerifyResult = { status: string; message: string };

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
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [flash, setFlash] = useState<{ kind: 'success' | 'error' | 'info'; text: string }>();
  const [saving, setSaving] = useState(false);
  const [verifs, setVerifs] = useState<Record<string, VerifyResult>>({});
  const [showGuide, setShowGuide] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api<Me>('/vendor');
      setMe(r); setProfile(r.vendor.profile); applyBranding(r.buyer.branding);
      setVerifs((r.vendor.profile._verifications ?? {}) as Record<string, VerifyResult>);
    } catch (e) { if (e instanceof ApiError && e.status === 401) nav('/vendor/expired'); }
  }, [nav]);
  useEffect(() => { load(); }, [load]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty.size) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const errors = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of me?.checklist ?? []) if (!c.ok && c.message && revealed.has(c.section)) m[c.id.replace(/^cross\./, '')] = c.message;
    return m;
  }, [me, revealed]);

  if (!me) return <div className="center-page"><div className="spinner" /></div>;
  const v = me.vendor;
  const editable = me.editable;
  const cfg = me.config;
  const tabs = [...cfg.sections.map((s) => ({ key: s.key, label: s.label })), { key: 'documents', label: 'Documents' }];
  const sectionErrors = (k: string) => me.checklist.filter((c) => c.section === k && !c.ok && c.severity === 'error').length;

  function change(section: string, field: string, value: string) {
    setProfile((p) => ({ ...p, [section]: { ...(p[section] ?? {}), [field]: value } }));
    setDirty((d) => new Set(d).add(section));
  }

  async function save(section = tab, quiet = false) {
    if (!dirty.has(section) || section === 'documents') { setRevealed((r) => new Set(r).add(section)); return true; }
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

  async function upload(docType: string, file: File) {
    const fd = new FormData(); fd.append('docType', docType); fd.append('file', file);
    try { await api('/vendor/documents', { body: fd }); await load(); setRevealed((r) => new Set(r).add('documents')); }
    catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }
  async function remove(id: string) {
    try { await api(`/vendor/documents/${id}`, { method: 'DELETE' }); await load(); } catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }
  async function runVerify(f: FieldDef) {
    const cfg = VERIFY[f.key];
    await save(tab, true);
    try {
      const r = await api<VerifyResult>(`/vendor/verify/${cfg.kind}`, { body: cfg.from(profile) });
      setVerifs((x) => ({ ...x, [cfg.kind]: r }));
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

  const blocking = me.checklist.filter((c) => !c.ok && c.severity === 'error').length;
  const extra = (f: FieldDef) => {
    const cfg = editable ? VERIFY[f.key] : undefined;
    if (!cfg) return null;
    const r = verifs[cfg.kind];
    return (
      <span className="verify">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => runVerify(f)}>{cfg.label}</button>
        {r && <span className={`vbadge v-${r.status.toLowerCase()}`} title={r.message}>{r.status === 'VERIFIED' ? '✓ Verified' : r.status === 'NOT_FOUND' ? 'Not found' : 'Invalid'}</span>}
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
          <button className="btn btn-ghost btn-sm" onClick={() => setShowGuide(true)}>Help</button>
          <button className="btn btn-ghost btn-sm" onClick={async () => { await api('/vendor-auth/logout', { method: 'POST' }).catch(() => {}); nav('/vendor/expired'); }}>Sign out</button>
        </div>
      </header>

      <div className="page">
        <header className="page-head"><div><h1>Business profile</h1><p className="muted">Vendor code <span className="mono">{v.code}</span>. Complete each tab, upload documents, then submit for review.</p></div></header>

        {v.status === 'SENT_BACK' && <Alert kind="warning"><strong>Changes requested:</strong> “{me.sendBackRemarks}”. Update the form and submit again.</Alert>}
        {v.status === 'UNDER_REVIEW' && <Alert kind="info">Submitted — your registration is being reviewed. Editing is locked until a decision is made.</Alert>}
        {v.status === 'APPROVED' && <Alert kind="success">You’re approved and active as a vendor. 🎉</Alert>}
        {v.status === 'REJECTED' && <Alert kind="error">This registration was not approved. Check your email for the reason.</Alert>}
        {flash && <Alert kind={flash.kind}>{flash.text}</Alert>}

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
              {tab === 'documents' && <DocumentsPanel requirements={me.docRequirements} documents={v.documents} editable={editable} onUpload={upload} onDelete={remove} />}
            </div>
            {editable && (
              <div className="form-foot">
                <button className="btn btn-ghost" disabled={saving || !dirty.has(tab)} onClick={() => save()}>{saving ? 'Saving…' : 'Save'}</button>
                {tabs.findIndex((t) => t.key === tab) < tabs.length - 1
                  ? <button className="btn btn-primary" onClick={() => goTo(tabs[tabs.findIndex((t) => t.key === tab) + 1].key)}>Save & next →</button>
                  : <button className="btn btn-primary" onClick={() => setConfirmSubmit(true)}>Review & submit</button>}
              </div>
            )}
          </div>
          <aside className="side-col">
            {editable ? (
              <div className="card pad">
                <Checklist items={me.checklist} sections={cfg.sections} onJump={(s) => { setRevealed((r) => new Set(r).add(s)); goTo(s); }} />
                <button className="btn btn-primary btn-block" onClick={() => setConfirmSubmit(true)} disabled={saving}>Submit for review</button>
                {blocking > 0 && <p className="small muted center">You can submit once all required items are done.</p>}
              </div>
            ) : (
              <div className="card pad"><h3 className="card-title">Approval progress</h3><ApprovalTimeline steps={v.steps} levels={cfg.levels} /></div>
            )}
            <div className="card pad">
              <h3 className="card-title">How onboarding works</h3>
              <ol className="guide-mini">{cfg.guide.map((g) => <li key={g.title}>{g.title.replace(/^Step \d+: /, '')}</li>)}</ol>
              <button className="link-btn small" onClick={() => setShowGuide(true)}>Read the full guide</button>
            </div>
          </aside>
        </div>
      </div>

      {showGuide && (
        <Modal title="Vendor onboarding guide" onClose={() => setShowGuide(false)}>
          {cfg.guide.map((g) => <div key={g.title} className="guide-step"><h4>{g.title}</h4><p>{g.body}</p></div>)}
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
