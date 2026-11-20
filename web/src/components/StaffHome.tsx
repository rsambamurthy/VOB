/** /staff — the first screen for the workspace's plan: Vendors, or Contracts in a Contracts-only workspace. */
import { Navigate } from 'react-router-dom';
import { useSession } from '../lib/session';

export function StaffHome() {
  const { me, can } = useSession();
  if (!me) return null;
  const to = me.plan?.features.onboarding === false ? (me.contracts?.on && can('contracts.view') ? 'contracts' : 'account') : 'vendors';
  return <Navigate to={to} replace />;
}
