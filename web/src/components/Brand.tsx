/**
 * VendorGate brand pieces, matching the Integrata identity: the "VendorGate" wordmark (Philosopher Bold,
 * Integrata navy with the red dot from the Integrata "i") and the "Powered by Integratatech.ai Pvt Ltd" line.
 */
import { t } from '../i18n';

export const PRODUCT = 'VendorGate';
export const COMPANY = 'Integratatech.ai Pvt Ltd';
export const COMPANY_URL = 'https://integratatech.ai';

/** The VendorGate wordmark. `light` = for dark backgrounds (sidebar, sign-in side panel). */
export function Wordmark({ light, size }: { light?: boolean; size?: number }) {
  return <span className={`vg-wordmark${light ? ' light' : ''}`} style={size ? { fontSize: size } : undefined}>{PRODUCT}</span>;
}

/** A workspace's product name: the styled wordmark when it is VendorGate itself, plain text when white-labelled. */
export function ProductName({ name, light }: { name?: string | null; light?: boolean }) {
  return !name || name === PRODUCT ? <Wordmark light={light} /> : <span>{name}</span>;
}

/** "Powered by VendorGate · Integratatech.ai Pvt Ltd" with the Integrata mark. */
export function PoweredBy({ light, compact, className = '' }: { light?: boolean; compact?: boolean; className?: string }) {
  return (
    <a className={`powered-by${light ? ' light' : ''}${compact ? ' compact' : ''} ${className}`} href={COMPANY_URL} target="_blank" rel="noopener noreferrer"
      title={t('brand.productOf', { product: PRODUCT, company: COMPANY })}>
      <img src="/brand/integrata-mark.png" alt="" className="pb-mark" />
      {!compact && <span>{t('brand.poweredBy')} <Wordmark light={light} /> · <span className="ltr">{COMPANY}</span></span>}
    </a>
  );
}
