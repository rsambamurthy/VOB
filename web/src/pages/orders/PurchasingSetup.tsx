import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { fmtDateTime } from '../../lib/format';
import { Alert, Empty, Modal } from '../../components/ui';
import { useHelpContext } from '../../help/HelpPanel';

interface Entity { id: string; code: string; name: string; active: boolean }
interface Site { id: string; code: string; name: string; entityId: string | null; active: boolean }
interface Group { id: string; code: string; name: string; autoAcceptDays: number | null; asnRequired: boolean; active: boolean; orders: number }
interface Setup { entities: Entity[]; sites: Site[]; groups: Group[] }
interface ApiKey { id: string; name: string; prefix: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }

type Tab = 'groups' | 'entities' | 'keys';

export function PurchasingSetup() {
  const { can } = useSession();
  const [tab, setTab] = useState<Tab>('groups');
  useHelpContext(`purchasing-${tab}`);
  const [d, setD] = useState<Setup>();
  const [error, setError] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const manage = can('orders.manage');
  const load = useCallback(() => api<Setup>('/purchasing/setup').then(setD).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const done = (msg: string) => { setFlash(msg); setError(undefined); load(); };

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Purchasing setup</h1><p className="muted">How purchase orders are grouped, when they auto-accept, and how your ERP connects.</p></div>
      </header>
      {error && <Alert kind="error">{error}</Alert>}
      {flash && <Alert kind="success">{flash}</Alert>}
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'groups'} className={tab === 'groups' ? 'active' : ''} onClick={() => setTab('groups')}>Buying groups</button>
        <button role="tab" aria-selected={tab === 'entities'} className={tab === 'entities' ? 'active' : ''} onClick={() => setTab('entities')}>Companies &amp; sites</button>
        {can('tenant.settings') && <button role="tab" aria-selected={tab === 'keys'} className={tab === 'keys' ? 'active' : ''} onClick={() => setTab('keys')}>API keys</button>}
      </div>
      {!d && !error && <div className="spinner" />}
      {d && tab === 'groups' && <Groups groups={d.groups} manage={manage} onDone={done} onError={setError} />}
      {d && tab === 'entities' && <Entities d={d} manage={manage} onDone={done} onError={setError} />}
      {tab === 'keys' && can('tenant.settings') && <Keys onError={setError} />}
    </div>
  );
}

type Props = { manage: boolean; onDone: (m: string) => void; onError: (m: string) => void };

function Groups({ groups, manage, onDone, onError }: Props & { groups: Group[] }) {
  const [edit, setEdit] = useState<Group | 'new'>();
  return (
    <section className="card section-card">
      <div className="toolbar"><div><h3>Buying groups</h3><p className="muted small">Each order belongs to one buying group (the ERP’s purchasing category or buyer team). The group decides whether the supplier must accept, and after how many days an order accepts itself.</p></div>
        {manage && <button className="btn btn-primary btn-sm" onClick={() => setEdit('new')}>Add buying group</button>}</div>
      {groups.length ? (
        <table className="table static">
          <thead><tr><th>Code</th><th>Name</th><th>Acceptance</th><th>ASN</th><th className="num">Orders</th><th /></tr></thead>
          <tbody>{groups.map((g) => (
            <tr key={g.id} className={g.active ? '' : 'muted'}>
              <td className="mono">{g.code}</td><td>{g.name}{!g.active && <span className="badge badge-invited sm">inactive</span>}</td>
              <td>{g.autoAcceptDays ? <span className="badge badge-auto">Auto after {g.autoAcceptDays} day{g.autoAcceptDays === 1 ? '' : 's'}</span> : <span className="badge badge-under_review">Supplier must accept</span>}</td>
              <td className="small">{g.asnRequired ? 'Required' : 'Optional'}</td>
              <td className="num">{g.orders}</td>
              <td className="actions">{manage && <button className="link-btn small" onClick={() => setEdit(g)}>Edit</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : <Empty>No buying groups yet. Orders without a group need manual acceptance. Groups are also created automatically when the ERP sends a code we haven’t seen.</Empty>}
      {edit && <GroupModal g={edit === 'new' ? undefined : edit} onClose={() => setEdit(undefined)} onDone={(m) => { setEdit(undefined); onDone(m); }} onError={onError} />}
    </section>
  );
}

function GroupModal({ g, onClose, onDone, onError }: { g?: Group; onClose: () => void; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [code, setCode] = useState(g?.code ?? '');
  const [name, setName] = useState(g?.name ?? '');
  const [auto, setAuto] = useState(g ? g.autoAcceptDays !== null : true);
  const [days, setDays] = useState(String(g?.autoAcceptDays ?? 3));
  const [asn, setAsn] = useState(g?.asnRequired ?? false);
  const [active, setActive] = useState(g?.active ?? true);
  const [err, setErr] = useState<string>();
  const n = Number(days);
  const valid = name.trim() && (g || code.trim()) && (!auto || (Number.isInteger(n) && n >= 1 && n <= 90));
  async function save() {
    const body = { name, autoAcceptDays: auto ? n : null, asnRequired: asn, active };
    try {
      if (g) {
        const r = await api<{ retimed: number }>(`/purchasing/groups/${g.id}`, { method: 'PATCH', body });
        onDone(`Saved ${g.code}.${r.retimed ? ` ${r.retimed} waiting order${r.retimed === 1 ? '' : 's'} now follow the new rule.` : ''}`);
      } else { await api('/purchasing/groups', { body: { ...body, code } }); onDone(`Added buying group ${code}.`); }
    } catch (e: any) { setErr(e.message); onError(''); }
  }
  return (
    <Modal title={g ? `Edit ${g.code}` : 'Add buying group'} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!valid} onClick={save}>Save</button></>}>
      {err && <Alert kind="error">{err}</Alert>}
      {!g && <div className="field"><label htmlFor="g-code">Code</label><input id="g-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Same as in the ERP, e.g. RAW-MAT" /></div>}
      <div className="field"><label htmlFor="g-name">Name</label><input id="g-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Raw materials" /></div>
      <fieldset className="field"><legend>When an order arrives</legend>
        <label className="radio"><input type="radio" checked={!auto} onChange={() => setAuto(false)} /> The supplier must accept it</label>
        <label className="radio"><input type="radio" checked={auto} onChange={() => setAuto(true)} /> Accept it automatically if the supplier hasn’t responded after
          <input className="inline-num" type="number" min={1} max={90} value={days} disabled={!auto} onChange={(e) => setDays(e.target.value)} aria-label="Days" /> days</label>
      </fieldset>
      <label className="checkbox"><input type="checkbox" checked={asn} onChange={(e) => setAsn(e.target.checked)} /> Supplier must send an advance shipping notice (used from phase 2)</label>
      {g && <label className="checkbox"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active</label>}
      {g && g.orders > 0 && <p className="muted small">Changing the rule also re-times orders in this group that are still waiting.</p>}
    </Modal>
  );
}

function Entities({ d, manage, onDone, onError }: Props & { d: Setup }) {
  const [adding, setAdding] = useState<'entity' | 'site'>();
  const toggle = async (kind: 'entities' | 'sites', id: string, active: boolean) => {
    try { await api(`/purchasing/${kind}/${id}`, { method: 'PATCH', body: { active } }); onDone(active ? 'Re-activated.' : 'Deactivated.'); } catch (e: any) { onError(e.message); }
  };
  return (
    <>
      <section className="card section-card">
        <div className="toolbar"><div><h3>Companies</h3><p className="muted small">The legal entities that place orders (operating units in Oracle). Suppliers can filter their orders by company.</p></div>
          {manage && <button className="btn btn-secondary btn-sm" onClick={() => setAdding('entity')}>Add company</button>}</div>
        {d.entities.length ? (
          <table className="table static"><thead><tr><th>Code</th><th>Name</th><th>Sites</th><th /></tr></thead>
            <tbody>{d.entities.map((e) => <tr key={e.id} className={e.active ? '' : 'muted'}><td className="mono">{e.code}</td><td>{e.name}{!e.active && <span className="badge badge-invited sm">inactive</span>}</td>
              <td className="small">{d.sites.filter((s) => s.entityId === e.id).length}</td>
              <td className="actions">{manage && <button className="link-btn small" onClick={() => toggle('entities', e.id, !e.active)}>{e.active ? 'Deactivate' : 'Activate'}</button>}</td></tr>)}</tbody></table>
        ) : <Empty>No companies yet — they’re added automatically from incoming orders, or add them here.</Empty>}
      </section>
      <section className="card section-card">
        <div className="toolbar"><div><h3>Delivery sites</h3><p className="muted small">Plants, warehouses and offices that goods are delivered to (ship-to locations).</p></div>
          {manage && <button className="btn btn-secondary btn-sm" onClick={() => setAdding('site')}>Add site</button>}</div>
        {d.sites.length ? (
          <table className="table static"><thead><tr><th>Code</th><th>Name</th><th>Company</th><th /></tr></thead>
            <tbody>{d.sites.map((s) => <tr key={s.id} className={s.active ? '' : 'muted'}><td className="mono">{s.code}</td><td>{s.name}{!s.active && <span className="badge badge-invited sm">inactive</span>}</td>
              <td className="small">{d.entities.find((e) => e.id === s.entityId)?.name ?? '—'}</td>
              <td className="actions">{manage && <button className="link-btn small" onClick={() => toggle('sites', s.id, !s.active)}>{s.active ? 'Deactivate' : 'Activate'}</button>}</td></tr>)}</tbody></table>
        ) : <Empty>No sites yet — they’re added automatically from incoming orders, or add them here.</Empty>}
      </section>
      {adding && <CodeNameModal kind={adding} entities={d.entities} onClose={() => setAdding(undefined)} onDone={(m) => { setAdding(undefined); onDone(m); }} />}
    </>
  );
}

function CodeNameModal({ kind, entities, onClose, onDone }: { kind: 'entity' | 'site'; entities: Entity[]; onClose: () => void; onDone: (m: string) => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [entityId, setEntityId] = useState('');
  const [err, setErr] = useState<string>();
  const label = kind === 'entity' ? 'company' : 'site';
  async function save() {
    try { await api(kind === 'entity' ? '/purchasing/entities' : '/purchasing/sites', { body: { code, name, ...(kind === 'site' ? { entityId: entityId || null } : {}) } }); onDone(`Added ${label} ${code}.`); }
    catch (e: any) { setErr(e.message); }
  }
  return (
    <Modal title={`Add ${label}`} onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!code.trim() || !name.trim()} onClick={save}>Add</button></>}>
      {err && <Alert kind="error">{err}</Alert>}
      <div className="field"><label htmlFor="cn-code">Code</label><input id="cn-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Same as in the ERP" /></div>
      <div className="field"><label htmlFor="cn-name">Name</label><input id="cn-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
      {kind === 'site' && <div className="field"><label htmlFor="cn-ent">Company</label><select id="cn-ent" value={entityId} onChange={(e) => setEntityId(e.target.value)}><option value="">—</option>{entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></div>}
    </Modal>
  );
}

function Keys({ onError }: { onError: (m: string) => void }) {
  const [keys, setKeys] = useState<ApiKey[]>();
  const [name, setName] = useState('');
  const [created, setCreated] = useState<{ key: string; name: string }>();
  const [revoke, setRevoke] = useState<ApiKey>();
  const [copied, setCopied] = useState(false);
  const load = useCallback(() => api<ApiKey[]>('/purchasing/api-keys').then(setKeys).catch((e) => onError(e.message)), [onError]);
  useEffect(() => { load(); }, [load]);
  const base = `${window.location.origin}/api/v1`;
  return (
    <>
      <section className="card section-card">
        <div className="toolbar"><div><h3>API keys</h3><p className="muted small">Let your ERP or middleware push purchase orders and read acceptances. Send the key in the <span className="icode">Authorization: Bearer …</span> header.</p></div></div>
        <form className="inline-form pad" onSubmit={async (e) => { e.preventDefault(); try { setCreated(await api('/purchasing/api-keys', { body: { name } })); setName(''); setCopied(false); load(); } catch (er: any) { onError(er.message); } }}>
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
          <tr><td className="mono small nowrap">POST {base}/purchase-orders</td><td className="small">Send one order or <span className="icode">{'{ "orders": [...] }'}</span>. Add <span className="icode">?format=oracle</span> to send Oracle EBS rows (PO_HEADERS_ALL, PO_LINES_ALL, shipments) as they are.</td></tr>
          <tr><td className="mono small nowrap">GET {base}/purchase-orders/:poNumber</td><td className="small">The order with its acceptance status per line.</td></tr>
          <tr><td className="mono small nowrap">GET {base}/acknowledgements?since=…</td><td className="small">Acceptances since a time (ISO date), for ERPs that poll instead of receiving a push.</td></tr>
        </tbody></table>
      </section>
      {revoke && <Modal title={`Revoke “${revoke.name}”?`} onClose={() => setRevoke(undefined)} footer={<><button className="btn btn-ghost" onClick={() => setRevoke(undefined)}>Cancel</button>
        <button className="btn btn-danger" onClick={async () => { try { await api(`/purchasing/api-keys/${revoke.id}`, { method: 'DELETE' }); setRevoke(undefined); load(); } catch (e: any) { onError(e.message); } }}>Revoke key</button></>}>
        <p>Anything using this key will stop working straight away. This can’t be undone.</p></Modal>}
    </>
  );
}
