/**
 * Default approval workflow (a template). Levels reference ROLE KEYS, which each tenant
 * maps to its own role records. Phase 2 moves this into per-tenant, editable configuration.
 */
import type { VendorType } from '../db/schema.js';

export interface WorkflowLevel {
  roleKey: string;
  label: string;
  appliesTo?: VendorType[];
}

export const workflowLevels: WorkflowLevel[] = [
  { roleKey: 'TAX_MANAGER', label: 'Tax Review' },
  { roleKey: 'FINANCE_MANAGER', label: 'Finance & Risk Review' },
  { roleKey: 'MDM_MANAGER', label: 'Master Data Approval' },
];

export function levelsFor(vendorType: VendorType): WorkflowLevel[] {
  return workflowLevels.filter((l) => !l.appliesTo || l.appliesTo.includes(vendorType));
}
