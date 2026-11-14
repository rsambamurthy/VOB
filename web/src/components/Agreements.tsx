import { useState } from 'react';
import type { AgreementView } from '../lib/types';
import { Alert } from './ui';
import { t } from '../i18n';
import { fmtDate } from '../lib/format';

export const agreementFileUrl = (versionId: string) => `/api/agreements/versions/${versionId}/file`;
export const certificateUrl = (acceptanceId: string) => `/api/agreements/acceptances/${acceptanceId}/certificate.pdf`;

type Signer = { signerName: string; signerDesignation: string };

/**
 * The agreements on a supplier — one component for everyone who sees them:
 *  - the supplier in the portal (onAccept: read, tick "I agree", name and designation);
 *  - a buyer filling in for the supplier (onSignedCopy: who signed + the signed copy);
 *  - reviewers (neither: status, version and certificate only).
 */
export function AgreementsPanel({ agreements, vendorName, buyer, defaultSigner, onAccept, onSignedCopy }: {
  agreements: AgreementView[]; vendorName: string; buyer?: string; defaultSigner?: string;
  onAccept?: (a: AgreementView, signer: Signer) => Promise<void>;
  onSignedCopy?: (a: AgreementView, signer: Signer, file: File) => Promise<void>;
}) {
  if (!agreements.length) return null;
  return (
    <div className="stack">
      {buyer && onAccept && <p className="muted">{t('agr.intro', { buyer })}</p>}
      {agreements.map((a) => <AgreementCard key={`${a.id}-${a.current.id}`} a={a} vendorName={vendorName} defaultSigner={defaultSigner} onAccept={onAccept} onSignedCopy={onSignedCopy} />)}
    </div>
  );
}

function AgreementCard({ a, vendorName, defaultSigner, onAccept, onSignedCopy }: { a: AgreementView; vendorName: string; defaultSigner?: string; onAccept?: (a: AgreementView, s: Signer) => Promise<void>; onSignedCopy?: (a: AgreementView, s: Signer, f: File) => Promise<void> }) {
  const [name, setName] = useState(defaultSigner ?? '');
  const [designation, setDesignation] = useState('');
  const [agree, setAgree] = useState(false);
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const acc = a.accepted;
  const signerOk = name.trim().length >= 3 && designation.trim().length >= 2;
  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr(undefined);
    try { await fn(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <div className={`agreement-card ${a.outstanding ? 'open' : 'done'}`}>
      <div className="row-between">
        <div>
          <strong>{a.title}</strong> <span className={`badge sm ${a.required ? 'flag-medium' : ''}`}>{a.required ? t('agr.required') : t('agr.optional')}</span>
          <span className="muted small"> · {t('agr.version', { version: a.current.version })}</span>
        </div>
        {a.outstanding ? <span className="badge sm flag-high">{t('agr.toAccept')}</span> : acc && <span className="ok-text">✓</span>}
      </div>
      {acc && (
        <p className="small muted agreement-status">
          {t('agr.acceptedBy', { name: acc.signerName, designation: acc.signerDesignation, date: fmtDate(acc.acceptedAt) })} · {t('agr.version', { version: acc.version })}
          {acc.recordedByName && <> · {t('agr.recordedBy', { name: acc.recordedByName })}</>}
          {' · '}<a href={certificateUrl(acc.id)}>{t('agr.certificate')}</a>
        </p>
      )}
      {a.outstanding && (<>
        {acc && acc.version < a.current.version && <Alert kind="info">{t('agr.olderAccepted', { version: acc.version })}{a.current.changeNote ? ` ${t('agr.whatChanged', { note: a.current.changeNote })}` : ''}</Alert>}
        {a.current.kind === 'TEXT'
          ? <div className="notice-text agreement-text" tabIndex={0}>{a.current.body}</div>
          : <p><a className="btn btn-secondary btn-sm" href={agreementFileUrl(a.current.id)} target="_blank" rel="noreferrer">{t('agr.openPdf')}</a> <span className="small muted">{t('agr.readPdf')}</span></p>}
        {err && <Alert kind="error">{err}</Alert>}
        {(onAccept || onSignedCopy) && (
          <div className="field-grid">
            <div className="field"><label htmlFor={`sn-${a.id}`}>{t('agr.yourName')}</label><input id={`sn-${a.id}`} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></div>
            <div className="field"><label htmlFor={`sd-${a.id}`}>{t('agr.designation')}</label><input id={`sd-${a.id}`} value={designation} maxLength={120} onChange={(e) => setDesignation(e.target.value)}/></div>
          </div>
        )}
        {onAccept && (
          <div className="row-between">
            <label className="check-item"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /><span className="small">{t('agr.agree', { title: a.title, vendor: vendorName })}</span></label>
            <button className="btn btn-primary" disabled={busy || !agree || !signerOk} onClick={() => run(() => onAccept(a, { signerName: name, signerDesignation: designation }))}>{busy ? t('agr.accepting') : t('agr.accept')}</button>
          </div>
        )}
        {onSignedCopy && (
          <div className="row-between">
            <label className="small">Signed copy (PDF or photo) <input type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => setFile(e.target.files?.[0])} /></label>
            <button className="btn btn-secondary" disabled={busy || !file || !signerOk} onClick={() => run(() => onSignedCopy(a, { signerName: name, signerDesignation: designation }, file!))}>{busy ? 'Saving…' : 'Record signed copy'}</button>
          </div>
        )}
      </>)}
    </div>
  );
}
