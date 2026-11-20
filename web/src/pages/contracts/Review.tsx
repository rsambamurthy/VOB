/**
 * The other party's view of a contract: read the version sent, comment on clauses, propose wording, upload a marked-up
 * copy, accept or ask for changes, and sign. One component (ContractReview) for both ways in:
 *   /review/:token → code → /review         people who got an email link (customers, suppliers not onboarded)
 *   /vendor/contracts/:id                    onboarded suppliers in their supplier portal
 * English and Arabic (i18n keys review.*).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDate, fmtDateTime, fmtSize, money } from '../../lib/format';
import { Alert, Empty } from '../../components/ui';
import { useSupplier } from '../../orders/SupplierShell';
import { LangSwitch } from '../../i18n/LangSwitch';
import { t, useLang, type Key } from '../../i18n';

interface FileRef { id: string; fileName: string; size: number }
interface ReviewData {
  contract: { id: string; number: string; title: string; type: string; status: string; value: number | null; currency: string; startDate: string | null; endDate: string | null; signedDate: string | null };
  buyer: { name: string }; party: { name: string }; you: { name: string; email: string };
  versions: { id: string; number: number; sentAt: string; note: string | null; status: string; response: string | null; respondedByName: string | null; respondedAt: string | null; files: FileRef[] }[];
  signed: FileRef[];
  clauses: { group: string; number: number; title: string; text: string }[];
  comments: { id: string; clauseGroup: string | null; side: 'US' | 'PARTY'; authorName: string; text: string; proposedText: string | null; status: string; fileId: string | null; createdAt: string }[];
  canComment: boolean; canRespond: boolean;
  signing: { provider: string; kind: string; status: string; test: boolean; myTurn: boolean; signers: { name: string; side: string; status: string; signedAt: string | null }[] } | null;
}

export function ContractReview({ base }: { base: string }) {
  useLang();
  const [d, setD] = useState<ReviewData>();
  const [flash, setFlash] = useState<{ kind: 'success' | 'error'; text: string }>();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string>();
  const [draft, setDraft] = useState({ text: '', proposed: '', propose: false });
  const [answer, setAnswer] = useState<'ACCEPT' | 'CHANGES'>();
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File>();
  const load = useCallback(() => api<ReviewData>(base).then(setD).catch((e) => setFlash({ kind: 'error', text: e.message })), [base]);
  useEffect(() => {
    load();
    const s = new URLSearchParams(location.search).get('signing');
    if (s) setFlash(s === 'done' ? { kind: 'success', text: t('review.signedDone') } : { kind: 'error', text: t('review.signedFailed') });
  }, [load]);
  const run = async (fn: () => Promise<ReviewData | void>, ok = t('review.saved')) => {
    setBusy(true); setFlash(undefined);
    try { const r = await fn(); if (r) setD(r); setFlash({ kind: 'success', text: ok }); return true; } catch (e: any) { setFlash({ kind: 'error', text: e.message }); return false; } finally { setBusy(false); }
  };
  if (!d) return <div className="page">{flash ? <Alert kind={flash.kind}>{flash.text}</Alert> : <div className="spinner" />}</div>;
  const c = d.contract;
  const v = d.versions[0];
  const href = (id: string) => `/api${base}/files/${id}`;
  const files = (fs: FileRef[]) => <ul className="plain-list">{fs.map((f) => <li key={f.id}><a href={href(f.id)} target="_blank" rel="noreferrer">{f.fileName}</a> <span className="muted small">{fmtSize(f.size)}</span></li>)}</ul>;
  const comment = (group: string | null) => run(() => api<ReviewData>(`${base}/comments`, { body: { clauseGroup: group, text: draft.text, proposedText: draft.propose ? draft.proposed : null } })).then((ok) => { if (ok) { setOpen(undefined); setDraft({ text: '', proposed: '', propose: false }); } });
  const thread = (group: string | null) => d.comments.filter((k) => k.clauseGroup === group);
  const commentList = (group: string | null) => <>{thread(group).map((k) => (
    <div key={k.id} className="card pad" style={{ margin: '8px 0', background: k.side === 'PARTY' ? 'var(--surface-2, #f7f8fb)' : undefined }}>
      <div className="small"><b>{k.side === 'PARTY' ? (k.authorName.startsWith(d.you.name) ? t('review.you') : k.authorName) : d.buyer.name}</b> · <span className="muted">{fmtDateTime(k.createdAt)}</span>
        {k.status !== 'OPEN' && <span className={`badge sm ${k.status === 'ACCEPTED' ? 'badge-approved' : k.status === 'DECLINED' ? 'badge-rejected' : ''}`} style={{ marginInlineStart: 6 }}>{t(`review.commentStatus.${k.status}` as Key)}</span>}</div>
      <div style={{ whiteSpace: 'pre-wrap' }}>{k.text}</div>
      {k.proposedText && <div className="small" style={{ marginTop: 6, borderInlineStart: '3px solid var(--accent, #3b5bdb)', paddingInlineStart: 8 }}><b>{t('review.proposedWording')}:</b> {k.proposedText}</div>}
      {k.fileId && <a className="small" href={href(k.fileId)} target="_blank" rel="noreferrer">{t('review.download')}</a>}
    </div>))}</>;
  const composer = (group: string | null, text?: string) => (
    <div style={{ marginTop: 8 }}>
      <div className="field"><label htmlFor={`rc-${group ?? 'gen'}`}>{t('review.yourComment')}</label><textarea id={`rc-${group ?? 'gen'}`} rows={3} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} /></div>
      {group && <label className="check-item"><input type="checkbox" checked={draft.propose} onChange={(e) => setDraft({ ...draft, propose: e.target.checked, proposed: draft.proposed || text || '' })} /> <span>{t('review.proposeWording')}</span></label>}
      {draft.propose && <div className="field"><label htmlFor={`rp-${group}`}>{t('review.proposedWording')}</label><textarea id={`rp-${group}`} rows={6} value={draft.proposed} onChange={(e) => setDraft({ ...draft, proposed: e.target.value })} /></div>}
      <div className="btn-row"><button className="btn btn-secondary btn-sm" onClick={() => setOpen(undefined)}>{t('review.cancel')}</button><button className="btn btn-primary btn-sm" disabled={busy || draft.text.trim().length < 2} onClick={() => comment(group)}>{t('review.post')}</button></div>
    </div>
  );
  return (
    <div className="page">
      <header className="page-head"><div>
        <h1>{c.title}</h1>
        <p className="muted"><span className="mono">{c.number}</span> · {c.type} · {t('review.from', { buyer: d.buyer.name })} · <span className={`badge sm ${c.status === 'ACTIVE' ? 'badge-approved' : 'badge-under_review'}`}>{t(`review.status.${c.status}` as Key)}</span></p>
      </div></header>
      {flash && <Alert kind={flash.kind}>{flash.text}</Alert>}

      {d.signing && (
        <section className="card pad section-card" aria-label={t('review.signing')}>
          <h3>{t('review.signing')}</h3>
          {d.signing.test && <p className="small" style={{ color: '#9a2a2a', marginTop: 0 }}>{t('review.testNote')}</p>}
          <ol className="plain-list">{d.signing.signers.map((s, i) => <li key={i}>{s.name} <span className="muted small">({s.side === 'PARTY' ? d.party.name : d.buyer.name})</span> — <span className={`badge sm ${s.status === 'SIGNED' ? 'badge-approved' : s.status === 'DECLINED' ? 'badge-rejected' : ''}`}>{t(`review.signer.${s.status}` as Key)}</span>{s.signedAt && <span className="muted small"> {fmtDateTime(s.signedAt)}</span>}</li>)}</ol>
          {d.signing.myTurn ? <><p><b>{t('review.yourTurn')}</b></p><button className="btn btn-primary" disabled={busy} onClick={async () => { setBusy(true); try { window.location.href = (await api<{ url: string }>(`${base}/sign`, { method: 'POST' })).url; } catch (e: any) { setFlash({ kind: 'error', text: e.message }); setBusy(false); } }}>{d.signing.test ? t('review.sign') : t('review.signWith', { provider: d.signing.provider })}</button></>
            : d.signing.status === 'SENT' && d.signing.kind === 'email' && <p className="muted small">{t('review.signByEmail', { provider: d.signing.provider })}</p>}
        </section>
      )}
      {d.signed.length > 0 && <section className="card pad section-card"><h3>{t('review.signedCopy')}</h3>{files(d.signed)}</section>}

      <div className="detail-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)', gap: 16, alignItems: 'start' }}>
        <div>
          {v && <section className="card pad section-card">
            <h3>{t('review.version', { n: v.number })} <span className="muted small" style={{ fontWeight: 400 }}>{t('review.sentOn', { date: fmtDate(v.sentAt) })}</span></h3>
            {v.note && <p><b>{t('review.noteFromBuyer', { buyer: d.buyer.name })}:</b> {v.note}</p>}
            {files(v.files)}
            {v.respondedByName && <p className="small muted">{t(`review.answered.${v.status}` as Key, { name: v.respondedByName })}{v.response ? ` — ${v.response}` : ''}</p>}
            {d.canRespond && <div style={{ marginTop: 10 }}>
              <h4 style={{ margin: '0 0 6px' }}>{t('review.yourAnswer')}</h4>
              <div className="btn-row" style={{ justifyContent: 'flex-start' }}>
                <button className={`btn ${answer === 'ACCEPT' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setAnswer('ACCEPT')}>{t('review.accept')}</button>
                <button className={`btn ${answer === 'CHANGES' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setAnswer('CHANGES')}>{t('review.requestChanges')}</button>
              </div>
              {answer === 'ACCEPT' && <p className="small muted">{t('review.acceptHelp', { buyer: d.buyer.name })}</p>}
              {answer === 'CHANGES' && <div className="field"><label htmlFor="rv-note">{t('review.changesNote')}</label><textarea id="rv-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></div>}
              {answer && <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api<ReviewData>(`${base}/respond`, { body: { decision: answer, note: note || undefined } })).then((ok) => ok && setAnswer(undefined))}>{t('review.sendAnswer')}</button>}
            </div>}
          </section>}

          {d.clauses.length > 0 && <section className="card pad section-card">
            <h3>{t('review.clauses')}</h3>
            {d.clauses.map((x) => (
              <div key={x.group} style={{ borderTop: '1px solid var(--border, #e5e7ef)', padding: '10px 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><b>{x.number}. {x.title}</b>
                  {d.canComment && open !== x.group && <button className="link-btn small" aria-label={`${t('review.comment')}: ${x.title}`} onClick={() => { setOpen(x.group); setDraft({ text: '', proposed: x.text, propose: false }); }}>{t('review.comment')}</button>}</div>
                <div className="small" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{x.text}</div>
                {commentList(x.group)}
                {open === x.group && composer(x.group, x.text)}
              </div>))}
          </section>}
        </div>
        <div>
          <section className="card pad section-card">
            <h3>{t('review.comments')}</h3>
            {thread(null).length === 0 && !d.comments.length && <p className="muted small">{t('review.noComments')}</p>}
            {commentList(null)}
            {d.canComment ? (open === '__general' ? composer(null) : <button className="link-btn small" onClick={() => { setOpen('__general'); setDraft({ text: '', proposed: '', propose: false }); }}>+ {t('review.generalComment')}</button>)
              : <p className="muted small">{t('review.closed')}</p>}
          </section>
          {d.canComment && <section className="card pad section-card">
            <h3>{t('review.uploadTitle')}</h3>
            <p className="muted small" style={{ marginTop: 0 }}>{t('review.uploadHelp')}</p>
            <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>{file ? file.name : t('review.chooseFile')}<input type="file" hidden accept=".docx,.pdf" aria-label={t('review.uploadTitle')} onChange={(e) => setFile(e.target.files?.[0])} /></label>
            {file && <div className="btn-row"><button className="btn btn-primary btn-sm" disabled={busy} onClick={() => { const fd = new FormData(); fd.append('file', file); run(() => api<ReviewData>(`${base}/upload`, { body: fd })).then((ok) => ok && setFile(undefined)); }}>{t('review.upload')}</button></div>}
          </section>}
          <section className="card pad section-card"><dl className="kv">
            {c.value !== null && <><dt>{t('review.value')}</dt><dd>{money(c.value, c.currency)}</dd></>}
            <dt>{t('review.term')}</dt><dd>{fmtDate(c.startDate)} – {c.endDate ? fmtDate(c.endDate) : t('review.noEnd')}</dd>
          </dl></section>
        </div>
      </div>
    </div>
  );
}

/* ---------- email link: sign in with a code ---------- */

export function ReviewSignIn() {
  useLang();
  const { token } = useParams();
  const nav = useNavigate();
  const [info, setInfo] = useState<{ contract: { number: string; title: string }; email: string; buyer: { name: string } }>();
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState<string>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<typeof info>(`/review/link/${token}`).then(setInfo).catch(() => setError('invalid')); }, [token]);
  const go = async (fn: () => Promise<void>) => { setBusy(true); setError(undefined); try { await fn(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  return (
    <div className="auth-page"><div className="auth-card card pad" style={{ maxWidth: 460, margin: '8vh auto' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}><LangSwitch available={['en', 'ar']} /></div>
      {error === 'invalid' || !info ? (error ? <Alert kind="error">{t('review.linkInvalid')}</Alert> : <div className="spinner" />) : <>
        <h1 style={{ fontSize: 22 }}>{t('review.signInTitle', { number: info.contract.number })}</h1>
        <p className="muted">{t('review.signInIntro', { buyer: info.buyer.name, title: info.contract.title, email: info.email })}</p>
        {error && <Alert kind="error">{error}</Alert>}
        {!sent ? <button className="btn btn-primary" disabled={busy} onClick={() => go(async () => { const r = await api<{ sentTo: string; devOtp?: string }>(`/review/link/${token}/code`, { body: {} }); setSent(r.sentTo); if (r.devOtp) setCode(r.devOtp); })}>{t('review.sendCode')}</button> : <>
          <p className="small">{t('review.codeSent', { to: sent })}</p>
          <div className="field"><label htmlFor="rv-code">{t('review.code')}</label><input id="rv-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} /></div>
          <button className="btn btn-primary" disabled={busy || code.length !== 6} onClick={() => go(async () => { await api(`/review/link/${token}/verify`, { body: { code } }); nav('/review', { replace: true }); })}>{t('review.open')}</button>
        </>}
      </>}
    </div></div>
  );
}
/** /review — the contract for someone signed in through an email link. */
export function ReviewPage() {
  useLang();
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #f3f5fa)' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 16px' }}>
        <LangSwitch available={['en', 'ar']} />
        <button className="btn btn-secondary btn-sm" onClick={async () => { await api('/review/sign-out', { method: 'POST' }).catch(() => {}); location.href = '/'; }}>{t('review.signOut')}</button>
      </div>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}><ContractReview base="/review/session" /></div>
    </div>
  );
}

/* ---------- supplier portal ---------- */

export function SupplierContracts() {
  useLang();
  const { info } = useSupplier();
  const [list, setList] = useState<{ id: string; number: string; title: string; type: string; status: string; endDate: string | null }[]>();
  useEffect(() => { api<{ contracts: NonNullable<typeof list> }>('/vendor/contracts').then((r) => setList(r.contracts)).catch(() => setList([])); }, []);
  return (
    <div className="page">
      <header className="page-head"><div><h1>{t('review.listTitle')}</h1><p className="muted">{t('review.listIntro', { buyer: info?.buyer.name ?? '' })}</p></div></header>
      {!list ? <div className="spinner" /> : !list.length ? <Empty>{t('review.listEmpty')}</Empty> : (
        <table className="table"><tbody>{list.map((c) => (
          <tr key={c.id}><td><Link to={`/vendor/contracts/${c.id}`}>{c.title}</Link><div className="muted small mono">{c.number}</div></td><td className="small">{c.type}</td>
            <td><span className={`badge sm ${c.status === 'ACTIVE' ? 'badge-approved' : 'badge-under_review'}`}>{t(`review.status.${c.status}` as Key)}</span></td></tr>))}</tbody></table>)}
    </div>
  );
}
export function SupplierContract() {
  const { id } = useParams();
  return <ContractReview base={`/vendor/contracts/${id}`} />;
}
