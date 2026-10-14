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
      await api('/admin/tenant', { method: 'PATCH', body: { name: f.name, branding: { productName: f.productName || undefined, primaryColor: f.primaryColor, logoUrl: f.logoUrl }, settings: { requireMfa: f.requireMfa || !!t.settings.mfaEnforcedByPlatform, sessionHours: Number(f.sessionHours), reKycMonths: Number(f.reKycMonths), skipWeekends: f.skipWeekends } } });
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
        <CountryChoice onChanged={refresh} />
        <section className="card pad section-card">
          <h3>Security</h3>
          <label className="check-item"><input type="checkbox" checked={f.requireMfa || !!t.settings.mfaEnforcedByPlatform} disabled={!!t.settings.mfaEnforcedByPlatform} onChange={(e) => setF({ ...f, requireMfa: e.target.checked })} /><span><strong>Require two-factor authentication for all staff</strong><span className="muted small block">Users without 2FA will be asked to set it up before they can do anything else.{t.settings.mfaEnforcedByPlatform && ' Required for your workspace by VendorGate.'}</span></span></label>
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
      <EmailSettings />
      <PrivacySettings />
    </div>
  );
}

/** Home country: shown always; can be changed once, before suppliers are invited or the form is edited. */
function CountryChoice({ onChanged }: { onChanged: () => unknown }) {
  const [d, setD] = useState<{ country: string; countryName: string; confirmed: boolean; canChange: boolean; reason: string | null; countries: { code: string; name: string }[] }>();
  const [pick, setPick] = useState('');
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const load = () => api<NonNullable<typeof d>>('/admin/tenant/country').then((r) => { setD(r); setPick(r.country); });
  useEffect(() => { load(); }, []);
  if (!d) return null;
  async function save() {
    setMsg(undefined);
    try { await api('/admin/tenant/country', { body: { country: pick } }); await load(); await onChanged(); setMsg({ kind: 'success', text: pick === d!.country ? 'Country confirmed.' : 'Country changed — the supplier form, currency, working week and privacy notice now follow it.' }); }
    catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  }
  return (
    <section className="card pad section-card">
      <h3>Country</h3>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <p className="muted small">The home country sets the starting supplier form, currency, working week, privacy law and the ERP record.</p>
      {d.canChange ? (
        <div className="inline-form">
          <select aria-label="Home country" value={pick} onChange={(e) => setPick(e.target.value)}>{d.countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select>
          <button type="button" className="btn btn-secondary btn-sm" onClick={save}>{pick === d.country ? 'Confirm country' : `Change to ${d.countries.find((c) => c.code === pick)?.name}`}</button>
          <span className="small muted">You can do this once, before inviting suppliers.</span>
        </div>
      ) : <p><strong>{d.countryName}</strong> <span className="small muted">· {d.confirmed ? 'confirmed' : d.reason}</span></p>}
    </section>
  );
}

interface DnsRecord { type: string; name: string; value: string; priority?: number; status?: string }
interface EmailData {
  status: { provider: string; live: boolean; domains: boolean; bounceTracking: boolean };
  sender: { from: string; replyTo?: string }; fromName: string; replyTo: string; canUseDomain: boolean;
  domain: { name: string; status: 'pending' | 'verified' | 'failed'; fromLocal?: string; records?: DnsRecord[]; checkedAt?: string } | null;
  bounced: { id: string; code: string; name: string; email: string; at: string; reason: string | null }[];
}

/** Sender name, reply-to address, own sending domain and addresses that bounced. */
function EmailSettings() {
  const [d, setD] = useState<EmailData>();
  const [f, setF] = useState({ fromName: '', replyTo: '' });
  const [dom, setDom] = useState({ name: '', fromLocal: 'no-reply' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'info'; text: string }>();
  const load = () => api<EmailData>('/admin/email').then((r) => { setD(r); setF({ fromName: r.fromName, replyTo: r.replyTo }); }).catch((e) => setMsg({ kind: 'error', text: e.message }));
  useEffect(() => { load(); }, []);
  if (!d) return null;
  const act = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); setMsg(undefined); try { await fn(); await load(); setMsg({ kind: 'success', text: ok }); } catch (e: any) { setMsg({ kind: 'error', text: e.message }); } finally { setBusy(false); } };
  return (
    <section className="card pad section-card" style={{ marginTop: 16 }}>
      <h3>Email</h3>
      <p className="muted small">Emails to suppliers and staff currently go out as <strong className="mono">{d.sender.from}</strong>{d.sender.replyTo && <> with replies to <strong>{d.sender.replyTo}</strong></>}.</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="field-grid">
        <div className="field"><label htmlFor="em-name">Sender name</label><input id="em-name" value={f.fromName} maxLength={80} placeholder="e.g. Your Company — Procurement" onChange={(e) => setF({ ...f, fromName: e.target.value })} /></div>
        <div className="field"><label htmlFor="em-reply">Replies go to</label><input id="em-reply" type="email" value={f.replyTo} placeholder="procurement@yourcompany.com" onChange={(e) => setF({ ...f, replyTo: e.target.value })} /></div>
      </div>
      <div className="btn-row"><button className="btn btn-secondary" disabled={busy} onClick={() => act(() => api('/admin/tenant', { method: 'PATCH', body: { email: f } }), 'Sender details saved.')}>Save sender details</button></div>

      <h4 style={{ marginTop: 20 }}>Your own sending domain</h4>
      {!d.status.domains ? <p className="muted small">Sending from your own domain becomes available when VendorGate's email provider supports it.</p>
        : !d.canUseDomain ? <p className="muted small">Available on paid plans.</p>
        : d.domain ? (
          <>
            <p className="small">Domain <strong className="mono">{d.domain.name}</strong> — {d.domain.status === 'verified' ? <span className="badge badge-approved sm">Verified</span> : d.domain.status === 'failed' ? <span className="badge badge-rejected sm">Verification failed</span> : <span className="badge badge-invited sm">Waiting for DNS</span>}
              {d.domain.status === 'verified' ? <> Emails are sent from <span className="mono">{d.domain.fromLocal || 'no-reply'}@{d.domain.name}</span>.</> : ' Add these records at your DNS provider, then check again. It can take up to a few hours.'}</p>
            {d.domain.status !== 'verified' && d.domain.records && (
              <div className="table-wrap"><table className="table static compact"><thead><tr><th>Type</th><th>Name</th><th>Value</th><th>Status</th></tr></thead>
                <tbody>{d.domain.records.map((r, i) => <tr key={i}><td>{r.type}</td><td className="mono small break">{r.name}</td><td className="mono small break">{r.priority !== undefined ? `${r.priority} ` : ''}{r.value}</td><td className="small">{r.status ?? ''}</td></tr>)}</tbody></table></div>
            )}
            <div className="btn-row">
              {d.domain.status !== 'verified' && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => act(() => api('/admin/email/domain/check', { method: 'POST' }), 'Checked with the email provider.')}>Check again</button>}
              <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act(() => api('/admin/email/domain', { method: 'DELETE' }), 'Domain removed. Emails go out from VendorGate’s address again.')}>Remove domain</button>
            </div>
          </>
        ) : (
          <div className="inline-form">
            <input aria-label="Sender mailbox" value={dom.fromLocal} onChange={(e) => setDom({ ...dom, fromLocal: e.target.value })} style={{ maxWidth: 140 }} /><span>@</span>
            <input aria-label="Domain" placeholder="mail.yourcompany.com" value={dom.name} onChange={(e) => setDom({ ...dom, name: e.target.value })} />
            <button className="btn btn-secondary btn-sm" disabled={busy || dom.name.length < 4} onClick={() => act(() => api('/admin/email/domain', { body: dom }), 'Domain added — now add the DNS records shown.')}>Add domain</button>
          </div>
        )}

      <h4 style={{ marginTop: 20 }}>Addresses that bounced</h4>
      {!d.status.bounceTracking && <p className="muted small">Bounce tracking is switched on by VendorGate together with the email provider.</p>}
      {d.bounced.length ? (
        <table className="table static compact"><thead><tr><th>Supplier</th><th>Contact email</th><th>Reason</th><th /></tr></thead>
          <tbody>{d.bounced.map((b) => (
            <tr key={b.id}><td><Link to={`/staff/vendors/${b.id}`}>{b.name}</Link><div className="muted small mono">{b.code}</div></td><td className="small">{b.email}</td><td className="small">{b.reason}<div className="muted">{new Date(b.at).toLocaleDateString(loc())}</div></td>
              <td className="actions"><button className="link-btn small" disabled={busy} onClick={() => act(() => api('/admin/email/unsuppress', { body: { address: b.email } }), `${b.email} can receive email again.`)}>Send to it again</button></td></tr>))}</tbody></table>
      ) : <p className="muted small">None. When a supplier’s contact address bounces or reports our email as spam, we stop sending to it and list it here. Change the contact on the supplier’s page.</p>}
    </section>
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
