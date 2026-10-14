import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { applyBranding, useSession } from '../../lib/session';
import { Alert } from '../../components/ui';
import { Link, useSearchParams } from 'react-router-dom';
import { loc, localeInfo } from '../../lib/format';

export function Workspace() {
  const { me, refresh } = useSession();
  const t = me!.tenant;
  const welcome = useSearchParams()[0].get('welcome') === '1';
  const [f, setF] = useState({
    name: t.name, productName: t.branding.productName ?? '', primaryColor: t.branding.primaryColor ?? '#1f2758', logoUrl: t.branding.logoUrl ?? '',
    requireMfa: !!t.settings.requireMfa, sessionHours: t.settings.sessionHours ?? 12, reKycMonths: t.settings.reKycMonths ?? 12, skipWeekends: !!t.settings.skipWeekends,
  });
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(undefined);
    try {
      await api('/admin/tenant', { method: 'PATCH', body: { name: f.name, branding: { productName: f.productName || undefined, primaryColor: f.primaryColor, logoUrl: f.logoUrl }, settings: { requireMfa: f.requireMfa, sessionHours: Number(f.sessionHours), reKycMonths: Number(f.reKycMonths), skipWeekends: f.skipWeekends } } });
      await refresh();
      setMsg({ kind: 'success', text: 'Workspace settings saved.' });
    } catch (err: any) { setMsg({ kind: 'error', text: err.message }); }
  }
  return (
    <div className="page narrow-page">
      <header className="page-head"><div><h1>Workspace</h1><p className="muted">Workspace ID <strong className="mono">{t.slug}</strong> — staff enter this when signing in.</p></div></header>
      {welcome && (
        <Alert kind="success"><strong>Welcome to VendorGate — {t.name} is ready.</strong>
          {me!.plan?.trialEndsAt && <> Your free trial runs until {new Date(me!.plan.trialEndsAt).toLocaleDateString(loc(), { day: 'numeric', month: 'long' })}.</>}
          <ol className="welcome-steps">
            <li>Add your logo and colour below, so suppliers recognise you.</li>
            <li><Link to="/staff/admin/users">Invite your team</Link> — reviewers, finance and approvers.</li>
            <li><Link to="/staff/admin/config">Review the supplier form and approval flow</Link>, then <Link to="/staff/vendors">invite your first vendor</Link>.</li>
          </ol>
        </Alert>
      )}
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <form onSubmit={save} className="stack">
        <section className="card pad section-card">
          <h3>Company & branding</h3>
          <p className="muted small">Shown to your staff and to suppliers in the vendor portal and emails.</p>
          <div className="field-grid">
            <div className="field"><label htmlFor="w-name">Company name</label><input id="w-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></div>
            <div className="field"><label htmlFor="w-prod">Portal name</label><input id="w-prod" value={f.productName} placeholder="VendorGate" onChange={(e) => setF({ ...f, productName: e.target.value })} /></div>
            <div className="field"><label htmlFor="w-color">Brand colour</label>
              <div className="control-row"><input type="color" value={f.primaryColor} onChange={(e) => { setF({ ...f, primaryColor: e.target.value }); applyBranding({ primaryColor: e.target.value, productName: f.productName }); }} className="color-input" aria-label="Pick colour" /><input id="w-color" value={f.primaryColor} onChange={(e) => setF({ ...f, primaryColor: e.target.value })} /></div></div>
            <div className="field"><label htmlFor="w-logo">Logo URL</label><input id="w-logo" value={f.logoUrl} placeholder="https://…/logo.png" onChange={(e) => setF({ ...f, logoUrl: e.target.value })} /></div>
          </div>
        </section>
        <section className="card pad section-card">
          <h3>Security</h3>
          <label className="check-item"><input type="checkbox" checked={f.requireMfa} onChange={(e) => setF({ ...f, requireMfa: e.target.checked })} /><span><strong>Require two-factor authentication for all staff</strong><span className="muted small block">Users without 2FA will be asked to set it up before they can do anything else.</span></span></label>
          <div className="field" style={{ maxWidth: 260, marginTop: 12 }}><label htmlFor="w-hours">Sign-in session length (hours)</label><input id="w-hours" type="number" min={1} max={72} value={f.sessionHours} onChange={(e) => setF({ ...f, sessionHours: Number(e.target.value) })} /></div>
        </section>
        <section className="card pad section-card">
          <h3>Vendor lifecycle</h3>
          <p className="muted small">Approved vendors are re-checked on this cycle: their online checks are run again and the vendor is asked to confirm their details. Problems are flagged to approvers. Document expiry reminders go out 30 days, 7 days and on the day a document expires.</p>
          <div className="field" style={{ maxWidth: 260 }}><label htmlFor="w-rekyc">Re-verify every (months)</label><input id="w-rekyc" type="number" min={0} max={60} value={f.reKycMonths} onChange={(e) => setF({ ...f, reKycMonths: Number(e.target.value) })} /><div className="field-help">0 turns periodic re-checks off.</div></div>
          <label className="check-item" style={{ marginTop: 12 }}><input type="checkbox" checked={f.skipWeekends} onChange={(e) => setF({ ...f, skipWeekends: e.target.checked })} /><span><strong>Count deadlines in working days</strong><span className="muted small block">Approval deadlines and purchase-order auto-accept skip the weekend{weekendText(me!.tenant.country)}. Applies to steps and orders from now on.</span></span></label>
        </section>
        <div><button className="btn btn-primary">Save settings</button></div>
      </form>
      <PrivacySettings />
    </div>
  );
}

interface PrivacyData { notice: { version: number; text: string; contactEmail: string | null; updatedAt: string | null; isDefault: boolean }; retention: { rejectedDays: number; abandonedDays: number }; template: string }

/** DPDP: privacy notice vendors accept, grievance contact, and how long unfinished registrations are kept. */
function PrivacySettings() {
  const [d, setD] = useState<PrivacyData>();
  const [text, setText] = useState('');
  const [email, setEmail] = useState('');
  const [ret, setRet] = useState({ rejectedDays: 365, abandonedDays: 180 });
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  useEffect(() => { api<PrivacyData>('/admin/privacy').then((r) => { setD(r); setText(r.notice.text); setEmail(r.notice.contactEmail ?? ''); setRet(r.retention); }).catch((e) => setMsg({ kind: 'error', text: e.message })); }, []);
  if (!d) return null;
  const textChanged = text !== d.notice.text || (email || null) !== d.notice.contactEmail;
  async function save() {
    setMsg(undefined);
    try {
      const r = await api<{ notice: PrivacyData['notice']; retention: PrivacyData['retention'] }>('/admin/privacy', { method: 'PUT', body: { text, contactEmail: email, retention: ret } });
      setD({ ...d!, ...r }); setText(r.notice.text);
      setMsg({ kind: 'success', text: textChanged ? `Saved as version ${r.notice.version}. Vendors will be asked to accept it the next time they sign in.` : 'Saved.' });
    } catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  }
  return (
    <section className="card pad section-card" style={{ marginTop: 16 }}>
      <h3>Privacy & data retention{localeInfo().privacyLaw ? ` (${localeInfo().privacyLaw})` : ''}</h3>
      <p className="muted small">Vendors must accept this notice before entering any data. Changing it creates a new version and asks every vendor to accept again. {d.notice.isDefault ? <strong>You are using the starting template — have it reviewed by your legal team.</strong> : <>Current version {d.notice.version}{d.notice.updatedAt ? `, updated ${new Date(d.notice.updatedAt).toLocaleDateString(loc())}` : ''}.</>}</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="field"><label htmlFor="pv-text">Privacy notice</label><textarea id="pv-text" rows={14} value={text} onChange={(e) => setText(e.target.value)} /></div>
      <div className="field-grid">
        <div className="field"><label htmlFor="pv-email">Grievance officer email</label><input id="pv-email" type="email" value={email} placeholder="privacy@yourcompany.com" onChange={(e) => setEmail(e.target.value)} /></div>
        <div />
        <div className="field"><label htmlFor="pv-rej">Erase rejected registrations after (days)</label><input id="pv-rej" type="number" min={0} max={3650} value={ret.rejectedDays} onChange={(e) => setRet({ ...ret, rejectedDays: Number(e.target.value) })} /><div className="field-help">0 = keep. Personal data is removed; counts and the audit trail stay.</div></div>
        <div className="field"><label htmlFor="pv-ab">Erase abandoned registrations after (days of inactivity)</label><input id="pv-ab" type="number" min={0} max={3650} value={ret.abandonedDays} onChange={(e) => setRet({ ...ret, abandonedDays: Number(e.target.value) })} /><div className="field-help">Invited, in progress or sent back, with no activity. 0 = keep.</div></div>
      </div>
      <div className="btn-row">
        <button className="btn btn-primary" onClick={save}>{textChanged ? 'Save as new version' : 'Save'}</button>
        <button className="btn btn-ghost" onClick={() => setText(d.template)}>Reset to template</button>
      </div>
    </section>
  );
}

const weekendText = (country: string) => (country === 'IN' ? ' (Sunday)' : ['SA', 'BH', 'QA', 'KW', 'OM'].includes(country) ? ' (Friday and Saturday)' : ' (Saturday and Sunday)');
