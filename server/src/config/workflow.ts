/**
 * Approval workflow: levels run in order. Change this array to add/remove levels
 * or re-order them. `appliesTo` optionally restricts a level to certain vendor types
 * (e.g. an extra compliance level only for IMPORT vendors).
 */
import type { Role, VendorType } from '../db/schema.js';

export interface WorkflowLevel {
  role: Role;
  label: string;
  appliesTo?: VendorType[];
}

export const workflowLevels: WorkflowLevel[] = [
  { role: 'TAX_MANAGER', label: 'Tax Review' },
  { role: 'FINANCE_MANAGER', label: 'Finance & Risk Review' },
  { role: 'MDM_MANAGER', label: 'Master Data Approval' },
];

export function levelsFor(vendorType: VendorType): WorkflowLevel[] {
  return workflowLevels.filter((l) => !l.appliesTo || l.appliesTo.includes(vendorType));
}

export const roleLabels: Record<Role, string> = {
  ADMIN: 'Vendor Admin (Buyer)',
  TAX_MANAGER: 'Tax Accounts Manager',
  FINANCE_MANAGER: 'Finance Manager',
  MDM_MANAGER: 'Master Data Manager',
};
