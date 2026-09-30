import { useState } from 'react';
import { api } from '../../lib/api';
import { applyBranding, useSession } from '../../lib/session';
import { Alert } from '../../components/ui';

export function Workspace() {
  const { me, refresh } = useSession();
  const t = me!.tenant;
  const [f, setF] = useState({
    name: t.name, productName: t.branding.productName ?? '', primaryColor: t.branding.primaryColor ?? '#6d1a73', logoUrl: t.branding.logoUrl ?? '',
    requireMfa: !!t.settings.requireMfa, sessionHours: t.settings.sessionHours ?? 12,
  });
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  async function save(e: React.FormEvent) {
    e.preventDefault(); setMsg(undefined);
    try {
      await api('/admin/tenant', { method: 'PATCH', body: { name: f.name, branding: { productName: f.productName || undefined, primaryColor: f.primaryColor, logoUrl: f.logoUrl }, settings: { requireMfa: f.requireMfa, sessionHours: Number(f.sessionHours) } } });
      await refresh();
      setMsg({ kind: 'success', text: 'Workspace settings saved.' });
    } catch (err: any) { setMsg({ kind: 'error', text: err.message }); }
  }
  return (
    <div className="page narrow-page">
      <header className="page-head"><div><h1>Workspace</h1><p className="muted">Workspace ID <strong className="mono">{t.slug}</strong> — staff enter this when signing in.</p></div></header>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <form onSubmit={save} className="stack">
        <section className="card pad section-card">
          <h3>Company & branding</h3>
          <p className="muted small">Shown to your staff and to suppliers in the vendor portal and emails.</p>
          <div className="field-grid">
            <div className="field"><label htmlFor="w-name">Company name</label><input id="w-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></div>
            <div className="field"><label htmlFor="w-prod">Portal name</label><input id="w-prod" value={f.productName} placeholder="VendorGate" onChange={(e) => setF({ ...f, productName: e.target.value })} /></div>
            <div className="field"><label htmlFor="w-color">Brand colour</label>
              <div className="control-row"><input type="color" value={f.primaryColor} onChange={(e) => { setF({ ...f, primaryColor: e.target.value }); applyBranding({ primaryColor: e.target.value, productName: f.productName }); }} className="color-input" aria-label="Pick colour" /><input id="w-color" value={f.primaryColor} onChange={(e) => setF({ ...f, primaryColor: e.target.value })} /></div></div>
            <div className="field"><label htmlFor="w-logo">Logo URL</label><input id="w-logo" value={f.logoUrl} placeholder="https://…/logo.png" onChange={(e) => setF({ ...f, logoUrl: e.target.value })} /></div>
          </div>
        </section>
        <section className="card pad section-card">
          <h3>Security</h3>
          <label className="check-item"><input type="checkbox" checked={f.requireMfa} onChange={(e) => setF({ ...f, requireMfa: e.target.checked })} /><span><strong>Require two-factor authentication for all staff</strong><span className="muted small block">Users without 2FA will be asked to set it up before they can do anything else.</span></span></label>
          <div className="field" style={{ maxWidth: 260, marginTop: 12 }}><label htmlFor="w-hours">Sign-in session length (hours)</label><input id="w-hours" type="number" min={1} max={72} value={f.sessionHours} onChange={(e) => setF({ ...f, sessionHours: Number(e.target.value) })} /></div>
        </section>
        <div><button className="btn btn-primary">Save settings</button></div>
      </form>
    </div>
  );
}
