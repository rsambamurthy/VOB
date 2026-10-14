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
  'approvals.manage': 'Reassign approval steps and see every queue',
  'reports.view': 'View dashboards and reports',
  'audit.view': 'View the audit log',
  'orders.view': 'View purchase orders and supplier acknowledgements',
  'orders.manage': 'Pull and import purchase orders, set up buying groups, manage supplier portal access',
  'invoices.manage': 'Approve or reject supplier invoices and see supplier payments',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** Roles created for every new tenant. Keys are referenced by the default workflow. */
export const DEFAULT_ROLES: { key: string; name: string; description: string; permissions: Permission[] }[] = [
  { key: 'ADMIN', name: 'Administrator', description: 'Full access to the workspace', permissions: ALL_PERMISSIONS },
  { key: 'VENDOR_ADMIN', name: 'Vendor Admin', description: 'Creates and invites vendors', permissions: ['vendors.view', 'vendors.create', 'reports.view'] },
  { key: 'TAX_MANAGER', name: 'Tax Accounts Manager', description: 'Tax review level', permissions: ['vendors.view'] },
  { key: 'FINANCE_MANAGER', name: 'Finance Manager', description: 'Finance & risk review level', permissions: ['vendors.view', 'reports.view', 'orders.view', 'invoices.manage'] },
  { key: 'MDM_MANAGER', name: 'Master Data Manager', description: 'Final approval and ERP export', permissions: ['vendors.view', 'vendors.export', 'vendors.block', 'vendors.edit', 'reports.view'] },
  { key: 'BUYER', name: 'Buyer', description: 'Purchase orders and supplier collaboration', permissions: ['vendors.view', 'orders.view', 'orders.manage', 'reports.view'] },
  { key: 'VIEWER', name: 'Viewer', description: 'Read-only access', permissions: ['vendors.view', 'reports.view'] },
];
