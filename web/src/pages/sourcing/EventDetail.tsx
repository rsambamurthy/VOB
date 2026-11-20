/** One sourcing event: details, schedule, terms, rules, lots and items (screen or Excel), checks, approval and history. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDateTime, humanize, money } from '../../lib/format';
import { useSession } from '../../lib/session';
import { Alert, Empty, Modal } from '../../components/ui';
import { EventStatus, FORMAT_LABEL, RuleInput, ruleText, ruleValue, type RuleRow } from '../../components/Sourcing';
import { FlowPanel, type FlowDecision, type FlowViewData } from '../../components/ApprovalFlow';
import { useHelpContext } from '../../help/HelpPanel';
import { BiddersCard, ClarificationsCard, type Bidder, type Question } from './EventBidders';
import { ScoringEditor, SealedCard, type Sealed, type Scoring } from './EventSealed';
import { LiveMonitor } from './EventLive';
import { HistoryCard } from '../../components/HistoryCard';
import { AwardCard, type Award } from './EventAward';

interface Line { id?: string; itemCode: string | null; description: string; quantity: string | number; unit: string; specification: string | null; targetPrice: string | number | null }
interface Lot { id?: string; position?: number; title: string; bidMode: 'lot' | 'line'; startPrice: string | number | null; reservePrice: string | number | null; lines: Line[] }
interface EventData {
  event: { id: string; number: string; title: string; description: string | null; format: string; status: string; currency: string; estimatedValue: string | null; category: string | null; termsAgreementId: string | null; termsNote: string | null;
    bidDeadline: string | null; liveStartsAt: string | null; liveEndsAt: string | null; scoring: Scoring; ruleChoices: Record<string, string | number | null>; rules: Record<string, string | number | null>; isTemplate: boolean; editable: boolean; owner: string; ownerId: string | null; cancelledReason: string | null; approvalCycle: number; submittedAt: string | null; approvedAt: string | null };
  lots: Lot[]; terms: { id: string; title: string; status: string } | null; issues: { field: string; message: string }[]; approval: FlowViewData;
  history: { actor: string; action: string; detail: Record<string, unknown> | null; createdAt: string }[];
  bidders?: Bidder[]; questions?: Question[]; closesAt?: string | null; outsideBidders?: boolean; sealed?: Sealed | null; award?: Award | null;
}
interface Setup { config: { rules: RuleRow[]; features: { key: string; on: boolean }[] }; terms: { id: string; title: string }[]; categories: string[]; currency: string }

/** ISO ↔ the value of an <input type="datetime-local"> (local time). */
const toLocal = (iso: string | null) => { if (!iso) return ''; const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null);
const n = (v: string) => (v.trim() === '' ? null : Number(v.replace(/,/g, '')));
/** Database numerics ("20.000", "14.0000") as typed numbers ("20", "14"). */
const plain = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '' : String(Number(v)));
const plainLots = (lots: Lot[]): Lot[] => lots.map((l) => ({ ...l, startPrice: plain(l.startPrice), reservePrice: plain(l.reservePrice), lines: l.lines.map((x) => ({ ...x, quantity: plain(x.quantity), targetPrice: plain(x.targetPrice) })) }));

export function EventDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const nav = useNavigate();
  useHelpContext('sourcing-event');
  const [d, setD] = useState<EventData>();
  const [setup, setSetup] = useState<Setup>();
  const [flash, setFlash] = useState<{ kind: 'success' | 'error' | 'info'; text: string }>();
  const [cancelling, setCancelling] = useState(false);
  const load = useCallback(() => api<EventData>(`/staff/sourcing/events/${id}`).then(setD).catch((e) => setFlash({ kind: 'error', text: e.message })), [id]);
  useEffect(() => { load(); api<Setup>('/staff/sourcing/setup').then(setSetup).catch(() => {}); }, [load]);
  if (!d) return <div className="page">{flash ? <Alert kind="error">{flash.text}</Alert> : <div className="spinner" />}</div>;
  const e = d.event;
  const manage = can('sourcing.events');
  const canEdit = manage && e.editable;
  const run = async (fn: () => Promise<unknown>, ok: string) => { setFlash(undefined); try { await fn(); setFlash({ kind: 'success', text: ok }); await load(); } catch (err: any) { setFlash({ kind: 'error', text: err.message }); } };

  async function submit() {
    setFlash(undefined);
    try {
      const r = await api<EventData & { status: string; levels: string[] }>(`/staff/sourcing/events/${e.id}/submit`, { method: 'POST' });
      setD(r);
      setFlash({ kind: 'success', text: r.status === 'APPROVED' ? 'No approval is needed for this event — it is approved.' : `Submitted. Approval: ${r.levels.join(' → ')}.` });
    } catch (err: any) { setFlash({ kind: 'error', text: err.message }); }
  }
  async function decide(action: FlowDecision, remarks: string) {
    const r = await api<EventData & { status: string; nextLevel?: string }>(`/staff/sourcing/events/${e.id}/decision`, { body: { action, remarks } });
    setD(r);
    setFlash({ kind: 'success', text: action === 'APPROVE' ? (r.nextLevel ? `Approved. Next: ${r.nextLevel}.` : 'Approved. The owner can now invite bidders.') : action === 'SEND_BACK' ? 'Sent back to the owner.' : 'Rejected.' });
  }
  async function copy(template: boolean) {
    try { const r = await api<{ event: { id: string } }>(`/staff/sourcing/events/${e.id}/copy`, { body: { template } }); nav(`/staff/sourcing/events/${r.event.id}`); setFlash({ kind: 'success', text: template ? 'Saved as a template.' : 'Copied into a new draft.' }); }
    catch (err: any) { setFlash({ kind: 'error', text: err.message }); }
  }
  async function remove() {
    if (!confirm(`Delete ${e.isTemplate ? 'template' : 'draft'} ${e.number}? This can’t be undone.`)) return;
    try { await api(`/staff/sourcing/events/${e.id}`, { method: 'DELETE' }); nav(e.isTemplate ? '/staff/sourcing?filter=templates' : '/staff/sourcing'); } catch (err: any) { setFlash({ kind: 'error', text: err.message }); }
  }

  return (
    <div className="page">
      <nav className="breadcrumb"><Link to="/staff/sourcing">Sourcing events</Link> › {e.number}</nav>
      <header className="page-head">
        <div><h1>{e.title}</h1>
          <p className="muted"><span className="mono">{e.number}</span> · {FORMAT_LABEL[e.format] ?? e.format} · <EventStatus status={e.status} template={e.isTemplate} /> · owner {e.owner}</p></div>
        {manage && <div className="head-actions">
          {e.status === 'DRAFT' && !e.isTemplate && <button className="btn btn-primary" disabled={d.issues.length > 0} title={d.issues.length ? 'Fix the items listed first' : undefined} onClick={submit}>Submit for approval</button>}
          {e.status === 'PENDING_APPROVAL' && <button className="btn btn-secondary" onClick={() => run(() => api(`/staff/sourcing/events/${e.id}/withdraw`, { method: 'POST' }), 'Withdrawn — the event is a draft again.')}>Withdraw</button>}
          <button className="btn btn-secondary" onClick={() => copy(false)}>{e.isTemplate ? 'Copy template' : 'Copy'}</button>
          {!e.isTemplate && <button className="btn btn-secondary" onClick={() => copy(true)}>Save as template</button>}
          {(e.isTemplate || (e.status === 'DRAFT' && e.approvalCycle === 0)) && <button className="btn btn-secondary" onClick={remove}>Delete</button>}
          {!e.isTemplate && ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED'].includes(e.status) && <button className="btn btn-danger" onClick={() => setCancelling(true)}>Cancel event</button>}
        </div>}
      </header>
      {flash && <Alert kind={flash.kind}>{flash.text}</Alert>}
      {e.status === 'CANCELLED' && <Alert kind="warning">Cancelled: {e.cancelledReason}</Alert>}
      {d.award?.canPropose && <Alert kind="info">{e.format === 'rfq' ? 'Prices are open.' : 'The auction has closed.'} Propose the award in the Award section.</Alert>}
      {e.status === 'AWARD_PENDING' && <Alert kind="info">The award is waiting for approval.</Alert>}
      {e.status === 'APPROVED' && <Alert kind="success">Approved{e.approvedAt ? ` on ${fmtDateTime(e.approvedAt)}` : ''}. Send the invitations from the Bidders section.</Alert>}
      {canEdit && !e.isTemplate && d.issues.length > 0 && (
        <Alert kind="info"><strong>Before submitting:</strong><ul style={{ margin: '4px 0 0' }}>{d.issues.map((i, k) => <li key={k}>{i.message}</li>)}</ul></Alert>)}

      <div className="detail-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)', gap: 16, alignItems: 'start' }}>
        <div>
          <Details d={d} setup={setup} canEdit={canEdit} onSaved={(r) => { setD(r); setFlash({ kind: 'success', text: 'Saved.' }); }} onError={(m) => setFlash({ kind: 'error', text: m })} />
          <Items d={d} canEdit={canEdit} onSaved={(r, msg) => { setD(r); setFlash({ kind: 'success', text: msg }); }} onError={(m) => setFlash({ kind: 'error', text: m })} />
          {e.format !== 'rfq' && ['PUBLISHED', 'OPENING', 'EVALUATION', 'LIVE', 'CLOSED', 'AWARD_PENDING', 'AWARDED'].includes(e.status) && <LiveMonitor eventId={e.id} currency={e.currency} canControl={can('sourcing.live')} onPhase={load} />}
          {d.award && !e.isTemplate && <AwardCard a={d.award} eventId={e.id} currency={e.currency} canManage={manage}
            onDone={(r, msg) => { if (r?.event) setD(r); else load(); setFlash({ kind: 'success', text: msg }); }} onError={(m) => setFlash({ kind: 'error', text: m })} />}
          {d.sealed && <SealedCard s={d.sealed} eventId={e.id} format={e.format} currency={e.currency} perms={{ open: can('sourcing.open'), evaluate: can('sourcing.evaluate'), manage }}
            onDone={(r, msg) => { setD(r); setFlash({ kind: 'success', text: msg }); }} onError={(m) => setFlash({ kind: 'error', text: m })} />}
          {(e.scoring || (e.editable && (e.ruleChoices.envelope === 'two' || d.issues.some((i) => i.field === 'scoring')))) && <ScoringEditor eventId={e.id} scoring={e.scoring} canEdit={canEdit} onDone={(r, msg) => { setD(r); setFlash({ kind: 'success', text: msg }); }} onError={(m) => setFlash({ kind: 'error', text: m })} />}
          {!e.isTemplate && d.bidders && <BiddersCard bidders={d.bidders} eventId={e.id} status={e.status} closesAt={d.closesAt ?? null} canManage={manage} outsideAllowed={!!d.outsideBidders} category={e.category}
            onChanged={(r, msg) => { setD(r); setFlash({ kind: 'success', text: msg }); }} onError={(m) => setFlash({ kind: 'error', text: m })} />}
          {!e.isTemplate && d.questions && ['APPROVED', 'PUBLISHED', 'CLOSED'].includes(e.status) && <ClarificationsCard questions={d.questions} eventId={e.id} canAnswer={manage && ['APPROVED', 'PUBLISHED'].includes(e.status)}
            onChanged={(r, msg) => { setD(r); setFlash({ kind: 'success', text: msg }); }} onError={(m) => setFlash({ kind: 'error', text: m })} />}
        </div>
        <div>
          {!e.isTemplate && <FlowPanel flow={d.approval} onDecide={decide} title="Approval" empty={e.status === 'DRAFT' ? 'Not submitted yet. Who approves depends on the event’s value (Administration → Sourcing).' : 'No approval was needed.'} />}
          <Rules d={d} setup={setup} canEdit={canEdit} onSaved={(r) => { setD(r); setFlash({ kind: 'success', text: 'Rules saved.' }); }} onError={(m) => setFlash({ kind: 'error', text: m })} />
          <History rows={d.history} />
        </div>
      </div>
      {cancelling && <CancelModal onClose={() => setCancelling(false)} onCancel={(reason) => run(async () => { await api(`/staff/sourcing/events/${e.id}/cancel`, { body: { reason } }); setCancelling(false); }, 'Event cancelled.')} />}
    </div>
  );
}

type Saved = { d: EventData; canEdit: boolean; onError: (m: string) => void };

function Details({ d, setup, canEdit, onSaved, onError }: Saved & { setup?: Setup; onSaved: (r: EventData) => void }) {
  const e = d.event;
  const init = () => ({ title: e.title, description: e.description ?? '', estimatedValue: plain(e.estimatedValue), category: e.category ?? '', termsAgreementId: e.termsAgreementId ?? '', termsNote: e.termsNote ?? '', bidDeadline: toLocal(e.bidDeadline), liveStartsAt: toLocal(e.liveStartsAt), liveEndsAt: toLocal(e.liveEndsAt) });
  const [f, setF] = useState(init);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setF(init()); }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof ReturnType<typeof init>) => (ev: { target: { value: string } }) => setF({ ...f, [k]: ev.target.value });
  const auction = e.format !== 'rfq';
  async function save() {
    setBusy(true);
    try {
      onSaved(await api<EventData>(`/staff/sourcing/events/${e.id}`, { method: 'PATCH', body: {
        title: f.title, description: f.description || null, estimatedValue: n(String(f.estimatedValue)), category: f.category || null, termsAgreementId: f.termsAgreementId || null, termsNote: f.termsNote || null,
        bidDeadline: fromLocal(f.bidDeadline), liveStartsAt: auction ? fromLocal(f.liveStartsAt) : null, liveEndsAt: auction ? fromLocal(f.liveEndsAt) : null } }));
    } catch (err: any) { onError(err.message); } finally { setBusy(false); }
  }
  const dis = !canEdit;
  const terms = setup?.terms ?? [];
  return (
    <section className="card pad section-card">
      <h3>Details</h3>
      <div className="field-grid">
        <div className="field field-wide"><label htmlFor="ev-title">Title</label><input id="ev-title" disabled={dis} value={f.title} onChange={set('title')} /></div>
        <div className="field"><label htmlFor="ev-value">Estimated value ({e.currency})</label><input id="ev-value" inputMode="decimal" disabled={dis} value={f.estimatedValue} onChange={set('estimatedValue')} />
          <div className="field-help">Never shown to bidders. Decides who approves the event.{f.estimatedValue && !Number.isNaN(Number(f.estimatedValue)) ? ` ${money(Number(f.estimatedValue), e.currency)}` : ''}</div></div>
        <div className="field"><label htmlFor="ev-cat">Category</label>
          {setup?.categories.length ? <select id="ev-cat" disabled={dis} value={f.category} onChange={set('category')}><option value="">—</option>{setup.categories.map((c) => <option key={c}>{c}</option>)}</select>
            : <input id="ev-cat" disabled={dis} value={f.category} onChange={set('category')} />}</div>
        <div className="field field-wide"><label htmlFor="ev-desc">Description for bidders</label><textarea id="ev-desc" rows={3} disabled={dis} value={f.description} onChange={set('description')} /></div>
      </div>
      <h4>Schedule</h4>
      <div className="field-grid">
        {!auction && <div className="field"><label htmlFor="ev-deadline">Bid deadline</label><input id="ev-deadline" type="datetime-local" disabled={dis} value={f.bidDeadline} onChange={set('bidDeadline')} /></div>}
        {auction && <>
          <div className="field"><label htmlFor="ev-start">Auction starts</label><input id="ev-start" type="datetime-local" disabled={dis} value={f.liveStartsAt} onChange={set('liveStartsAt')} /></div>
          <div className="field"><label htmlFor="ev-end">Auction ends</label><input id="ev-end" type="datetime-local" disabled={dis} value={f.liveEndsAt} onChange={set('liveEndsAt')} /><div className="field-help">Auto-extension can move the end.</div></div>
          <div className="field"><label htmlFor="ev-deadline">Sealed round closes (optional)</label><input id="ev-deadline" type="datetime-local" disabled={dis} value={f.bidDeadline} onChange={set('bidDeadline')} /><div className="field-help">For technical qualification before the auction.</div></div>
        </>}
      </div>
      <h4>Terms</h4>
      <div className="field-grid">
        <div className="field"><label htmlFor="ev-terms">Terms bidders accept</label>
          <select id="ev-terms" disabled={dis} value={f.termsAgreementId} onChange={set('termsAgreementId')}>
            <option value="">No standard terms</option>
            {d.terms && !terms.some((t) => t.id === d.terms!.id) && <option value={d.terms.id}>{d.terms.title}</option>}
            {terms.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
          <div className="field-help">From Administration → Agreements (used for sourcing events). Versioned; bidders accept the current version.</div></div>
        <div className="field field-wide"><label htmlFor="ev-note">Extra terms for this event</label><textarea id="ev-note" rows={2} disabled={dis} value={f.termsNote} onChange={set('termsNote')} placeholder="e.g. delivery to the Pune plant within 30 days" /></div>
      </div>
      {canEdit && <div className="btn-row"><button className="btn btn-primary" disabled={busy} onClick={save}>Save details</button></div>}
    </section>
  );
}

function Rules({ d, setup, canEdit, onSaved, onError }: Saved & { setup?: Setup; onSaved: (r: EventData) => void }) {
  const e = d.event;
  const submitted = !e.editable;
  const on = useMemo(() => new Set(setup?.config.features.filter((f) => f.on).map((f) => f.key) ?? []), [setup]);
  const rules = (setup?.config.rules ?? []).filter((r) => !r.requires || on.has(r.requires));
  const [vals, setVals] = useState<Record<string, string>>({});
  useEffect(() => { setVals(Object.fromEntries(rules.map((r) => [r.key, ruleText(submitted ? e.rules[r.key] : r.locked ? r.value : e.ruleChoices[r.key] ?? r.value)]))); }, [d, setup]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!setup) return null;
  async function save() {
    // Only send what differs from the workspace default, so later default changes still reach this draft.
    const choices = Object.fromEntries(rules.filter((r) => !r.locked).map((r) => [r.key, ruleValue(r, vals[r.key])]).filter(([k, v]) => v !== undefined && v !== rules.find((r) => r.key === k)!.value));
    try { onSaved(await api<EventData>(`/staff/sourcing/events/${e.id}`, { method: 'PATCH', body: { ruleChoices: choices } })); } catch (err: any) { onError(err.message); }
  }
  return (
    <section className="card pad section-card">
      <h3>Rules</h3>
      <p className="muted small">{submitted ? 'Fixed when the event was submitted.' : 'Start from your workspace’s defaults. Locked rules are set by your administrator.'}</p>
      {rules.map((r) => (
        <div key={r.key} className="field">
          <label htmlFor={`rule-${r.key}`}>{r.label}{r.locked && <span className="badge sm" style={{ marginInlineStart: 6 }}>🔒 Locked</span>}</label>
          <RuleInput rule={r} value={vals[r.key] ?? ''} disabled={!canEdit || r.locked || submitted} currency={setup.currency} onChange={(v) => setVals({ ...vals, [r.key]: v })} />
        </div>
      ))}
      {canEdit && !submitted && <div className="btn-row"><button className="btn btn-secondary btn-sm" onClick={save}>Save rules</button></div>}
    </section>
  );
}

const blankLine = (): Line => ({ itemCode: '', description: '', quantity: '', unit: '', specification: '', targetPrice: '' });
const blankLot = (i: number): Lot => ({ title: `Lot ${i}`, bidMode: 'lot', startPrice: '', reservePrice: '', lines: [blankLine()] });
const toBody = (lots: Lot[]) => lots.map((l) => ({ title: l.title, bidMode: l.bidMode, startPrice: n(String(l.startPrice ?? '')), reservePrice: n(String(l.reservePrice ?? '')),
  lines: l.lines.filter((x) => String(x.description).trim() || String(x.quantity).trim()).map((x) => ({ itemCode: x.itemCode || null, description: x.description, quantity: n(String(x.quantity)) ?? undefined, unit: x.unit, specification: x.specification || null, targetPrice: n(String(x.targetPrice ?? '')) })) }));

function Items({ d, canEdit, onSaved, onError }: Saved & { onSaved: (r: EventData, msg: string) => void }) {
  const e = d.event;
  const [lots, setLots] = useState<Lot[]>(() => plainLots(d.lots));
  const [dirty, setDirty] = useState(false);
  const [excel, setExcel] = useState(false);
  useEffect(() => { setLots(plainLots(d.lots)); setDirty(false); }, [d]);
  const edit = (fn: (ls: Lot[]) => void) => { setLots((prev) => { const nx = structuredClone(prev); fn(nx); return nx; }); setDirty(true); };
  const auction = e.format !== 'rfq';
  async function save(list = lots, from: 'screen' | 'excel' = 'screen') {
    try { onSaved(await api<EventData>(`/staff/sourcing/events/${e.id}/items${from === 'excel' ? '?from=excel' : ''}`, { method: 'PUT', body: { lots: toBody(list) } }), from === 'excel' ? 'Items imported from Excel.' : 'Items saved.'); }
    catch (err: any) { onError(err.message); }
  }
  const total = lots.reduce((s, l) => s + l.lines.length, 0);
  return (
    <section className="card pad section-card">
      <div className="toolbar"><div><h3>Lots and items</h3><p className="muted small">{lots.length} lot{lots.length === 1 ? '' : 's'}, {total} item{total === 1 ? '' : 's'}. Bidders quote per lot (one price) or per item.</p></div>
        {canEdit && <div className="head-actions"><button className="btn btn-secondary btn-sm" onClick={() => setExcel(true)}>Import from Excel</button><button className="btn btn-secondary btn-sm" onClick={() => edit((ls) => { ls.push(blankLot(ls.length + 1)); })}>+ Add lot</button></div>}</div>
      {!lots.length && <Empty>No lots yet. Add a lot, or import the items from Excel.</Empty>}
      {lots.map((l, li) => (
        <div key={li} className="card pad" style={{ marginBottom: 12 }}>
          {!canEdit ? (
            <div className="row-between"><strong>Lot {li + 1}: {l.title}</strong>
              <span className="muted small">{l.bidMode === 'lot' ? 'One price for the lot' : 'A price per item'}{auction && l.startPrice !== '' ? ` · start ${money(Number(l.startPrice), e.currency)}` : ''}{l.reservePrice !== '' ? ` · target ${money(Number(l.reservePrice), e.currency)} (hidden)` : ''}</span></div>
          ) : <div className="field-grid">
            <div className="field"><label htmlFor={`lot-${li}`}>Lot {li + 1}</label><input id={`lot-${li}`} disabled={!canEdit} value={l.title} onChange={(ev) => edit((ls) => { ls[li].title = ev.target.value; })} /></div>
            <div className="field"><label htmlFor={`lot-mode-${li}`}>Bidders quote</label><select id={`lot-mode-${li}`} disabled={!canEdit} value={l.bidMode} onChange={(ev) => edit((ls) => { ls[li].bidMode = ev.target.value as 'lot' | 'line'; })}><option value="lot">One price for the lot</option><option value="line">A price per item</option></select></div>
            {auction && <div className="field"><label htmlFor={`lot-start-${li}`}>Start (ceiling) price</label><input id={`lot-start-${li}`} inputMode="decimal" disabled={!canEdit} value={l.startPrice ?? ''} onChange={(ev) => edit((ls) => { ls[li].startPrice = ev.target.value; })} /></div>}
            <div className="field"><label htmlFor={`lot-res-${li}`}>Target price (hidden)</label><input id={`lot-res-${li}`} inputMode="decimal" disabled={!canEdit} value={l.reservePrice ?? ''} onChange={(ev) => edit((ls) => { ls[li].reservePrice = ev.target.value; })} /></div>
          </div>}
          <table className="table static compact">
            <thead><tr><th style={{ width: '15%' }}>Code</th><th style={{ width: '27%' }}>Description</th><th style={{ width: '10%' }} className="num">Qty</th><th style={{ width: '8%' }}>Unit</th><th>Specification</th><th style={{ width: '13%' }} className="num">Target unit price</th>{canEdit && <th style={{ width: 32 }} />}</tr></thead>
            <tbody>{l.lines.map((x, xi) => (
              <tr key={xi}>
                {(['itemCode', 'description', 'quantity', 'unit', 'specification', 'targetPrice'] as const).map((k) => !canEdit ? (
                  <td key={k} className={k === 'quantity' || k === 'targetPrice' ? 'num' : k === 'itemCode' ? 'mono' : ''}>{k === 'targetPrice' && x[k] !== '' ? money(Number(x[k]), e.currency) : x[k] || '—'}</td>
                ) : (
                  <td key={k}><input aria-label={`Lot ${li + 1} item ${xi + 1} ${k === 'itemCode' ? 'code' : k === 'targetPrice' ? 'target price' : k}`} disabled={!canEdit} value={x[k] ?? ''} inputMode={k === 'quantity' || k === 'targetPrice' ? 'decimal' : undefined}
                    onChange={(ev) => edit((ls) => { (ls[li].lines[xi] as any)[k] = ev.target.value; })} style={{ width: '100%' }} /></td>))}
                {canEdit && <td><button className="icon-btn" aria-label={`Remove item ${xi + 1} of lot ${li + 1}`} onClick={() => edit((ls) => { ls[li].lines.splice(xi, 1); })}>×</button></td>}
              </tr>))}</tbody>
          </table>
          {canEdit && <div className="btn-row"><button className="link-btn small" onClick={() => edit((ls) => { ls[li].lines.push(blankLine()); })}>+ Add item</button>
            <button className="link-btn small" onClick={() => confirm(`Remove lot “${l.title}” and its items?`) && edit((ls) => { ls.splice(li, 1); })}>Remove lot</button></div>}
        </div>
      ))}
      {canEdit && dirty && <div className="btn-row"><button className="btn btn-secondary" onClick={() => { setLots(plainLots(d.lots)); setDirty(false); }}>Undo changes</button><button className="btn btn-primary" onClick={() => save()}>Save items</button></div>}
      {excel && <ExcelModal hasItems={d.lots.length > 0} onClose={() => setExcel(false)} onApply={(ls) => { setExcel(false); save(ls, 'excel'); }} />}
    </section>
  );
}

function ExcelModal({ hasItems, onClose, onApply }: { hasItems: boolean; onClose: () => void; onApply: (lots: Lot[]) => void }) {
  const [res, setRes] = useState<{ lots: Lot[]; errors: { row: number; message: string }[] }>();
  const [error, setError] = useState<string>();
  async function read(file?: File) {
    if (!file) return;
    setError(undefined); setRes(undefined);
    const fd = new FormData(); fd.append('file', file);
    try { setRes(await api('/staff/sourcing/items/excel', { body: fd })); } catch (e: any) { setError(e.message); }
  }
  const lines = res?.lots.reduce((s, l) => s + l.lines.length, 0) ?? 0;
  return (
    <Modal title="Import items from Excel" onClose={onClose} wide footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!res || res.errors.length > 0 || !res.lots.length} onClick={() => onApply(res!.lots)}>{hasItems ? 'Replace items' : 'Add items'}</button></>}>
      <ol className="small">
        <li><a href="/api/staff/sourcing/items-template.xlsx">Download the template</a> — one row per item; rows with the same lot number form a lot.</li>
        <li>Choose the filled-in file. Nothing is saved until you confirm.</li>
      </ol>
      <div className="field"><label htmlFor="items-file">Excel file (.xlsx)</label><input id="items-file" type="file" accept=".xlsx" onChange={(ev) => read(ev.target.files?.[0])} /></div>
      {error && <Alert kind="error">{error}</Alert>}
      {res && res.errors.length > 0 && <Alert kind="error"><strong>Fix these rows and choose the file again:</strong><ul style={{ margin: '4px 0 0' }}>{res.errors.map((x, k) => <li key={k}>{x.row ? `Row ${x.row}: ` : ''}{x.message}</li>)}</ul></Alert>}
      {res && !res.errors.length && <Alert kind="success">{res.lots.length} lot{res.lots.length === 1 ? '' : 's'} with {lines} item{lines === 1 ? '' : 's'} read: {res.lots.map((l) => `${l.title} (${l.lines.length})`).join(', ')}.{hasItems ? ' They replace the current items.' : ''}</Alert>}
    </Modal>
  );
}

const ACTION_TEXT: Record<string, string> = {
  SOURCING_EVENT_CREATED: 'Created', SOURCING_TEMPLATE_CREATED: 'Template created', SOURCING_EVENT_UPDATED: 'Details changed', SOURCING_ITEMS_SAVED: 'Items saved', SOURCING_EVENT_SUBMITTED: 'Submitted for approval',
  SOURCING_EVENT_WITHDRAWN: 'Withdrawn', SOURCING_EVENT_CANCELLED: 'Cancelled', SOURCING_EVENT_APPROVED: 'Approved', SOURCING_EVENT_COPIED: 'Copied', FLOW_STARTED: 'Approval started',
  FLOW_STEP_APPROVED: 'Approved a level', FLOW_STEP_SENT_BACK: 'Sent back', FLOW_STEP_REJECTED: 'Rejected', FLOW_STEP_OVERDUE: 'Approval overdue',
};
const History = ({ rows }: { rows: EventData['history'] }) => <HistoryCard rows={rows} actions={ACTION_TEXT} />;

function CancelModal({ onClose, onCancel }: { onClose: () => void; onCancel: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title="Cancel the event" onClose={onClose} footer={<><button className="btn btn-secondary" onClick={onClose}>Keep it</button><button className="btn btn-danger" disabled={!reason.trim()} onClick={() => onCancel(reason)}>Cancel event</button></>}>
      <div className="field"><label htmlFor="cancel-reason">Reason</label><textarea id="cancel-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /><div className="field-help">Recorded in the history. This can’t be undone.</div></div>
    </Modal>
  );
}
