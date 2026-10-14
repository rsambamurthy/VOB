import { useRef, useState } from 'react';
import type { DocRequirement, DocumentRow } from '../lib/types';
import { docUrl } from '../lib/api';
import { fmtSize, fmtDate } from '../lib/format';
import { ExpiryBadge } from './Lifecycle';
import { t } from '../i18n';
import { HijriHint } from '../i18n/dates';

interface Props {
  requirements: DocRequirement[];
  documents: DocumentRow[];
  editable?: boolean;
  onUpload?: (docType: string, file: File, expiresOn?: string) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  /** Per-file override of whether "Remove" is offered (defaults to `editable`). */
  canDelete?: (d: DocumentRow) => boolean;
  /** Show superseded / rejected files too (staff history view). */
  showHistory?: boolean;
  uploadLabel?: string;
}

const today = () => new Date().toISOString().slice(0, 10);

export function DocumentsPanel({ requirements, documents, showHistory, ...rest }: Props) {
  const visible = showHistory ? documents : documents.filter((d) => !d.status || d.status === 'ACTIVE' || d.status === 'PENDING');
  return (
    <div className="doc-list">
      {requirements.map((r) => (
        <DocRow key={r.type} req={r} files={visible.filter((d) => d.docType === r.type)} {...rest} />
      ))}
    </div>
  );
}

function DocRow({ req, files, editable, onUpload, onDelete, canDelete, uploadLabel }: { req: DocRequirement; files: DocumentRow[] } & Omit<Props, 'requirements' | 'documents' | 'showHistory'>) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [expiresOn, setExpiresOn] = useState('');
  const [err, setErr] = useState('');
  const current = files.filter((f) => !f.status || f.status === 'ACTIVE');
  const missing = req.isRequired && current.length === 0 && !files.some((f) => f.status === 'PENDING');

  async function handle(file?: File | null) {
    if (!file || !onUpload) return;
    if (req.hasExpiry && !expiresOn) { setErr(t('docs.enterValidUntil')); if (input.current) input.current.value = ''; return; }
    setErr(''); setBusy(true);
    try { await onUpload(req.type, file, req.hasExpiry ? expiresOn : undefined); setExpiresOn(''); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }

  return (
    <div className={`doc-row ${missing ? 'doc-missing' : ''}`}>
      <div className="doc-info">
        <div className="doc-title">{req.label}{req.isRequired ? <span className="req"> *</span> : <span className="muted small"> {t('docs.optional')}</span>}</div>
        {req.help && <div className="field-help">{req.help}</div>}
        {files.map((f) => {
          const old = f.status === 'SUPERSEDED' || f.status === 'REJECTED';
          return (
            <div key={f.id} className={`doc-file ${old ? 'doc-old' : ''}`}>
              <span className="file-icon" aria-hidden>{f.mimeType === 'application/pdf' ? 'PDF' : 'IMG'}</span>
              <a href={docUrl(f.id)} target="_blank" rel="noreferrer">{f.fileName}</a>
              <span className="muted small">{fmtSize(f.size)} · {fmtDate(f.uploadedAt)}</span>
              {f.status === 'PENDING' && <span className="badge step-pending" title={t('docs.takesEffect')}>{f.changeRequestId ? t('docs.awaitingApproval') : t('docs.notSubmitted')}</span>}
              {f.status === 'SUPERSEDED' && <span className="badge">{t('docs.replaced')}</span>}
              {f.status === 'REJECTED' && <span className="badge step-rejected">{t('docs.notAccepted')}</span>}
              {!old && <ExpiryBadge on={f.expiresOn} />}
              {(canDelete ? canDelete(f) : editable) && onDelete && <button type="button" className="link-btn danger small" onClick={() => onDelete(f.id)}>{t('common.remove')}</button>}
            </div>
          );
        })}
        {!files.length && !editable && <div className="muted small">{t('docs.notUploaded')}</div>}
      </div>
      {editable && (
        <div
          className={`dropzone ${drag ? 'drag' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files[0]); }}
        >
          {req.hasExpiry && (
            <label className="expiry-input small">{t('docs.validUntil')} <span className="req">*</span>
              <input type="date" className="input input-sm" min={today()} value={expiresOn} onChange={(e) => { setExpiresOn(e.target.value); setErr(''); }} aria-label={t('docs.validUntilFor', { doc: req.label })} />
              <HijriHint date={expiresOn} />
            </label>
          )}
          <input ref={input} type="file" accept=".pdf,.png,.jpg,.jpeg" hidden onChange={(e) => handle(e.target.files?.[0])} aria-label={t('docs.uploadFor', { doc: req.label })} />
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => (req.hasExpiry && !expiresOn ? setErr(t('docs.enterValidUntil')) : input.current?.click())}>
            {busy ? t('docs.uploading') : uploadLabel ?? (files.length ? t('docs.addAnother') : t('docs.upload'))}
          </button>
          {err ? <span className="small err-text">{err}</span> : <span className="muted small">{t('docs.dropHint')}</span>}
        </div>
      )}
    </div>
  );
}
