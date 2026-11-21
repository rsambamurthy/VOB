/**
 * Administration → Invoice code lists: operating units, GL accounts, cost centres, projects, tasks, tax codes, payment terms and
 * valid account combinations. Refreshed from Oracle (nightly or now), sent by other ERPs through the API, or imported from
 * Excel; maintained here: whether AP may use a code, and who owns each cost centre (the approval matrix sends invoices to them).
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useHelpContext } from '../../help/HelpPanel';
import { Alert, Empty, Modal } from '../../components/ui';
import { TabStrip } from '../../components/TabStrip';
import { Pager } from '../../components/Pager';
import { ExcelImportModal } from '../../components/ExcelImport';

interface Code { id: string; code: string; name: string; parent: string | null; enabled: boolean; usable: boolean; source: string; ownerId: string | null; ownerName: string | null; refreshedAt: string | null }
interface List { kind: string; total: number; page: number; pageSize: number; rows: Code[]; kinds: { key: string; label: string; count: number; refreshedAt: string | null }[] }

export function InvoiceCodes() {
  useHelpContext('ap-codes');
  const [kind, setKind] = useState('ACCOUNT');
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState(false);
  const [page, setPage] = useState(1);
  const [d, setD] = useState<List>();
  const [owners, setOwners] = useState<{ id: string; name: string }[]>([]);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error' | 'info'; text: string }>();
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    const p = new URLSearchParams({ kind, page: String(page) });
    if (q) p.set('q', q);
    if (closed) p.set('closed', '1');
    api<List>(`/staff/invoices/codes?${p}`).then(setD).catch((e) => setMsg({ kind: 'error', text: e.message }));
  }, [kind, q, closed, page]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  useEffect(() => { setPage(1); }, [kind, q, closed]);
  useEffect(() => { api<{ users: typeof owners }>('/staff/invoices/owners').then((r) => setOwners(r.users)).catch(() => {}); }, []);
  async function patch(c: Code, body: Partial<Code>) {
    try { await api(`/staff/invoices/codes/${c.id}`, { method: 'PATCH', body }); load(); } catch (e: any) { setMsg({ kind: 'error', text: e.message }); }
  }
  async function refresh() {
    setBusy(true); setMsg({ kind: 'info', text: 'Refreshing from the ERP…' });
    try {
      const r = await api<{ lists: { kind: string; received: number; added: number; changed: number; closed: number }[]; suppliers: { suppliers: number; added: number; linked: number } | null }>('/staff/invoices/codes/refresh', { method: 'POST' });
      setMsg({ kind: 'success', text: `Refreshed: ${r.lists.map((l) => `${d?.kinds.find((k) => k.key === l.kind)?.label ?? l.kind} ${l.received} (${l.added} new, ${l.closed} closed)`).join('; ') || 'no lists sent'}${r.suppliers ? `; suppliers ${r.suppliers.suppliers} (${r.suppliers.added} new parties)` : ''}.` });
      load();
    } catch (e: any) { setMsg({ kind: 'error', text: e.message }); } finally { setBusy(false); }
  }
  const current = d?.kinds.find((k) => k.key === kind);
  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Invoice code lists</h1><p className="muted">Codes AP picks from when coding invoices. Lists from the ERP refresh every night; here you decide which codes AP may use and who owns each cost centre.</p></div>
        <div className="head-actions">
          <button className="btn btn-secondary" onClick={() => setImporting(true)}>Import from Excel</button>
          <button className="btn btn-secondary" onClick={() => setAdding(true)}>+ Add a code</button>
          <button className="btn btn-primary" disabled={busy} onClick={refresh}>Refresh from the ERP</button></div>
      </header>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <TabStrip>{(d?.kinds ?? []).map((k) => <button key={k.key} role="tab" aria-selected={kind === k.key} className={kind === k.key ? 'active' : ''} onClick={() => setKind(k.key)}>{k.label} <span className="muted small">{k.count}</span></button>)}</TabStrip>
      <div className="card">
        <div className="toolbar"><input className="search" placeholder="Search code or name…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search codes" />
          <label className="check-item small"><input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} /> Show closed codes</label>
          {current?.refreshedAt && <span className="muted small">Last from the ERP {fmtDateTime(current.refreshedAt)}</span>}</div>
        {!d ? <div className="pad"><div className="spinner" /></div> : !d.rows.length ? <Empty>{q ? 'No codes match.' : 'No codes in this list yet. Refresh from the ERP, or import them from Excel.'}</Empty> : (
          <div className="table-wrap"><table className="table static">
            <thead><tr><th>Code</th><th>Name</th>{kind === 'TASK' && <th>Project</th>}<th>From</th><th>AP may use it</th>{kind === 'COST_CENTRE' && <th>Owner (budget approver)</th>}</tr></thead>
            <tbody>{d.rows.map((c) => (
              <tr key={c.id} className={c.enabled ? '' : 'muted'}>
                <td className="mono">{c.code}</td><td>{c.name}{!c.enabled && <span className="badge sm badge-invited" style={{ marginInlineStart: 6 }}>closed</span>}</td>
                {kind === 'TASK' && <td className="mono small">{c.parent}</td>}
                <td className="small">{c.source === 'ERP' ? 'ERP' : c.source === 'EXCEL' ? 'Excel' : 'Added here'}</td>
                <td><input type="checkbox" aria-label={`AP may use ${c.code}`} checked={c.usable} onChange={(e) => patch(c, { usable: e.target.checked })} /></td>
                {kind === 'COST_CENTRE' && <td><select aria-label={`Owner of ${c.code}`} value={c.ownerId ?? ''} onChange={(e) => patch(c, { ownerId: e.target.value || null })}>
                  <option value="">— none —</option>{owners.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></td>}
              </tr>))}</tbody>
          </table><Pager page={d.page} pageSize={d.pageSize} total={d.total} onPage={setPage} /></div>
        )}
      </div>
      {adding && d && <AddCodeModal kinds={d.kinds} kind={kind} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
      {importing && (
        <ExcelImportModal<{ row: number; list: string; code: string; name: string }> title="Import code lists" endpoint="/staff/invoices/codes/import" templateUrl="/staff/invoices/codes/template.xlsx"
          intro="One row per code: the list, code and name; for tasks the project; for cost centres the owner’s email. Codes already here are updated."
          columns={[{ label: 'List', cell: (r) => r.list }, { label: 'Code', cell: (r) => r.code }, { label: 'Name', cell: (r) => r.name }]}
          onClose={() => setImporting(false)} onDone={(n) => { setImporting(false); setMsg({ kind: 'success', text: `${n} list${n === 1 ? '' : 's'} imported.` }); load(); }} />
      )}
    </div>
  );
}

function AddCodeModal({ kinds, kind, onClose, onDone }: { kinds: List['kinds']; kind: string; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ kind, code: '', name: '', parent: '' });
  const [error, setError] = useState<string>();
  return (
    <Modal title="Add a code" onClose={onClose} footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!v.code.trim() || !v.name.trim()} onClick={async () => { try { await api('/staff/invoices/codes', { body: { ...v, parent: v.parent || null } }); onDone(); } catch (e: any) { setError(e.message); } }}>Add</button></>}>
      {error && <Alert kind="error">{error}</Alert>}
      <p className="muted small" style={{ marginTop: 0 }}>For codes the ERP doesn’t send. A code with the same value from the ERP later takes over.</p>
      <div className="field"><label htmlFor="ac-kind">List</label><select id="ac-kind" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}>{kinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</select></div>
      <div className="field"><label htmlFor="ac-code">Code</label><input id="ac-code" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value })} /></div>
      <div className="field"><label htmlFor="ac-name">Name</label><input id="ac-name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></div>
      {v.kind === 'TASK' && <div className="field"><label htmlFor="ac-parent">Project</label><input id="ac-parent" value={v.parent} onChange={(e) => setV({ ...v, parent: e.target.value })} /></div>}
    </Modal>
  );
}
