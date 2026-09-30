export type VendorStatus = 'INVITED' | 'IN_PROGRESS' | 'UNDER_REVIEW' | 'SENT_BACK' | 'APPROVED' | 'REJECTED';
export type StepStatus = 'WAITING' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'SENT_BACK' | 'CANCELLED';
export type Profile = Record<string, Record<string, unknown>>;

export interface Condition { field: string; equals?: string; notEquals?: string; in?: string[] }
export interface FieldDef {
  key: string; label: string;
  type: 'text' | 'textarea' | 'select' | 'radio' | 'number' | 'email' | 'tel' | 'date' | 'url';
  required?: boolean | Condition; showIf?: Condition; options?: string[]; validator?: string; placeholder?: string; help?: string;
}
export interface GroupDef { key: string; label: string; fields: FieldDef[] }
export interface SectionDef { key: string; label: string; groups: GroupDef[] }
export interface DocRequirement { type: string; label: string; help?: string; isRequired?: boolean }

export interface Meta {
  formSchema: SectionDef[];
  documentRequirements: DocRequirement[];
  vendorTypes: { value: string; label: string }[];
  onboardingGuide: { title: string; body: string }[];
  workflowLevels: { label: string }[];
}

export type Permission = 'vendors.view' | 'vendors.create' | 'vendors.export' | 'users.manage' | 'tenant.settings' | 'config.manage' | 'reports.view' | 'audit.view';
export interface Branding { productName?: string; primaryColor?: string; logoUrl?: string }
export interface Me {
  user: { id: string; name: string; email: string; mfaEnabled: boolean };
  tenant: { id: string; slug: string; name: string; branding: Branding; settings: { requireMfa?: boolean; sessionHours?: number } };
  roles: { id: string; key: string; name: string }[];
  permissions: Permission[];
  mfaSetupRequired: boolean;
  devMailbox: boolean;
}

export interface ChecklistItem { id: string; section: string; label: string; ok: boolean; message?: string; severity: 'error' | 'warning' }
export interface DocumentRow { id: string; docType: string; fileName: string; mimeType: string; size: number; uploadedAt: string }
export interface Step {
  id: string; cycle: number; level: number; roleId: string; roleName?: string; label: string; status: StepStatus;
  remarks?: string | null; actedAt?: string | null; actedBy?: { name: string } | null;
}
export interface AuditRow { id: string; actor: string; action: string; detail: Record<string, unknown> | null; createdAt: string }

export interface VendorSummary {
  id: string; code: string; name: string; vendorType: string; contactFirstName: string; contactLastName: string;
  contactEmail: string; contactMobile: string; status: VendorStatus; reviewCycle: number;
  createdAt: string; updatedAt: string; submittedAt?: string | null; decidedAt?: string | null;
  pendingStep?: { label: string; mine: boolean } | null; createdBy?: { name: string };
}
export interface VendorFull extends VendorSummary {
  profile: Profile; documents: DocumentRow[]; steps: Step[]; audit?: AuditRow[]; inviteLink?: string;
}
