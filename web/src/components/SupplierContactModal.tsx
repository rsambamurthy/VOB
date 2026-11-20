import { useState } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { VENDOR_TYPES } from '../lib/format';
import { Alert, Modal } from './ui';

/**
 * A supplier's company and contact (name, vendor type, contact, mobile, language) — one form for a new vendor
 * (Vendors → + New vendor) and an outside bidder on a sourcing event. `notify` shows the "email the invite now" choice.
 */
export function SupplierContactModal({ endpoint, onClose, onCreated, title = 'Vendor registration details', submitLabel, notify = true, intro }: {
  endpoint: string; onClose: () => void; onCreated: (r: any) => void; title?: string; submitLabel?: string; notify?: boolean; intro?: string;
}) {
  const { me } = useSession();
  const arabic = !!me?.tenant.supplierLanguages?.includes('ar');
  const [f, setF] = useState({ name: '', vendorType: 'DOMESTIC', contactFirstName: '', contactLastName: '', contactEmail: '', contactMobile: '', notify, language: me?.tenant.settings.supplierLanguage ?? 'en' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(undefined);
    try {
      const { language, ...rest } = f;
      const { notify: n, ...base } = rest;
      const r = await api(endpoint, { body: { ...base, ...(notify ? { notify: n } : {}), ...(arabic ? { language } : {}) } });
      onCreated(r);
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }
  return (
    <Modal title={title} onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="create-vendor" disabled={busy}>{busy ? 'Saving…' : submitLabel ?? (f.notify ? 'Create & notify contact' : 'Create vendor')}</button></>}>
      <form id="create-vendor" onSubmit={submit} className="field-grid">
        {intro && <p className="muted small field-wide">{intro}</p>}
        {error && <div className="field-wide"><Alert kind="error">{error}</Alert></div>}
        <div className="field"><label htmlFor="cv-name">Vendor name<span className="req"> *</span></label><input id="cv-name" required value={f.name} onChange={set('name')} autoFocus /></div>
        <div className="field"><label htmlFor="cv-type">Vendor type<span className="req"> *</span></label>
          <select id="cv-type" value={f.vendorType} onChange={set('vendorType')}>{VENDOR_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
        <div className="field"><label htmlFor="cv-fn">Contact first name<span className="req"> *</span></label><input id="cv-fn" required value={f.contactFirstName} onChange={set('contactFirstName')} /></div>
        <div className="field"><label htmlFor="cv-ln">Contact last name<span className="req"> *</span></label><input id="cv-ln" required value={f.contactLastName} onChange={set('contactLastName')} /></div>
        <div className="field"><label htmlFor="cv-em">Contact email<span className="req"> *</span></label><input id="cv-em" type="email" required value={f.contactEmail} onChange={set('contactEmail')} /></div>
        <div className="field"><label htmlFor="cv-mo">Mobile number<span className="req"> *</span></label><input id="cv-mo" type="tel" required value={f.contactMobile} onChange={set('contactMobile')} placeholder={f.vendorType === 'IMPORT' ? '+44 7700 900123' : me?.tenant.mobileExample} /><div className="field-help">{f.vendorType === 'IMPORT' ? 'Include the country code, e.g. +44 or +91.' : `A ${me?.tenant.countryName ?? 'local'} number, or include the country code.`}</div></div>
        {arabic && <div className="field"><label htmlFor="cv-lang">Supplier’s language</label><select id="cv-lang" value={f.language} onChange={set('language')}><option value="en">English</option><option value="ar">Arabic (العربية)</option></select><div className="field-help">For the invitation and the portal. The supplier can switch at any time.</div></div>}
        {notify && <label className="checkbox field-wide"><input type="checkbox" checked={f.notify} onChange={set('notify')} /> Email the invite link to the contact now</label>}
      </form>
    </Modal>
  );
}
