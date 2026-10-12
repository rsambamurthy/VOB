/**
 * Database schema. Every business table carries tenant_id — all queries MUST filter by it
 * (see lib/tenantScope notes in README "Multi-tenancy"). Platform-level tables: tenants.
 */
import { pgTable, pgEnum, text, integer, boolean, timestamp, jsonb, index, uniqueIndex, primaryKey, date, customType } from 'drizzle-orm/pg-core';
import { openChanges, openJson, openProfile, sealChanges, sealJson, sealProfile } from '../lib/fieldCrypto.js';

/* JSON columns that encrypt sensitive values on write and decrypt on read (see lib/fieldCrypto.ts). */
const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
type ProfileData = Record<string, Record<string, unknown>>;
const sealedProfile = customType<{ data: ProfileData; driverData: unknown }>({
  dataType: () => 'jsonb',
  toDriver: (v) => JSON.stringify(sealProfile(v)),
  fromDriver: (v) => openProfile(parse(v) as ProfileData),
});
type ChangeData = { fieldId: string; label: string; old: string; new: string }[];
const sealedChanges = customType<{ data: ChangeData; driverData: unknown }>({
  dataType: () => 'jsonb',
  toDriver: (v) => JSON.stringify(sealChanges(v)),
  fromDriver: (v) => openChanges(parse(v) as ChangeData),
});
function sealedJson<T>() {
  return customType<{ data: T; driverData: unknown }>({
    dataType: () => 'jsonb',
    toDriver: (v) => JSON.stringify(sealJson(v)),
    fromDriver: (v) => openJson<T>(parse(v)),
  });
}
import { relations } from 'drizzle-orm';
import crypto from 'node:crypto';
import type { OnboardingConfig } from '../config/types.js';

const id = () => text('id').primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const tenantId = () => text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' });

export const tenantStatusEnum = pgEnum('tenant_status', ['ACTIVE', 'SUSPENDED']);
export const userStatusEnum = pgEnum('user_status', ['INVITED', 'ACTIVE', 'DISABLED']);
export const vendorTypeEnum = pgEnum('vendor_type', ['DOMESTIC', 'IMPORT', 'GOVERNMENT']);
/**
 * INVITED      created by buyer, vendor not yet signed in
 * IN_PROGRESS  vendor is filling the profile
 * UNDER_REVIEW submitted, moving through approval levels
 * SENT_BACK    an approver returned it to the vendor for corrections
 */
export const vendorStatusEnum = pgEnum('vendor_status', ['INVITED', 'IN_PROGRESS', 'UNDER_REVIEW', 'SENT_BACK', 'APPROVED', 'REJECTED']);
/** WAITING = later level not yet reached; CANCELLED = superseded after a send-back / rejection */
export const stepStatusEnum = pgEnum('step_status', ['WAITING', 'PENDING', 'APPROVED', 'REJECTED', 'SENT_BACK', 'CANCELLED']);
export const sessionKindEnum = pgEnum('session_kind', ['STAFF', 'VENDOR']);
export const tokenPurposeEnum = pgEnum('token_purpose', ['INVITE', 'PASSWORD_RESET']);
export const configStatusEnum = pgEnum('config_status', ['DRAFT', 'PUBLISHED', 'ARCHIVED']);
/** TEST = recorded only (test mode); QUEUED → SENT / FAILED for real providers */
export const deliveryStatusEnum = pgEnum('delivery_status', ['TEST', 'QUEUED', 'SENT', 'FAILED']);
export const extractionStatusEnum = pgEnum('extraction_status', ['PENDING', 'DONE', 'FAILED', 'SKIPPED']);

export type VendorType = (typeof vendorTypeEnum.enumValues)[number];
export type VendorStatus = (typeof vendorStatusEnum.enumValues)[number];

export interface TenantBranding { productName?: string; primaryColor?: string; logoUrl?: string }
export interface TenantSettings {
  requireMfa?: boolean;
  /** Months between automatic re-verifications of approved vendors (0 = off). Default 12. */
  reKycMonths?: number;
  sessionHours?: number;
  /** Let AI read uploaded documents and suggest form values (sends documents to the AI provider). */
  aiExtraction?: boolean;
  /** Where vendor sign-in codes go. */
  vendorOtpChannel?: 'email' | 'sms' | 'both';
  /** DPDP privacy notice shown to vendors; changing the text bumps the version and asks vendors to accept again. */
  privacy?: { version: number; text: string; contactEmail?: string; updatedAt?: string };
  /** Days after which vendor data is anonymised: rejected registrations, and ones abandoned before submitting (0 = keep). */
  retention?: { rejectedDays: number; abandonedDays: number };
}

export const tenants = pgTable('tenants', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  status: tenantStatusEnum('status').notNull().default('ACTIVE'),
  branding: jsonb('branding').$type<TenantBranding>().notNull().default({}),
  settings: jsonb('settings').$type<TenantSettings>().notNull().default({}),
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  status: userStatusEnum('status').notNull().default('INVITED'),
  passwordHash: text('password_hash'),
  /** AES-GCM encrypted TOTP secret (see lib/crypto.ts) */
  mfaSecretEnc: text('mfa_secret_enc'),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  /** sha256 hashes of unused recovery codes */
  mfaRecoveryHashes: jsonb('mfa_recovery_hashes').$type<string[]>().notNull().default([]),
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('users_tenant_email_uq').on(t.tenantId, t.email)]);

/** Tenant-defined roles. `key` is stable (used by workflow config); `permissions` from lib/permissions.ts */
export const roles = pgTable('roles', {
  id: id(),
  tenantId: tenantId(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('roles_tenant_key_uq').on(t.tenantId, t.key)]);

export const userRoles = pgTable('user_roles', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.userId, t.roleId] })]);

/** Server-side sessions; the cookie holds a random token, the DB holds its sha256. */
export const sessions = pgTable('sessions', {
  id: id(),
  tokenHash: text('token_hash').notNull().unique(),
  kind: sessionKindEnum('kind').notNull(),
  tenantId: tenantId(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  vendorId: text('vendor_id').references(() => vendors.id, { onDelete: 'cascade' }),
  /** true between password check and TOTP check */
  mfaPending: boolean('mfa_pending').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: createdAt(),
});

/** One-time links: staff invites and password resets. */
export const authTokens = pgTable('auth_tokens', {
  id: id(),
  tenantId: tenantId(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  purpose: tokenPurposeEnum('purpose').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const vendors = pgTable('vendors', {
  id: id(),
  tenantId: tenantId(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  vendorType: vendorTypeEnum('vendor_type').notNull(),
  contactFirstName: text('contact_first_name').notNull(),
  contactLastName: text('contact_last_name').notNull(),
  contactEmail: text('contact_email').notNull(),
  contactMobile: text('contact_mobile').notNull(),
  status: vendorStatusEnum('status').notNull().default('INVITED'),
  /** Profile answers keyed by section -> field (driven by config/formSchema.ts) */
  /** Sensitive values (PAN, bank account…) are encrypted inside the JSON. */
  profile: sealedProfile('profile').notNull().default({}),
  inviteToken: text('invite_token').notNull().unique(),
  reviewCycle: integer('review_cycle').notNull().default(0),
  /** Config version in force when the vendor last submitted (for audit). */
  configVersion: integer('config_version'),
  createdById: text('created_by_id').notNull().references(() => users.id),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  /* ---- Lifecycle (Phase 4) ---- */
  blockedAt: timestamp('blocked_at', { withTimezone: true }),
  blockedReason: text('blocked_reason'),
  blockedById: text('blocked_by_id').references(() => users.id),
  /** Next periodic re-verification (set on approval from the workspace's re-check interval). */
  nextReviewAt: timestamp('next_review_at', { withTimezone: true }),
  lastReviewAt: timestamp('last_review_at', { withTimezone: true }),
  /** OK | ATTENTION — result of the last periodic re-verification */
  reviewStatus: text('review_status'),
  reviewNote: text('review_note'),
  /** When the vendor last confirmed their details are still correct. */
  lastConfirmedAt: timestamp('last_confirmed_at', { withTimezone: true }),
  /* ---- ERP (Phase 5) ---- */
  /** Supplier id the ERP assigned (returned by the first successful push). */
  erpVendorId: text('erp_vendor_id'),
  /** PENDING · SYNCED · FAILED · TEST — latest push outcome */
  erpSyncStatus: text('erp_sync_status'),
  erpSyncedAt: timestamp('erp_synced_at', { withTimezone: true }),
  /* ---- Privacy / DPDP (Phase 6) ---- */
  consentAt: timestamp('consent_at', { withTimezone: true }),
  consentVersion: integer('consent_version'),
  consentIp: text('consent_ip'),
  erasureRequestedAt: timestamp('erasure_requested_at', { withTimezone: true }),
  erasureReason: text('erasure_reason'),
  /** Personal data removed (on request or by the retention policy); the row stays for statistics and the audit trail. */
  erasedAt: timestamp('erased_at', { withTimezone: true }),
}, (t) => [uniqueIndex('vendors_tenant_code_uq').on(t.tenantId, t.code), index('vendors_tenant_status_idx').on(t.tenantId, t.status)]);

export const otpCodes = pgTable('otp_codes', {
  id: id(),
  tenantId: tenantId(),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  used: boolean('used').notNull().default(false),
  createdAt: createdAt(),
});

export const documents = pgTable('documents', {
  id: id(),
  tenantId: tenantId(),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  docType: text('doc_type').notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  storagePath: text('storage_path').notNull(),
  /** Which storage driver holds the file (local / s3 / azure) — lets you switch drivers without breaking old files. */
  storageDriver: text('storage_driver').notNull().default('local'),
  sha256: text('sha256'),
  /** CLEAN, SKIPPED (no scanner configured) */
  scanStatus: text('scan_status').notNull().default('SKIPPED'),
  /** ACTIVE (in force) · PENDING (uploaded by an approved vendor, waiting in a change request) · SUPERSEDED · REJECTED */
  status: text('status').notNull().default('ACTIVE'),
  expiresOn: date('expires_on', { mode: 'string' }),
  /** Bit flags of expiry reminders already sent: 1 = 30 days, 2 = 7 days, 4 = expired */
  expiryNotified: integer('expiry_notified').notNull().default(0),
  changeRequestId: text('change_request_id'),
  /** Staff member who uploaded it on the vendor's behalf (null = the vendor). */
  uploadedById: text('uploaded_by_id'),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Online checks (GSTIN, PAN, bank penny-drop, CIN). Inputs are stored masked + hashed, never in full. */
export const verifications = pgTable('verifications', {
  id: id(),
  tenantId: tenantId(),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  inputHash: text('input_hash').notNull(),
  inputMasked: text('input_masked').notNull(),
  status: text('status').notNull(),
  provider: text('provider').notNull(),
  test: boolean('test').notNull().default(false),
  message: text('message').notNull(),
  nameOnRecord: text('name_on_record'),
  /** 0..1 similarity between the name on record and the vendor's legal name */
  nameMatch: integer('name_match'),
  data: jsonb('data').$type<Record<string, string>>(),
  requestedBy: text('requested_by').notNull(),
  createdAt: createdAt(),
}, (t) => [index('verifications_vendor_idx').on(t.vendorId, t.kind, t.createdAt)]);

/** AI reading of an uploaded document: values found, and how they compare with what the vendor typed. */
export const documentExtractions = pgTable('document_extractions', {
  id: id(),
  tenantId: tenantId(),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  documentId: text('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  status: extractionStatusEnum('status').notNull().default('PENDING'),
  provider: text('provider').notNull(),
  test: boolean('test').notNull().default(false),
  docTypeDetected: text('doc_type_detected'),
  /** Encrypted as a whole: values read from documents can include PAN and account numbers. */
  fields: sealedJson<{ fieldId: string; label: string; value: string; confidence: number }[]>()('fields').notNull().default([]),
  summary: text('summary'),
  error: text('error'),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  createdAt: createdAt(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [index('extractions_vendor_idx').on(t.vendorId)]);

/** An approved vendor's request to change details or renew documents; applied only after approval. */
export const changeRequests = pgTable('change_requests', {
  id: id(),
  tenantId: tenantId(),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  /** PENDING · APPROVED · REJECTED · CANCELLED */
  status: text('status').notNull().default('PENDING'),
  changes: sealedChanges('changes').notNull().default([]),
  documentIds: jsonb('document_ids').$type<string[]>().notNull().default([]),
  note: text('note'),
  /** Set when a staff member proposed the change on the vendor's behalf (null = vendor's own request). */
  raisedById: text('raised_by_id').references(() => users.id),
  sensitive: boolean('sensitive').notNull().default(false),
  remarks: text('remarks'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('change_requests_vendor_idx').on(t.vendorId, t.status), index('change_requests_tenant_idx').on(t.tenantId, t.status)]);

export const changeRequestSteps = pgTable('change_request_steps', {
  id: id(),
  tenantId: tenantId(),
  changeRequestId: text('change_request_id').notNull().references(() => changeRequests.id, { onDelete: 'cascade' }),
  level: integer('level').notNull(),
  roleId: text('role_id').notNull().references(() => roles.id),
  label: text('label').notNull(),
  status: stepStatusEnum('status').notNull(),
  assigneeUserId: text('assignee_user_id').references(() => users.id),
  remarks: text('remarks'),
  actedById: text('acted_by_id').references(() => users.id),
  actedAt: timestamp('acted_at', { withTimezone: true }),
  slaHours: integer('sla_hours'),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  dueAt: timestamp('due_at', { withTimezone: true }),
  remindedAt: timestamp('reminded_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('cr_steps_pending_idx').on(t.tenantId, t.status, t.roleId)]);

export const smsLog = pgTable('sms_log', {
  id: id(),
  tenantId: text('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  to: text('to').notNull(),
  body: text('body').notNull(),
  purpose: text('purpose').notNull(),
  status: deliveryStatusEnum('status').notNull(),
  provider: text('provider').notNull(),
  providerMessageId: text('provider_message_id'),
  error: text('error'),
  attempts: integer('attempts').notNull().default(0),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const approvalSteps = pgTable('approval_steps', {
  id: id(),
  tenantId: tenantId(),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  cycle: integer('cycle').notNull(),
  level: integer('level').notNull(),
  roleId: text('role_id').notNull().references(() => roles.id),
  label: text('label').notNull(),
  status: stepStatusEnum('status').notNull(),
  /** Set when an admin reassigns the step to one person instead of the whole role. */
  assigneeUserId: text('assignee_user_id').references(() => users.id),
  slaHours: integer('sla_hours'),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  dueAt: timestamp('due_at', { withTimezone: true }),
  remindedAt: timestamp('reminded_at', { withTimezone: true }),
  remarks: text('remarks'),
  actedById: text('acted_by_id').references(() => users.id),
  actedAt: timestamp('acted_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('approval_steps_vendor_cycle_idx').on(t.vendorId, t.cycle), index('approval_steps_pending_idx').on(t.tenantId, t.status, t.roleId)]);

export const auditLogs = pgTable('audit_logs', {
  id: id(),
  tenantId: tenantId(),
  vendorId: text('vendor_id').references(() => vendors.id, { onDelete: 'cascade' }),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  detail: jsonb('detail'),
  ip: text('ip'),
  createdAt: createdAt(),
}, (t) => [index('audit_tenant_created_idx').on(t.tenantId, t.createdAt)]);

/** Versioned onboarding configuration. One PUBLISHED and at most one DRAFT per tenant. */
export const tenantConfigs = pgTable('tenant_configs', {
  id: id(),
  tenantId: tenantId(),
  version: integer('version').notNull(),
  status: configStatusEnum('status').notNull(),
  config: jsonb('config').$type<OnboardingConfig>().notNull(),
  note: text('note'),
  updatedById: text('updated_by_id').references(() => users.id),
  publishedById: text('published_by_id').references(() => users.id),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [uniqueIndex('tenant_configs_version_uq').on(t.tenantId, t.version), index('tenant_configs_status_idx').on(t.tenantId, t.status)]);

/** Out-of-office: while active, the delegate can act on everything the delegator can approve. */
export const delegations = pgTable('delegations', {
  id: id(),
  tenantId: tenantId(),
  fromUserId: text('from_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  toUserId: text('to_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  reason: text('reason'),
  createdAt: createdAt(),
}, (t) => [index('delegations_to_idx').on(t.tenantId, t.toUserId)]);

/** Every outgoing email is recorded here (and, in dev, shown in the Mailbox screen). */
export const emailOutbox = pgTable('email_outbox', {
  id: id(),
  tenantId: text('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  to: text('to').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  link: text('link'),
  status: deliveryStatusEnum('status').notNull().default('TEST'),
  provider: text('provider').notNull().default('test'),
  providerMessageId: text('provider_message_id'),
  error: text('error'),
  attempts: integer('attempts').notNull().default(0),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const tenantsRelations = relations(tenants, ({ many }) => ({ users: many(users), roles: many(roles) }));
export const usersRelations = relations(users, ({ one, many }) => ({
  tenant: one(tenants, { fields: [users.tenantId], references: [tenants.id] }),
  userRoles: many(userRoles),
}));
export const rolesRelations = relations(roles, ({ many }) => ({ userRoles: many(userRoles) }));
export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, { fields: [userRoles.userId], references: [users.id] }),
  role: one(roles, { fields: [userRoles.roleId], references: [roles.id] }),
}));
export const vendorsRelations = relations(vendors, ({ one, many }) => ({
  createdBy: one(users, { fields: [vendors.createdById], references: [users.id] }),
  documents: many(documents),
  steps: many(approvalSteps),
  audit: many(auditLogs),
}));
export const documentsRelations = relations(documents, ({ one, many }) => ({ vendor: one(vendors, { fields: [documents.vendorId], references: [vendors.id] }), extractions: many(documentExtractions) }));
export const extractionsRelations = relations(documentExtractions, ({ one }) => ({ document: one(documents, { fields: [documentExtractions.documentId], references: [documents.id] }) }));
export const stepsRelations = relations(approvalSteps, ({ one }) => ({
  vendor: one(vendors, { fields: [approvalSteps.vendorId], references: [vendors.id] }),
  actedBy: one(users, { fields: [approvalSteps.actedById], references: [users.id], relationName: 'actedBy' }),
  assignee: one(users, { fields: [approvalSteps.assigneeUserId], references: [users.id], relationName: 'assignee' }),
  role: one(roles, { fields: [approvalSteps.roleId], references: [roles.id] }),
}));
export const auditRelations = relations(auditLogs, ({ one }) => ({ vendor: one(vendors, { fields: [auditLogs.vendorId], references: [vendors.id] }) }));

export type Tenant = typeof tenants.$inferSelect;
export type User = typeof users.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type Vendor = typeof vendors.$inferSelect;
export type ApprovalStep = typeof approvalSteps.$inferSelect;
export type TenantConfig = typeof tenantConfigs.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type ChangeRequest = typeof changeRequests.$inferSelect;
export type ChangeRequestStep = typeof changeRequestSteps.$inferSelect;

export const changeRequestsRelations = relations(changeRequests, ({ one, many }) => ({
  vendor: one(vendors, { fields: [changeRequests.vendorId], references: [vendors.id] }),
  steps: many(changeRequestSteps),
  raisedBy: one(users, { fields: [changeRequests.raisedById], references: [users.id], relationName: 'crRaisedBy' }),
}));
export const changeRequestStepsRelations = relations(changeRequestSteps, ({ one }) => ({
  changeRequest: one(changeRequests, { fields: [changeRequestSteps.changeRequestId], references: [changeRequests.id] }),
  role: one(roles, { fields: [changeRequestSteps.roleId], references: [roles.id] }),
  actedBy: one(users, { fields: [changeRequestSteps.actedById], references: [users.id], relationName: 'crActedBy' }),
  assignee: one(users, { fields: [changeRequestSteps.assigneeUserId], references: [users.id], relationName: 'crAssignee' }),
}));

/* ======================= ERP (Phase 5) ======================= */

/** One ERP connection per workspace. Secrets (passwords, signing keys) are AES-GCM encrypted. */
export const erpConnections = pgTable('erp_connections', {
  tenantId: text('tenant_id').primaryKey().references(() => tenants.id, { onDelete: 'cascade' }),
  /** none · oracle · webhook · csv */
  kind: text('kind').notNull().default('none'),
  /** Test mode: build and record exactly what would be sent, but send nothing. */
  testMode: boolean('test_mode').notNull().default(true),
  /** Push automatically on approval, approved changes and block / unblock. */
  autoPush: boolean('auto_push').notNull().default(true),
  config: jsonb('config').$type<Record<string, string>>().notNull().default({}),
  secretsEnc: text('secrets_enc'),
  updatedById: text('updated_by_id').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Every push attempt to the ERP, for status, troubleshooting and retry. */
export const erpSyncs = pgTable('erp_syncs', {
  id: id(),
  tenantId: tenantId(),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  /** CREATE · UPDATE · BLOCK · UNBLOCK · MANUAL */
  event: text('event').notNull(),
  kind: text('kind').notNull(),
  /** PENDING · SENT · TEST · FAILED */
  status: text('status').notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0),
  target: text('target'),
  /** What was (or would be) sent — payload / CSV text, never secrets. */
  /** Encrypted as a whole: payloads carry bank details. */
  request: sealedJson<{ body?: unknown; csv?: string; fileName?: string; headers?: Record<string, string> } | null>()('request'),
  httpStatus: integer('http_status'),
  response: text('response'),
  error: text('error'),
  erpVendorId: text('erp_vendor_id'),
  requestedBy: text('requested_by'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('erp_syncs_vendor_idx').on(t.vendorId, t.createdAt), index('erp_syncs_tenant_status_idx').on(t.tenantId, t.status)]);
export const erpSyncsRelations = relations(erpSyncs, ({ one }) => ({ vendor: one(vendors, { fields: [erpSyncs.vendorId], references: [vendors.id] }) }));
export type ErpConnection = typeof erpConnections.$inferSelect;
export type ErpSync = typeof erpSyncs.$inferSelect;

/** Scheduled database backups written to storage (operator-level, not per workspace). */
export const systemBackups = pgTable('system_backups', {
  id: id(),
  storageKey: text('storage_key').notNull(),
  storageDriver: text('storage_driver').notNull(),
  size: integer('size').notNull(),
  createdAt: createdAt(),
});
