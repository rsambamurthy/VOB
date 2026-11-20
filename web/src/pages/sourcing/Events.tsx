/** Sourcing → Events: every RFQ and auction, filters, templates, and starting a new event. */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { fmtDateTime, money } from '../../lib/format';
import { Alert, Empty, Modal } from '../../components/ui';
import { TabStrip } from '../../components/TabStrip';
import { EventStatus, FORMAT_LABEL } from '../../components/Sourcing';
import { useHelpContext } from '../../help/HelpPanel';
import { useSession } from '../../lib/session';

interface EventRow { id: string; number: string; title: string; format: string; status: string; currency: string; estimatedValue: string | null; category: string | null; bidDeadline: string | null; liveStartsAt: string | null; owner: string; lots: number; lines: number; bidders: number; waitingForMe: boolean }
const FILTERS = [['all', 'All'], ['approval', 'Waiting for approval'], ['drafts', 'Drafts'], ['approved', 'Approved / open'], ['mine', 'Mine'], ['templates', 'Templates']] as const;

export function SourcingEvents() {
  useHelpContext('sourcing');
  const { me, can } = useSession();
  const [params, setParams] = useSearchParams();
  const filter = params.get('filter') ?? 'all';
  const [events, setEvents] = useState<EventRow[]>();
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState<false | { fromTemplate?: EventRow; template?: boolean }>(false);
  const load = useCallback(() => { setEvents(undefined); api<{ events: EventRow[] }>(`/staff/sourcing/events?filter=${filter}`).then((r) => setEvents(r.events)).catch((e) => setError(e.message)); }, [filter]);
  useEffect(() => { load(); }, [load]);
  const formats = (me?.sourcing?.formats ?? []).map((f) => FORMAT_LABEL[f] ?? f).join(', ');
  const templates = filter === 'templates';
  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Sourcing events</h1><p className="muted">RFQs and auctions{formats ? ` — switched on: ${formats}` : ''}.</p></div>
        {can('sourcing.events') && <div className="head-actions">
          <button className="btn btn-secondary" onClick={() => setCreating({ template: true })}>+ New template</button>
          <button className="btn btn-primary" onClick={() => setCreating({})}>+ New event</button></div>}
      </header>
      {error && <Alert kind="error">{error}</Alert>}
      <TabStrip>{FILTERS.map(([k, l]) => <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'active' : ''} onClick={() => setParams(k === 'all' ? {} : { filter: k })}>{l}</button>)}</TabStrip>
      {!events && !error && <div className="spinner" />}
      {events && (events.length ? (
        <table className="table">
          <thead><tr><th>Number</th><th>Title</th><th>Format</th>{!templates && <th>Status</th>}<th className="num">Estimated value</th><th className="num">Items</th>{!templates && <th>Closes / starts</th>}<th>Owner</th>{templates && <th />}</tr></thead>
          <tbody>{events.map((e) => (
            <tr key={e.id}>
              <td className="mono"><Link to={`/staff/sourcing/events/${e.id}`}>{e.number}</Link></td>
              <td><Link to={`/staff/sourcing/events/${e.id}`}>{e.title}</Link>{e.waitingForMe && <span className="badge badge-under_review sm" style={{ marginInlineStart: 6 }}>Your approval</span>}{e.category && <div className="muted small">{e.category}</div>}</td>
              <td>{FORMAT_LABEL[e.format] ?? e.format}</td>
              {!templates && <td><EventStatus status={e.status} /></td>}
              <td className="num">{e.estimatedValue ? money(e.estimatedValue, e.currency) : '—'}</td>
              <td className="num">{e.lots} lot{e.lots === 1 ? '' : 's'} · {e.lines} item{e.lines === 1 ? '' : 's'}</td>
              {!templates && <td className="small">{e.liveStartsAt ? fmtDateTime(e.liveStartsAt) : e.bidDeadline ? fmtDateTime(e.bidDeadline) : '—'}</td>}
              <td className="small">{e.owner}</td>
              {templates && <td className="actions">{can('sourcing.events') && <button className="link-btn small" onClick={() => setCreating({ fromTemplate: e })}>Use template</button>}</td>}
            </tr>
          ))}</tbody>
        </table>
      ) : <Empty>{templates ? 'No templates yet. Save an event as a template, or create one.' : filter === 'approval' ? 'Nothing is waiting for approval.' : 'No sourcing events yet.'}</Empty>)}
      {creating && <NewEventModal fromTemplate={creating.fromTemplate} template={creating.template} formats={me?.sourcing?.formats ?? []} onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewEventModal({ fromTemplate, template, formats, onClose }: { fromTemplate?: EventRow; template?: boolean; formats: string[]; onClose: () => void }) {
  const nav = useNavigate();
  const [title, setTitle] = useState(fromTemplate ? fromTemplate.title : '');
  const [format, setFormat] = useState(formats[0] ?? 'rfq');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true); setError(undefined);
    try {
      const r = await api<{ event: { id: string } }>('/staff/sourcing/events', { body: fromTemplate ? { fromTemplate: fromTemplate.id, title } : { title, format, template: !!template } });
      nav(`/staff/sourcing/events/${r.event.id}`);
    } catch (e: any) { setError(e.message); setBusy(false); }
  }
  return (
    <Modal title={fromTemplate ? `New event from “${fromTemplate.title}”` : template ? 'New template' : 'New sourcing event'} onClose={onClose}
      footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || title.trim().length < 3} onClick={create}>Create</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="field"><label htmlFor="ne-title">Title</label><input id="ne-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. MS plates for Pune plant — Q3" /></div>
      {!fromTemplate && <div className="field"><label>Format</label>
        {formats.map((f) => <label key={f} className="radio" style={{ display: 'block' }}><input type="radio" name="ne-format" checked={format === f} onChange={() => setFormat(f)} /> {FORMAT_LABEL[f] ?? f}</label>)}
        <div className="field-help">The format can’t be changed later. The number is given now (e.g. RFQ-{new Date().getFullYear()}-0001).</div></div>}
      {fromTemplate && <p className="muted small">The format, terms, rules and items are copied from the template; you can change everything except the format.</p>}
    </Modal>
  );
}
