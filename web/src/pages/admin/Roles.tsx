import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Alert, Modal } from '../../components/ui';

interface RoleRow { id: string; key: string; name: string; description?: string; permissions: string[]; isSystem: boolean; userCount: number }

export function Roles() {
  const [data, setData] = useState<{ roles: RoleRow[]; permissions: Record<string, string> }>();
  const [editing, setEditing] = useState<RoleRow | 'new'>();
  const [flash, setFlash] = useState<{ kind: 'success' | 'error'; text: string }>();
  const load = useCallback(() => api('/admin/roles').then(setData).catch((e) => setFlash({ kind: 'error', text: e.message })), []);
  useEffect(() => { load(); }, [load]);
  async function remove(r: RoleRow) {
    if (!confirm(`Delete the ${r.name} role?`)) return;
    try { await api(`/admin/roles/${r.id}`, { method: 'DELETE' }); setFlash({ kind: 'success', text: `${r.name} deleted` }); load(); }
    catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }
  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Roles</h1><p className="muted">Roles bundle permissions. Approval levels are assigned to roles, so everyone holding a role can act on that level.</p></div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>+ New role</button>
      </header>
      {flash && <Alert kind={flash.kind}>{flash.text}</Alert>}
      {!data ? <div className="spinner" /> : (
        <div className="role-grid">
          {data.roles.map((r) => (
            <div key={r.id} className="card pad role-card">
              <div className="row-between"><h3>{r.name}</h3><span className="muted small">{r.userCount} user{r.userCount === 1 ? '' : 's'}</span></div>
              {r.description && <p className="muted small">{r.description}</p>}
              <div className="chips">{r.permissions.length ? r.permissions.map((p) => <span key={p} className="chip" title={data.permissions[p]}>{p}</span>) : <span className="muted small">No permissions — approval role only</span>}</div>
              <div className="btn-row">
                <button className="btn btn-secondary btn-sm" onClick={() => setEditing(r)}>Edit</button>
                {!r.isSystem && <button className="btn btn-ghost btn-sm" onClick={() => remove(r)}>Delete</button>}
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && data && <RoleModal role={editing === 'new' ? undefined : editing} permissions={data.permissions} onClose={() => setEditing(undefined)} onSaved={(t) => { setEditing(undefined); setFlash({ kind: 'success', text: t }); load(); }} />}
    </div>
  );
}

function RoleModal({ role, permissions, onClose, onSaved }: { role?: RoleRow; permissions: Record<string, string>; onClose: () => void; onSaved: (m: string) => void }) {
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [perms, setPerms] = useState<string[]>(role?.permissions ?? ['vendors.view']);
  const [error, setError] = useState<string>();
  const locked = role?.key === 'ADMIN';
  async function save(e: React.FormEvent) {
    e.preventDefault(); setError(undefined);
    try {
      if (role) await api(`/admin/roles/${role.id}`, { method: 'PATCH', body: { name, description, permissions: perms } });
      else await api('/admin/roles', { body: { name, description, permissions: perms } });
      onSaved(`${name} saved`);
    } catch (err: any) { setError(err.message); }
  }
  return (
    <Modal title={role ? `Edit ${role.name}` : 'New role'} onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="role-form">Save</button></>}>
      <form id="role-form" onSubmit={save} className="stack">
        {error && <Alert kind="error">{error}</Alert>}
        <div className="field"><label htmlFor="r-name">Name</label><input id="r-name" value={name} onChange={(e) => setName(e.target.value)} required /></div>
        <div className="field"><label htmlFor="r-desc">Description</label><input id="r-desc" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        <fieldset className="group"><legend>Permissions</legend>
          {locked && <p className="small muted">The Administrator role always has every permission.</p>}
          <div className="check-list">
            {Object.entries(permissions).map(([k, label]) => (
              <label key={k} className="check-item"><input type="checkbox" disabled={locked} checked={perms.includes(k)} onChange={() => setPerms((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]))} /><span><strong className="mono">{k}</strong><span className="muted small block">{label}</span></span></label>
            ))}
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
