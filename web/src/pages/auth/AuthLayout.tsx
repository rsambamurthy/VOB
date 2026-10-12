import type { ReactNode } from 'react';

export function AuthLayout({ title, children, subtitle }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="center-page login-bg">
      <div className="card login-card narrow">
        <div className="brand brand-lg"><span className="brand-mark">VG</span><span>VendorGate</span></div>
        <h2 className="auth-title">{title}</h2>
        {subtitle && <p className="muted">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}

export function PasswordHint() {
  return <div className="field-help">At least 10 characters, using three of: lowercase, uppercase, numbers, symbols.</div>;
}
