import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { applyBranding } from '../lib/session';
import type { Branding } from '../lib/types';
import { SupplierPublicCard } from '../components/SupplierPublicCard';
import { Alert } from '../components/ui';
import { getLang, preferredLang, setLang, t, useLang, type Lang } from '../i18n';
import { LangSwitch } from '../i18n/LangSwitch';
import { Rich } from '../i18n/Rich';

export function VendorLogin() {
  const { token = '' } = useParams();
  const nav = useNavigate();
  const [invite, setInvite] = useState<{ vendorName: string; email: string; language?: Lang; buyer: { name: string; branding: Branding; languages?: Lang[]; defaultLanguage?: Lang } }>();
  useLang();
  const [sent, setSent] = useState<{ sentTo: string; devOtp?: string }>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => { api(`/vendor-auth/invite/${token}`).then((i) => { setInvite(i); applyBranding(i.buyer.branding); setLang(preferredLang(i.buyer.languages, i.language ?? i.buyer.defaultLanguage)); }).catch((e) => setError(e.message)); }, [token]);

  async function requestOtp() {
    setBusy(true); setError(undefined);
    try { setSent(await api('/vendor-auth/request-otp', { body: { token, language: getLang() } })); setTimeout(() => codeRef.current?.focus(), 50); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try {
      await api('/vendor-auth/verify-otp', { body: { token, code, language: getLang() } });
      nav('/vendor');
    } catch (err: any) { setError(err.message); setBusy(false); }
  }

  return (
    <SupplierPublicCard branding={invite?.buyer.branding} title={invite ? t('login.registrationFor', { buyer: invite.buyer.name }) : t('login.registration')} pitch={t('login.registrationPitch')}>
          {!invite && !error && <div className="spinner" />}
          {error && !invite && <Alert kind="error">{error}</Alert>}
          {invite && (
            <>
              <div className="login-lang"><LangSwitch available={invite.buyer.languages} /></div>
              <h2>{t('login.welcome', { name: invite.vendorName })}</h2>
              {!sent ? (
                <>
                  <p className="muted"><Rich text={t('login.willSendTo', { email: '{email}' })} values={{ email: <strong className="ltr">{invite.email}</strong> }} /></p>
                  {error && <Alert kind="error">{error}</Alert>}
                  <button className="btn btn-primary btn-block" onClick={requestOtp} disabled={busy}>{busy ? t('common.sending') : t('common.sendCode')}</button>
                </>
              ) : (
                <form onSubmit={verify}>
                  <p className="muted"><Rich text={t('login.enterCodeSentTo', { to: '{to}' })} values={{ to: <strong className="ltr">{sent.sentTo}</strong> }} /></p>
                  {sent.devOtp && <Alert kind="info"><Rich text={t('common.devCode', { code: '{code}' })} values={{ code: <strong className="mono">{sent.devOtp}</strong> }} /></Alert>}
                  {error && <Alert kind="error">{error}</Alert>}
                  <label htmlFor="otp" className="sr-only">{t('common.oneTimeCode')}</label>
                  <input id="otp" ref={codeRef} className="otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="••••••" />
                  <button className="btn btn-primary btn-block" disabled={busy || code.length !== 6}>{busy ? t('login.verifying') : t('login.verifyContinue')}</button>
                  <button type="button" className="link-btn small" onClick={requestOtp} disabled={busy}>{t('common.resendCode')}</button>
                </form>
              )}
            </>
          )}
    </SupplierPublicCard>
  );
}
