/** The contract form — one form for a new contract and for editing one (only some fields once it is active). */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { money } from '../../lib/format';
import { DIRECTION_LABEL, KIND_FOR, KIND_LABEL, NewPartyModal, optionOn, type Direction, type Setup } from '../../components/Contracts';

export interface ContractData {
  title: string; direction: Direction; type: string; partyId: string; reference: string; value: string; currency: string;
  startDate: string; endDate: string; signedDate: string; autoRenew: boolean; renewalTermMonths: string; noticeDays: string;
  ownerId: string; parentId: string; description: string; category: string;
}
export const blankContract = (setup: Setup, direction: Direction, ownerId: string, partyId = ''): ContractData => {
  const rule = (k: string) => setup.config.rules.find((r) => r.key === k)?.value;
  return { title: '', direction, type: setup.config.types.find((k) => k.on && k.directions.includes(direction))?.key ?? '', partyId, reference: '', value: '', currency: setup.currency,
    startDate: '', endDate: '', signedDate: '', autoRenew: false, renewalTermMonths: String(rule('renewalTermMonths') ?? 12), noticeDays: String(rule('noticeDays') ?? ''), ownerId, parentId: '', description: '', category: '' };
};
const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(/,/g, '')));
/** Body for the server; `only` limits it to the fields that may change. */
export function contractBody(c: ContractData, only?: readonly string[]) {
  const all: Record<string, unknown> = {
    title: c.title, direction: c.direction, type: c.type, partyId: c.partyId, reference: c.reference || null, value: num(c.value), currency: c.currency,
    startDate: c.startDate || null, endDate: c.endDate || null, signedDate: c.signedDate || null, autoRenew: c.autoRenew,
    renewalTermMonths: c.autoRenew ? num(c.renewalTermMonths) : null, noticeDays: num(c.noticeDays), ownerId: c.ownerId || null, parentId: c.parentId || null,
    description: c.description || null, category: c.category || null,
  };
  return only ? Object.fromEntries(Object.entries(all).filter(([k]) => only.includes(k))) : all;
}

export function ContractForm({ value, onChange, setup, editable = 'all', askSigned, signed, onSigned }: {
  value: ContractData; onChange: (c: ContractData) => void; setup: Setup;
  /** 'all', or the fields that may still change (an active contract). */
  editable?: 'all' | readonly string[];
  /** New contract: offer "already signed" (recording an existing contract). */
  askSigned?: boolean; signed?: boolean; onSigned?: (v: boolean) => void;
}) {
  const [parties, setParties] = useState<{ id: string; name: string; code: string }[]>([]);
  const [parents, setParents] = useState<{ id: string; number: string; title: string }[]>([]);
  const [newParty, setNewParty] = useState(false);
  const kind = KIND_FOR[value.direction];
  useEffect(() => { api<{ parties: typeof parties }>(`/staff/parties/options?kind=${kind}`).then((r) => setParties(r.parties)).catch(() => {}); }, [kind]);
  const hierarchy = optionOn(setup, 'contractHierarchy');
  useEffect(() => { if (hierarchy && value.partyId) api<{ contracts: typeof parents }>(`/staff/contracts/parents?partyId=${value.partyId}`).then((r) => setParents(r.contracts)).catch(() => {}); else setParents([]); }, [value.partyId, hierarchy]);
  const can = (k: string) => editable === 'all' || editable.includes(k);
  const set = (k: keyof ContractData) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  const locked = (k: string) => !!setup.config.rules.find((r) => r.key === k)?.locked;
  const directions = (Object.keys(DIRECTION_LABEL) as Direction[]).filter((d) => setup.config.types.some((k) => k.on && k.directions.includes(d)) && (d === 'BUY' || optionOn(setup, 'customerContracts')));
  const types = setup.config.types.filter((k) => k.on && k.directions.includes(value.direction));
  return (
    <>
      {editable === 'all' && directions.length > 1 && (
        <div className="field"><label>Contract with a</label>
          {directions.map((d) => <label key={d} className="radio" style={{ marginInlineEnd: 16 }}><input type="radio" name="cf-direction" checked={value.direction === d} onChange={() => onChange({ ...value, direction: d, partyId: '', parentId: '', type: setup.config.types.find((k) => k.on && k.directions.includes(d))?.key ?? '' })} /> {d === 'BUY' ? 'Supplier' : 'Customer'}</label>)}
        </div>
      )}
      <div className="field-grid">
        <div className="field field-wide"><label htmlFor="cf-title">Title</label><input id="cf-title" disabled={!can('title')} value={value.title} onChange={set('title')} placeholder="e.g. Annual maintenance — HVAC, Pune plant" /></div>
        <div className="field"><label htmlFor="cf-type">Contract type</label>
          <select id="cf-type" disabled={!can('type')} value={value.type} onChange={set('type')}>{types.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</select></div>
        <div className="field"><label htmlFor="cf-party">{KIND_LABEL[kind]}</label>
          <select id="cf-party" disabled={!can('partyId')} value={value.partyId} onChange={(e) => onChange({ ...value, partyId: e.target.value, parentId: '' })}>
            <option value="">Choose…</option>{parties.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.code})</option>)}</select>
          {can('partyId') && <button className="link-btn small" onClick={() => setNewParty(true)}>+ New {KIND_LABEL[kind].toLowerCase()}</button>}</div>
        {hierarchy && value.type !== 'msa' && parents.length > 0 && (
          <div className="field"><label htmlFor="cf-parent">Under master agreement</label>
            <select id="cf-parent" disabled={!can('parentId')} value={value.parentId} onChange={set('parentId')}><option value="">None</option>{parents.map((p) => <option key={p.id} value={p.id}>{p.number} — {p.title}</option>)}</select></div>
        )}
        <div className="field"><label htmlFor="cf-ref">Their reference</label><input id="cf-ref" disabled={!can('reference')} value={value.reference} onChange={set('reference')} /></div>
        <div className="field"><label htmlFor="cf-value">Value</label>
          <span style={{ display: 'flex', gap: 6 }}><input id="cf-value" inputMode="decimal" disabled={!can('value')} value={value.value} onChange={set('value')} style={{ flex: 1 }} />
            <input aria-label="Currency" disabled={!can('currency')} value={value.currency} onChange={(e) => onChange({ ...value, currency: e.target.value.toUpperCase().slice(0, 3) })} style={{ width: 64 }} /></span>
          {value.value && !Number.isNaN(num(value.value)) && <div className="field-help">{money(num(value.value) ?? 0, value.currency)}</div>}</div>
        <div className="field"><label htmlFor="cf-start">Start date</label><input id="cf-start" type="date" disabled={!can('startDate')} value={value.startDate} onChange={set('startDate')} /></div>
        <div className="field"><label htmlFor="cf-end">End date</label><input id="cf-end" type="date" disabled={!can('endDate')} value={value.endDate} onChange={set('endDate')} /><div className="field-help">Empty = no fixed end.</div></div>
        {askSigned && <div className="field"><label className="check-item"><input type="checkbox" checked={!!signed} onChange={(e) => onSigned?.(e.target.checked)} /> <span>Already signed</span></label>
          {signed && <><label htmlFor="cf-signed">Signed on</label><input id="cf-signed" type="date" value={value.signedDate} onChange={set('signedDate')} /></>}</div>}
        <div className="field"><label htmlFor="cf-notice">Notice period (days)</label><input id="cf-notice" inputMode="numeric" disabled={!can('noticeDays') || locked('noticeDays')} value={value.noticeDays} onChange={set('noticeDays')} />
          {locked('noticeDays') && <div className="field-help">Set by your administrator.</div>}</div>
        <div className="field"><label className="check-item"><input type="checkbox" disabled={!can('autoRenew')} checked={value.autoRenew} onChange={(e) => onChange({ ...value, autoRenew: e.target.checked })} /> <span>Renews automatically</span></label>
          {value.autoRenew && <><label htmlFor="cf-renew">for (months)</label><input id="cf-renew" inputMode="numeric" disabled={!can('renewalTermMonths') || locked('renewalTermMonths')} value={value.renewalTermMonths} onChange={set('renewalTermMonths')} /></>}</div>
        <div className="field"><label htmlFor="cf-owner">Owner</label>
          <select id="cf-owner" disabled={!can('ownerId')} value={value.ownerId} onChange={set('ownerId')}><option value="">—</option>{setup.owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
        <div className="field"><label htmlFor="cf-cat">Category</label><input id="cf-cat" disabled={!can('category')} value={value.category} onChange={set('category')} placeholder="e.g. Facilities, IT" /></div>
        <div className="field field-wide"><label htmlFor="cf-desc">Description</label><textarea id="cf-desc" rows={3} disabled={!can('description')} value={value.description} onChange={set('description')} /></div>
      </div>
      {newParty && <NewPartyModal kind={kind} kindFixed countries={setup.countries} country={setup.country} onClose={() => setNewParty(false)}
        onCreated={(p) => { setParties((ps) => [...ps, p].sort((a, b) => a.name.localeCompare(b.name))); onChange({ ...value, partyId: p.id, parentId: '' }); setNewParty(false); }} />}
    </>
  );
}
