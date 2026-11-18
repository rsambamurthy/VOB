/** Sourcing → Events: every RFQ and auction in the workspace. */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { Alert, Empty } from '../../components/ui';
import { useHelpContext } from '../../help/HelpPanel';
import { useSession } from '../../lib/session';

interface EventRow { id: string; number: string; title: string; format: string; status: string; currency: string; estimatedValue: string | null; bidDeadline: string | null; liveStartsAt: string | null; bidders: number }
export const FORMAT_LABEL: Record<string, string> = { rfq: 'Sealed bid / RFQ', reverse: 'Reverse auction', forward: 'Forward auction', japanese: 'Japanese auction', dutch: 'Dutch auction' };
export const EVENT_STATUS: Record<string, string> = { DRAFT: 'Draft', PENDING_APPROVAL: 'Waiting for approval', PUBLISHED: 'Published', BIDDING: 'Taking bids', OPENING: 'Opening', EVALUATION: 'Evaluation', LIVE: 'Live', CLOSED: 'Closed', AWARD_PENDING: 'Award waiting for approval', AWARDED: 'Awarded', CANCELLED: 'Cancelled' };

export function SourcingEvents() {
  useHelpContext('sourcing');
  const { me } = useSession();
  const [events, setEvents] = useState<EventRow[]>();
  const [error, setError] = useState<string>();
  useEffect(() => { api<{ events: EventRow[] }>('/staff/sourcing/events').then((r) => setEvents(r.events)).catch((e) => setError(e.message)); }, []);
  const formats = (me?.sourcing?.formats ?? []).map((f) => FORMAT_LABEL[f] ?? f).join(', ');
  return (
    <div className="page">
      <header className="page-head"><div><h1>Sourcing events</h1><p className="muted">RFQs and auctions{formats ? ` — switched on: ${formats}` : ''}.</p></div></header>
      {error && <Alert kind="error">{error}</Alert>}
      {!events && !error && <div className="spinner" />}
      {events && (events.length ? (
        <table className="table static">
          <thead><tr><th>Number</th><th>Title</th><th>Format</th><th>Status</th><th className="num">Bidders</th><th>Closes / starts</th></tr></thead>
          <tbody>{events.map((e) => (
            <tr key={e.id}><td className="mono">{e.number}</td><td>{e.title}</td><td>{FORMAT_LABEL[e.format] ?? e.format}</td><td><span className="badge sm">{EVENT_STATUS[e.status] ?? e.status}</span></td>
              <td className="num">{e.bidders}</td><td className="small">{e.liveStartsAt ? fmtDateTime(e.liveStartsAt) : e.bidDeadline ? fmtDateTime(e.bidDeadline) : '—'}</td></tr>
          ))}</tbody>
        </table>
      ) : <Empty>No sourcing events yet.</Empty>)}
    </div>
  );
}
