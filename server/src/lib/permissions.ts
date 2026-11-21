/**
 * Fixed list of permissions. Tenants combine these into their own roles.
 * Approval authority is NOT a permission: a user can act on an approval step when they
 * hold the role that the workflow level is assigned to.
 */
export const PERMISSIONS = {
  'vendors.view': 'View vendors and their profiles',
  'vendors.create': 'Create and invite vendors',
  'vendors.export': 'Export vendors to ERP',
  'vendors.block': 'Block / unblock approved vendors',
  'vendors.edit': 'Propose changes to an approved vendor’s details (sent for approval)',
  'users.manage': 'Invite users, assign roles, disable accounts',
  'tenant.settings': 'Edit workspace name, branding and security settings',
  'config.manage': 'Edit onboarding fields, documents and approval flow',
  'approvals.manage': 'Reassign approval steps, see every queue and get overdue approvals (suppliers and contracts)',
  'reports.view': 'View dashboards and reports',
  'audit.view': 'View the audit log',
  'orders.view': 'View purchase orders and supplier acknowledgements',
  'orders.manage': 'Pull and import purchase orders, set up buying groups, manage supplier portal access',
  'invoices.view': 'View supplier invoices, credit and debit notes, payments and invoice reports',
  'invoices.capture': 'Enter supplier invoices (upload, bulk upload, Excel), code them and submit them',
  'invoices.manage': 'Approve or reject supplier invoices, send them to the ERP, raise debit notes and see supplier payments',
  'actions.manage': 'Raise corrective actions on suppliers and review their evidence (approvers can also raise them on suppliers they are reviewing)',
  'sourcing.view': 'View sourcing events (RFQs and auctions) and their results',
  'sourcing.events': 'Create sourcing events, invite bidders and answer their questions',
  'sourcing.open': 'Be on the opening committee for sealed bids',
  'sourcing.evaluate': 'Score technical offers and evaluate bids',
  'sourcing.live': 'Control live auctions (pause, extend, message bidders)',
  'contracts.view': 'View contracts and contract parties',
  'contracts.manage': 'Create and edit contracts and parties, upload and import them',
  'contracts.templates': 'Manage contract templates and the clause library',
} as const;

export type Permission = keyof typeof PERMISSIONS;

type Feature = import('./features.js').Feature;
/**
 * The product each permission belongs to. Without that product in the plan, the permission is hidden on the Roles screen and
 * grants nothing (`effectivePermissions`). A list = any of those products (invoices.manage serves portal invoices on purchase
 * orders and the Invoices add-on).
 */
export const PERMISSION_FEATURE: Partial<Record<Permission, Feature | readonly Feature[]>> = {
  'vendors.view': 'onboarding', 'vendors.create': 'onboarding', 'vendors.export': 'onboarding', 'vendors.block': 'onboarding', 'vendors.edit': 'onboarding',
  'config.manage': 'onboarding', 'actions.manage': 'onboarding', 'reports.view': 'onboarding',
  'orders.view': 'collab', 'orders.manage': 'collab', 'invoices.manage': ['collab', 'invoices'],
  'invoices.view': 'invoices', 'invoices.capture': 'invoices',
  'sourcing.view': 'sourcing', 'sourcing.events': 'sourcing', 'sourcing.open': 'sourcing', 'sourcing.evaluate': 'sourcing', 'sourcing.live': 'sourcing',
  'contracts.view': 'contracts', 'contracts.manage': 'contracts', 'contracts.templates': 'contracts',
};
/** The permission list to show for a workspace, given its plan features. */
/** Whether the plan has the product a permission belongs to. */
export function permissionInPlan(p: string, features: Record<string, boolean>) {
  const f = PERMISSION_FEATURE[p as Permission];
  return !f || (typeof f === 'string' ? !!features[f] : f.some((x) => features[x]));
}
export function visiblePermissions(features: Record<string, boolean>) {
  return Object.fromEntries(Object.entries(PERMISSIONS).filter(([k]) => permissionInPlan(k, features)));
}
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];
/** What a set of role permissions actually allows in a workspace with these plan features. */
export function effectivePermissions(perms: Iterable<string>, features: Record<string, boolean>) {
  return new Set([...perms].filter((p) => permissionInPlan(p, features)) as Permission[]);
}

/** Roles created for every new tenant. Keys are referenced by the default workflow. */
export const DEFAULT_ROLES: { key: string; name: string; description: string; permissions: Permission[]; /** The product the role is for; created only when the plan has it. */ feature?: import('./features.js').Feature }[] = [
  { key: 'ADMIN', name: 'Administrator', description: 'Full access to the workspace', permissions: ALL_PERMISSIONS },
  { key: 'VENDOR_ADMIN', name: 'Vendor Admin', description: 'Creates and invites vendors', permissions: ['vendors.view', 'vendors.create', 'reports.view'], feature: 'onboarding' },
  { key: 'TAX_MANAGER', name: 'Tax Accounts Manager', description: 'Tax review level', permissions: ['vendors.view'], feature: 'onboarding' },
  { key: 'FINANCE_MANAGER', name: 'Finance Manager', description: 'Finance & risk review level', permissions: ['vendors.view', 'reports.view', 'orders.view', 'invoices.manage', 'actions.manage', 'sourcing.view', 'sourcing.open', 'contracts.view'], feature: 'onboarding' },
  { key: 'MDM_MANAGER', name: 'Master Data Manager', description: 'Final approval and ERP export', permissions: ['vendors.view', 'vendors.export', 'vendors.block', 'vendors.edit', 'reports.view', 'actions.manage'], feature: 'onboarding' },
  { key: 'BUYER', name: 'Buyer', description: 'Purchase orders and supplier collaboration', permissions: ['vendors.view', 'orders.view', 'orders.manage', 'reports.view', 'sourcing.view', 'sourcing.events', 'sourcing.evaluate', 'sourcing.live'], feature: 'onboarding' },
  { key: 'VIEWER', name: 'Viewer', description: 'Read-only access', permissions: ['vendors.view', 'reports.view'], feature: 'onboarding' },
  { key: 'CONTRACT_MANAGER', name: 'Contract Manager', description: 'Supplier and customer contracts', permissions: ['contracts.view', 'contracts.manage', 'contracts.templates', 'reports.view'], feature: 'contracts' },
  { key: 'LEGAL', name: 'Legal Counsel', description: 'Contract templates, clause library and legal review', permissions: ['contracts.view', 'contracts.templates'], feature: 'contracts' },
  { key: 'CONTRACT_VIEWER', name: 'Contract Viewer', description: 'Read-only access to contracts, parties and contract reports', permissions: ['contracts.view'], feature: 'contracts' },
  { key: 'AP_CLERK', name: 'AP Clerk', description: 'Enters, codes and submits supplier invoices; sends approved ones to the ERP when pushing is manual', permissions: ['invoices.view', 'invoices.capture'], feature: 'invoices' },
  { key: 'INVOICE_APPROVER', name: 'Invoice Approver', description: 'Approves supplier invoices at a level of the approval matrix, raises debit notes', permissions: ['invoices.view', 'invoices.manage'], feature: 'invoices' },
  { key: 'INVOICE_VIEWER', name: 'Invoice Viewer', description: 'Read-only access to invoices, payments and invoice reports', permissions: ['invoices.view'], feature: 'invoices' },
  { key: 'CONTRACT_APPROVER', name: 'Contract Approver', description: 'Approves contracts at an approval level (choose this role in the contract approval levels)', permissions: ['contracts.view'], feature: 'contracts' },
];

/** The default roles a workspace with these plan features gets (others stay hidden until the product is added). */
export const rolesFor = (features: Record<string, boolean>) => DEFAULT_ROLES.filter((r) => !r.feature || features[r.feature]);
/** A role the workspace's plan doesn't use (a default role for a product it doesn't have) — hidden on Roles and Users. */
export const roleHidden = (key: string, features: Record<string, boolean>) => { const d = DEFAULT_ROLES.find((r) => r.key === key); return !!d?.feature && !features[d.feature]; };
