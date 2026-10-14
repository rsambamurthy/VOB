import { useState } from 'react';
import { Modal } from '../../../components/ui';
import { DynamicSection } from '../../../components/DynamicSection';
import { conditionHolds, isRequired } from '../../../lib/conditions';
import type { OnboardingConfig, Profile } from '../../../lib/types';
import type { EditorMeta } from './shared';
import { TabStrip } from '../../../components/TabStrip';

/** Interactive preview of the vendor form, exactly as the portal renders it. */
export function PreviewModal({ config, meta, title, onClose }: { config: OnboardingConfig; meta: EditorMeta; title: string; onClose: () => void }) {
  const [tab, setTab] = useState(config.sections[0].key);
  const [vendorType, setVendorType] = useState('DOMESTIC');
  const [profile, setProfile] = useState<Profile>({ basic: { supplierCountry: 'India' }, bank: { bankCountry: 'India' } });
  const ctx = { profile, vendor: { vendorType } };
  const docs = config.documents.filter((d) => conditionHolds(d.showIf, ctx));
  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="row-between preview-bar">
        <span className="muted small">Fill in answers to see conditional fields and documents appear.</span>
        <label className="small">Vendor type <select value={vendorType} onChange={(e) => setVendorType(e.target.value)}>{meta.vendorTypes.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></label>
      </div>
      <TabStrip>
        {config.sections.map((s) => <button key={s.key} role="tab" aria-selected={tab === s.key} className={tab === s.key ? 'active' : ''} onClick={() => setTab(s.key)}>{s.label}</button>)}
        <button role="tab" aria-selected={tab === '__docs'} className={tab === '__docs' ? 'active' : ''} onClick={() => setTab('__docs')}>Documents</button>
      </TabStrip>
      <div className="pad-y">
        {config.sections.filter((s) => s.key === tab).map((s) => (
          <DynamicSection key={s.key} section={s} profile={profile} vendorType={vendorType} onChange={(f, v) => setProfile((p) => ({ ...p, [s.key]: { ...(p[s.key] ?? {}), [f]: v } }))} />
        ))}
        {tab === '__docs' && (
          <ul className="plain-list">{docs.map((d) => <li key={d.type}><strong>{d.label}</strong>{isRequired(d.required, ctx) ? <span className="req"> *</span> : <span className="muted small"> (optional)</span>}{d.hasExpiry && <span className="chip">expiry tracked</span>}{d.help && <span className="muted small block">{d.help}</span>}</li>)}</ul>
        )}
      </div>
    </Modal>
  );
}
