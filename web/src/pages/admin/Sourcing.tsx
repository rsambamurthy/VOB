/** Administration → Sourcing: switch the module on, choose formats and sub-features, set rule defaults and lock them. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import { useSession } from '../../lib/session';
import { Alert } from '../../components/ui';
import { useHelpContext } from '../../help/HelpPanel';

interface FormatRow { key: string; label: string; help: string; on: boolean; licensed: boolean; available: boolean; chosen: boolean }
interface FeatureRow { key: string; area: string; label: string; help: string; default: boolean; on: boolean; available: boolean; chosen: boolean; needs?: string }
interface RuleRow { key: string; kind: 'choice' | 'number'; label: string; help: string; options?: Record<string, string>; min?: number; max?: number; step?: number; unit?: string; nullable?: boolean; requires?: string; value: string | number | null; locked: boolean }
export interface SourcingConfig { licensed: boolean; enabled: boolean; on: boolean; formats: FormatRow[]; features: FeatureRow[]; areas: Record<string, string>; rules: RuleRow[]; plan?: string; changes?: string[] }

const NEEDS: Record<string, string> = { erp: 'ERP integration', ai: 'AI features' };

export function SourcingSettings() {
  useHelpContext('sourcing-settings');
  const { me, refresh } = useSession();
  const [cfg, setCfg] = useState<SourcingConfig>();
  const [enabled, setEnabled] = useState(false);
  const [formats, setFormats] = useState<Record<string, boolean>>({});
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [rules, setRules] = useState<Record<string, string>>({});
  const [locked, setLocked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const [busy, setBusy] = useState(false);

  const take = useCallback((c: SourcingConfig) => {
    setCfg(c); setEnabled(c.enabled);
    setFormats(Object.fromEntries(c.formats.map((f) => [f.key, f.chosen])));
    setFeatures(Object.fromEntries(c.features.map((f) => [f.key, f.chosen])));
    setRules(Object.fromEntries(c.rules.map((r) => [r.key, r.value === null ? '' : String(r.value)])));
    setLocked(new Set(c.rules.filter((r) => r.locked).map((r) => r.key)));
  }, []);
  useEffect(() => { api<SourcingConfig>('/admin/sourcing').then(take).catch((e) => setMsg({ kind: 'error', text: e.message })); }, [take]);
  const areas = useMemo(() => cfg ? Object.entries(cfg.areas).map(([k, label]) => ({ key: k, label, items: cfg.features.filter((f) => f.area === k) })).filter((a) => a.items.length) : [], [cfg]);

  async function save() {
    if (!cfg) return;
    setBusy(true); setMsg(undefined);
    const ruleValues = Object.fromEntries(cfg.rules.map((r) => [r.key, r.kind === 'choice' ? rules[r.key] : rules[r.key] === '' ? (r.nullable ? null : undefined) : Number(rules[r.key])]).filter(([, v]) => v !== undefined));
    try {
      const c = await api<SourcingConfig>('/admin/sourcing', { method: 'PUT', body: { enabled, formats: onlyTrue(formats, cfg.formats.filter((f) => f.available && f.licensed).map((f) => f.key)), features: pick(features, cfg.features.filter((f) => f.available).map((f) => f.key)), rules: ruleValues, locked: [...locked] } });
      take(c); refresh();
      setMsg({ kind: 'success', text: c.changes?.length ? `Saved: ${c.changes.join('; ')}.` : 'Saved — nothing changed.' });
    } catch (e: any) { setMsg({ kind: 'error', text: e.message }); } finally { setBusy(false); }
  }

  if (!cfg) return <div className="page"><h1>Sourcing</h1>{msg ? <Alert kind="error">{msg.text}</Alert> : <div className="spinner" />}</div>;
  const ruleOff = (r: RuleRow) => !!r.requires && !features[r.requires];
  const currency = me?.tenant.currency ?? '';
  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Sourcing</h1><p className="muted">RFQs and e-auctions: what is switched on for your buyers, and the rules every new event starts with.</p></div>
      </header>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {!cfg.licensed && <Alert kind="warning">Sourcing isn’t included in your {me?.deployment === 'onprem' ? 'licence' : `plan (${cfg.plan})`}. Contact Integratatech to add it.</Alert>}

      <section className="card pad section-card">
        <h3>Sourcing for this workspace</h3>
        <label className="check-item"><input type="checkbox" checked={enabled} disabled={!cfg.licensed} onChange={(e) => setEnabled(e.target.checked)} />
          <span><strong>Switch Sourcing on</strong><span className="muted small block">When off, there are no Sourcing menus, screens or emails for staff or suppliers. Your choices below are kept.</span></span></label>
        <p className="small" style={{ marginTop: 8 }}>Status: {cfg.on ? <span className="badge badge-approved sm">On</span> : <span className="badge sm">Off</span>}</p>
      </section>

      <section className="card pad section-card">
        <h3>Formats</h3>
        <p className="muted small">Choose which kinds of event buyers can create.</p>
        {cfg.formats.map((f) => (
          <label key={f.key} className="check-item">
            <input type="checkbox" checked={!!formats[f.key]} disabled={!f.available || !f.licensed} onChange={(e) => setFormats({ ...formats, [f.key]: e.target.checked })} />
            <span><strong>{f.label}</strong>{!f.available ? <span className="badge sm" style={{ marginInlineStart: 6 }}>Coming later</span> : !f.licensed ? <span className="badge sm" style={{ marginInlineStart: 6 }}>Not in your plan</span> : null}
              <span className="muted small block">{f.help}</span></span>
          </label>
        ))}
      </section>

      <section className="card pad section-card">
        <h3>Options</h3>
        <p className="muted small">Switch each capability on or off for every event.</p>
        {areas.map((a) => (
          <div key={a.key} style={{ marginBottom: 12 }}>
            <h4 style={{ margin: '12px 0 4px' }}>{a.label}</h4>
            {a.items.map((f) => (
              <label key={f.key} className="check-item">
                <input type="checkbox" checked={!!features[f.key]} disabled={!f.available} onChange={(e) => setFeatures({ ...features, [f.key]: e.target.checked })} />
                <span><strong>{f.label}</strong>{!f.available && <span className="badge sm" style={{ marginInlineStart: 6 }}>Coming later</span>}
                  {f.available && f.needs && <span className="badge sm" style={{ marginInlineStart: 6 }}>Needs {NEEDS[f.needs] ?? f.needs}</span>}
                  <span className="muted small block">{f.help}</span></span>
              </label>
            ))}
          </div>
        ))}
      </section>

      <section className="card pad section-card">
        <h3>Rule defaults</h3>
        <p className="muted small">Every new event starts with these. <strong>Lock</strong> a rule so buyers can’t change it for an event. Changes apply to new events only — a published event keeps the rules it was published with.</p>
        <table className="table static">
          <thead><tr><th>Rule</th><th style={{ width: 260 }}>Default</th><th style={{ width: 80 }}>Lock</th></tr></thead>
          <tbody>{cfg.rules.map((r) => (
            <tr key={r.key} className={ruleOff(r) ? 'muted' : ''}>
              <td><label htmlFor={`rule-${r.key}`}><strong>{r.label}</strong></label><div className="muted small">{r.help}{ruleOff(r) && ' (the option it belongs to is off)'}</div></td>
              <td>{r.kind === 'choice'
                ? <select id={`rule-${r.key}`} value={rules[r.key]} disabled={ruleOff(r)} onChange={(e) => setRules({ ...rules, [r.key]: e.target.value })}>{Object.entries(r.options ?? {}).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                : <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><input id={`rule-${r.key}`} type="number" style={{ width: 130 }} min={r.min} max={r.max} step={r.step} value={rules[r.key]} disabled={ruleOff(r)} placeholder={r.nullable ? 'Not required' : undefined} onChange={(e) => setRules({ ...rules, [r.key]: e.target.value })} />
                  <span className="muted small">{r.unit === 'currency' ? currency : r.unit}</span></span>}</td>
              <td><input type="checkbox" aria-label={`Lock ${r.label}`} checked={locked.has(r.key)} disabled={ruleOff(r)} onChange={(e) => { const n = new Set(locked); if (e.target.checked) n.add(r.key); else n.delete(r.key); setLocked(n); }} /></td>
            </tr>
          ))}</tbody>
        </table>
      </section>
      <div className="btn-row"><button className="btn btn-primary" disabled={busy} onClick={save}>Save</button></div>
    </div>
  );
}
const pick = (o: Record<string, boolean>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, !!o[k]]));
const onlyTrue = (o: Record<string, boolean>, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k]).map((k) => [k, true]));
