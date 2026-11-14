import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { applyBranding } from '../lib/session';
import type { Branding } from '../lib/types';
import { Alert } from '../components/ui';
import { SupplierPublicCard } from '../components/SupplierPublicCard';
import { preferredLang, setLang, t, useLang, type Lang } from '../i18n';
import { LangSwitch } from '../i18n/LangSwitch';
import { Rich } from '../i18n/Rich';

type VT = 'DOMESTIC' | 'IMPORT' | 'GOVERNMENT';
interface Page {
  buyer: { name: string; branding: Branding; languages?: Lang[]; defaultLanguage?: Lang };
  link: { name: string; intro: string | null; vendorType: VT | null };
  vendorTypes: { value: VT; label: string }[];
  mobileExample?: string;
  registrationId: { label: string; placeholder?: string } | null;
}
const blank = { name: '', vendorType: 'DOMESTIC' as VT, contactFirstName: '', contactLastName: '', contactEmail: '', contactMobile: '', registrationId: '', website: '', supplies: '', message: '', company: '' };

/** Public "Become a supplier" page: application → email code → sent. */
export function Apply() {
  const { slug = '' } = useParams();
  const lang = useLang();
  const [page, setPage] = useState<Page>();
  const [closed, setClosed] = useState<string>();
  const [f, setF] = useState(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ id: string; devOtp?: string }>();
  const [code, setCode] = useState('');
  const [done, setDone] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<Page>(`/apply/${slug}`).then((p) => {
      setPage(p); applyBranding(p.buyer.branding); setLang(preferredLang(p.buyer.languages, p.buyer.defaultLanguage));
      if (p.link.vendorType) setF((x) => ({ ...x, vendorType: p.link.vendorType! }));
    }).catch((e) => setClosed(e.message));
  }, [slug]);
  useEffect(() => { if (sent) codeRef.current?.focus(); }, [sent]);

  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => { setF({ ...f, [k]: e.target.value }); setErrors((x) => ({ ...x, [k]: '' })); };
  const typeLabel = (v: { value: VT; label: string }) => (lang === 'ar' ? t(`apply.type.ar.${v.value}` as never) : v.label);

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined); setErrors({});
    try { setSent(await api(`/apply/${slug}`, { body: { ...f, language: lang } })); }
    catch (err: any) {
      if (err instanceof ApiError && Array.isArray(err.details)) {
        const map: Record<string, string> = {};
        for (const d of err.details as { path?: (string | number)[]; message: string }[]) if (d.path?.[0]) map[String(d.path[0])] = d.message;
        setErrors(map);
      }
      setError(err.message);
    } finally { setBusy(false); }
  }
  async function verify(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined);
    try { await api(`/apply/${slug}/${sent!.id}/verify`, { body: { code } }); setDone(true); }
    catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }
  async function resend() {
    setBusy(true); setError(undefined);
    try { const r = await api<{ devOtp?: string }>(`/apply/${slug}/${sent!.id}/resend`, { method: 'POST' }); setSent({ ...sent!, devOtp: r.devOtp ?? sent!.devOtp }); }
    catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }

  const field = (k: keyof typeof blank, label: string, props: Record<string, unknown> = {}) => (
    <div className={`field${errors[k] ? ' has-error' : ''}`}>
      <label htmlFor={`ap-${k}`}>{label}</label>
      <input id={`ap-${k}`} value={f[k]} onChange={set(k)} {...props} />
      {errors[k] && <div className="field-error">{errors[k]}</div>}
    </div>
  );
  const optional = (s: string) => `${s} (${t('common.optional')})`;

  return (
    <SupplierPublicCard branding={page?.buyer.branding} title={page ? t('apply.title', { buyer: page.buyer.name }) : t('apply.heading')} pitch={t('apply.pitch')} wide>
      {!page && !closed && <div className="spinner" />}
      {closed && <Alert kind="error">{closed}</Alert>}
      {page && (<>
        <div className="login-lang"><LangSwitch available={page.buyer.languages} /></div>
        {done ? (<>
          <h2>{t('apply.doneTitle')}</h2>
          <Alert kind="success"><Rich text={t('apply.done', { buyer: page.buyer.name, email: '{email}' })} values={{ email: <strong className="ltr">{f.contactEmail}</strong> }} /></Alert>
        </>) : sent ? (
          <form onSubmit={verify}>
            <h2>{t('apply.codeTitle')}</h2>
            <p className="muted"><Rich text={t('apply.codeSent', { email: '{email}' })} values={{ email: <strong className="ltr">{f.contactEmail}</strong> }} /></p>
            {sent.devOtp && <Alert kind="info"><Rich text={t('common.devCode', { code: '{code}' })} values={{ code: <strong className="mono">{sent.devOtp}</strong> }} /></Alert>}
            {error && <Alert kind="error">{error}</Alert>}
            <label htmlFor="ap-otp" className="sr-only">{t('common.oneTimeCode')}</label>
            <input id="ap-otp" ref={codeRef} className="otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="••••••" />
            <button className="btn btn-primary btn-block" disabled={busy || code.length !== 6}>{busy ? t('login.verifying') : t('apply.confirm')}</button>
            <button type="button" className="link-btn small" onClick={resend} disabled={busy}>{t('common.resendCode')}</button>
          </form>
        ) : (
          <form onSubmit={submit} className="apply-form">
            <h2>{t('apply.heading')}</h2>
            {page.link.intro && <p className="muted">{page.link.intro}</p>}
            {error && !Object.values(errors).some(Boolean) && <Alert kind="error">{error}</Alert>}
            {field('name', t('apply.company'), { required: true, maxLength: 200, autoComplete: 'organization' })}
            {!page.link.vendorType && (
              <div className="field"><label htmlFor="ap-type">{t('apply.type')}</label>
                <select id="ap-type" value={f.vendorType} onChange={set('vendorType')}>{page.vendorTypes.map((v) => <option key={v.value} value={v.value}>{typeLabel(v)}</option>)}</select></div>
            )}
            <div className="field-grid">
              {field('contactFirstName', t('apply.firstName'), { required: true, autoComplete: 'given-name' })}
              {field('contactLastName', t('apply.lastName'), { required: true, autoComplete: 'family-name' })}
              {field('contactEmail', t('apply.email'), { required: true, type: 'email', autoComplete: 'email', dir: 'ltr' })}
              {field('contactMobile', t('apply.mobile'), { required: true, type: 'tel', autoComplete: 'tel', dir: 'ltr', placeholder: f.vendorType === 'IMPORT' ? '+44 20 7946 0000' : page.mobileExample })}
            </div>
            <div className="field-grid">
              {page.registrationId && f.vendorType !== 'IMPORT' && field('registrationId', optional(page.registrationId.label), { maxLength: 40, dir: 'ltr', placeholder: page.registrationId.placeholder })}
              {field('website', optional(t('apply.website')), { maxLength: 200, dir: 'ltr', placeholder: 'www.example.com' })}
            </div>
            {field('supplies', t('apply.supplies'), { maxLength: 500 })}
            <div className="field"><label htmlFor="ap-message">{optional(t('apply.message'))}</label><textarea id="ap-message" rows={3} maxLength={1000} value={f.message} onChange={set('message')} /></div>
            {/* Hidden from people; bots fill it in. */}
            <div className="hp-field" aria-hidden="true"><label htmlFor="ap-company">Company</label><input id="ap-company" tabIndex={-1} autoComplete="off" value={f.company} onChange={set('company')} /></div>
            <p className="small muted">{t('apply.privacy')}</p>
            <button className="btn btn-primary btn-block" disabled={busy}>{busy ? t('common.sending') : t('apply.send')}</button>
          </form>
        )}
      </>)}
    </SupplierPublicCard>
  );
}
