import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { Alert, Empty, Modal } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';

interface RoleRow { id: string; key: string; name: string; description?: string }
interface UserRow { id: string; name: string; email: string; status: 'INVITED' | 'ACTIVE' | 'DISABLED'; mfaEnabled: boolean; locked: boolean; lastLoginAt?: string; roles: RoleRow[] }

export function Users() {
  const { me } = useSession();
  const [users, setUsers] = useState<UserRow[]>();
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [editing, setEditing] = useState<UserRow | 'new'>();
  const [flash, setFlash] = useState<{ kind: 'success' | 'error'; text: string }>();
  const [q, setQ] = useState('');
  const load = useCallback(async () => {
    const [u, r] = await Promise.all([api<UserRow[]>('/admin/users'), api<{ roles: RoleRow[] }>('/admin/roles')]);
    setUsers(u); setRoles(r.roles);
  }, []);
  useEffect(() => { load().catch((e) => setFlash({ kind: 'error', text: e.message })); }, [load]);

  async function act(path: string, body: unknown, ok: string) {
    try { await api(path, { method: body === undefined ? 'POST' : 'PATCH', body }); setFlash({ kind: 'success', text: ok }); load(); }
    catch (e: any) { setFlash({ kind: 'error', text: e.message }); }
  }
  const shown = users?.filter((u) => !q || `${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Users</h1><p className="muted">People in the {me?.tenant.name} workspace and what they can do.</p></div>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>+ Invite user</button>
      </header>
      {flash && <Alert kind={flash.kind}>{flash.text}</Alert>}
      <div className="card">
        <div className="toolbar"><input className="search" placeholder="Search name or email…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" /></div>
        {!shown ? <div className="pad"><div className="spinner" /></div> : shown.length === 0 ? <Empty>No users match.</Empty> : (
          <div className="table-wrap">
            <table className="table static">
              <thead><tr><th>User</th><th>Roles</th><th>Status</th><th>2FA</th><th>Last sign-in</th><th /></tr></thead>
              <tbody>
                {shown.map((u) => (
                  <tr key={u.id}>
                    <td><div className="strong">{u.name}{u.id === me?.user.id && <span className="muted small"> (you)</span>}</div><div className="muted small">{u.email}</div></td>
                    <td>{u.roles.map((r) => <span key={r.id} className="chip">{r.name}</span>)}</td>
                    <td>
                      <span className={`badge ${u.status === 'ACTIVE' ? 'badge-approved' : u.status === 'INVITED' ? 'badge-invited' : 'badge-rejected'}`}>{u.status === 'ACTIVE' ? 'Active' : u.status === 'INVITED' ? 'Invited' : 'Disabled'}</span>
                      {u.locked && <span className="badge badge-sent_back">Locked</span>}
                    </td>
                    <td>{u.mfaEnabled ? '✓' : <span className="muted">—</span>}</td>
                    <td className="muted small">{fmtDateTime(u.lastLoginAt)}</td>
                    <td className="actions">
                      <button className="link-btn small" onClick={() => setEditing(u)}>Edit</button>
                      {u.status === 'INVITED' && <button className="link-btn small" onClick={() => act(`/admin/users/${u.id}/resend-invite`, undefined, `Invitation re-sent to ${u.email}`)}>Resend invite</button>}
                      {u.locked && <button className="link-btn small" onClick={() => act(`/admin/users/${u.id}/unlock`, undefined, `${u.name} unlocked`)}>Unlock</button>}
                      {u.mfaEnabled && u.id !== me?.user.id && <button className="link-btn small" onClick={() => confirm(`Reset 2FA for ${u.name}? They'll set it up again at next sign-in.`) && act(`/admin/users/${u.id}/reset-mfa`, undefined, `2FA reset for ${u.name}`)}>Reset 2FA</button>}
                      {u.status === 'ACTIVE' && u.id !== me?.user.id && <button className="link-btn small danger" onClick={() => confirm(`Disable ${u.name}? They'll be signed out immediately.`) && act(`/admin/users/${u.id}`, { status: 'DISABLED' }, `${u.name} disabled`)}>Disable</button>}
                      {u.status === 'DISABLED' && <button className="link-btn small" onClick={() => act(`/admin/users/${u.id}`, { status: 'ACTIVE' }, `${u.name} re-enabled`)}>Enable</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {editing && <UserModal user={editing === 'new' ? undefined : editing} roles={roles} onClose={() => setEditing(undefined)} onSaved={(t) => { setEditing(undefined); setFlash({ kind: 'success', text: t }); load(); }} />}
    </div>
  );
}

function UserModal({ user, roles, onClose, onSaved }: { user?: UserRow; roles: RoleRow[]; onClose: () => void; onSaved: (msg: string) => void }) {
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [roleIds, setRoleIds] = useState<string[]>(user?.roles.map((r) => r.id) ?? []);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const toggle = (id: string) => setRoleIds((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id]));
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined);
    try {
      if (user) { await api(`/admin/users/${user.id}`, { method: 'PATCH', body: { name, roleIds } }); onSaved(`${name} updated`); }
      else { await api('/admin/users', { body: { name, email, roleIds } }); onSaved(`Invitation sent to ${email}`); }
    } catch (err: any) { setError(err.message); setBusy(false); }
  }
  return (
    <Modal title={user ? `Edit ${user.name}` : 'Invite a user'} onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="user-form" disabled={busy || !roleIds.length}>{user ? 'Save' : 'Send invitation'}</button></>}>
      <form id="user-form" onSubmit={save} className="stack">
        {error && <Alert kind="error">{error}</Alert>}
        <div className="field"><label htmlFor="u-name">Name</label><input id="u-name" value={name} onChange={(e) => setName(e.target.value)} required /></div>
        {!user && <div className="field"><label htmlFor="u-email">Email</label><input id="u-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>}
        <fieldset className="group"><legend>Roles</legend>
          <div className="check-list">
            {roles.map((r) => (
              <label key={r.id} className="check-item"><input type="checkbox" checked={roleIds.includes(r.id)} onChange={() => toggle(r.id)} /><span><strong>{r.name}</strong>{r.description && <span className="muted small block">{r.description}</span>}</span></label>
            ))}
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
