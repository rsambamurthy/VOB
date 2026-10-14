export type VendorStatus = 'INVITED' | 'IN_PROGRESS' | 'UNDER_REVIEW' | 'SENT_BACK' | 'APPROVED' | 'REJECTED';
export type StepStatus = 'WAITING' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'SENT_BACK' | 'CANCELLED';
export type Profile = Record<string, Record<string, unknown>>;

export type Op = 'eq' | 'neq' | 'in' | 'notIn' | 'gt' | 'gte' | 'lt' | 'lte' | 'empty' | 'notEmpty';
export interface Condition { field: string; op: Op; value?: string | number | string[] }
export interface Rule { match: 'all' | 'any'; conditions: Condition[] }
export type FieldType = 'text' | 'textarea' | 'select' | 'radio' | 'number' | 'email' | 'tel' | 'date' | 'url';
/** Arabic wording a workspace gives its own form (shown to suppliers who use the portal in Arabic). */
export interface ArabicText { label?: string; help?: string; placeholder?: string; options?: string[]; title?: string; body?: string }
export interface FieldDef {
  key: string; label: string; type: FieldType;
  required?: boolean | Condition; showIf?: Condition; options?: string[]; validator?: string; placeholder?: string; help?: string; dir?: 'rtl' | 'ltr' | 'auto';
  tr?: { ar?: ArabicText };
  /** Supplier portal only: the text shown for each option (the stored value stays `options[i]`). */
  optionLabels?: string[];
}
export interface GroupDef { key: string; label: string; fields: FieldDef[]; tr?: { ar?: ArabicText } }
export interface SectionDef { key: string; label: string; groups: GroupDef[]; tr?: { ar?: ArabicText } }
export interface DocRequirement { type: string; label: string; help?: string; required?: boolean | Condition; showIf?: Condition; hasExpiry?: boolean; holdOnExpiry?: boolean; isRequired?: boolean; tr?: { ar?: ArabicText } }
export interface WorkflowLevel { id: string; label: string; roleKey: string; rule?: Rule; slaHours?: number }
export interface ChangeRule { match: string[]; levelIds: string[] }
export interface ChangeApproval { rules: ChangeRule[]; defaultLevelIds: string[] }
export interface OnboardingConfig { sections: SectionDef[]; documents: DocRequirement[]; workflow: { levels: WorkflowLevel[]; changes?: ChangeApproval }; guide: { title: string; body: string; tr?: { ar?: ArabicText } }[] }
export interface ConfigIssue { path: string; message: string }


export type Permission = 'vendors.view' | 'vendors.create' | 'vendors.export' | 'vendors.block' | 'vendors.edit' | 'users.manage' | 'tenant.settings' | 'config.manage' | 'approvals.manage' | 'reports.view' | 'audit.view' | 'orders.view' | 'orders.manage' | 'invoices.manage';
export interface Branding { productName?: string; primaryColor?: string; logoUrl?: string }
export interface Me {
  user: { id: string; name: string; email: string; mfaEnabled: boolean };
  tenant: { id: string; slug: string; name: string; branding: Branding; country: string; countryName: string; currency: string; locale: string; privacyLaw: string | null; mobileExample?: string; supplierLanguages?: ('en' | 'ar')[]; settings: { supplierLanguage?: 'en' | 'ar'; requireMfa?: boolean; sessionHours?: number; aiExtraction?: boolean; vendorOtpChannel?: 'email' | 'sms' | 'both'; reKycMonths?: number; skipWeekends?: boolean; mfaEnforcedByPlatform?: boolean } };
  roles: { id: string; key: string; name: string }[];
  permissions: Permission[];
  mfaSetupRequired: boolean;
  devMailbox: boolean;
  plan?: { key: string; label: string; trialEndsAt: string | null; trialExpired: boolean; features: { erp: boolean; ai: boolean; kyc: boolean; collab: boolean } };
  /** Read-only support session opened from the platform console. */
  support?: { by: string; reason: string | null; endsAt: string };
}

export interface ChecklistItem { id: string; section: string; label: string; ok: boolean; message?: string; severity: 'error' | 'warning' }
export type DocStatus = 'ACTIVE' | 'PENDING' | 'SUPERSEDED' | 'REJECTED';
export interface DocumentRow { id: string; docType: string; fileName: string; mimeType: string; size: number; uploadedAt: string; status?: DocStatus; expiresOn?: string | null; changeRequestId?: string | null; uploadedById?: string | null }
export interface Step {
  id: string; cycle: number; level: number; roleId?: string; roleName?: string; label: string; status: StepStatus;
  remarks?: string | null; actedAt?: string | null; actedBy?: { name: string } | null;
  assigneeName?: string | null; dueAt?: string | null; overdue?: boolean; slaHours?: number | null;
}
export interface AuditRow { id: string; actor: string; action: string; detail: Record<string, unknown> | null; createdAt: string }

export interface VendorSummary {
  id: string; code: string; name: string; vendorType: string; contactFirstName: string; contactLastName: string;
  contactEmail: string; contactMobile: string; status: VendorStatus; reviewCycle: number;
  createdAt: string; updatedAt: string; submittedAt?: string | null; decidedAt?: string | null;
  pendingStep?: { label: string; mine: boolean; dueAt?: string | null; overdue?: boolean; assignee?: string | null } | null; createdBy?: { name: string };
  flags?: Flag[];
}
export interface VendorFull extends VendorSummary {
  blockedAt?: string | null; blockedReason?: string | null; nextReviewAt?: string | null; lastReviewAt?: string | null;
  reviewStatus?: string | null; reviewNote?: string | null; lastConfirmedAt?: string | null;
  profile: Profile; documents: DocumentRow[]; steps: Step[]; audit?: AuditRow[]; inviteLink?: string;
}

export interface Check {
  id: string; kind: string; status: 'VERIFIED' | 'NOT_FOUND' | 'INVALID_FORMAT' | 'ERROR';
  message: string; inputMasked: string; nameOnRecord: string | null; nameMatch: number | null; test: boolean; checkedAt: string;
  data: Record<string, string> | null; requestedBy?: string; provider?: string;
}
export interface Suggestion { fieldId: string; fieldLabel: string; value: string; confidence: number; current: string; state: 'empty' | 'match' | 'differs' }
export interface Extraction {
  id: string; documentId: string; status: 'PENDING' | 'DONE' | 'FAILED' | 'SKIPPED'; provider: string; test: boolean;
  summary: string | null; error: string | null; appliedAt: string | null; docTypeDetected: string | null; suggestions: Suggestion[];
}

export interface Flag { code: 'EMAIL_BOUNCING' | 'ERASURE_REQUESTED' | 'BLOCKED' | 'DOC_EXPIRED' | 'DOC_EXPIRING' | 'CHANGE_PENDING' | 'REVIEW_ATTENTION' | 'REVIEW_DUE'; label: string; severity: 'high' | 'medium' | 'low' }
export type CrStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
export interface FieldChange { fieldId: string; label: string; old: string; new: string }
export interface ChangeRequest {
  id: string; status: CrStatus; changes: FieldChange[]; documentIds: string[]; note: string | null; remarks: string | null;
  sensitive?: boolean; createdAt: string; decidedAt: string | null; steps: Step[]; canAct?: boolean; canReassign?: boolean;
  /** staff view */ raisedBy?: { id: string; name: string } | null; canWithdraw?: boolean;
  /** vendor view: proposed by the buyer's staff */ byBuyer?: boolean;
}
export interface ChangeQueueRow {
  id: string; status: CrStatus; changes: FieldChange[]; documentIds: string[]; sensitive: boolean; createdAt: string; mine: boolean;
  vendor: { id: string; name: string; code: string }; raisedBy: { name: string } | null;
  pendingStep: { label: string; dueAt: string | null; overdue: boolean; assignee: string | null } | null;
}
