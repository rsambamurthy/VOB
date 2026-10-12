import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Alert, Empty } from '../components/ui';
import { fmtDateTime } from '../lib/format';

interface Mail { id: string; to: string; subject: string; body: string; link?: string | null; createdAt: string; status: 'TEST' | 'QUEUED' | 'SENT' | 'FAILED'; error?: string | null }

export function Mailbox() {
  const [mails, setMails] = useState<Mail[]>();
  const [open, setOpen] = useState<string>();
  const load = () => api<Mail[]>('/meta/outbox').then((m) => { setMails(m); setOpen((o) => o ?? m[0]?.id); });
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);
  const current = mails?.find((m) => m.id === open);
  return (
    <div className="page">
      <header className="page-head"><div><h1>Mailbox</h1><p className="muted">Every email the system would send. Stand-in for a real email provider while prototyping.</p></div></header>
      <Alert kind="info">Development only: emails for this workspace are captured here instead of being sent. Open a vendor <strong>invitation</strong> to play the supplier, or a staff invitation / reset email to test sign-up.</Alert>
      <div className="card mailbox">
        {!mails ? <div className="pad"><div className="spinner" /></div> : mails.length === 0 ? <Empty>No emails yet.</Empty> : (
          <>
            <ul className="mail-list">
              {mails.map((m) => (
                <li key={m.id}><button className={open === m.id ? 'active' : ''} onClick={() => setOpen(m.id)}>
                  <span className="strong">{m.subject}</span><span className="muted small">{m.to} · {fmtDateTime(m.createdAt)} · <span className={`mail-st st-${m.status.toLowerCase()}`}>{m.status === 'TEST' ? 'not sent (test mode)' : m.status.toLowerCase()}</span></span>
                </button></li>
              ))}
            </ul>
            {current && (
              <article className="mail-view">
                <h3>{current.subject}</h3>
                <div className="muted small">To: {current.to} · {fmtDateTime(current.createdAt)}{current.error && <span className="diff-text"> · {current.error}</span>}</div>
                <pre className="mail-body">{current.body}</pre>
                {current.link && <Link className="btn btn-primary" to={new URL(current.link).pathname} target="_blank">{current.link.includes('/onboard/') ? 'Open vendor portal ↗' : 'Open link ↗'}</Link>}
              </article>
            )}
          </>
        )}
      </div>
    </div>
  );
}
