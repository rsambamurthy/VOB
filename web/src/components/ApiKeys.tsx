/**
 * API keys for the ERP or middleware — one card for Purchasing setup and Administration → Invoices (the same keys, server
 * routes/apiKeys.ts). `endpoints` lists what the caller's product offers under /api/v1.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { Alert, Empty, Modal } from './ui';

interface ApiKey { id: string; name: string; prefix: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }

export function ApiKeysCard({ endpoint, purpose, endpoints, onError }: { endpoint: string; purpose: string; endpoints: [string, ReactNode][]; onError: (m: string) => void }) {
  const [keys, setKeys] = useState<ApiKey[]>();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ key: string; name: string }>();
  const [revoke, setRevoke] = useState<ApiKey>();
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => api<ApiKey[]>(endpoint).then(setKeys).catch((e) => onError(e.message)), [endpoint, onError]);
  useEffect(() => { load(); }, [load]);
  const base = `${window.location.origin}/api/v1`;
  return (
    <>
      <section className="card section-card">
        <div className="toolbar"><div><h3>API keys</h3><p className="muted small">{purpose} Send the key in the <span className="icode">Authorization: Bearer …</span> header.</p></div></div>
        <form className="inline-form pad" onSubmit={async (e) => { e.preventDefault(); try { setCreated(await api(endpoint, { body: { name } })); setName(''); setCopied(false); load(); } catch (er: any) { onError(er.message); } }}>
          <input aria-label="Key name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Oracle EBS production" />
          <button className="btn btn-primary btn-sm" disabled={name.trim().length < 2}>Create key</button>
        </form>
        {created && (
          <div className="pad"><Alert kind="success"><strong>Copy this key now — it won’t be shown again.</strong>
            <div className="key-row"><span className="icode break">{created.key}</span><button className="btn btn-secondary btn-sm" onClick={() => { navigator.clipboard?.writeText(created.key).then(() => setCopied(true)).catch(() => {}); }}>{copied ? 'Copied' : 'Copy'}</button></div></Alert></div>
        )}
        {keys?.length ? (
          <table className="table static"><thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th /></tr></thead>
            <tbody>{keys.map((k) => <tr key={k.id} className={k.revokedAt ? 'muted' : ''}><td>{k.name}</td><td className="mono small">{k.prefix}…</td><td className="small">{fmtDateTime(k.createdAt)}</td><td className="small">{k.lastUsedAt ? fmtDateTime(k.lastUsedAt) : 'Never'}</td>
              <td className="actions">{k.revokedAt ? <span className="badge badge-invited sm">revoked</span> : <button className="link-btn small danger" onClick={() => setRevoke(k)}>Revoke</button>}</td></tr>)}</tbody></table>
        ) : keys && <Empty>No API keys yet.</Empty>}
      </section>
      <section className="card section-card">
        <div className="toolbar"><h3>Endpoints</h3></div>
        <table className="table static compact"><tbody>
          {endpoints.map(([path, help]) => { const [verb, ...rest] = path.split(' '); return <tr key={path}><td className="mono small nowrap">{verb} {base}{rest.join(' ')}</td><td className="small">{help}</td></tr>; })}
        </tbody></table>
      </section>
      {revoke && <Modal title={`Revoke “${revoke.name}”?`} onClose={() => setRevoke(undefined)} footer={<><button className="btn btn-ghost" onClick={() => setRevoke(undefined)}>Cancel</button>
        <button className="btn btn-danger" onClick={async () => { try { await api(`${endpoint}/${revoke.id}`, { method: 'DELETE' }); setRevoke(undefined); load(); } catch (e: any) { onError(e.message); } }}>Revoke key</button></>}>
        <p>Anything using this key will stop working straight away. This can’t be undone.</p></Modal>}
    </>
  );
}
