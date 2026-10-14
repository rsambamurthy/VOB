import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, lastWorkspace } from '../../lib/api';
import { useSession } from '../../lib/session';
import { Alert } from '../../components/ui';
import { PasswordHint } from '../auth/AuthLayout';
import { PoweredBy, Wordmark } from '../../components/Brand';

interface Config { enabled: boolean; plan: string; trialDays: number | null; termsUrl: string | null; workEmailOnly: boolean; countries?: { code: string; name: string }[] }

function SignupLayout({ cfg, children }: { cfg?: Config; children: ReactNode }) {
  return (
    <div className="center-page login-bg">
      <div className="card login-card split signup-card">
        <div className="login-side">
          <div className="brand brand-lg light"><Wordmark light size={30} /></div>
          <h2>Vendor onboarding your finance team can trust</h2>
          <ul className="signup-points">
            <li>Suppliers register themselves through a secure link</li>
            <li>Tax, company and bank checks before anyone approves (GSTIN and PAN in India; CR, trade licence and VAT in the Gulf)</li>
            <li>Approval levels, reminders and a full audit trail</li>
            <li>Approved vendors sent straight to your ERP</li>
          </ul>
          {cfg?.trialDays && <p className="signup-trial">Free for {cfg.trialDays} days. No card needed.</p>}
          <PoweredBy light />
        </div>
        <div className="login-main">{children}</div>
      </div>
    </div>
  );
}

/** Live workspace-ID availability (debounced). */
function useSlugCheck(slug: string) {
  const [state, setState] = useState<{ available: boolean; reason: string | null }>();
  useEffect(() => {
    if (!slug) { setState(undefined); return; }
    const t = setTimeout(() => api(`/signup/check-slug?slug=${encodeURIComponent(slug)}`).then(setState).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [slug]);
  return state;
}
const cleanSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);

export function Signup() {
  const [cfg, setCfg] = useState<Config>();
  const [f, setF] = useState({ company: '', name: '', email: '', slug: '', country: 'IN', agree: false, website: '' });
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<{ text: string; field?: string }>();
  const [sentTo, setSentTo] = useState<string>();
  const [busy, setBusy] = useState(false);
  const slugState = useSlugCheck(f.slug);
  useEffect(() => { api('/signup/config').then(setCfg).catch(() => setCfg({ enabled: false, plan: '', trialDays: null, termsUrl: null, workEmailOnly: false })); }, []);
  useEffect(() => {
    if (slugTouched || f.company.trim().length < 2) return;
    const t = setTimeout(() => api(`/signup/check-slug?company=${encodeURIComponent(f.company)}`).then((r) => setF((x) => ({ ...x, slug: r.slug }))).catch(() => {}), 350);
    return () => clearTimeout(t);
  }, [f.company, slugTouched]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined);
    try { const r = await api('/signup', { body: f }); setSentTo(r.email); }
    catch (err: any) {
      const d = err instanceof ApiError ? (err.details as { field?: string; suggestion?: string } | undefined) : undefined;
      if (d?.suggestion) { setF((x) => ({ ...x, slug: d.suggestion! })); setSlugTouched(true); }
      setError({ text: d?.suggestion ? `${err.message}. We’ve suggested another one.` : err.message, field: d?.field });
    } finally { setBusy(false); }
  }

  if (!cfg) return <div className="center-page"><div className="spinner" /></div>;
  if (!cfg.enabled) return (
    <SignupLayout>
      <h2 className="auth-title">Get started with <Wordmark /></h2>
      <p>We set up new workspaces personally at the moment. Write to us and we’ll have yours ready within a day.</p>
      <p className="small muted">Already have a workspace? <Link to="/login">Sign in</Link></p>
    </SignupLayout>
  );
  if (sentTo) return (
    <SignupLayout cfg={cfg}>
      <div className="stack">
        <div className="mail-icon" aria-hidden>✉</div>
        <h2 className="auth-title">Check your email</h2>
        <p>We’ve sent a link to <strong>{sentTo}</strong>. Open it to choose your password and finish creating your workspace.</p>
        <p className="small muted">The link works for 24 hours. Nothing there? Check spam or junk, or <button className="link-btn" onClick={() => setSentTo(undefined)}>try again</button>.</p>
      </div>
    </SignupLayout>
  );
  const fieldClass = (k: string) => `field ${error?.field === k ? 'has-error' : ''}`;
  return (
    <SignupLayout cfg={cfg}>
      <h2 className="auth-title">Create your workspace</h2>
      <p className="muted small">Already have one? <Link to="/login">Sign in</Link></p>
      {error && <Alert kind="error">{error.text}</Alert>}
      <form onSubmit={submit} className="stack" noValidate={false}>
        <div className={fieldClass('company')}><label htmlFor="su-c">Company name</label><input id="su-c" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} required maxLength={120} autoComplete="organization" autoFocus /></div>
        <div className={fieldClass('slug')}><label htmlFor="su-s">Workspace ID</label>
          <input id="su-s" className="mono" value={f.slug} onChange={(e) => { setSlugTouched(true); setF({ ...f, slug: cleanSlug(e.target.value) }); }} required minLength={3} maxLength={40} autoCapitalize="none" />
          <div className={`field-help ${slugState && !slugState.available ? 'err-text' : ''}`}>{slugState && !slugState.available ? slugState.reason : slugState?.available ? '✓ Available. Your team types this when they sign in.' : 'Your team types this when they sign in.'}</div></div>
        {(cfg?.countries?.length ?? 0) > 1 && (
          <div className={fieldClass('country')}><label htmlFor="su-co">Country</label>
            <select id="su-co" value={f.country} onChange={(e) => setF({ ...f, country: e.target.value })}>{cfg!.countries!.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select>
            <div className="field-help">Where your company buys from. Sets the supplier form, tax and bank checks, currency and privacy notice.</div></div>
        )}
        <div className={fieldClass('name')}><label htmlFor="su-n">Your name</label><input id="su-n" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={100} autoComplete="name" /></div>
        <div className={fieldClass('email')}><label htmlFor="su-e">Work email</label><input id="su-e" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required autoComplete="email" />
          {cfg.workEmailOnly && <div className="field-help">Use your company address — personal Gmail, Outlook.com or Yahoo addresses aren’t accepted.</div>}</div>
        {/* Honeypot: hidden from people, filled in by bots. */}
        <div className="hp" aria-hidden="true"><label htmlFor="su-w">Website</label><input id="su-w" tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} /></div>
        <label className="check-row small"><input type="checkbox" checked={f.agree} onChange={(e) => setF({ ...f, agree: e.target.checked })} required />
          <span>I agree to the {cfg.termsUrl ? <a href={cfg.termsUrl} target="_blank" rel="noreferrer">terms of service</a> : 'terms of service'} and confirm I may sign up on behalf of this company.</span></label>
        <button className="btn btn-primary btn-block" disabled={busy || slugState?.available === false}>{busy ? 'Sending…' : 'Continue'}</button>
        {cfg.trialDays && <p className="small muted center">{cfg.plan} plan · free for {cfg.trialDays} days</p>}
      </form>
    </SignupLayout>
  );
}

export function SignupVerify() {
  const { token = '' } = useParams();
  const nav = useNavigate();
  const { refresh } = useSession();
  const [info, setInfo] = useState<{ company: string; name: string; email: string; slug: string; slugAvailable: boolean; suggestion?: string }>();
  const [slug, setSlug] = useState('');
  const [pw, setPw] = useState({ password: '', confirm: '' });
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const [busy, setBusy] = useState(false);
  const slugState = useSlugCheck(info && !info.slugAvailable ? slug : '');
  useEffect(() => {
    api(`/signup/verify/${token}`).then((i) => { setInfo(i); setSlug(i.slugAvailable ? i.slug : i.suggestion ?? ''); })
      .catch((e) => { if (e instanceof ApiError && e.code === 'SIGNUP_DONE') setDone((e.details as any)?.workspace ?? ''); else setError(e.message); });
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw.password !== pw.confirm) return setError('Passwords don’t match');
    setBusy(true); setError(undefined);
    try {
      const r = await api('/signup/complete', { body: { token, password: pw.password, slug } });
      lastWorkspace.set(r.workspace);
      await refresh();
      nav('/staff/admin/workspace?welcome=1', { replace: true });
    } catch (err: any) {
      const d = err instanceof ApiError ? (err.details as { suggestion?: string } | undefined) : undefined;
      if (d?.suggestion) { setSlug(d.suggestion); setInfo((i) => i && { ...i, slugAvailable: false }); }
      setError(err.message); setBusy(false);
    }
  }
  return (
    <SignupLayout>
      {done !== undefined ? (
        <div className="stack"><h2 className="auth-title">Your workspace is ready</h2><p>This link has already been used to create the workspace.</p>
          <Link className="btn btn-primary btn-block" to={`/login?workspace=${encodeURIComponent(done)}`}>Sign in</Link></div>
      ) : !info ? (error ? <><Alert kind="error">{error}</Alert><Link to="/signup" className="small">Sign up again</Link></> : <div className="spinner" />) : (
        <>
          <h2 className="auth-title">Almost there, {info.name.split(' ')[0]}</h2>
          <p className="muted small">Email confirmed: <strong>{info.email}</strong></p>
          {error && <Alert kind="error">{error}</Alert>}
          <form onSubmit={submit} className="stack">
            <dl className="kv small"><dt>Company</dt><dd>{info.company}</dd>{info.slugAvailable && <><dt>Workspace ID</dt><dd className="mono">{slug}</dd></>}</dl>
            {!info.slugAvailable && (
              <div className="field"><label htmlFor="sv-s">Workspace ID</label>
                <input id="sv-s" className="mono" value={slug} onChange={(e) => setSlug(cleanSlug(e.target.value))} required />
                <div className={`field-help ${slugState && !slugState.available ? 'err-text' : ''}`}>{slugState && !slugState.available ? slugState.reason : `“${info.slug}” was taken in the meantime, so we’ve suggested another.`}</div></div>
            )}
            <div className="field"><label htmlFor="sv-p">Choose a password</label><input id="sv-p" type="password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} required autoComplete="new-password" autoFocus /><PasswordHint /></div>
            <div className="field"><label htmlFor="sv-c">Confirm password</label><input id="sv-c" type="password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required autoComplete="new-password" /></div>
            <input type="email" className="sr-only" tabIndex={-1} aria-hidden="true" autoComplete="username" value={info.email} readOnly />
            <button className="btn btn-primary btn-block" disabled={busy || slugState?.available === false}>{busy ? 'Creating your workspace…' : 'Create workspace'}</button>
          </form>
        </>
      )}
    </SignupLayout>
  );
}
