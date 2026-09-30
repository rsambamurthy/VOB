import { useRef, useState } from 'react';
import type { DocRequirement, DocumentRow } from '../lib/types';
import { docUrl, type Session } from '../lib/api';
import { fmtSize, fmtDate } from '../lib/format';

interface Props {
  requirements: DocRequirement[];
  documents: DocumentRow[];
  session: Session;
  editable?: boolean;
  onUpload?: (docType: string, file: File) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}

export function DocumentsPanel({ requirements, documents, session, editable, onUpload, onDelete }: Props) {
  return (
    <div className="doc-list">
      {requirements.map((r) => (
        <DocRow key={r.type} req={r} files={documents.filter((d) => d.docType === r.type)} session={session} editable={editable} onUpload={onUpload} onDelete={onDelete} />
      ))}
    </div>
  );
}

function DocRow({ req, files, session, editable, onUpload, onDelete }: { req: DocRequirement; files: DocumentRow[] } & Omit<Props, 'requirements' | 'documents'>) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const missing = req.isRequired && files.length === 0;

  async function handle(file?: File | null) {
    if (!file || !onUpload) return;
    setBusy(true);
    try { await onUpload(req.type, file); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  }

  return (
    <div className={`doc-row ${missing ? 'doc-missing' : ''}`}>
      <div className="doc-info">
        <div className="doc-title">{req.label}{req.isRequired ? <span className="req"> *</span> : <span className="muted small"> (optional)</span>}</div>
        {req.help && <div className="field-help">{req.help}</div>}
        {files.map((f) => (
          <div key={f.id} className="doc-file">
            <span className="file-icon" aria-hidden>{f.mimeType === 'application/pdf' ? 'PDF' : 'IMG'}</span>
            <a href={docUrl(f.id, session)} target="_blank" rel="noreferrer">{f.fileName}</a>
            <span className="muted small">{fmtSize(f.size)} · {fmtDate(f.uploadedAt)}</span>
            {editable && onDelete && <button type="button" className="link-btn danger small" onClick={() => onDelete(f.id)}>Remove</button>}
          </div>
        ))}
        {!files.length && !editable && <div className="muted small">Not uploaded</div>}
      </div>
      {editable && (
        <div
          className={`dropzone ${drag ? 'drag' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files[0]); }}
        >
          <input ref={input} type="file" accept=".pdf,.png,.jpg,.jpeg" hidden onChange={(e) => handle(e.target.files?.[0])} aria-label={`Upload ${req.label}`} />
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? 'Uploading…' : files.length ? 'Add another' : 'Upload'}
          </button>
          <span className="muted small">or drop file · PDF/JPG/PNG · max 5 MB</span>
        </div>
      )}
    </div>
  );
}
