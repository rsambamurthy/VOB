/**
 * Administration page for an add-on module (Sourcing, Contracts): switch it on, choose its kinds (formats, contract
 * types), switch options, set rule defaults and lock them. One page for every module — the server's layered
 * configuration (lib/moduleConfig.ts) sends the same shape for each. Module-specific cards go in `children`.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Alert } from './ui';
import { RuleInput, ruleText, ruleValue, type RuleRow } from './Sourcing';

export interface KindRow { key: string; label: string; help: string; on: boolean; licensed: boolean; available: boolean; chosen: boolean; [extra: string]: unknown }
interface OptionRow { key: string; area: string; label: string; help: string; default: boolean; on: boolean; available: boolean; chosen: boolean; needs?: string }
export interface ModuleConfig { licensed: boolean; enabled: boolean; on: boolean; features: OptionRow[]; areas: Record<string, string>; rules: RuleRow[]; plan?: string; changes?: string[]; [kinds: string]: unknown }

/** Plan features an option may need (labels come from the server's feature list on the platform side). */
const NEEDS: Record<string, string> = { erp: 'ERP integration', ai: 'AI features' };
/** Options that need another product (supplier onboarding, purchase orders) aren't shown without it — the plan doesn't have that product at all. */
const OTHER_PRODUCTS = new Set(['onboarding', 'collab']);

export function ModuleSettings<C extends ModuleConfig>({ name, endpoint, kindsKey, kinds, intro, switchHelp, ruleNoun, kindExtra, children }: {
  name: string; endpoint: string;
  /** Where the kinds are in the config and the body ("formats", "types"). */
  kindsKey: string;
  kinds: { title: string; help: string };
  intro: string; switchHelp: string;
  /** "event", "contract" — in the rules help. */
  ruleNoun: string;
  kindExtra?: (k: KindRow) => ReactNode;
  children?: (cfg: C) => ReactNode;
}) {
  const { me, refresh } = useSession();
  const [cfg, setCfg] = useState<C>();
  const [enabled, setEnabled] = useState(false);
  const [chosenKinds, setKinds] = useState<Record<string, boolean>>({});
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [rules, setRules] = useState<Record<string, string>>({});
  const [locked, setLocked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const [busy, setBusy] = useState(false);
  const kindRows = (c: C) => (c[kindsKey] as KindRow[]) ?? [];

  const take = useCallback((c: C) => {
    setCfg(c); setEnabled(c.enabled);
    setKinds(Object.fromEntries(kindRows(c).map((f) => [f.key, f.chosen])));
    setFeatures(Object.fromEntries(c.features.map((f) => [f.key, f.chosen])));
    setRules(Object.fromEntries(c.rules.map((r) => [r.key, ruleText(r.value)])));
    setLocked(new Set(c.rules.filter((r) => r.locked).map((r) => r.key)));
  }, [kindsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api<C>(endpoint).then(take).catch((e) => setMsg({ kind: 'error', text: e.message })); }, [endpoint, take]);
  const areas = useMemo(() => cfg ? Object.entries(cfg.areas).map(([k, label]) => ({ key: k, label, items: cfg.features.filter((f) => f.area === k && !(f.needs && OTHER_PRODUCTS.has(f.needs))) })).filter((a) => a.items.length) : [], [cfg]);

  async function save() {
    if (!cfg) return;
    setBusy(true); setMsg(undefined);
    const ruleValues = Object.fromEntries(cfg.rules.map((r) => [r.key, ruleValue(r, rules[r.key])]).filter(([, v]) => v !== undefined));
    try {
      const c = await api<C>(endpoint, { method: 'PUT', body: { enabled, [kindsKey]: onlyTrue(chosenKinds, kindRows(cfg).filter((f) => f.available && f.licensed).map((f) => f.key)), features: pick(features, cfg.features.filter((f) => f.available).map((f) => f.key)), rules: ruleValues, locked: [...locked] } });
      take(c); refresh();
      setMsg({ kind: 'success', text: c.changes?.length ? `Saved: ${c.changes.join('; ')}.` : 'Saved — nothing changed.' });
    } catch (e: any) { setMsg({ kind: 'error', text: e.message }); } finally { setBusy(false); }
  }

  if (!cfg) return <div className="page"><h1>{name}</h1>{msg ? <Alert kind="error">{msg.text}</Alert> : <div className="spinner" />}</div>;
  const ruleOff = (r: RuleRow) => !!r.requires && !features[r.requires];
  const currency = me?.tenant.currency ?? '';
  return (
    <div className="page">
      <header className="page-head"><div><h1>{name}</h1><p className="muted">{intro}</p></div></header>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {!cfg.licensed && <Alert kind="warning">{name} isn’t included in your {me?.deployment === 'onprem' ? 'licence' : `plan (${cfg.plan})`}. Contact Integratatech to add it.</Alert>}

      <section className="card pad section-card">
        <h3>{name} for this workspace</h3>
        <label className="check-item"><input type="checkbox" checked={enabled} disabled={!cfg.licensed} onChange={(e) => setEnabled(e.target.checked)} />
          <span><strong>Switch {name} on</strong><span className="muted small block">{switchHelp}</span></span></label>
        <p className="small" style={{ marginTop: 8 }}>Status: {cfg.on ? <span className="badge badge-approved sm">On</span> : <span className="badge sm">Off</span>}</p>
      </section>

      <section className="card pad section-card">
        <h3>{kinds.title}</h3>
        <p className="muted small">{kinds.help}</p>
        {kindRows(cfg).map((f) => (
          <label key={f.key} className="check-item">
            <input type="checkbox" checked={!!chosenKinds[f.key]} disabled={!f.available || !f.licensed} onChange={(e) => setKinds({ ...chosenKinds, [f.key]: e.target.checked })} />
            <span><strong>{f.label}</strong>{!f.available ? <span className="badge sm" style={{ marginInlineStart: 6 }}>Coming later</span> : !f.licensed ? <span className="badge sm" style={{ marginInlineStart: 6 }}>Not in your plan</span> : null}
              {kindExtra?.(f)}
              <span className="muted small block">{f.help}</span></span>
          </label>
        ))}
      </section>

      <section className="card pad section-card">
        <h3>Options</h3>
        <p className="muted small">Switch each capability on or off for the whole workspace.</p>
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
        <p className="muted small">Every new {ruleNoun} starts with these. <strong>Lock</strong> a rule so it can’t be changed for a {ruleNoun}. Changes apply to new {ruleNoun}s only.</p>
        <table className="table static">
          <thead><tr><th>Rule</th><th style={{ width: 260 }}>Default</th><th style={{ width: 80 }}>Lock</th></tr></thead>
          <tbody>{cfg.rules.map((r) => (
            <tr key={r.key} className={ruleOff(r) ? 'muted' : ''}>
              <td><label htmlFor={`rule-${r.key}`}><strong>{r.label}</strong></label><div className="muted small">{r.help}{ruleOff(r) && ' (the option it belongs to is off)'}</div></td>
              <td><RuleInput rule={r} value={rules[r.key]} disabled={ruleOff(r)} currency={currency} onChange={(v) => setRules({ ...rules, [r.key]: v })} /></td>
              <td>{r.workspace ? <span className="muted small" title="A setting for the whole workspace">—</span> : <input type="checkbox" aria-label={`Lock ${r.label}`} checked={locked.has(r.key)} disabled={ruleOff(r)} onChange={(e) => { const n = new Set(locked); if (e.target.checked) n.add(r.key); else n.delete(r.key); setLocked(n); }} />}</td>
            </tr>
          ))}</tbody>
        </table>
      </section>
      <div className="btn-row"><button className="btn btn-primary" disabled={busy} onClick={save}>Save</button></div>
      {children?.(cfg)}
    </div>
  );
}

const pick = (o: Record<string, boolean>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, !!o[k]]));
const onlyTrue = (o: Record<string, boolean>, keys: string[]) => Object.fromEntries(keys.filter((k) => o[k]).map((k) => [k, true]));
