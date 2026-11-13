import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { Alert } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';

type Provider = 'entra' | 'okta' | 'google' | 'oidc' | 'saml';
type PasswordLogin = 'everyone' | 'admins' | 'off';
interface Sso {
  enabled: boolean; provider: Provider; label?: string; issuer?: string; clientId?: string; hasClientSecret: boolean;
  samlEntryPoint?: string; samlIdpIssuer?: string; samlCert?: string; allowedDomains: string[]; passwordLogin: PasswordLogin;
  autoCreate: boolean; defaultRoleId?: string; verifiedAt?: string; verifiedBy?: string; buttonLabel: string;
}
interface View {
  sso: Sso | null; requireMfa: boolean; roles: { id: string; name: string }[];
  provider: { redirectUri: string; samlAcsUrl: string; samlEntityId: string; samlMetadataUrl: string; signInUrl: string };
}

const PROVIDERS: { key: Provider; title: string; sub: string }[] = [
  { key: 'entra', title: 'Microsoft Entra ID', sub: 'Azure AD · Microsoft 365' },
  { key: 'okta', title: 'Okta', sub: 'OpenID Connect' },
  { key: 'google', title: 'Google Workspace', sub: 'Google accounts' },
  { key: 'oidc', title: 'Other OpenID Connect', sub: 'Auth0, Keycloak, AD FS 2016+, OneLogin…' },
  { key: 'saml', title: 'SAML 2.0', sub: 'AD FS, Ping, JumpCloud, any SAML IdP' },
];

/** Entra / Okta / Google issuers are built from what the admin knows (tenant ID, Okta domain). */
function issuerFor(p: Provider, f: Form) {
  if (p === 'entra') return f.entraTenant.trim() ? `https://login.microsoftonline.com/${f.entraTenant.trim()}/v2.0` : '';
  if (p === 'okta') { const d = f.oktaDomain.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); return d ? `https://${d}${f.oktaCustomServer ? '/oauth2/default' : ''}` : ''; }
  if (p === 'google') return 'https://accounts.google.com';
  return f.issuer.trim();
}
interface Form {
  mode: 'password' | 'sso'; provider: Provider; label: string; entraTenant: string; oktaDomain: string; oktaCustomServer: boolean; issuer: string; clientId: string; clientSecret: string;
  samlEntryPoint: string; samlIdpIssuer: string; samlCert: string; domains: string; passwordLogin: PasswordLogin; autoCreate: boolean; defaultRoleId: string;
}
function formOf(s: Sso | null): Form {
  const iss = s?.issuer ?? '';
  return {
    mode: s?.enabled ? 'sso' : 'password', provider: s?.provider ?? 'entra', label: s?.label ?? '',
    entraTenant: /login\.microsoftonline\.com\/([^/]+)/.exec(iss)?.[1] ?? '', oktaDomain: s?.provider === 'okta' ? iss.replace(/^https:\/\//, '').replace(/\/.*$/, '') : '', oktaCustomServer: /\/oauth2\//.test(iss),
    issuer: iss, clientId: s?.clientId ?? '', clientSecret: '', samlEntryPoint: s?.samlEntryPoint ?? '', samlIdpIssuer: s?.samlIdpIssuer ?? '', samlCert: s?.samlCert ?? '',
    domains: (s?.allowedDomains ?? []).join(', '), passwordLogin: s?.passwordLogin ?? 'admins', autoCreate: !!s?.autoCreate, defaultRoleId: s?.defaultRoleId ?? '',
  };
}

function Copy({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy-row"><span className="muted small">{label}</span>
      <code className="copy-val">{value}</code>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard?.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); }}>{done ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

export function SignIn() {
  const { me } = useSession();
  const [params] = useSearchParams();
  const [v, setV] = useState<View>();
  const [f, setF] = useState<Form>(formOf(null));
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'info'; text: string }>();
  const [busy, setBusy] = useState(false);
  const load = () => api<View>('/admin/sso').then((r) => { setV(r); setF(formOf(r.sso)); }).catch((e) => setMsg({ kind: 'error', text: e.message }));
  useEffect(() => { load(); }, []);
  useEffect(() => { if (params.get('sso') === 'ok') setMsg({ kind: 'success', text: 'Single sign-on works — you signed in through your identity provider.' }); }, [params]);
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));
  const oidcKind = f.provider !== 'saml';
  const verified = !!v?.sso?.verifiedAt && v.sso.enabled;
  const dirty = useMemo(() => v && JSON.stringify(formOf(v.sso)) !== JSON.stringify({ ...f, clientSecret: '' }), [v, f]) || !!f.clientSecret;

  async function save() {
    setBusy(true); setMsg(undefined);
    try {
      const body = {
        enabled: f.mode === 'sso', provider: f.provider, label: f.label || undefined,
        issuer: oidcKind ? issuerFor(f.provider, f) : '', clientId: oidcKind ? f.clientId : '', clientSecret: f.clientSecret || undefined,
        samlEntryPoint: oidcKind ? '' : f.samlEntryPoint, samlIdpIssuer: oidcKind ? '' : f.samlIdpIssuer, samlCert: oidcKind ? '' : f.samlCert,
        allowedDomains: f.domains.split(/[\s,;]+/).map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean),
        passwordLogin: f.mode === 'sso' ? f.passwordLogin : 'everyone', autoCreate: f.autoCreate, defaultRoleId: f.defaultRoleId || undefined,
      };
      const r = await api<Omit<View, 'roles'>>('/admin/sso', { method: 'PUT', body });
      setV((old) => old && { ...old, ...r }); setF(formOf(r.sso));
      setMsg({ kind: 'success', text: f.mode === 'sso' ? (r.sso?.verifiedAt ? 'Saved.' : 'Saved. Now use “Test sign-in” to check it works.') : 'Saved. Staff sign in with their VendorGate password.' });
    } catch (e: any) { setMsg({ kind: 'error', text: e.message }); } finally { setBusy(false); }
  }
  async function check() {
    const r = await api<{ ok: boolean; message: string }>('/admin/sso/check', { method: 'POST' }).catch((e) => ({ ok: false, message: e.message }));
    setMsg({ kind: r.ok ? 'success' : 'error', text: r.message });
  }
  const testUrl = `/api/auth/sso/start?workspace=${encodeURIComponent(me?.tenant.slug ?? '')}&next=${encodeURIComponent('/staff/admin/sign-in?sso=ok')}`;

  if (!v) return <div className="page">{msg ? <Alert kind="error">{msg.text}</Alert> : <div className="spinner" />}</div>;
  return (
    <div className="page">
      <header className="page-head"><div><h1>Sign-in &amp; single sign-on</h1><p className="muted">How your staff sign in to VendorGate. Suppliers are not affected — they sign in with codes sent by email.</p></div></header>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

      <section className="card pad">
        <h3 className="card-title">How staff sign in</h3>
        <div className="entry-modes">
          <label className={`check-item entry-mode ${f.mode === 'password' ? 'on' : ''}`}><input type="radio" name="mode" checked={f.mode === 'password'} onChange={() => set({ mode: 'password' })} />
            <span><strong>VendorGate password and two-factor authentication</strong><span className="muted small block">Users set a password from their invitation. Two-factor: {v.requireMfa ? 'required for everyone' : 'optional'} — change it in <Link to="/staff/admin/workspace">Workspace settings</Link>.</span></span></label>
          <label className={`check-item entry-mode ${f.mode === 'sso' ? 'on' : ''}`}><input type="radio" name="mode" checked={f.mode === 'sso'} onChange={() => set({ mode: 'sso' })} />
            <span><strong>Single sign-on with your company’s identity provider</strong><span className="muted small block">Staff use their work account (Microsoft, Okta, Google or any SAML / OpenID Connect provider). Two-factor and password rules come from your provider.</span></span></label>
        </div>
      </section>

      {f.mode === 'sso' && (<>
        <section className="card pad">
          <h3 className="card-title">Identity provider</h3>
          <div className="provider-grid">
            {PROVIDERS.map((p) => (
              <button type="button" key={p.key} className={`provider-card ${f.provider === p.key ? 'on' : ''}`} onClick={() => set({ provider: p.key })}>
                <strong>{p.title}</strong><span className="muted small">{p.sub}</span>
              </button>
            ))}
          </div>

          <div className="sso-register">
            <p className="small"><strong>1. Register VendorGate in your provider</strong> {f.provider === 'entra' ? '(Entra admin centre → App registrations → New registration → Web platform)' : f.provider === 'okta' ? '(Okta admin → Applications → Create App Integration → OIDC, Web Application)' : f.provider === 'google' ? '(Google Cloud console → APIs & Services → Credentials → OAuth client ID, Web application; consent screen “Internal”)' : f.provider === 'saml' ? '(create a SAML application, or upload the metadata file)' : ''}:</p>
            {oidcKind ? <Copy label="Redirect URI" value={v.provider.redirectUri} /> : (<>
              <Copy label="ACS / Reply URL" value={v.provider.samlAcsUrl} />
              <Copy label="Entity ID / Audience" value={v.provider.samlEntityId} />
              <Copy label="Metadata URL" value={v.provider.samlMetadataUrl} />
              <p className="muted small">Name ID: email address. Send the email (and display name) as attributes; sign the assertion.</p>
            </>)}
          </div>

          <p className="small" style={{ marginTop: 14 }}><strong>2. Copy these from your provider</strong></p>
          <div className="field-grid">
            {f.provider === 'entra' && <div className="field"><label>Directory (tenant) ID</label><input value={f.entraTenant} onChange={(e) => set({ entraTenant: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" /></div>}
            {f.provider === 'okta' && (<>
              <div className="field"><label>Okta domain</label><input value={f.oktaDomain} onChange={(e) => set({ oktaDomain: e.target.value })} placeholder="yourcompany.okta.com" /></div>
              <label className="check-item"><input type="checkbox" checked={f.oktaCustomServer} onChange={(e) => set({ oktaCustomServer: e.target.checked })} /><span className="small">Use the “default” custom authorization server</span></label>
            </>)}
            {f.provider === 'oidc' && <div className="field field-wide"><label>Issuer URL</label><input value={f.issuer} onChange={(e) => set({ issuer: e.target.value })} placeholder="https://login.example.com" /></div>}
            {oidcKind && (<>
              <div className="field"><label>{f.provider === 'entra' ? 'Application (client) ID' : 'Client ID'}</label><input value={f.clientId} onChange={(e) => set({ clientId: e.target.value })} /></div>
              <div className="field"><label>Client secret</label><input type="password" value={f.clientSecret} onChange={(e) => set({ clientSecret: e.target.value })} placeholder={v.sso?.hasClientSecret ? 'Saved — leave empty to keep' : ''} autoComplete="new-password" /></div>
            </>)}
            {!oidcKind && (<>
              <div className="field field-wide"><label>Sign-in URL (SSO URL)</label><input value={f.samlEntryPoint} onChange={(e) => set({ samlEntryPoint: e.target.value })} placeholder="https://idp.example.com/sso/saml" /></div>
              <div className="field"><label>Identity provider entity ID (Issuer)</label><input value={f.samlIdpIssuer} onChange={(e) => set({ samlIdpIssuer: e.target.value })} /></div>
              <div className="field field-wide"><label>Signing certificate</label><textarea rows={5} value={f.samlCert} onChange={(e) => set({ samlCert: e.target.value })} placeholder="-----BEGIN CERTIFICATE-----" className="mono small" /></div>
            </>)}
            {oidcKind && f.provider !== 'google' && <p className="muted small field-wide">Issuer: <code>{issuerFor(f.provider, f) || '—'}</code></p>}
          </div>
        </section>

        <section className="card pad">
          <h3 className="card-title">Who can sign in</h3>
          <div className="field-grid">
            <div className="field field-wide"><label>Allowed email domains</label><input value={f.domains} onChange={(e) => set({ domains: e.target.value })} placeholder="acme.com, acme.in" />
              <div className="field-help">Only addresses at these domains can sign in through single sign-on. Leave empty to allow any address your provider vouches for.</div></div>
          </div>
          <label className="check-item"><input type="checkbox" checked={f.autoCreate} onChange={(e) => set({ autoCreate: e.target.checked })} />
            <span><strong>Create a VendorGate user on first sign-in</strong><span className="muted small block">Otherwise people must be added under Users first (they skip the password step and sign in with single sign-on).</span></span></label>
          {f.autoCreate && <div className="field" style={{ maxWidth: 320, marginTop: 8 }}><label>Role for new users</label>
            <select value={f.defaultRoleId} onChange={(e) => set({ defaultRoleId: e.target.value })}><option value="">Choose…</option>{v.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>}
        </section>

        <section className="card pad">
          <h3 className="card-title">Password sign-in</h3>
          <div className="entry-modes">
            {([['everyone', 'Keep it for everyone', 'Staff can use either single sign-on or their VendorGate password.'],
              ['admins', 'Administrators only (recommended)', 'Everyone else must use single sign-on. Admins keep a password as a way in if your provider is down.'],
              ['off', 'Off', verified ? 'Only single sign-on. If your provider is down, contact VendorGate support.' : 'Available after an administrator has signed in once through single sign-on with these settings (Test sign-in).']] as [PasswordLogin, string, string][]).map(([k, title, text]) => (
              <label key={k} className={`check-item entry-mode ${f.passwordLogin === k ? 'on' : ''} ${k === 'off' && !verified ? 'locked' : ''}`}>
                <input type="radio" name="pw" disabled={k === 'off' && !verified} checked={f.passwordLogin === k} onChange={() => set({ passwordLogin: k })} />
                <span><strong>{title}</strong><span className="muted small block">{text}</span></span></label>
            ))}
          </div>
          <div className="field" style={{ maxWidth: 360, marginTop: 10 }}><label>Button text on the sign-in page (optional)</label><input value={f.label} onChange={(e) => set({ label: e.target.value })} placeholder={v.sso?.buttonLabel ?? 'Sign in with Microsoft'} /></div>
        </section>

        <section className="card pad">
          <h3 className="card-title">Status</h3>
          <p className="small">{!v.sso?.enabled ? 'Not switched on yet.' : verified ? <>✓ Working — {v.sso!.verifiedBy} signed in through single sign-on on {fmtDateTime(v.sso!.verifiedAt!)}.</> : 'Saved, not yet tested. Use “Test sign-in”.'}</p>
          <div className="btn-row">
            {oidcKind && v.sso?.enabled && <button type="button" className="btn btn-secondary btn-sm" disabled={dirty} onClick={check}>Check connection</button>}
            {v.sso?.enabled && <a className={`btn btn-secondary btn-sm ${dirty ? 'disabled' : ''}`} href={dirty ? undefined : testUrl} title={dirty ? 'Save first' : 'Sign in through your provider; you come back here.'}>Test sign-in</a>}
          </div>
          <p className="muted small">Share this sign-in link with staff: <code>{v.provider.signInUrl}</code></p>
        </section>
      </>)}

      <div className="form-foot"><span className="grow" /><button className="btn btn-primary" disabled={busy || !dirty} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div>
    </div>
  );
}
