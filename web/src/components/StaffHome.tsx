/** /staff — the first screen for the workspace's plan: Vendors, or Contracts (then Invoices) in a workspace without onboarding. */
import { Navigate } from 'react-router-dom';
import { useSession } from '../lib/session';

export function StaffHome() {
  const { me, can } = useSession();
  if (!me) return null;
  const to = me.plan?.features.onboarding !== false ? 'vendors'
    : me.contracts?.on && can('contracts.view') ? 'contracts'
    : me.invoices?.on && (can('invoices.view') || can('invoices.manage')) ? 'ap/invoices' : 'account';
  return <Navigate to={to} replace />;
}
