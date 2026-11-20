/** Shared contract pieces: labels, status badge, the setup every contract screen needs, and the party and contract forms. */
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Alert, Modal } from './ui';

export type Direction = 'BUY' | 'SELL';
export interface TypeRow { key: string; label: string; prefix: string; directions: Direction[]; on: boolean }
export interface RuleRow { key: string; value: string | number | null; locked: boolean }
export interface Setup {
  config: { types: TypeRow[]; features: { key: string; on: boolean }[]; rules: RuleRow[] };
  owners: { id: string; name: string }[]; statuses: Record<string, string>; directions: Record<Direction, string>; fileKinds: Record<string, string>;
  currency: string; country: string; countries: { code: string; name: string }[]; onboarding: boolean;
}

export const STATUS_CLS: Record<string, string> = { DRAFT: 'badge-invited', IN_APPROVAL: 'flag-medium', APPROVED: 'badge-approved', WITH_PARTY: 'badge-under_review', AGREED: 'badge-approved', SIGNING: 'badge-under_review', ACTIVE: 'badge-approved', EXPIRED: '', TERMINATED: 'badge-rejected' };
export const STATUS_LABEL: Record<string, string> = { DRAFT: 'Draft', IN_APPROVAL: 'In approval', APPROVED: 'Approved', WITH_PARTY: 'With the other party', AGREED: 'Agreed', SIGNING: 'Out for signature', ACTIVE: 'Active', EXPIRED: 'Expired', TERMINATED: 'Terminated' };
export const DIRECTION_LABEL: Record<Direction, string> = { BUY: 'Supplier contract', SELL: 'Customer contract' };
export const KIND_LABEL: Record<string, string> = { SUPPLIER: 'Supplier', CUSTOMER: 'Customer' };
export const KIND_FOR: Record<Direction, 'SUPPLIER' | 'CUSTOMER'> = { BUY: 'SUPPLIER', SELL: 'CUSTOMER' };

export function ContractStatus({ status, expiring }: { status: string; expiring?: boolean }) {
  return <>{<span className={`badge sm ${STATUS_CLS[status] ?? ''}`}>{STATUS_LABEL[status] ?? status}</span>}{expiring && <span className="badge sm flag-medium" style={{ marginInlineStart: 4 }}>Expiring</span>}</>;
}

/** Types, owners, rules… for the contract screens (fetched once per screen). */
export function useContractSetup() {
  const [setup, setSetup] = useState<Setup>();
  useEffect(() => { api<Setup>('/staff/contracts/setup').then(setSetup).catch(() => {}); }, []);
  return setup;
}
export const typeLabel = (setup: Setup | undefined, key: string) => (key === 'amendment' ? 'Amendment' : setup?.config.types.find((k) => k.key === key)?.label ?? key);
export const optionOn = (setup: Setup | undefined, key: string) => !!setup?.config.features.find((f) => f.key === key)?.on;

/* ---------------- party form (new party and editing one) ---------------- */

export interface Contact { name: string; email?: string; phone?: string; role?: string; signatory?: boolean }
export interface PartyData {
  id?: string; kind: 'SUPPLIER' | 'CUSTOMER'; name: string; legalName: string | null; country: string; registrationNo: string | null; taxNo: string | null;
  address: { line1?: string; city?: string; region?: string; postalCode?: string }; email: string | null; phone: string | null; website: string | null; contacts: Contact[]; notes: string | null;
}
export const blankParty = (kind: 'SUPPLIER' | 'CUSTOMER', country: string): PartyData => ({ kind, name: '', legalName: null, country, registrationNo: null, taxNo: null, address: {}, email: null, phone: null, website: null, contacts: [], notes: null });

export function PartyForm({ value, onChange, countries, kindFixed }: { value: PartyData; onChange: (p: PartyData) => void; countries: { code: string; name: string }[]; kindFixed?: boolean }) {
  const { me } = useSession();
  const customers = me?.contracts?.directions.includes('SELL');
  const set = (k: keyof PartyData) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  const addr = (k: keyof PartyData['address']) => (e: { target: { value: string } }) => onChange({ ...value, address: { ...value.address, [k]: e.target.value } });
  const contact = (i: number, patch: Partial<Contact>) => onChange({ ...value, contacts: value.contacts.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <>
      {!kindFixed && customers && <div className="field"><label>This party is a</label>
        {(['SUPPLIER', 'CUSTOMER'] as const).map((k) => <label key={k} className="radio" style={{ marginInlineEnd: 16 }}><input type="radio" name="party-kind" checked={value.kind === k} onChange={() => onChange({ ...value, kind: k })} /> {KIND_LABEL[k]}</label>)}</div>}
      <div className="field-grid">
        <div className="field"><label htmlFor="pf-name">Name</label><input id="pf-name" value={value.name} onChange={set('name')} /></div>
        <div className="field"><label htmlFor="pf-legal">Legal name</label><input id="pf-legal" value={value.legalName ?? ''} onChange={set('legalName')} placeholder="If different" /></div>
        <div className="field"><label htmlFor="pf-country">Country</label>
          <select id="pf-country" value={value.country} onChange={set('country')}>
            {[...countries, ...(countries.some((c) => c.code === value.country) ? [] : [{ code: value.country, name: value.country }])].map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            <option value="US">United States</option><option value="GB">United Kingdom</option><option value="DE">Germany</option><option value="SG">Singapore</option><option value="CN">China</option>
          </select></div>
        <div className="field"><label htmlFor="pf-reg">Registration number</label><input id="pf-reg" value={value.registrationNo ?? ''} onChange={set('registrationNo')} placeholder="e.g. CIN, CR number" /></div>
        <div className="field"><label htmlFor="pf-tax">Tax number</label><input id="pf-tax" value={value.taxNo ?? ''} onChange={set('taxNo')} placeholder="e.g. GSTIN, VAT / TRN" /></div>
        <div className="field"><label htmlFor="pf-email">Email</label><input id="pf-email" type="email" value={value.email ?? ''} onChange={set('email')} /></div>
        <div className="field"><label htmlFor="pf-phone">Phone</label><input id="pf-phone" value={value.phone ?? ''} onChange={set('phone')} /></div>
        <div className="field"><label htmlFor="pf-web">Website</label><input id="pf-web" value={value.website ?? ''} onChange={set('website')} placeholder="https://" /></div>
        <div className="field field-wide"><label htmlFor="pf-addr">Address</label><input id="pf-addr" value={value.address.line1 ?? ''} onChange={addr('line1')} /></div>
        <div className="field"><label htmlFor="pf-city">City</label><input id="pf-city" value={value.address.city ?? ''} onChange={addr('city')} /></div>
        <div className="field"><label htmlFor="pf-region">State / region</label><input id="pf-region" value={value.address.region ?? ''} onChange={addr('region')} /></div>
        <div className="field"><label htmlFor="pf-pin">Postal code</label><input id="pf-pin" value={value.address.postalCode ?? ''} onChange={addr('postalCode')} /></div>
      </div>
      <h4 style={{ margin: '14px 0 6px' }}>Contacts and signatories</h4>
      {value.contacts.map((c, i) => (
        <div key={i} className="field-grid" style={{ gridTemplateColumns: '1.2fr 1.4fr 1fr 1fr auto auto', alignItems: 'end' }}>
          <div className="field"><label htmlFor={`pc-name-${i}`}>Name</label><input id={`pc-name-${i}`} value={c.name} onChange={(e) => contact(i, { name: e.target.value })} /></div>
          <div className="field"><label htmlFor={`pc-email-${i}`}>Email</label><input id={`pc-email-${i}`} value={c.email ?? ''} onChange={(e) => contact(i, { email: e.target.value })} /></div>
          <div className="field"><label htmlFor={`pc-phone-${i}`}>Phone</label><input id={`pc-phone-${i}`} value={c.phone ?? ''} onChange={(e) => contact(i, { phone: e.target.value })} /></div>
          <div className="field"><label htmlFor={`pc-role-${i}`}>Role</label><input id={`pc-role-${i}`} value={c.role ?? ''} onChange={(e) => contact(i, { role: e.target.value })} placeholder="e.g. Director" /></div>
          <label className="check-item" style={{ marginBottom: 10 }}><input type="checkbox" checked={!!c.signatory} onChange={(e) => contact(i, { signatory: e.target.checked })} /> <span>Signs</span></label>
          <button className="icon-btn" aria-label={`Remove contact ${i + 1}`} style={{ marginBottom: 10 }} onClick={() => onChange({ ...value, contacts: value.contacts.filter((_, j) => j !== i) })}>×</button>
        </div>
      ))}
      <button className="link-btn small" onClick={() => onChange({ ...value, contacts: [...value.contacts, { name: '' }] })}>+ Add contact</button>
      <div className="field" style={{ marginTop: 12 }}><label htmlFor="pf-notes">Notes</label><textarea id="pf-notes" rows={2} value={value.notes ?? ''} onChange={set('notes')} /></div>
    </>
  );
}

/** Body for the server: empty strings as nulls. */
export const partyBody = (p: PartyData, confirmDuplicate = false) => ({
  kind: p.kind, name: p.name, legalName: p.legalName || null, country: p.country, registrationNo: p.registrationNo || null, taxNo: p.taxNo || null,
  address: p.address, email: p.email || null, phone: p.phone || null, website: p.website || null, notes: p.notes || null,
  contacts: p.contacts.filter((c) => c.name.trim()).map((c) => ({ ...c, email: c.email || undefined, phone: c.phone || undefined, role: c.role || undefined })),
  ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
});

/** New party in a dialog; answers the created party. Asks again when it looks like an existing one. */
export function NewPartyModal({ kind, kindFixed, countries, country, onClose, onCreated }: { kind: 'SUPPLIER' | 'CUSTOMER'; kindFixed?: boolean; countries: { code: string; name: string }[]; country: string; onClose: () => void; onCreated: (p: { id: string; name: string; code: string; kind: string }) => void }) {
  const [p, setP] = useState<PartyData>(blankParty(kind, country));
  const [error, setError] = useState<string>();
  const [dup, setDup] = useState(false);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setError(undefined);
    try { const r = await api<{ party: { id: string; name: string; code: string; kind: string } }>('/staff/parties', { body: partyBody(p, dup) }); onCreated(r.party); }
    catch (e: any) { setError(e.message); if (/looks like/.test(e.message)) setDup(true); } finally { setBusy(false); }
  }
  return (
    <Modal title={`New ${KIND_LABEL[p.kind].toLowerCase()}`} wide onClose={onClose} footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || p.name.trim().length < 2} onClick={save}>{dup ? 'Create anyway' : 'Create'}</button></>}>
      {error && <Alert kind={dup ? 'warning' : 'error'}>{error}</Alert>}
      <PartyForm value={p} onChange={(v) => { setP(v); setDup(false); }} countries={countries} kindFixed={kindFixed} />
    </Modal>
  );
}
