/**
 * Database schema. Every business table carries tenant_id — all queries MUST filter by it
 * (see lib/tenantScope notes in README "Multi-tenancy"). Platform-level tables: tenants.
 */
import { pgTable, pgEnum, text, integer, boolean, timestamp, jsonb, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core';
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
  sessionHours?: number;
  /** Let AI read uploaded documents and suggest form values (sends documents to the AI provider). */
  aiExtraction?: boolean;
  /** Where vendor sign-in codes go. */
  vendorOtpChannel?: 'email' | 'sms' | 'both';
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
  profile: jsonb('profile').$type<Record<string, Record<string, unknown>>>().notNull().default({}),
  inviteToken: text('invite_token').notNull().unique(),
  reviewCycle: integer('review_cycle').notNull().default(0),
  /** Config version in force when the vendor last submitted (for audit). */
  configVersion: integer('config_version'),
  createdById: text('created_by_id').notNull().references(() => users.id),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
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
  fields: jsonb('fields').$type<{ fieldId: string; label: string; value: string; confidence: number }[]>().notNull().default([]),
  summary: text('summary'),
  error: text('error'),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  createdAt: createdAt(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [index('extractions_vendor_idx').on(t.vendorId)]);

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
