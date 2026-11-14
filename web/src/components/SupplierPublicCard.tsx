import type { ReactNode } from 'react';
import type { Branding } from '../lib/types';
import { monogram } from '../lib/format';
import { PoweredBy, PRODUCT, ProductName } from './Brand';

/**
 * The buyer-branded two-column card on public supplier pages — signing in from an invitation (VendorLogin)
 * and applying through a "Become a supplier" link (Apply). One layout, so both look the same.
 */
export function SupplierPublicCard({ branding, title, pitch, wide, children }: { branding?: Branding; title: string; pitch: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className="center-page login-bg">
      <div className={`card login-card split${wide ? ' wide' : ''}`}>
        <div className="login-side">
          <div className="brand brand-lg light">
            {branding?.logoUrl ? <img src={branding.logoUrl} alt="" className="brand-logo" /> : (branding?.productName ?? PRODUCT) !== PRODUCT && <span className="brand-mark">{monogram(branding?.productName)}</span>}
            <ProductName name={branding?.productName} light />
          </div>
          <h2>{title}</h2>
          <p>{pitch}</p>
          <PoweredBy light />
        </div>
        <div className="login-main">{children}</div>
      </div>
    </div>
  );
}
