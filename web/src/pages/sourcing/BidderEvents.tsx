/** The supplier portal side of sourcing: My events, one event (terms, accept/decline, questions), outside-bidder registration. */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDateTime, money } from '../../lib/format';
import { Alert, Empty, Modal } from '../../components/ui';
import { clock, useCountdown, useLive } from '../../lib/live';
import { agreementFileUrl } from '../../components/Agreements';
import { useSupplier } from '../../orders/SupplierShell';
import { t, type Key } from '../../i18n';
import { useHelpContext } from '../../help/HelpPanel';

interface MyEvent { id: string; number: string; title: string; format: string; status: string; myStatus: string; closesAt: string | null; liveStartsAt: string | null; liveEndsAt: string | null; open: boolean }
interface Bidder { bidderOnly: boolean; registered: boolean; registration: { label: string; placeholder?: string } | null }
interface EventView {
  event: { id: string; number: string; title: string; description: string | null; format: string; status: string; currency: string; bidDeadline: string | null; liveStartsAt: string | null; liveEndsAt: string | null; closesAt: string | null; open: boolean; running: boolean; termsNote: string | null; clarifications: boolean; conflictDeclaration: boolean };
  lots: { position: number; title: string; bidMode: string; startPrice: string | null; lines: { position: number; itemCode: string | null; description: string; quantity: string; unit: string; specification: string | null }[] }[];
  terms: { title: string; version: number; versionId: string; kind: string; body: string | null; fileName: string | null } | null;
  me: { alias: string; status: string; respondedAt: string | null; declaration: { noConflict?: boolean; conflictNote?: string } | null; declineReason: string | null; bidderOnly: boolean; registered: boolean };
  questions: { id: string; question: string | null; answer: string | null; mine: boolean; publishedAt: string | null; createdAt: string }[];
  result: { awarded: { position: number; title: string; sharePct: number; amount: number }[] } | null;
}
const fmt = (f: string) => t(`bid.format.${f}` as Key);
const when = (e: Pick<MyEvent, 'format' | 'closesAt' | 'liveStartsAt' | 'liveEndsAt'>) => (e.format !== 'rfq' && e.liveStartsAt ? t('bid.auctionRuns', { from: fmtDateTime(e.liveStartsAt), to: fmtDateTime(e.liveEndsAt) }) : e.closesAt ? t('bid.closes', { when: fmtDateTime(e.closesAt) }) : '');

export function BidderEventList() {
  useHelpContext('bidding');
  const { info } = useSupplier();
  const [d, setD] = useState<{ events: MyEvent[]; bidder: Bidder }>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => api<{ events: MyEvent[]; bidder: Bidder }>('/vendor/events').then(setD).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  if (error) return <div className="page"><Alert kind="error">{error}</Alert></div>;
  if (!d) return <div className="spinner" />;
  if (d.bidder.bidderOnly && !d.bidder.registered) return <BidderRegistration bidder={d.bidder} buyer={info?.buyer.name ?? ''} onDone={load} />;
  return (
    <div className="page">
      <header className="page-head"><div><h1>{t('bid.title')}</h1><p className="muted">{t('bid.intro', { buyer: info?.buyer.name ?? '' })}</p></div></header>
      {!d.events.length ? <Empty>{t('bid.none')}</Empty> : (
        <table className="table">
          <thead><tr><th>{t('bid.colEvent')}</th><th>{t('bid.colType')}</th><th>{t('bid.colCloses')}</th><th>{t('bid.colStatus')}</th></tr></thead>
          <tbody>{d.events.map((e) => (
            <tr key={e.id}>
              <td><Link to={`/vendor/events/${e.id}`}>{e.title}</Link><div className="muted small mono">{e.number}</div></td>
              <td>{fmt(e.format)}</td>
              <td className="small">{when(e)}</td>
              <td>{e.status === 'CANCELLED' ? <span className="badge sm">{t('bid.cancelled')}</span> : !e.open ? <span className="badge sm">{t('bid.closed')}</span>
                : <span className={`badge sm ${e.myStatus === 'ACCEPTED' || e.myStatus === 'QUALIFIED' ? 'badge-approved' : e.myStatus === 'DECLINED' ? 'badge-rejected' : 'badge-under_review'}`}>{t(`bid.my.${e.myStatus}` as Key)}</span>}</td>
            </tr>))}</tbody>
        </table>)}
    </div>
  );
}

function BidderRegistration({ bidder, buyer, onDone }: { bidder: Bidder; buyer: string; onDone: () => void }) {
  const [f, setF] = useState({ registrationId: '', website: '', supplies: '' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setError(undefined);
    try { await api('/vendor/bidder-registration', { body: { ...f, registrationId: f.registrationId || undefined, website: f.website || undefined } }); onDone(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="page">
      <section className="card pad section-card" style={{ maxWidth: 640 }}>
        <h2>{t('bid.reg.title')}</h2>
        <p className="muted">{t('bid.reg.intro', { buyer })}</p>
        {error && <Alert kind="error">{error}</Alert>}
        {bidder.registration && <div className="field"><label htmlFor="br-id">{bidder.registration.label}</label><input id="br-id" value={f.registrationId} placeholder={bidder.registration.placeholder} onChange={(e) => setF({ ...f, registrationId: e.target.value })} /></div>}
        <div className="field"><label htmlFor="br-web">{t('bid.reg.website')}</label><input id="br-web" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} placeholder="https://" /></div>
        <div className="field"><label htmlFor="br-sup">{t('bid.reg.supplies')}</label><textarea id="br-sup" rows={3} value={f.supplies} onChange={(e) => setF({ ...f, supplies: e.target.value })} /></div>
        <div className="btn-row"><button className="btn btn-primary" disabled={busy || f.supplies.trim().length < 2} onClick={save}>{t('bid.reg.save')}</button></div>
      </section>
    </div>
  );
}

export function BidderEvent() {
  useHelpContext('bidding');
  const { id } = useParams();
  const { info } = useSupplier();
  const [d, setD] = useState<EventView>();
  const [error, setError] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const load = useCallback(() => api<EventView>(`/vendor/events/${id}`).then(setD).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  if (!d) return <div className="page">{error ? <Alert kind="error">{error}</Alert> : <div className="spinner" />}</div>;
  const e = d.event;
  const act = async (path: string, body: unknown) => { setError(undefined); setFlash(undefined); try { setD(await api<EventView>(`/vendor/events/${e.id}/${path}`, { body })); setFlash(t('bid.sent')); } catch (err: any) { setError(err.message); } };
  return (
    <div className="page">
      <nav className="breadcrumb"><Link to="/vendor/events">{t('bid.back')}</Link> › {e.number}</nav>
      <header className="page-head"><div><h1>{e.title}</h1><p className="muted"><span className="mono">{e.number}</span> · {fmt(e.format)} · {when(e)}</p></div></header>
      {error && <Alert kind="error">{error}</Alert>}
      {flash && <Alert kind="success">{flash}</Alert>}
      {e.status === 'CANCELLED' ? <Alert kind="warning">{t('bid.cancelled')}</Alert> : d.result ? <AwardResult r={d.result} currency={e.currency} /> : !e.running && <Alert kind="info">{t('bid.closedNote')}</Alert>}
      <p className="muted small">{t('bid.youAre', { alias: d.me.alias })}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)', gap: 16, alignItems: 'start' }}>
        <div>
          {e.description && <section className="card pad section-card"><p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{e.description}</p></section>}
          <section className="card pad section-card">
            <h3>{t('bid.items')}</h3>
            {d.lots.map((l) => (
              <div key={l.position} style={{ marginBottom: 14 }}>
                <div className="row-between"><strong>{t('bid.lot', { n: l.position, title: l.title })}</strong>
                  <span className="muted small">{l.bidMode === 'line' ? t('bid.quoteLine') : t('bid.quoteLot')}{l.startPrice ? ` · ${t('bid.startPrice', { price: money(l.startPrice, e.currency) })}` : ''}</span></div>
                <table className="table static compact">
                  <thead><tr><th>{t('bid.colCode')}</th><th>{t('bid.colItem')}</th><th className="num">{t('bid.colQty')}</th><th>{t('bid.colUnit')}</th><th>{t('bid.colSpec')}</th></tr></thead>
                  <tbody>{l.lines.map((x) => <tr key={x.position}><td className="mono small">{x.itemCode ?? '—'}</td><td>{x.description}</td><td className="num">{Number(x.quantity)}</td><td>{x.unit}</td><td className="small">{x.specification ?? '—'}</td></tr>)}</tbody>
                </table>
              </div>))}
          </section>
          {e.format !== 'rfq' && ['ACCEPTED', 'QUALIFIED', 'DISQUALIFIED'].includes(d.me.status) && e.status !== 'CANCELLED' && <LivePanel eventId={e.id} />}
          {d.me.status !== 'INVITED' && d.me.status !== 'DECLINED' && <OfferPanel eventId={e.id} buyer={info?.buyer.name ?? ''} currency={e.currency} accepted={['ACCEPTED', 'QUALIFIED', 'DISQUALIFIED'].includes(d.me.status)} />}
          {(d.terms || e.termsNote) && <section className="card pad section-card">
            <h3>{t('bid.terms')}{d.terms && <span className="muted small"> · {d.terms.title} · {t('bid.termsVersion', { v: d.terms.version })}</span>}</h3>
            {d.terms?.body && <div style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' }} className="small">{d.terms.body}</div>}
            {d.terms?.kind === 'PDF' && <a className="btn btn-secondary btn-sm" href={agreementFileUrl(d.terms.versionId)} target="_blank" rel="noreferrer">{t('agr.openPdf')}</a>}
            {e.termsNote && <><h4>{t('bid.termsNote')}</h4><p className="small" style={{ whiteSpace: 'pre-wrap' }}>{e.termsNote}</p></>}
          </section>}
        </div>
        <div>
          <Response d={d} buyer={info?.buyer.name ?? ''} onSend={(body) => act('response', body)} />
          {e.clarifications && <Questions d={d} onAsk={(question) => act('questions', { question })} />}
        </div>
      </div>
    </div>
  );
}

function Response({ d, buyer, onSend }: { d: EventView; buyer: string; onSend: (body: unknown) => void }) {
  const { me, event: e, terms } = d;
  const [changing, setChanging] = useState(false);
  const [agree, setAgree] = useState(false);
  const [conflict, setConflict] = useState<'none' | 'some' | ''>('');
  const [note, setNote] = useState('');
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const decided = me.status !== 'INVITED' && !changing;
  const accepted = ['ACCEPTED', 'QUALIFIED', 'DISQUALIFIED'].includes(me.status);
  return (
    <section className="card pad section-card">
      <h3>{t('bid.respond')}</h3>
      {decided ? (<>
        {accepted && <Alert kind="success">{t('bid.accepted', { when: fmtDateTime(me.respondedAt) })} {t(d.event.format === 'rfq' || d.event.bidDeadline ? 'bid.acceptedOffer' : 'bid.acceptedLive')}</Alert>}
        {me.status === 'DECLINED' && <Alert kind="info">{t('bid.declinedText', { reason: me.declineReason ?? '' })}</Alert>}
        {e.open && me.status !== 'QUALIFIED' && me.status !== 'DISQUALIFIED' && <button className="link-btn small" onClick={() => setChanging(true)}>{t('bid.changeMind')}</button>}
      </>) : !e.open ? <p className="muted small">{t('bid.closedNote')}</p> : (<>
        {terms && <label className="check-item"><input type="checkbox" checked={agree} onChange={(x) => setAgree(x.target.checked)} /><span>{t('bid.acceptTerms', { v: terms.version })}</span></label>}
        {e.conflictDeclaration && <>
          <label className="radio" style={{ display: 'block' }}><input type="radio" name="coi" checked={conflict === 'none'} onChange={() => setConflict('none')} /> {t('bid.noConflict', { buyer })}</label>
          <label className="radio" style={{ display: 'block' }}><input type="radio" name="coi" checked={conflict === 'some'} onChange={() => setConflict('some')} /> {t('bid.conflict')}</label>
          {conflict === 'some' && <textarea aria-label={t('bid.conflictPh')} placeholder={t('bid.conflictPh')} rows={3} style={{ width: '100%' }} value={note} onChange={(x) => setNote(x.target.value)} />}
        </>}
        <div className="btn-row">
          <button className="btn btn-secondary" onClick={() => setDeclining(true)}>{t('bid.decline')}</button>
          <button className="btn btn-primary" disabled={(!!terms && !agree) || (e.conflictDeclaration && (!conflict || (conflict === 'some' && !note.trim())))}
            onClick={() => { setChanging(false); onSend({ accept: true, termsVersion: terms?.version, noConflict: conflict === 'none', conflictNote: conflict === 'some' ? note : undefined }); }}>{t('bid.accept')}</button>
        </div>
        {declining && <div style={{ marginTop: 10 }}>
          <div className="field"><label htmlFor="dec-reason">{t('bid.declineReason')}</label><textarea id="dec-reason" rows={2} value={reason} onChange={(x) => setReason(x.target.value)} /></div>
          <button className="btn btn-secondary btn-sm" disabled={!reason.trim()} onClick={() => { setChanging(false); setDeclining(false); onSend({ accept: false, declineReason: reason }); }}>{t('bid.sendDecline')}</button>
        </div>}
      </>)}
    </section>
  );
}

function Questions({ d, onAsk }: { d: EventView; onAsk: (q: string) => void }) {
  const [q, setQ] = useState('');
  return (
    <section className="card pad section-card">
      <h3>{t('bid.qa')}</h3>
      <p className="muted small">{t('bid.qaNote')}</p>
      {!d.questions.length && <p className="muted small">{t('bid.noQuestions')}</p>}
      {d.questions.map((x) => (
        <div key={x.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--line, #e5e7eb)' }} className="small">
          {x.question ? <div><strong>{x.mine ? t('bid.yours') : t('bid.q')}:</strong> {x.question}</div> : <div><strong>{t('bid.announcement')}</strong></div>}
          {x.answer ? <div style={{ marginTop: 2 }}>{x.question && <strong>{t('bid.a')}: </strong>}{x.answer}<div className="muted">{fmtDateTime(x.publishedAt)}</div></div> : <div className="muted">{t('bid.waitingAnswer')}</div>}
        </div>))}
      {d.event.open && d.me.status !== 'DECLINED' && <div style={{ marginTop: 10 }}>
        <div className="field"><label htmlFor="ask-q">{t('bid.ask')}</label><textarea id="ask-q" rows={3} value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <button className="btn btn-secondary btn-sm" disabled={q.trim().length < 5} onClick={() => { onAsk(q); setQ(''); }}>{t('bid.askSend')}</button>
      </div>}
    </section>
  );
}

/* ---------------- the bidder's sealed offer ---------------- */

type Env = 'single' | 'technical' | 'commercial';
interface OfferContent { lots?: { lotId: string; price?: number; lines?: { lineId: string; unitPrice: number }[]; total: number }[]; taxPct?: number | null; deliveryDays?: number | null; validityDays?: number | null; paymentTerms?: string; remarks?: string }
interface Offers {
  envelopes: Env[]; canBid: boolean; canRevise: boolean; deadline: string | null; technicalResult: 'QUALIFIED' | 'DISQUALIFIED' | null;
  items: { id: string; position: number; title: string; bidMode: string; lines: { id: string; position: number; description: string; quantity: string; unit: string }[] }[];
  offers: Partial<Record<Env, { version: number; submittedAt: string; withdrawnAt: string | null; receipt: string; content: OfferContent; attachments: { documentId: string; fileName: string }[] }>>;
}

export function OfferPanel({ eventId, buyer, currency, accepted }: { eventId: string; buyer: string; currency: string; accepted: boolean }) {
  const [o, setO] = useState<Offers>();
  const [editing, setEditing] = useState<Env>();
  const [error, setError] = useState<string>();
  const load = useCallback(() => api<Offers>(`/vendor/events/${eventId}/offer`).then(setO).catch((e) => setError(e.message)), [eventId]);
  useEffect(() => { load(); }, [load, accepted]);
  if (!o) return error ? <Alert kind="error">{error}</Alert> : null;
  if (!o.deadline) return null; // auctions without a sealed round: bidding is live (next step)
  async function withdraw(env: Env) {
    if (!confirm(t('offer.withdrawConfirm'))) return;
    try { setO(await api<Offers>(`/vendor/events/${eventId}/offer/${env}`, { method: 'DELETE' })); } catch (e: any) { setError(e.message); }
  }
  return (
    <section className="card pad section-card">
      <h3>{t('offer.title')}</h3>
      <p className="muted small">🔒 {t('offer.sealedNote', { buyer, when: fmtDateTime(o.deadline) })}</p>
      {error && <Alert kind="error">{error}</Alert>}
      {o.technicalResult && <Alert kind={o.technicalResult === 'QUALIFIED' ? 'success' : 'info'}>{t(o.technicalResult === 'QUALIFIED' ? 'offer.qualified' : 'offer.notQualified')}</Alert>}
      {!accepted && !Object.keys(o.offers).length && <p className="muted small">{t('offer.acceptFirst')}</p>}
      {!o.canBid && accepted && <p className="muted small">{t('offer.closed')}</p>}
      {o.envelopes.map((env) => {
        const sent = o.offers[env];
        const live = sent && !sent.withdrawnAt;
        return (
          <div key={env} className="card pad" style={{ marginBottom: 10 }}>
            {o.envelopes.length > 1 && <h4 style={{ marginTop: 0 }}>{t(`offer.env.${env}` as Key)}</h4>}
            {sent && editing !== env && (<>
              <p className="small" style={{ margin: 0 }}>{sent.withdrawnAt ? <span className="badge sm">{t('offer.withdrawn')}</span> : '✅'} {t('offer.received', { version: sent.version, when: fmtDateTime(sent.submittedAt) })} · <span className="mono">{t('offer.receipt', { ref: sent.receipt })}</span></p>
              <OfferSummary o={o} content={sent.content} files={sent.attachments} currency={currency} />
              {o.canBid && <div className="btn-row">
                {(!live || o.canRevise) && <button className="btn btn-secondary btn-sm" onClick={() => setEditing(env)}>{t('offer.revise')}</button>}
                {live && o.canRevise && <button className="btn btn-secondary btn-sm" onClick={() => withdraw(env)}>{t('offer.withdraw')}</button>}
              </div>}
            </>)}
            {!sent && editing !== env && (o.canBid ? <OfferForm o={o} env={env} eventId={eventId} currency={currency} onSent={(r) => { setO(r); setEditing(undefined); }} /> : <p className="muted small">{t('offer.none')}</p>)}
            {editing === env && <OfferForm o={o} env={env} eventId={eventId} currency={currency} initial={sent?.content} initialFiles={sent?.attachments} onCancel={() => setEditing(undefined)} onSent={(r) => { setO(r); setEditing(undefined); }} />}
          </div>);
      })}
    </section>
  );
}

function OfferSummary({ o, content, files, currency }: { o: Offers; content: OfferContent; files: { documentId: string; fileName: string }[]; currency: string }) {
  return (
    <div className="small" style={{ marginTop: 6 }}>
      {(content.lots ?? []).map((q) => { const lot = o.items.find((l) => l.id === q.lotId); return <div key={q.lotId}>{t('bid.lot', { n: lot?.position ?? '', title: lot?.title ?? '' })}: <strong>{money(q.total, currency)}</strong></div>; })}
      {content.taxPct != null && <div>{t('offer.taxPct')}: {content.taxPct}</div>}
      {content.deliveryDays != null && <div>{t('offer.deliveryDays')}: {content.deliveryDays}</div>}
      {content.validityDays != null && <div>{t('offer.validityDays')}: {content.validityDays}</div>}
      {content.paymentTerms && <div>{t('offer.paymentTerms')}: {content.paymentTerms}</div>}
      {content.remarks && <div style={{ whiteSpace: 'pre-wrap' }}>{content.remarks}</div>}
      {files.map((f) => <div key={f.documentId}>📎 {f.fileName}</div>)}
    </div>
  );
}

function OfferForm({ o, env, eventId, currency, initial, initialFiles, onSent, onCancel }: { o: Offers; env: Env; eventId: string; currency: string; initial?: OfferContent; initialFiles?: { documentId: string; fileName: string }[]; onSent: (r: Offers) => void; onCancel?: () => void }) {
  const priced = env !== 'technical';
  const [prices, setPrices] = useState<Record<string, string>>(() => {
    const p: Record<string, string> = {};
    for (const q of initial?.lots ?? []) { if (q.price !== undefined) p[q.lotId] = String(q.price); for (const l of q.lines ?? []) p[l.lineId] = String(l.unitPrice); }
    return p;
  });
  const [f, setF] = useState({ taxPct: initial?.taxPct ?? '', deliveryDays: initial?.deliveryDays ?? '', validityDays: initial?.validityDays ?? '', paymentTerms: initial?.paymentTerms ?? '', remarks: initial?.remarks ?? '' });
  const [files, setFiles] = useState(initialFiles ?? []);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const num = (v: string | number) => (String(v).trim() === '' ? undefined : Number(String(v).replace(/,/g, '')));
  const lotTotal = (lot: Offers['items'][number]) => (lot.bidMode === 'line' ? (lot.lines.every((x) => num(prices[x.id] ?? '') !== undefined) ? lot.lines.reduce((n, x) => n + Number(x.quantity) * (num(prices[x.id])!), 0) : null) : num(prices[lot.id] ?? '') ?? null);
  async function upload(file?: File) {
    if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    try { const r = await api<{ documentId: string; fileName: string }>(`/vendor/events/${eventId}/offer/files`, { body: fd }); setFiles([...files, r]); } catch (e: any) { setError(e.message); }
  }
  async function send() {
    setBusy(true); setError(undefined);
    const lots = priced ? o.items.flatMap((lot): { lotId: string; price?: number; lines?: { lineId: string; unitPrice?: number }[] }[] => {
      if (lot.bidMode === 'line') { const ls = lot.lines.map((x) => ({ lineId: x.id, unitPrice: num(prices[x.id] ?? '') })); return ls.every((x) => x.unitPrice === undefined) ? [] : [{ lotId: lot.id, lines: ls }]; }
      const p = num(prices[lot.id] ?? ''); return p === undefined ? [] : [{ lotId: lot.id, price: p }];
    }) : [];
    const body = priced ? { lots, taxPct: num(f.taxPct), deliveryDays: num(f.deliveryDays), validityDays: num(f.validityDays), paymentTerms: f.paymentTerms || undefined, remarks: f.remarks || undefined, attachments: files.map((x) => x.documentId) }
      : { remarks: f.remarks || undefined, attachments: files.map((x) => x.documentId) };
    try { onSent(await api<Offers>(`/vendor/events/${eventId}/offer/${env}`, { body })); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div>
      {error && <Alert kind="error">{error}</Alert>}
      {!priced && <p className="muted small">{t('offer.techHelp')}</p>}
      {priced && <>
        <p className="muted small">{t('offer.skipLot')}</p>
        {o.items.map((lot) => {
          const total = lotTotal(lot);
          return (
            <div key={lot.id} style={{ marginBottom: 10 }}>
              <div className="row-between"><strong>{t('bid.lot', { n: lot.position, title: lot.title })}</strong>{total !== null && <span className="small">{t('offer.lotTotal', { total: money(total, currency) })}</span>}</div>
              {lot.bidMode === 'line' ? (
                <table className="table static compact"><tbody>{lot.lines.map((x) => (
                  <tr key={x.id}><td>{x.description}</td><td className="num small">{Number(x.quantity)} {x.unit}</td>
                    <td style={{ width: 160 }}><input aria-label={`${t('offer.unitPrice')} — ${x.description}`} inputMode="decimal" placeholder={t('offer.unitPrice')} value={prices[x.id] ?? ''} onChange={(e) => setPrices({ ...prices, [x.id]: e.target.value })} style={{ width: '100%' }} /></td></tr>))}</tbody></table>
              ) : <div className="field" style={{ maxWidth: 240 }}><label htmlFor={`lp-${lot.id}`}>{t('offer.lotPrice')} ({currency})</label><input id={`lp-${lot.id}`} inputMode="decimal" value={prices[lot.id] ?? ''} onChange={(e) => setPrices({ ...prices, [lot.id]: e.target.value })} /></div>}
            </div>);
        })}
        <div className="field-grid">
          <div className="field"><label htmlFor={`tax-${env}`}>{t('offer.taxPct')}</label><input id={`tax-${env}`} inputMode="decimal" value={f.taxPct} onChange={set('taxPct')} /></div>
          <div className="field"><label htmlFor={`del-${env}`}>{t('offer.deliveryDays')}</label><input id={`del-${env}`} inputMode="numeric" value={f.deliveryDays} onChange={set('deliveryDays')} /></div>
          <div className="field"><label htmlFor={`val-${env}`}>{t('offer.validityDays')}</label><input id={`val-${env}`} inputMode="numeric" value={f.validityDays} onChange={set('validityDays')} /></div>
          <div className="field"><label htmlFor={`pay-${env}`}>{t('offer.paymentTerms')}</label><input id={`pay-${env}`} value={f.paymentTerms} onChange={set('paymentTerms')} /></div>
        </div>
      </>}
      <div className="field"><label htmlFor={`rem-${env}`}>{t('offer.remarks')}</label><textarea id={`rem-${env}`} rows={3} value={f.remarks} onChange={set('remarks')} /></div>
      <div className="field"><label htmlFor={`file-${env}`}>{t('offer.files')}</label><input id={`file-${env}`} type="file" accept=".pdf,.png,.jpg,.jpeg" onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
        {files.map((x) => <div key={x.documentId} className="small">📎 {x.fileName} <button className="link-btn small" aria-label={`Remove ${x.fileName}`} onClick={() => setFiles(files.filter((y) => y.documentId !== x.documentId))}>×</button></div>)}</div>
      <div className="btn-row">{onCancel && <button className="btn btn-secondary" onClick={onCancel}>{t('offer.cancel')}</button>}<button className="btn btn-primary" disabled={busy} onClick={send}>{t('offer.submit')}</button></div>
    </div>
  );
}

/* ---------------- the bidder's live auction ---------------- */

interface BidderLive {
  phase: 'upcoming' | 'live' | 'paused' | 'closed'; serverTime: string; startsAt: string; endsAt: string; extensionMinutes: number; minStepPct: number; canBid: boolean; visibility: string; currency: string; alias: string;
  messages: { text: string; at: string }[];
  lots: { id: string; position: number; title: string; bidMode: string; startPrice: number | null; lines: { id: string; description: string; quantity: number; unit: string }[]; myBest: number | null; myRank: number | null; bidders: number; maxNext: number | null; best: number | null; ladder: { rank: number; amount: number; mine: boolean }[] | null; myBids: { seq: number; amount: number; at: string; struck: boolean }[] }[];
}

export function LivePanel({ eventId }: { eventId: string }) {
  const { data, setData, reload, offset, connected } = useLive<BidderLive>(`/vendor/events/${eventId}/live`, `/vendor/events/${eventId}/stream`);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const [confirm, setConfirm] = useState<{ lotId: string; body: any; amount: number }>();
  const left = useCountdown(data?.phase === 'upcoming' ? data.startsAt : data?.phase === 'live' ? data.endsAt : null, offset, reload);
  if (!data) return null;
  const n = (s: string | undefined) => (s && s.trim() !== '' ? Number(s.replace(/,/g, '')) : undefined);
  const bodyFor = (lot: BidderLive['lots'][number]) => (lot.bidMode === 'line' ? { lotId: lot.id, lines: lot.lines.map((x) => ({ lineId: x.id, unitPrice: n(vals[x.id]) })) } : { lotId: lot.id, amount: n(vals[lot.id]) });
  const totalOf = (lot: BidderLive['lots'][number]) => (lot.bidMode === 'line' ? (lot.lines.every((x) => n(vals[x.id]) !== undefined) ? lot.lines.reduce((s, x) => s + x.quantity * n(vals[x.id])!, 0) : null) : n(vals[lot.id]) ?? null);
  async function place(body: any, sure = false) {
    setMsg(undefined);
    try {
      const r = await api<{ placed: { amount: number; rank: number; extendedTo: string | null }; live: BidderLive }>(`/vendor/events/${eventId}/bids`, { body: { ...body, confirm: sure } });
      setData(r.live); setConfirm(undefined);
      setMsg({ kind: 'success', text: t('live.placed', { amount: money(r.placed.amount, data!.currency), rank: r.placed.rank }) + (r.placed.extendedTo ? ` ${t('live.extended', { when: fmtDateTime(r.placed.extendedTo) })}` : '') });
    } catch (e: any) {
      if (e.code === 'CONFIRM_BID') setConfirm({ lotId: body.lotId, body, amount: e.details?.amount });
      else setMsg({ kind: 'error', text: e.message });
    }
  }
  const head = data.phase === 'upcoming' ? t('live.startsIn') : data.phase === 'live' ? t('live.endsIn') : data.phase === 'paused' ? t('live.paused') : t('live.closed');
  return (
    <section className="card pad section-card">
      <div className="row-between"><h3 style={{ margin: 0 }}>{t('live.title')}</h3>
        <div style={{ textAlign: 'end' }}><div className="small muted">{head}</div>{(data.phase === 'live' || data.phase === 'upcoming') && <div style={{ fontSize: 30, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{clock(left)}</div>}</div></div>
      <p className="muted small">{data.extensionMinutes ? t('live.rules', { step: data.minStepPct, ext: data.extensionMinutes }) : t('live.rulesNoExt', { step: data.minStepPct })} {t('live.serverTime')}{!connected && ` · ${t('live.offline')}`}</p>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {!data.canBid && <Alert kind="info">{t('live.cantBid')}</Alert>}
      {data.messages.length > 0 && <div className="card pad" style={{ marginBottom: 10, background: 'var(--bg-soft, #fffbeb)' }}><strong className="small">{t('live.messages')}</strong>{data.messages.map((m, i) => <div key={i} className="small">{m.text} <span className="muted">· {fmtDateTime(m.at)}</span></div>)}</div>}
      {data.lots.map((lot) => {
        const total = totalOf(lot);
        return (
          <div key={lot.id} className="card pad" style={{ marginBottom: 10 }}>
            <div className="row-between"><strong>{t('bid.lot', { n: lot.position, title: lot.title })}</strong><span className="small muted">{t('live.bidders', { n: lot.bidders })}{lot.startPrice !== null ? ` · ${t('live.startPrice', { price: money(lot.startPrice, data.currency) })}` : ''}</span></div>
            <div style={{ display: 'flex', gap: 24, margin: '8px 0', flexWrap: 'wrap' }}>
              <div><div className="small muted">{t('live.yourRank')}</div><div style={{ fontSize: 26, fontWeight: 700 }}>{lot.myRank ? `L${lot.myRank}` : '—'}</div></div>
              <div><div className="small muted">{t('live.yourBest')}</div><div style={{ fontSize: 20, fontWeight: 600 }}>{lot.myBest !== null ? money(lot.myBest, data.currency) : t('live.noBid')}</div></div>
              {lot.best !== null && <div><div className="small muted">{t('live.best')}</div><div style={{ fontSize: 20, fontWeight: 600 }}>{money(lot.best, data.currency)}</div></div>}
            </div>
            {lot.ladder && lot.ladder.length > 0 && <div className="small"><span className="muted">{t('live.ladder')}: </span>{lot.ladder.map((r) => <span key={r.rank} style={{ marginInlineEnd: 10, fontWeight: r.mine ? 700 : 400 }}>L{r.rank} {money(r.amount, data.currency)}{r.mine ? ` (${t('live.you')})` : ''}</span>)}</div>}
            {data.phase === 'live' && data.canBid && (<div style={{ marginTop: 8 }}>
              {lot.maxNext !== null && <div className="small">{t('live.maxNext', { max: money(lot.maxNext, data.currency) })}</div>}
              {lot.bidMode === 'line' ? (
                <table className="table static compact"><tbody>{lot.lines.map((x) => <tr key={x.id}><td>{x.description}</td><td className="num small">{x.quantity} {x.unit}</td><td style={{ width: 160 }}><input aria-label={`${t('live.unitPrice')} — ${x.description}`} inputMode="decimal" value={vals[x.id] ?? ''} onChange={(e) => setVals({ ...vals, [x.id]: e.target.value })} style={{ width: '100%' }} /></td></tr>)}</tbody></table>
              ) : <div className="field" style={{ maxWidth: 260 }}><label htmlFor={`bid-${lot.id}`}>{t('live.amount')} ({data.currency})</label><input id={`bid-${lot.id}`} inputMode="decimal" value={vals[lot.id] ?? ''} onChange={(e) => setVals({ ...vals, [lot.id]: e.target.value })} /></div>}
              <div className="btn-row">{total !== null && lot.bidMode === 'line' && <span className="small">{t('live.total', { total: money(total, data.currency) })}</span>}
                <button className="btn btn-primary" disabled={total === null} onClick={() => place(bodyFor(lot))}>{t('live.bid')}</button></div>
            </div>)}
            {lot.myBids.length > 0 && <div className="small muted" style={{ marginTop: 6 }}>{t('live.myBids')}: {lot.myBids.slice(0, 8).map((b) => <span key={b.seq} style={{ marginInlineEnd: 8, textDecoration: b.struck ? 'line-through' : undefined }}>{money(b.amount, data.currency)}{b.struck ? ` (${t('live.struck')})` : ''}</span>)}</div>}
          </div>);
      })}
      {confirm && (
        <Modal title={t('live.confirmTitle')} onClose={() => setConfirm(undefined)} footer={<><button className="btn btn-secondary" onClick={() => setConfirm(undefined)}>{t('live.cancel')}</button><button className="btn btn-primary" onClick={() => place(confirm.body, true)}>{t('live.confirm')}</button></>}>
          <p>{t('live.confirmText', { amount: money(confirm.amount, data.currency) })}</p>
        </Modal>)}
    </section>
  );
}

/** Once awarded: what this bidder won (never anyone else's result). */
function AwardResult({ r, currency }: { r: NonNullable<EventView['result']>; currency: string }) {
  if (!r.awarded.length) return <Alert kind="info">{t('bid.award.none')}</Alert>;
  return (
    <Alert kind="success"><strong>{t('bid.award.won')}</strong>
      <ul style={{ margin: '4px 0 0' }}>{r.awarded.map((a) => <li key={a.position}>{t('bid.lot', { n: a.position, title: a.title })} — {t('bid.award.share', { share: a.sharePct, amount: money(a.amount, currency) })}</li>)}</ul>
      <div className="small">{t('bid.award.next')}</div></Alert>
  );
}
