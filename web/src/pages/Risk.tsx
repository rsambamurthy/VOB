import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Alert, Empty, Modal } from '../components/ui';
import { TabStrip } from '../components/TabStrip';
import { fmtDate } from '../lib/format';
import { RiskBadge, RiskSignals, type Band, type RiskSignal } from '../components/Risk';

interface Row { id: string; code: string; name: string; status: string; riskScore: number | null; riskBand: Band | null; riskSignals: RiskSignal[] | null; lastMonitoredAt: string | null; blockedAt: string | null; blockSource: string | null }
interface Settings { monitorDays: number; alertEmails: string; autoHold: boolean }
interface Data { rows: Row[]; counts: Record<string, number>; heldByRisk: number; settings: Settings; canChangeSettings: boolean; canCheck: boolean }

/** Vendors → Risk: every supplier's risk score, what drives it, and how monitoring is set up. */
export function Risk() {
  const [band, setBand] = useState<Band | ''>('');
  const [d, setD] = useState<Data>();
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string }>();
  const [settings, setSettings] = useState(false);
  const load = useCallback(() => api<Data>(`/staff/risk${band ? `?band=${band}` : ''}`).then(setD).catch((e) => setMsg({ kind: 'error', text: e.message })), [band]);
  useEffect(() => { load(); }, [load]);
  const tile = (b: Band | '', label: string, n: number, cls: string) => (
    <button type="button" className={`stat ${cls}${band === b ? ' active' : ''}`} onClick={() => setBand(b)}><span className="stat-n">{n}</span><span className="stat-l">{label}</span></button>
  );
  const total = d ? Object.values(d.counts).reduce((a, b) => a + b, 0) : 0;
  return (
    <div className="page">
      <header className="page-head"><div><h1>Risk</h1><p className="muted">Every approved and under-review supplier gets a risk score from what VendorGate knows — verification results, duplicates, bank changes, questionnaire answers, expired documents, performance. Registration status and sanctions are re-checked {d?.settings.monitorDays ? `every ${d.settings.monitorDays} days` : '— monitoring is off'}.</p></div>
        {d?.canChangeSettings && <button className="btn btn-secondary" onClick={() => setSettings(true)}>Monitoring settings</button>}</header>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {d && (
        <div className="stat-row">
          {tile('', 'All suppliers', total, '')}
          {tile('HIGH', 'High risk', d.counts.HIGH ?? 0, 'stat-high')}
          {tile('MEDIUM', 'Medium risk', d.counts.MEDIUM ?? 0, 'stat-medium')}
          {tile('LOW', 'Low risk', d.counts.LOW ?? 0, 'stat-low')}
        </div>
      )}
      {d && d.heldByRisk > 0 && <Alert kind="warning">{d.heldByRisk} supplier{d.heldByRisk === 1 ? ' is' : 's are'} on hold because of risk monitoring. Open them to review and unblock.</Alert>}
      <div className="card">
        <TabStrip>{(['', 'HIGH', 'MEDIUM', 'LOW'] as const).map((b) => <button key={b} role="tab" aria-selected={band === b} className={band === b ? 'active' : ''} onClick={() => setBand(b)}>{b ? `${b[0]}${b.slice(1).toLowerCase()}` : 'All'}</button>)}</TabStrip>
        {!d ? <div className="pad"><div className="spinner" /></div> : !d.rows.length ? <Empty>No suppliers here.</Empty> : (
          <table className="table">
            <thead><tr><th>Supplier</th><th>Risk</th><th>Why</th><th>Re-checked</th></tr></thead>
            <tbody>{d.rows.map((r) => (
              <tr key={r.id}>
                <td><Link to={`/staff/vendors/${r.id}`} className="strong">{r.name}</Link><div className="small muted"><span className="mono">{r.code}</span> · {r.status === 'APPROVED' ? 'Approved' : 'Under review'}{r.blockedAt ? ` · ${r.blockSource === 'RISK' ? 'on hold (risk)' : 'blocked'}` : ''}</div></td>
                <td>{r.riskBand ? <RiskBadge band={r.riskBand} score={r.riskScore} /> : <span className="muted small">Not scored yet</span>}</td>
                <td className="small">{r.riskSignals ? <RiskSignals signals={r.riskSignals} limit={2} /> : '—'}</td>
                <td className="small muted">{r.lastMonitoredAt ? fmtDate(r.lastMonitoredAt) : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <details className="card pad small"><summary><strong>How the score is worked out</strong></summary>
        <p>Points add up to a score out of 100: <strong>Low</strong> below 25, <strong>Medium</strong> 25–49, <strong>High</strong> 50 or more. A serious finding makes a supplier High whatever the score.</p>
        <ul>
          <li><strong>Serious (High straight away):</strong> registration (GSTIN / CR / TRN) cancelled, suspended or not found; a possible sanctions match; an approved supplier sharing a bank account with another supplier.</li>
          <li>Another failed verification +15 · name on record doesn't match +10 · possible duplicate +25.</li>
          <li>Bank details changed in the last 90 days +10, twice or more in a year +15 · contact email changed in the last 30 days +5.</li>
          <li>Questionnaire result High +25, Medium +10 · documents expired +15 (expiring soon +5).</li>
          <li>Scorecard below 70 (last 90 days) +15 · required agreement not accepted +5 · contact email bouncing +5.</li>
        </ul>
        <p>Scores are refreshed every day and whenever someone opens the supplier. Suppliers never see them.</p>
      </details>
      {settings && d && <SettingsModal current={d.settings} onClose={() => setSettings(false)} onSaved={() => { setSettings(false); setMsg({ kind: 'success', text: 'Monitoring settings saved.' }); load(); }} />}
    </div>
  );
}

function SettingsModal({ current, onClose, onSaved }: { current: Settings; onClose: () => void; onSaved: () => void }) {
  const [s, setS] = useState(current);
  const [err, setErr] = useState<string>();
  async function save() { try { await api('/staff/risk/settings', { method: 'PUT', body: s }); onSaved(); } catch (e: any) { setErr(e.message); } }
  return (
    <Modal title="Monitoring settings" onClose={onClose} footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save}>Save</button></>}>
      {err && <Alert kind="error">{err}</Alert>}
      <div className="field"><label htmlFor="rk-days">Re-check registration status and sanctions every</label>
        <select id="rk-days" value={s.monitorDays} onChange={(e) => setS({ ...s, monitorDays: Number(e.target.value) })}>
          {[[7, '7 days'], [14, '14 days'], [30, '30 days'], [60, '60 days'], [90, '90 days'], [0, 'Never (off)']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <div className="field-help">Approved suppliers only. Uses your verification provider; in test mode nothing is charged. The full yearly re-verification (Workspace settings) still runs as well.</div></div>
      <div className="field"><label htmlFor="rk-emails">Alert these people when a supplier turns high risk</label><input id="rk-emails" value={s.alertEmails} maxLength={500} placeholder="risk@company.com, cfo@company.com" onChange={(e) => setS({ ...s, alertEmails: e.target.value })} />
        <div className="field-help">Leave empty to alert everyone who can block vendors.</div></div>
      <label className="check-item"><input type="checkbox" checked={s.autoHold} onChange={(e) => setS({ ...s, autoHold: e.target.checked })} />
        <span><strong>Put the supplier on hold automatically on a serious finding</strong><span className="muted small block">Registration cancelled, a sanctions match, or another supplier's bank account: payment and purchase-order hold in the ERP until someone reviews it and unblocks.</span></span></label>
    </Modal>
  );
}
