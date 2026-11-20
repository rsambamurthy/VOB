/**
 * Database schema. Every business table carries tenant_id — all queries MUST filter by it
 * (see lib/tenantScope notes in README "Multi-tenancy"). Platform-level tables: tenants.
 */
import { pgTable, pgEnum, text, integer, boolean, timestamp, jsonb, index, uniqueIndex, primaryKey, date, customType, numeric } from 'drizzle-orm/pg-core';
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
import { relations, sql } from 'drizzle-orm';
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
/** Who the workspace is billed as (tax invoice "Bill to"). */
export interface TenantBilling {
  legalName?: string; gstin?: string; address?: string; city?: string; postalCode?: string;
  /** ISO country of the billing address; India uses stateCode (GST place of supply). */
  country?: string; stateCode?: string; email?: string;
  cycle?: 'monthly' | 'yearly';
  /** Issue the next invoice automatically on this date (YYYY-MM-DD). */
  nextInvoiceOn?: string; autoInvoice?: boolean;
}
/** Seller details, prices and invoice numbering (platform settings). */
export interface PlatformBilling {
  seller?: { name: string; gstin?: string; pan?: string; address: string; stateCode: string; email?: string; bank?: string };
  /** Prices in major units per currency → plan → cycle, e.g. { INR: { standard: { monthly: 25000, yearly: 250000 } } } */
  prices?: Record<string, Record<string, { monthly?: number; yearly?: number }>>;
  gstRate?: number; sac?: string; dueDays?: number; prefix?: string;
  /** Text printed on export invoices (e.g. the LUT reference). */
  exportNote?: string;
}
export interface InvoiceLine { description: string; sac: string; quantity: number; unitPrice: number; amount: number }
export interface InvoiceParty { name: string; gstin?: string; address: string; country: string; stateCode?: string; stateName?: string; email?: string }

/** Outstanding SAML sign-in requests (matched against the identity provider's reply). */
export const ssoRequests = pgTable('sso_requests', {
  id: text('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export interface TenantSettings {
  /** Staff single sign-on (OpenID Connect or SAML); see services/sso.ts. */
  sso?: import('../services/sso.js').SsoSettings;
  /** SCIM 2.0 user provisioning from the identity provider; the bearer token is stored hashed. */
  /** Supplier performance scorecards: weights per measure (0–100), grace days for on-time, supplier visibility. */
  scorecard?: { weights?: Partial<Record<'onTime' | 'fillRate' | 'acknowledgement' | 'invoiceAccuracy' | 'asn' | 'rating', number>>; graceDays?: number; showToSuppliers?: boolean };
  scim?: { enabled: boolean; tokenHash?: string; tokenCreatedAt?: string; lastUsedAt?: string; defaultRoleId?: string };
  requireMfa?: boolean;
  /** Sourcing (RFQs and e-auctions): workspace switch, formats, sub-features, rule defaults and locks. See services/sourcing/config.ts. */
  sourcing?: import('../services/sourcing/config.js').SourcingSettings;
  /** Contracts: workspace switch, contract types, options, rule defaults and locks. See services/contracts/config.ts. */
  contracts?: import('../lib/moduleConfig.js').ModuleSettings;
  /** Months between automatic re-verifications of approved vendors (0 = off). Default 12. */
  reKycMonths?: number;
  sessionHours?: number;
  /** Count approval deadlines and PO auto-accept days on working days only (skip the home country's weekend). */
  skipWeekends?: boolean;
  /** Let AI read uploaded documents and suggest form values (sends documents to the AI provider). */
  aiExtraction?: boolean;
  /** With AI reading on: 'assisted' suggests values the supplier applies; 'automatic' fills empty fields straight from documents (documents first). */
  dataEntry?: 'assisted' | 'automatic';
  /** Where vendor sign-in codes go. */
  vendorOtpChannel?: 'email' | 'sms' | 'both';
  /** DPDP privacy notice shown to vendors; changing the text bumps the version and asks vendors to accept again. */
  privacy?: { version: number; text: string; textAr?: string; contactEmail?: string; updatedAt?: string };
  /** Pre-review for approvers: also send general facts about the submission (privacy mode: no names, numbers or free text) to the AI provider for a summary and recommendation. Off by default; VendorGate's own findings are always shown. */
  aiPreReview?: boolean;
  /** Privacy mode: amounts (turnover, company age) go to the AI as ranges (default) or exact — never with names. */
  aiPrecision?: 'ranges' | 'exact';
  /** Supplier guide: turn a buyer's send-back remarks into a to-do list with AI (privacy mode; values replaced by placeholders). Default on; otherwise by rules. */
  aiGuide?: boolean;
  /** Ongoing risk monitoring: days between re-checks of registration status and sanctions (0 = off; default 30), who is alerted, and whether a serious hit puts the supplier on hold. */
  risk?: { monitorDays?: number; alertEmails?: string; autoHold?: boolean; holdOnOverdueAction?: boolean };
  /** Days after which vendor data is anonymised: rejected registrations, and ones abandoned before submitting (0 = keep). */
  retention?: { rejectedDays: number; abandonedDays: number };
  /** Answer F1 help questions with AI (from the help articles only). Default on. */
  helpAi?: boolean;
  /** "Ask VendorGate": AI search over the supplier base (default on). */
  askAi?: boolean;
  /** Invoice matching: allowed difference in unit price (%) before an invoice is flagged. Default 2. */
  priceTolerancePct?: number;
  /** Language new suppliers get in the portal and emails, where the country offers more than one. */
  supplierLanguage?: 'en' | 'ar';
  /** India: suppliers registered for GST must give the e-invoice IRN (flagged when missing). */
  einvoiceRequired?: boolean;
  /** Set once the workspace admin has confirmed (or changed) the home country; after that it is fixed. */
  countryConfirmed?: boolean;
  /** Two-factor sign-in required by the platform operator; the workspace admin can't turn it off. */
  mfaEnforcedByPlatform?: boolean;
  /** Outgoing email: sender name, reply-to, and an own sending domain (verified through the email provider). */
  email?: { fromName?: string; replyTo?: string; domain?: { name: string; providerId?: string; status: 'pending' | 'verified' | 'failed'; fromLocal?: string; records?: { type: string; name: string; value: string; priority?: number; status?: string }[]; checkedAt?: string } };
}

/** Per-tenant overrides of the plan's limits (see lib/plans.ts). Missing = use the plan's value; null = unlimited. */
export interface TenantLimits {
  maxUsers?: number | null;
  maxVendors?: number | null;
  emailsPerDay?: number | null;
  features?: Partial<Record<import('../lib/features.js').Feature, boolean>>;
  /** Sourcing formats included (null = all; missing = the plan's). */
  sourcingFormats?: import('../lib/features.js').SourcingFormat[] | null;
}

export const tenants = pgTable('tenants', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  status: tenantStatusEnum('status').notNull().default('ACTIVE'),
  branding: jsonb('branding').$type<TenantBranding>().notNull().default({}),
  settings: jsonb('settings').$type<TenantSettings>().notNull().default({}),
  /** Home country (ISO code): picks the country pack — currency, formats, template, privacy law, ERP mapping. */
  country: text('country').notNull().default('IN'),
  /** trial | standard | enterprise (lib/plans.ts) */
  plan: text('plan').notNull().default('standard'),
  limits: jsonb('limits').$type<TenantLimits>().notNull().default({}),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  /** How the workspace was created: platform console, self-service sign-up, CLI or first-deploy bootstrap. */
  source: text('source').notNull().default('platform'),
  statusReason: text('status_reason'),
  /** Internal notes, visible only in the platform console. */
  notes: text('notes'),
  billing: jsonb('billing').$type<TenantBilling>().notNull().default({}),
  createdAt: createdAt(),
});

export const users = pgTable('users', {
  id: id(),
  tenantId: tenantId(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  status: userStatusEnum('status').notNull().default('INVITED'),
  passwordHash: text('password_hash'),
  /** The identity provider's id for this person (SCIM externalId). */
  scimExternalId: text('scim_external_id'),
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
  /** Signed in through the workspace's single sign-on (the identity provider handles 2FA). */
  sso: boolean('sso').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  /** Read-only support session opened from the platform console: the platform admin's id and reason. */
  supportAdminId: text('support_admin_id'),
  supportReason: text('support_reason'),
  /** Supplier sessions: the contact email that signed in (a supplier can have several). */
  contactEmail: text('contact_email'),
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
  /** Why the vendor is on hold: MANUAL (a person blocked it) or EXPIRY (a required document lapsed — released automatically on renewal). */
  blockSource: text('block_source'),
  /** Set when email to the contact bounces or is marked as spam (Resend webhook); cleared when the address changes. */
  emailBouncedAt: timestamp('email_bounced_at', { withTimezone: true }),
  emailBounceReason: text('email_bounce_reason'),
  /** Supplier portal and email language (en · ar); null = the workspace default. */
  language: text('language'),
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
  /** Keyed hashes of the supplier's identifiers (PAN, GSTIN, bank account, IBAN, CR, VAT…) for spotting duplicates
   *  without decrypting anything. Null = not computed yet (filled at startup). See services/duplicates.ts. */
  identityKeys: text('identity_keys').array(),
  /* ---- Risk monitoring (services/risk.ts) ---- */
  /** 0–100, higher = riskier; LOW · MEDIUM · HIGH; the signals behind it. Recomputed daily and when the supplier is opened. */
  /** Created to bid in a sourcing event (outside bidder): not asked to onboard until awarded or the buyer starts onboarding. */
  bidderOnly: boolean('bidder_only').notNull().default(false),
  /** When an outside bidder completed the short bidder registration. */
  bidderRegisteredAt: timestamp('bidder_registered_at', { withTimezone: true }),
  riskScore: integer('risk_score'),
  riskBand: text('risk_band'),
  riskSignals: jsonb('risk_signals'),
  riskUpdatedAt: timestamp('risk_updated_at', { withTimezone: true }),
  /** When registration status and sanctions were last re-checked by monitoring. */
  lastMonitoredAt: timestamp('last_monitored_at', { withTimezone: true }),
}, (t) => [uniqueIndex('vendors_tenant_code_uq').on(t.tenantId, t.code), index('vendors_tenant_status_idx').on(t.tenantId, t.status), index('vendors_identity_keys_idx').using('gin', t.identityKeys), index('vendors_tenant_risk_idx').on(t.tenantId, t.riskScore), index('vendors_tenant_updated_idx').on(t.tenantId, t.updatedAt)]);

export const otpCodes = pgTable('otp_codes', {
  id: id(),
  tenantId: tenantId(),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull(),
  /** Set for email sign-in to the supplier portal: the address the code was sent to. */
  email: text('email'),
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
}, (t) => [index('documents_vendor_idx').on(t.vendorId, t.status)]);

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
  /** Fields filled in automatically from this document (automatic data entry). */
  autoApplied: jsonb('auto_applied').$type<string[]>().notNull().default([]),
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
  /** Send-back: the remarks as a to-do list for the supplier (supplier guide), in the language it was written for. */
  todo: jsonb('todo').$type<{ lang: string; by: 'ai' | 'rules'; items: { text: string; tab?: string }[] }>(),
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
}, (t) => [index('audit_tenant_created_idx').on(t.tenantId, t.createdAt), index('audit_vendor_idx').on(t.vendorId, t.createdAt),
  // Sourcing history and the approval engine look up audit rows by the event / subject in `detail`.
  index('audit_event_idx').on(sql`(${t.detail}->>'eventId')`), index('audit_subject_idx').on(sql`(${t.detail}->>'subjectId')`)]);

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
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  bouncedAt: timestamp('bounced_at', { withTimezone: true }),
  bounceType: text('bounce_type'),
  complainedAt: timestamp('complained_at', { withTimezone: true }),
  createdAt: createdAt(),
});

/** Addresses we stop sending to after a hard bounce or a spam complaint (any workspace). */
export const emailSuppressions = pgTable('email_suppressions', {
  id: id(),
  address: text('address').notNull().unique(),
  reason: text('reason').notNull(), // BOUNCE | COMPLAINT
  detail: text('detail'),
  tenantId: text('tenant_id').references(() => tenants.id, { onDelete: 'set null' }),
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

/* ---------- Supplier collaboration (purchase orders) ---------- */

const qty = (name: string) => numeric(name, { precision: 18, scale: 4 });

/** Legal entity / company (Oracle: operating unit, ORG_ID). */
export const legalEntities = pgTable('legal_entities', {
  id: id(), tenantId: tenantId(),
  code: text('code').notNull(), name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('legal_entities_code_uq').on(t.tenantId, t.code)]);

/** Plant / warehouse / ship-to location (Oracle: ship-to organization). */
export const sites = pgTable('sites', {
  id: id(), tenantId: tenantId(),
  entityId: text('entity_id').references(() => legalEntities.id, { onDelete: 'set null' }),
  code: text('code').notNull(), name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('sites_code_uq').on(t.tenantId, t.code)]);

/** Buying / purchasing group: how POs in it are acknowledged. */
export const buyingGroups = pgTable('buying_groups', {
  id: id(), tenantId: tenantId(),
  code: text('code').notNull(), name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  /** Accept automatically this many calendar days after the PO reaches the portal; null = the supplier must accept. */
  autoAcceptDays: integer('auto_accept_days'),
  /** Shipment notice required before goods are received (used from Phase 2). */
  asnRequired: boolean('asn_required').notNull().default(false),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('buying_groups_code_uq').on(t.tenantId, t.code)]);

/** A vendor's supplier codes in the ERP (one vendor may have several, e.g. per site). */
export const supplierCodes = pgTable('supplier_codes', {
  id: id(), tenantId: tenantId(),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('supplier_codes_uq').on(t.tenantId, t.code)]);

/** People at a supplier who may sign in to the supplier portal (besides the vendor's main contact). */
export const supplierContacts = pgTable('supplier_contacts', {
  id: id(), tenantId: tenantId(),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), email: text('email').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('supplier_contacts_uq').on(t.vendorId, t.email), index('supplier_contacts_email_idx').on(t.tenantId, t.email)]);

/**
 * Purchase order header, mirrored from the ERP (the ERP stays the record).
 * acceptance: PENDING · PARTIAL · ACCEPTED · AUTO_ACCEPTED ; status: OPEN · CLOSED · CANCELLED
 */
export const purchaseOrders = pgTable('purchase_orders', {
  id: id(), tenantId: tenantId(),
  erpId: text('erp_id').notNull(),
  poNumber: text('po_number').notNull(),
  revision: integer('revision').notNull().default(0),
  vendorId: text('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
  supplierCode: text('supplier_code').notNull(),
  supplierSiteCode: text('supplier_site_code'),
  entityId: text('entity_id').references(() => legalEntities.id, { onDelete: 'set null' }),
  buyingGroupId: text('buying_group_id').references(() => buyingGroups.id, { onDelete: 'set null' }),
  buyerName: text('buyer_name'), buyerEmail: text('buyer_email'),
  poType: text('po_type'),
  currency: text('currency').notNull().default('INR'),
  poDate: date('po_date'),
  paymentTerms: text('payment_terms'), incoterms: text('incoterms'),
  total: qty('total'),
  status: text('status').notNull().default('OPEN'),
  acceptance: text('acceptance').notNull().default('PENDING'),
  /** When it is accepted automatically if the supplier hasn't (null = never). */
  acceptDueAt: timestamp('accept_due_at', { withTimezone: true }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  notes: text('notes'),
  attachments: jsonb('attachments').$type<{ name: string; url: string }[]>().notNull().default([]),
  /** api · csv · oracle · demo */
  source: text('source').notNull(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  remindedAt: timestamp('reminded_at', { withTimezone: true }),
  /** Hash of the last imported content, to tell real changes from repeats. */
  contentHash: text('content_hash'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('po_erp_uq').on(t.tenantId, t.erpId), index('po_number_idx').on(t.tenantId, t.poNumber), index('po_vendor_idx').on(t.tenantId, t.vendorId, t.acceptance), index('po_supplier_code_idx').on(t.tenantId, t.supplierCode)]);

export const poLines = pgTable('po_lines', {
  id: id(), tenantId: tenantId(),
  poId: text('po_id').notNull().references(() => purchaseOrders.id, { onDelete: 'cascade' }),
  erpId: text('erp_id').notNull(),
  lineNo: integer('line_no').notNull(),
  /** GOODS (has an item code) · SERVICE */
  lineType: text('line_type').notNull().default('GOODS'),
  itemCode: text('item_code'), description: text('description').notNull(),
  uom: text('uom'),
  quantity: qty('quantity').notNull(), unitPrice: qty('unit_price').notNull(), amount: qty('amount').notNull(),
  taxCode: text('tax_code'), taxRate: qty('tax_rate'), hsn: text('hsn'),
  siteId: text('site_id').references(() => sites.id, { onDelete: 'set null' }),
  needByDate: date('need_by_date'), promisedDate: date('promised_date'),
  /** Over-delivery tolerance in % (used by shipment notices). */
  tolerancePct: qty('tolerance_pct'),
  receivedQty: qty('received_qty').notNull().default('0'),
  billedQty: qty('billed_qty').notNull().default('0'),
  status: text('status').notNull().default('OPEN'),
  /** PENDING · ACCEPTED · AUTO_ACCEPTED */
  acceptance: text('acceptance').notNull().default('PENDING'),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  acceptedBy: text('accepted_by'),
  acceptNote: text('accept_note'),
}, (t) => [uniqueIndex('po_lines_erp_uq').on(t.poId, t.erpId), index('po_lines_po_idx').on(t.poId, t.lineNo)]);

/** Goods receipts / service acceptances from the ERP. */
export const poReceipts = pgTable('po_receipts', {
  id: id(), tenantId: tenantId(),
  poId: text('po_id').notNull().references(() => purchaseOrders.id, { onDelete: 'cascade' }),
  lineId: text('line_id').references(() => poLines.id, { onDelete: 'cascade' }),
  erpId: text('erp_id').notNull(),
  receiptNumber: text('receipt_number').notNull(),
  receiptDate: date('receipt_date'),
  quantity: qty('quantity').notNull(),
  /** The shipment notice this receipt was matched to, if any. */
  shipmentId: text('shipment_id'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('po_receipts_uq').on(t.tenantId, t.erpId)]);

/** Outbound messages to the ERP about orders: ACCEPTANCE · ASN · ASN_CANCEL · INVOICE. */
export const poMessages = pgTable('po_messages', {
  id: id(), tenantId: tenantId(),
  poId: text('po_id').references(() => purchaseOrders.id, { onDelete: 'cascade' }),
  /** Award messages (kind AWARD): the sourcing event and the winning supplier, instead of a purchase order. */
  eventId: text('event_id'),
  /** Contract messages (kind CONTRACT): the contract sent to the ERP. */
  contractId: text('contract_id'),
  vendorId: text('vendor_id'),
  kind: text('kind').notNull(),
  connector: text('connector').notNull(),
  /** PENDING · SENT · TEST · FAILED · NO_CONNECTOR */
  status: text('status').notNull().default('PENDING'),
  attempts: integer('attempts').notNull().default(0),
  target: text('target'),
  payload: jsonb('payload'),
  httpStatus: integer('http_status'), response: text('response'), error: text('error'),
  requestedBy: text('requested_by'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('po_messages_po_idx').on(t.poId, t.createdAt), index('po_messages_status_idx').on(t.tenantId, t.status)]);

/** Each inbound import run (API call, CSV upload, Oracle pull, demo load). */
export const poImports = pgTable('po_imports', {
  id: id(), tenantId: tenantId(),
  source: text('source').notNull(),
  requestedBy: text('requested_by').notNull(),
  /** OK · PARTIAL · FAILED */
  status: text('status').notNull(),
  created: integer('created').notNull().default(0), updated: integer('updated').notNull().default(0),
  unchanged: integer('unchanged').notNull().default(0), failed: integer('failed').notNull().default(0),
  unmapped: integer('unmapped').notNull().default(0),
  errors: jsonb('errors').$type<string[]>().notNull().default([]),
  detail: jsonb('detail'),
  createdAt: createdAt(),
}, (t) => [index('po_imports_tenant_idx').on(t.tenantId, t.createdAt)]);

/**
 * Advance shipping notice (ASN) from the supplier against accepted lines. Partial shipments allowed.
 * status: SHIPPED · PARTLY_RECEIVED · RECEIVED · CANCELLED
 */
export const shipments = pgTable('shipments', {
  id: id(), tenantId: tenantId(),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  poId: text('po_id').notNull().references(() => purchaseOrders.id, { onDelete: 'cascade' }),
  /** Our reference (ASN-2026-000123) and the supplier's own delivery note / dispatch number. */
  number: text('number').notNull(),
  supplierRef: text('supplier_ref'),
  status: text('status').notNull().default('SHIPPED'),
  shipDate: date('ship_date').notNull(),
  expectedDate: date('expected_date'),
  carrier: text('carrier'), trackingNo: text('tracking_no'), vehicleNo: text('vehicle_no'),
  /** India: e-way bill number for goods movement. */
  ewayBill: text('eway_bill'),
  packages: integer('packages'),
  notes: text('notes'),
  createdBy: text('created_by').notNull(),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }), cancelReason: text('cancel_reason'),
  /** When the buyer and supplier were reminded that the expected delivery date has passed. */
  overdueNotifiedAt: timestamp('overdue_notified_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('shipments_number_uq').on(t.tenantId, t.number), index('shipments_po_idx').on(t.poId), index('shipments_vendor_idx').on(t.tenantId, t.vendorId, t.createdAt)]);

export const shipmentLines = pgTable('shipment_lines', {
  id: id(), tenantId: tenantId(),
  shipmentId: text('shipment_id').notNull().references(() => shipments.id, { onDelete: 'cascade' }),
  lineId: text('line_id').notNull().references(() => poLines.id, { onDelete: 'cascade' }),
  quantity: qty('quantity').notNull(),
  receivedQty: qty('received_qty').notNull().default('0'),
  batchNo: text('batch_no'),
}, (t) => [index('shipment_lines_shipment_idx').on(t.shipmentId), index('shipment_lines_line_idx').on(t.lineId)]);

/**
 * Supplier invoice raised from a PO (and optionally a shipment), matched against the order, receipts and
 * earlier invoices. status: SUBMITTED · EXCEPTION · APPROVED · REJECTED · CANCELLED · PARTLY_PAID · PAID
 */
export const supplierInvoices = pgTable('supplier_invoices', {
  id: id(), tenantId: tenantId(),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  poId: text('po_id').notNull().references(() => purchaseOrders.id, { onDelete: 'cascade' }),
  shipmentId: text('shipment_id').references(() => shipments.id, { onDelete: 'set null' }),
  invoiceNumber: text('invoice_number').notNull(),
  invoiceDate: date('invoice_date').notNull(),
  currency: text('currency').notNull(),
  subtotal: qty('subtotal').notNull(), taxAmount: qty('tax_amount').notNull(), total: qty('total').notNull(),
  status: text('status').notNull().default('SUBMITTED'),
  /** Match result: problems (blocking) and notes (for the reviewer). */
  checks: jsonb('checks').$type<{ code: string; level: 'error' | 'warning' | 'ok'; message: string }[]>().notNull().default([]),
  /** Country rules (e.g. India e-invoice IRN / signed QR, supplier GSTIN). */
  einvoice: jsonb('einvoice').$type<Record<string, string>>(),
  documentId: text('document_id'),
  notes: text('notes'),
  submittedBy: text('submitted_by').notNull(),
  decidedBy: text('decided_by'), decidedAt: timestamp('decided_at', { withTimezone: true }), decisionNote: text('decision_note'),
  erpInvoiceId: text('erp_invoice_id'),
  paidAmount: qty('paid_amount').notNull().default('0'),
  dueDate: date('due_date'),
  createdAt: createdAt(),
}, (t) => [index('supplier_invoices_number_idx').on(t.tenantId, t.vendorId, t.invoiceNumber), index('supplier_invoices_po_idx').on(t.poId), index('supplier_invoices_status_idx').on(t.tenantId, t.status, t.createdAt)]);

export const supplierInvoiceLines = pgTable('supplier_invoice_lines', {
  id: id(), tenantId: tenantId(),
  invoiceId: text('invoice_id').notNull().references(() => supplierInvoices.id, { onDelete: 'cascade' }),
  lineId: text('line_id').notNull().references(() => poLines.id, { onDelete: 'cascade' }),
  quantity: qty('quantity').notNull(), unitPrice: qty('unit_price').notNull(), amount: qty('amount').notNull(),
  taxRate: qty('tax_rate'), taxAmount: qty('tax_amount').notNull().default('0'),
}, (t) => [index('supplier_invoice_lines_invoice_idx').on(t.invoiceId), index('supplier_invoice_lines_line_idx').on(t.lineId)]);

/** Payments the ERP made to a supplier (remittance advice), allocated to invoices. */
export const supplierPayments = pgTable('supplier_payments', {
  id: id(), tenantId: tenantId(),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  erpId: text('erp_id').notNull(),
  reference: text('reference').notNull(),
  paymentDate: date('payment_date').notNull(),
  method: text('method'),
  currency: text('currency').notNull(),
  amount: qty('amount').notNull(),
  /** Tax deducted at source / withholding, total across the invoices. */
  withheld: qty('withheld').notNull().default('0'),
  notes: text('notes'),
  allocations: jsonb('allocations').$type<{ invoiceId: string | null; invoiceNumber: string; amount: number; withheld?: number }[]>().notNull().default([]),
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('supplier_payments_erp_uq').on(t.tenantId, t.erpId), index('supplier_payments_vendor_idx').on(t.tenantId, t.vendorId, t.paymentDate)]);

/** A buyer's rating of a supplier (1–5 per criterion; a criterion left out is null). Feeds the scorecard. */
export const supplierRatings = pgTable('supplier_ratings', {
  id: id(), tenantId: tenantId(),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  quality: integer('quality'), delivery: integer('delivery'), service: integer('service'), communication: integer('communication'),
  comment: text('comment'),
  ratedById: text('rated_by_id').references(() => users.id, { onDelete: 'set null' }),
  ratedByName: text('rated_by_name').notNull(),
  createdAt: createdAt(),
}, (t) => [index('supplier_ratings_vendor_idx').on(t.tenantId, t.vendorId, t.createdAt)]);

/**
 * Agreements suppliers accept in the portal (code of conduct, NDA, supplier agreement). Each has versions; a
 * supplier accepts a specific version. Required ones must be accepted before submitting for approval.
 */
export const agreements = pgTable('agreements', {
  id: id(), tenantId: tenantId(),
  title: text('title').notNull(),
  titleAr: text('title_ar'),
  /** Which suppliers it applies to: vendor types (empty = all). */
  vendorTypes: text('vendor_types').array().notNull().default([]),
  /** Required before submitting for approval (otherwise offered, optional). */
  required: boolean('required').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  /** ACTIVE · ARCHIVED (no longer asked for; past acceptances kept) */
  status: text('status').notNull().default('ACTIVE'),
  /** onboarding: asked of suppliers during onboarding · sourcing: terms a buyer picks for a sourcing event */
  purpose: text('purpose').notNull().default('onboarding'),
  createdAt: createdAt(),
}, (t) => [index('agreements_tenant_idx').on(t.tenantId, t.status)]);

export const agreementVersions = pgTable('agreement_versions', {
  id: id(), tenantId: tenantId(),
  agreementId: text('agreement_id').notNull().references(() => agreements.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  /** TEXT (written in VendorGate) · PDF (the company's own document) */
  kind: text('kind').notNull(),
  body: text('body'),
  bodyAr: text('body_ar'),
  fileName: text('file_name'), mimeType: text('mime_type'), size: integer('size'),
  storagePath: text('storage_path'), storageDriver: text('storage_driver'),
  /** SHA-256 of the text or file — recorded on each acceptance as evidence of exactly what was accepted. */
  contentHash: text('content_hash').notNull(),
  changeNote: text('change_note'),
  /** Approved suppliers who accepted an earlier version are asked to accept this one. */
  reaccept: boolean('reaccept').notNull().default(false),
  publishedByName: text('published_by_name').notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('agreement_versions_uq').on(t.agreementId, t.version)]);

export const agreementAcceptances = pgTable('agreement_acceptances', {
  id: id(), tenantId: tenantId(),
  agreementId: text('agreement_id').notNull().references(() => agreements.id, { onDelete: 'cascade' }),
  versionId: text('version_id').notNull().references(() => agreementVersions.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  signerName: text('signer_name').notNull(),
  signerDesignation: text('signer_designation').notNull(),
  /** Signed-in email (supplier) — or the buyer's user who recorded a paper signature. */
  signerEmail: text('signer_email'),
  language: text('language'),
  contentHash: text('content_hash').notNull(),
  ip: text('ip'), userAgent: text('user_agent'),
  /** Set when a buyer recorded it from a signed copy (the copy is a document on the supplier). */
  recordedByName: text('recorded_by_name'),
  signedCopyDocumentId: text('signed_copy_document_id'),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('agreement_acceptances_vendor_idx').on(t.vendorId, t.agreementId)]);

/**
 * Questionnaires suppliers answer (ESG, information security, quality, anti-bribery…), targeted by any form
 * answer. Questions live here; a response keeps a copy of the questions it answered (edits only affect new ones).
 * See services/questionnaires.ts.
 */
export const questionnaires = pgTable('questionnaires', {
  id: id(), tenantId: tenantId(),
  title: text('title').notNull(),
  titleAr: text('title_ar'),
  description: text('description'),
  descriptionAr: text('description_ar'),
  /** Which suppliers it applies to (a condition on the form, like "show if"); null = everyone. */
  appliesIf: jsonb('applies_if'),
  /** Must be answered before submitting for approval (otherwise offered). */
  required: boolean('required').notNull().default(true),
  questions: jsonb('questions').notNull().default([]),
  /** Risk bands by score (% of the maximum): at or above `low` = Low risk, at or above `medium` = Medium, below = High. */
  bands: jsonb('bands').notNull().default({ low: 75, medium: 50 }),
  sortOrder: integer('sort_order').notNull().default(0),
  status: text('status').notNull().default('ACTIVE'),
  updatedByName: text('updated_by_name').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
});

/** A supplier's answers to one questionnaire. DRAFT (being answered) · SUBMITTED. Requested ones were sent by a buyer (e.g. yearly). */
export const questionnaireResponses = pgTable('questionnaire_responses', {
  id: id(), tenantId: tenantId(),
  questionnaireId: text('questionnaire_id').notNull().references(() => questionnaires.id, { onDelete: 'cascade' }),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('DRAFT'),
  answers: jsonb('answers').notNull().default({}),
  /** Copy of the questions answered, taken on submit. */
  questions: jsonb('questions'),
  score: integer('score'), maxScore: integer('max_score'), percent: integer('percent'),
  /** LOW · MEDIUM · HIGH risk */
  band: text('band'),
  knockouts: jsonb('knockouts'),
  requestedByName: text('requested_by_name'),
  requestedAt: timestamp('requested_at', { withTimezone: true }),
  dueOn: date('due_on', { mode: 'string' }),
  submittedByName: text('submitted_by_name'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('questionnaire_responses_vendor_idx').on(t.vendorId, t.questionnaireId)]);

/**
 * Pre-review for approvers: what VendorGate found about a submission (missing items, failed checks, documents
 * that disagree with the form, duplicates, risk…) and, when switched on, an AI summary and recommendation.
 * One per review cycle (regenerated on request). Advisory only. See services/preReview.ts.
 */
export const preReviews = pgTable('pre_reviews', {
  id: id(), tenantId: tenantId(),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  cycle: integer('cycle').notNull(),
  /** PENDING · READY · FAILED */
  status: text('status').notNull().default('PENDING'),
  /** 'checks' (VendorGate's own findings only) or the AI provider. */
  provider: text('provider').notNull(),
  live: boolean('live').notNull().default(false),
  result: jsonb('result'),
  /** Fingerprint of what was reviewed — when the supplier's data changes, the pre-review shows as out of date. */
  inputHash: text('input_hash').notNull(),
  /** Exactly what was sent to the AI provider (privacy mode: no names, numbers or free text), for “What the AI saw”. */
  sentToAi: jsonb('sent_to_ai'),
  error: text('error'),
  requestedBy: text('requested_by').notNull(),
  createdAt: createdAt(),
}, (t) => [index('pre_reviews_vendor_idx').on(t.vendorId, t.createdAt)]);

/** Public "Become a supplier" links (website, trade fair, QR code…). Applications from them are screened before an invitation. */
export const registrationLinks = pgTable('registration_links', {
  id: id(), tenantId: tenantId(),
  /** In the public URL /apply/<slug>; random, so links can't be guessed. */
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /** Pre-set vendor type for applicants (null = they choose). */
  vendorType: text('vendor_type'),
  /** Short message shown at the top of the page (optional). */
  intro: text('intro'),
  /** Who is emailed about new applications (comma-separated). */
  notifyEmails: text('notify_emails'),
  active: boolean('active').notNull().default(true),
  createdByName: text('created_by_name').notNull(),
  createdAt: createdAt(),
});

/** An application through a registration link. UNVERIFIED (email not confirmed) · PENDING · ACCEPTED (vendor created and invited) · DECLINED */
export const supplierApplications = pgTable('supplier_applications', {
  id: id(), tenantId: tenantId(),
  linkId: text('link_id').notNull().references(() => registrationLinks.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('UNVERIFIED'),
  companyName: text('company_name').notNull(),
  vendorType: text('vendor_type').notNull(),
  contactFirstName: text('contact_first_name').notNull(),
  contactLastName: text('contact_last_name').notNull(),
  email: text('email').notNull(),
  mobile: text('mobile').notNull(),
  /** The home country's main registration number (GSTIN, CR…), as in the vendor register. */
  registrationId: text('registration_id'),
  website: text('website'),
  supplies: text('supplies'),
  message: text('message'),
  language: text('language'),
  codeHash: text('code_hash'),
  codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }),
  codeAttempts: integer('code_attempts').notNull().default(0),
  ip: text('ip'), userAgent: text('user_agent'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedByName: text('decided_by_name'),
  declineReason: text('decline_reason'),
  vendorId: text('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
}, (t) => [index('supplier_applications_tenant_idx').on(t.tenantId, t.status, t.createdAt)]);

/** "Not a duplicate": a person checked two suppliers that share an identifier and confirmed they are different. Pair stored with vendorA < vendorB. */
export const duplicateDismissals = pgTable('duplicate_dismissals', {
  id: id(), tenantId: tenantId(),
  vendorA: text('vendor_a').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  vendorB: text('vendor_b').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  note: text('note').notNull(),
  byName: text('by_name').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('duplicate_dismissals_pair_uq').on(t.tenantId, t.vendorA, t.vendorB)]);

/** Keys an ERP or middleware uses to call the VendorGate API (stored hashed). */
export const apiKeys = pgTable('api_keys', {
  id: id(), tenantId: tenantId(),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  createdById: text('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type PoLine = typeof poLines.$inferSelect;

/* ---------- Platform (the SaaS operator, above all tenants) ---------- */

/** People who run the platform. Separate from tenant users; 2FA is mandatory. */
export const platformAdmins = pgTable('platform_admins', {
  id: id(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  status: userStatusEnum('status').notNull().default('INVITED'),
  passwordHash: text('password_hash'),
  mfaSecretEnc: text('mfa_secret_enc'),
  mfaEnabled: boolean('mfa_enabled').notNull().default(false),
  mfaRecoveryHashes: jsonb('mfa_recovery_hashes').$type<string[]>().notNull().default([]),
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  /** One live invite / password-reset link at a time (sha256 of the token). */
  tokenHash: text('token_hash'),
  tokenPurpose: text('token_purpose'),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const platformSessions = pgTable('platform_sessions', {
  id: id(),
  tokenHash: text('token_hash').notNull().unique(),
  adminId: text('admin_id').notNull().references(() => platformAdmins.id, { onDelete: 'cascade' }),
  mfaPending: boolean('mfa_pending').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: createdAt(),
});

/** Platform-level audit trail. tenant_id has no foreign key so entries outlive a deleted tenant. */
export const platformAudit = pgTable('platform_audit', {
  id: id(),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  tenantId: text('tenant_id'),
  detail: jsonb('detail'),
  ip: text('ip'),
  createdAt: createdAt(),
}, (t) => [index('platform_audit_created_idx').on(t.createdAt)]);

/** Self-service sign-ups waiting for (or done with) email verification. */
export const signups = pgTable('signups', {
  id: id(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  company: text('company').notNull(),
  slug: text('slug').notNull(),
  /** Home country chosen on the sign-up page (ISO code). */
  country: text('country').notNull().default('IN'),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  tenantId: text('tenant_id'),
  ip: text('ip'),
  createdAt: createdAt(),
}, (t) => [index('signups_email_idx').on(t.email, t.createdAt)]);

/** Single row (id = 'default'). */
export const platformSettings = pgTable('platform_settings', {
  id: text('id').primaryKey().default('default'),
  signupEnabled: boolean('signup_enabled').notNull().default(false),
  signupPlan: text('signup_plan').notNull().default('trial'),
  trialDays: integer('trial_days').notNull().default(14),
  blockFreeEmail: boolean('block_free_email').notNull().default(true),
  notifyEmail: text('notify_email'),
  termsUrl: text('terms_url'),
  billing: jsonb('billing').$type<PlatformBilling>().notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A workspace's own help topics (its approval policy, who to call…), shown in F1 help next to the built-in ones. */
export const helpTopics = pgTable('help_topics', {
  id: id(),
  tenantId: tenantId(),
  title: text('title').notNull(),
  summary: text('summary').notNull().default(''),
  body: text('body').notNull(),
  /** staff | supplier | both */
  audience: text('audience').notNull().default('staff'),
  keywords: text('keywords'),
  updatedBy: text('updated_by'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('help_topics_tenant_idx').on(t.tenantId)]);

/** Questions asked in F1 help (for answering limits and to see what people struggle with). */
export const helpQuestions = pgTable('help_questions', {
  id: id(),
  tenantId: text('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  audience: text('audience').notNull(),
  askedBy: text('asked_by'),
  question: text('question').notNull(),
  answered: boolean('answered').notNull().default(false),
  sources: jsonb('sources').$type<string[]>().notNull().default([]),
  provider: text('provider').notNull(),
  createdAt: createdAt(),
}, (t) => [index('help_questions_tenant_idx').on(t.tenantId, t.createdAt)]);

/** Tax invoices for subscriptions. Amounts in minor units (paise / cents). */
export const invoices = pgTable('invoices', {
  id: id(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  number: text('number').notNull().unique(),
  /** DUE | PAID | VOID */
  status: text('status').notNull().default('DUE'),
  plan: text('plan').notNull(),
  cycle: text('cycle').notNull(),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  currency: text('currency').notNull(),
  lines: jsonb('lines').$type<InvoiceLine[]>().notNull(),
  subtotal: integer('subtotal').notNull(),
  /** INTRA (CGST+SGST) | INTER (IGST) | EXPORT (zero-rated) */
  taxMode: text('tax_mode').notNull(),
  taxRate: integer('tax_rate').notNull().default(0),
  cgst: integer('cgst').notNull().default(0),
  sgst: integer('sgst').notNull().default(0),
  igst: integer('igst').notNull().default(0),
  total: integer('total').notNull(),
  seller: jsonb('seller').$type<InvoiceParty>().notNull(),
  buyer: jsonb('buyer').$type<InvoiceParty>().notNull(),
  /** Activate this plan when paid (upgrade from trial). */
  activatesPlan: boolean('activates_plan').notNull().default(false),
  paymentLinkId: text('payment_link_id'),
  paymentLinkUrl: text('payment_link_url'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  paymentRef: text('payment_ref'),
  paymentMethod: text('payment_method'),
  remindersSent: integer('reminders_sent').notNull().default(0),
  notes: text('notes'),
  createdAt: createdAt(),
}, (t) => [index('invoices_tenant_idx').on(t.tenantId, t.issuedAt)]);

export type Tenant = typeof tenants.$inferSelect;
export type PlatformAdmin = typeof platformAdmins.$inferSelect;
export type PlatformSettings = typeof platformSettings.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type Shipment = typeof shipments.$inferSelect;
export type SupplierInvoice = typeof supplierInvoices.$inferSelect;
export type SupplierPayment = typeof supplierPayments.$inferSelect;
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

/**
 * Corrective actions: what a buyer asks a supplier to fix after a finding (questionnaire knock-out, failed re-check,
 * expired certificate, poor performance…), with a due date. The supplier sends evidence; whoever raised it (or anyone
 * with "actions.manage") accepts or rejects it. Raised during review they are conditions of approval. See
 * services/correctiveActions.ts.
 */
export const correctiveActions = pgTable('corrective_actions', {
  id: id(), tenantId: tenantId(),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  /** HIGH · MEDIUM · LOW */
  priority: text('priority').notNull().default('MEDIUM'),
  dueOn: date('due_on', { mode: 'string' }).notNull(),
  /** OPEN (to do, or evidence rejected) · SUBMITTED (evidence sent) · ACCEPTED (closed) · CANCELLED */
  status: text('status').notNull().default('OPEN'),
  /** What it came from, e.g. "questionnaire:<id>:<question>", "check:gstin", "document:GST_CERT", "scorecard", "manual". */
  source: text('source').notNull().default('manual'),
  sourceLabel: text('source_label'),
  /** Raised while the supplier was under review: a condition of approval. */
  condition: boolean('condition').notNull().default(false),
  raisedById: text('raised_by_id').references(() => users.id),
  raisedByName: text('raised_by_name').notNull(),
  /** The supplier's answer: a note and files (documents kept as attachments). */
  responseNote: text('response_note'),
  evidence: jsonb('evidence').$type<{ documentId: string; fileName: string }[]>().notNull().default([]),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  submittedByName: text('submitted_by_name'),
  reviewedByName: text('reviewed_by_name'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewRemarks: text('review_remarks'),
  remindedAt: timestamp('reminded_at', { withTimezone: true }),
  overdueNotifiedAt: timestamp('overdue_notified_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('corrective_actions_vendor_idx').on(t.vendorId, t.status), index('corrective_actions_tenant_idx').on(t.tenantId, t.status, t.dueOn)]);

/** On-prem installations: the licence issued by Integratatech (one row, id = 'current'). See lib/licence.ts. */
export const systemLicence = pgTable('system_licence', {
  id: text('id').primaryKey(),
  token: text('token').notNull(),
  installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
  installedBy: text('installed_by').notNull(),
  /** Reminder milestones already emailed (e.g. "30", "7", "expired", "readonly"), per licence id. */
  notified: jsonb('notified').$type<Record<string, string[]>>().notNull().default({}),
});

/* ================= Sourcing: RFQs and e-auctions (services/sourcing/) ================= */
/*
 * One event = one RFQ or auction. Lots group lines; bidders are always VendorGate suppliers (outside bidders are
 * created as suppliers through the light bidder form). Sealed offers are encrypted at rest and readable only after
 * opening; live bids are append-only and hash-chained so the bid history can't be changed unnoticed.
 */
export const sourcingEvents = pgTable('sourcing_events', {
  id: id(), tenantId: tenantId(),
  /** e.g. "RFQ-2026-0007", "RA-2026-0012" — unique per workspace. */
  number: text('number').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  /** rfq · reverse · forward · japanese · dutch (lib/features.ts SOURCING_FORMATS) */
  format: text('format').notNull(),
  /** DRAFT · PENDING_APPROVAL · PUBLISHED · BIDDING (sealed bids open) · OPENING · EVALUATION · LIVE · CLOSED · AWARD_PENDING · AWARDED · CANCELLED */
  status: text('status').notNull().default('DRAFT'),
  currency: text('currency').notNull(),
  estimatedValue: numeric('estimated_value', { precision: 18, scale: 2 }),
  categories: jsonb('categories').$type<string[]>().notNull().default([]),
  /** Rules fixed when the event is published (config.resolveRules) — later settings changes don't affect it. */
  rules: jsonb('rules').$type<Record<string, string | number | null>>().notNull().default({}),
  /** Sub-features that were on when the event was published. */
  features: jsonb('features').$type<string[]>().notNull().default([]),
  /** Event terms (an agreement version bidders accept) and the technical questionnaire, when used. */
  termsAgreementId: text('terms_agreement_id'),
  /** Extra terms for this event only, shown under the agreement. */
  termsNote: text('terms_note'),
  /** A template: not an event, copied into new events (number TPL-…). */
  isTemplate: boolean('is_template').notNull().default(false),
  /** The buyer's rule choices while drafting; resolved into `rules` when submitted. */
  ruleChoices: jsonb('rule_choices').$type<Record<string, string | number | null>>().notNull().default({}),
  /** Approval cycles (each submission starts a new one; see services/approvalFlow.ts). */
  approvalCycle: integer('approval_cycle').notNull().default(0),
  /** Technical evaluation (two envelopes): weighted criteria scored 0–10 and the pass mark (%). */
  scoring: jsonb('scoring').$type<{ criteria: { id: string; label: string; weight: number }[]; passMark: number } | null>(),
  /** When each envelope was opened by the committee: { single | technical | commercial: ISO time }. */
  opened: jsonb('opened').$type<Partial<Record<'single' | 'technical' | 'commercial', string>>>().notNull().default({}),
  technicalDoneAt: timestamp('technical_done_at', { withTimezone: true }),
  /** Live auction: when it was paused (null = running); resuming moves liveEndsAt out by the pause. */
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  liveStartedAt: timestamp('live_started_at', { withTimezone: true }),
  /** Reminders already sent to bidders before a live auction ("day", "hour"). */
  reminders: jsonb('reminders').$type<string[]>().notNull().default([]),
  /** Award: the proposal's note, who proposed it, the status to return to if it is sent back, and when it was approved. */
  awardNote: text('award_note'),
  awardProposedById: text('award_proposed_by_id'),
  awardProposedByName: text('award_proposed_by_name'),
  awardFromStatus: text('award_from_status'),
  awardedAt: timestamp('awarded_at', { withTimezone: true }),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  questionnaireId: text('questionnaire_id'),
  /** Schedule. liveEndsAt moves with auto-extensions. */
  bidDeadline: timestamp('bid_deadline', { withTimezone: true }),
  liveStartsAt: timestamp('live_starts_at', { withTimezone: true }),
  liveEndsAt: timestamp('live_ends_at', { withTimezone: true }),
  extensionsUsed: integer('extensions_used').notNull().default(0),
  ownerId: text('owner_id').references(() => users.id),
  createdByName: text('created_by_name').notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  cancelledReason: text('cancelled_reason'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('sourcing_events_number_idx').on(t.tenantId, t.number), index('sourcing_events_status_idx').on(t.tenantId, t.status)]);

export const sourcingLots = pgTable('sourcing_lots', {
  id: id(), tenantId: tenantId(),
  eventId: text('event_id').notNull().references(() => sourcingEvents.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  title: text('title').notNull(),
  /** line: a price per line, the lot total is worked out · lot: one price for the whole lot */
  bidMode: text('bid_mode').notNull().default('lot'),
  startPrice: numeric('start_price', { precision: 18, scale: 2 }),
  reservePrice: numeric('reserve_price', { precision: 18, scale: 2 }),
  /** Best live bid so far (kept with the bid in one transaction). */
  bestAmount: numeric('best_amount', { precision: 18, scale: 2 }),
  bestBidderId: text('best_bidder_id'),
  /** For sequential / staggered lots; null = closes with the event. */
  closesAt: timestamp('closes_at', { withTimezone: true }),
}, (t) => [uniqueIndex('sourcing_lots_pos_idx').on(t.eventId, t.position)]);

export const sourcingLines = pgTable('sourcing_lines', {
  id: id(), tenantId: tenantId(),
  eventId: text('event_id').notNull().references(() => sourcingEvents.id, { onDelete: 'cascade' }),
  lotId: text('lot_id').notNull().references(() => sourcingLots.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  itemCode: text('item_code'),
  description: text('description').notNull(),
  quantity: numeric('quantity', { precision: 18, scale: 3 }).notNull(),
  unit: text('unit').notNull(),
  specification: text('specification'),
  targetPrice: numeric('target_price', { precision: 18, scale: 4 }),
}, (t) => [index('sourcing_lines_lot_idx').on(t.lotId, t.position)]);

export const sourcingBidders = pgTable('sourcing_bidders', {
  id: id(), tenantId: tenantId(),
  eventId: text('event_id').notNull().references(() => sourcingEvents.id, { onDelete: 'cascade' }),
  vendorId: text('vendor_id').notNull().references(() => vendors.id),
  /** Name shown to the buyer side only; other bidders see "Bidder 3". */
  alias: text('alias').notNull(),
  /** INVITED · ACCEPTED · DECLINED · QUALIFIED · DISQUALIFIED · WITHDRAWN */
  status: text('status').notNull().default('INVITED'),
  /** Invited from outside VendorGate (light onboarding). */
  outside: boolean('outside').notNull().default(false),
  invitedAt: timestamp('invited_at', { withTimezone: true }).notNull().defaultNow(),
  invitedByName: text('invited_by_name'),
  /** When the invitation email went (null = picked but not sent yet). */
  sentAt: timestamp('sent_at', { withTimezone: true }),
  declineReason: text('decline_reason'),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
  /** Terms accepted and conflict-of-interest declaration. */
  declaration: jsonb('declaration').$type<{ acceptedTermsVersion?: number; noConflict?: boolean; conflictNote?: string; at: string; by: string }>(),
  technicalScore: numeric('technical_score', { precision: 6, scale: 2 }),
  remarks: text('remarks'),
  /** Why a bidder was qualified or not after the technical evaluation (always set when it differs from the pass mark). */
  qualificationNote: text('qualification_note'),
}, (t) => [uniqueIndex('sourcing_bidders_vendor_idx').on(t.eventId, t.vendorId), index('sourcing_bidders_vendor2_idx').on(t.vendorId)]);

/** Sealed offers (RFQ / first round). The content is encrypted and only shown after opening. */
export const sourcingSubmissions = pgTable('sourcing_submissions', {
  id: id(), tenantId: tenantId(),
  eventId: text('event_id').notNull().references(() => sourcingEvents.id, { onDelete: 'cascade' }),
  bidderId: text('bidder_id').notNull().references(() => sourcingBidders.id, { onDelete: 'cascade' }),
  /** single · technical · commercial */
  envelope: text('envelope').notNull(),
  version: integer('version').notNull().default(1),
  /** Prices per line, terms, answers — encrypted at rest. */
  content: sealedJson<Record<string, unknown>>()('content').notNull(),
  attachments: jsonb('attachments').$type<{ documentId: string; fileName: string }[]>().notNull().default([]),
  /** SHA-256 of the content at submission, shown on the bidder's receipt. */
  contentHash: text('content_hash').notNull(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  submittedByName: text('submitted_by_name').notNull(),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  openedAt: timestamp('opened_at', { withTimezone: true }),
}, (t) => [index('sourcing_submissions_bidder_idx').on(t.bidderId, t.envelope, t.version)]);

/** Live bids: append-only. seq orders bids within an event; hash = sha256(prevHash + bid), so history can be verified. */
export const sourcingBids = pgTable('sourcing_bids', {
  id: id(), tenantId: tenantId(),
  eventId: text('event_id').notNull().references(() => sourcingEvents.id, { onDelete: 'cascade' }),
  lotId: text('lot_id').notNull().references(() => sourcingLots.id, { onDelete: 'cascade' }),
  bidderId: text('bidder_id').notNull().references(() => sourcingBidders.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  lineAmounts: jsonb('line_amounts').$type<Record<string, string>>(),
  placedAt: timestamp('placed_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  prevHash: text('prev_hash').notNull(),
  hash: text('hash').notNull(),
  /** Bidder name as typed by the person placing it (who, at the supplier). */
  placedByName: text('placed_by_name'),
  /** Struck out as an obvious mistake: requested by one person (sourcing.live), confirmed by another. The row stays. */
  strikeRequestedById: text('strike_requested_by_id'),
  strikeRequestedByName: text('strike_requested_by_name'),
  strikeReason: text('strike_reason'),
  invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
  invalidatedReason: text('invalidated_reason'),
  invalidatedByName: text('invalidated_by_name'),
}, (t) => [uniqueIndex('sourcing_bids_seq_idx').on(t.eventId, t.seq), index('sourcing_bids_lot_idx').on(t.lotId, t.amount),
  // Ranking reads each bidder's best valid bid per lot (bestBids in live.ts).
  index('sourcing_bids_best_idx').on(t.eventId, t.lotId, t.bidderId, t.amount, t.placedAt).where(sql`${t.invalidatedAt} is null`)]);

/** The opening committee: each member's confirmation to open an envelope; it opens when the event's quorum is reached. */
export const sourcingOpenings = pgTable('sourcing_openings', {
  id: id(), tenantId: tenantId(),
  eventId: text('event_id').notNull().references(() => sourcingEvents.id, { onDelete: 'cascade' }),
  envelope: text('envelope').notNull(),
  userId: text('user_id').notNull().references(() => users.id),
  userName: text('user_name').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('sourcing_openings_uq').on(t.eventId, t.envelope, t.userId)]);

/** Technical scores: one row per evaluator and bidder, a score 0–10 per criterion. */
export const sourcingScores = pgTable('sourcing_scores', {
  id: id(), tenantId: tenantId(),
  eventId: text('event_id').notNull().references(() => sourcingEvents.id, { onDelete: 'cascade' }),
  bidderId: text('bidder_id').notNull().references(() => sourcingBidders.id, { onDelete: 'cascade' }),
  evaluatorId: text('evaluator_id').notNull().references(() => users.id),
  evaluatorName: text('evaluator_name').notNull(),
  scores: jsonb('scores').$type<Record<string, number>>().notNull(),
  comment: text('comment'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('sourcing_scores_uq').on(t.eventId, t.bidderId, t.evaluatorId)]);

/** Clarifications: a bidder's question (or the buyer's own announcement) and the answer, which goes to every bidder without saying who asked. */
export const sourcingQuestions = pgTable('sourcing_questions', {
  id: id(), tenantId: tenantId(),
  eventId: text('event_id').notNull().references(() => sourcingEvents.id, { onDelete: 'cascade' }),
  /** null = an announcement by the buyer */
  bidderId: text('bidder_id').references(() => sourcingBidders.id, { onDelete: 'cascade' }),
  question: text('question'),
  answer: text('answer'),
  askedByName: text('asked_by_name'),
  answeredByName: text('answered_by_name'),
  /** Set when the answer was shared with every bidder. */
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('sourcing_questions_event_idx').on(t.eventId, t.createdAt)]);

export const sourcingAwards = pgTable('sourcing_awards', {
  id: id(), tenantId: tenantId(),
  eventId: text('event_id').notNull().references(() => sourcingEvents.id, { onDelete: 'cascade' }),
  lotId: text('lot_id').notNull().references(() => sourcingLots.id, { onDelete: 'cascade' }),
  bidderId: text('bidder_id').notNull().references(() => sourcingBidders.id),
  amount: numeric('amount', { precision: 18, scale: 2 }).notNull(),
  /** Share of the lot quantity (100 unless split). The amount is the bidder's price for their share. */
  sharePct: numeric('share_pct', { precision: 5, scale: 2 }).notNull().default('100'),
  /** The bidder's price for the whole lot, its rank when proposed, and unit prices per line (lineId → price). */
  lotPrice: numeric('lot_price', { precision: 18, scale: 2 }),
  rank: integer('rank'),
  unitPrices: jsonb('unit_prices').$type<Record<string, number>>(),
  /** ERP: WAITING_ONBOARDING (new supplier not approved yet) · QUEUED · NOT_SENT (no ERP / switched off) */
  erpStatus: text('erp_status'),
  letterSentAt: timestamp('letter_sent_at', { withTimezone: true }),
  /** PROPOSED · APPROVED · REJECTED */
  status: text('status').notNull().default('PROPOSED'),
  reason: text('reason'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  /** Purchase order / contract reference returned by the ERP. */
  erpReference: text('erp_reference'),
  createdAt: createdAt(),
}, (t) => [index('sourcing_awards_event_idx').on(t.eventId)]);

/**
 * Approval steps for anything that isn't a supplier: sourcing events (and later awards). One generic flow
 * (services/approvalFlow.ts) — levels and rules are configured like the onboarding approval flow.
 */
export const flowSteps = pgTable('flow_steps', {
  id: id(), tenantId: tenantId(),
  /** e.g. sourcing_event */
  subjectType: text('subject_type').notNull(),
  subjectId: text('subject_id').notNull(),
  cycle: integer('cycle').notNull(),
  level: integer('level').notNull(),
  roleId: text('role_id').notNull().references(() => roles.id),
  label: text('label').notNull(),
  status: stepStatusEnum('status').notNull(),
  assigneeUserId: text('assignee_user_id').references(() => users.id),
  slaHours: integer('sla_hours'),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  dueAt: timestamp('due_at', { withTimezone: true }),
  remindedAt: timestamp('reminded_at', { withTimezone: true }),
  remarks: text('remarks'),
  actedById: text('acted_by_id').references(() => users.id),
  actedAt: timestamp('acted_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('flow_steps_subject_idx').on(t.subjectType, t.subjectId, t.cycle), index('flow_steps_pending_idx').on(t.tenantId, t.status, t.roleId)]);
export type FlowStep = typeof flowSteps.$inferSelect;

/* ============================ Contracts (supplier and customer) ============================ */

/**
 * A contract party: a supplier or a customer. Light on purpose — Contracts works without supplier onboarding. When
 * onboarding is on, a supplier party can be linked to its supplier record (vendor_id).
 */
export const parties = pgTable('parties', {
  id: id(), tenantId: tenantId(),
  /** SUPPLIER or CUSTOMER */
  kind: text('kind').notNull(),
  /** e.g. "SUP-00012", "CUS-00003" — unique per workspace. */
  code: text('code').notNull(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  country: text('country').notNull(),
  registrationNo: text('registration_no'),
  taxNo: text('tax_no'),
  address: jsonb('address').$type<{ line1?: string; city?: string; region?: string; postalCode?: string }>().notNull().default({}),
  email: text('email'),
  phone: text('phone'),
  website: text('website'),
  /** People at the party: who to contact and who signs. */
  contacts: jsonb('contacts').$type<{ name: string; email?: string; phone?: string; role?: string; signatory?: boolean }[]>().notNull().default([]),
  vendorId: text('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
  /** ACTIVE or ARCHIVED */
  status: text('status').notNull().default('ACTIVE'),
  notes: text('notes'),
  createdById: text('created_by_id'),
  createdByName: text('created_by_name').notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [uniqueIndex('parties_tenant_code_uq').on(t.tenantId, t.code), index('parties_tenant_kind_idx').on(t.tenantId, t.kind, t.name), index('parties_vendor_idx').on(t.vendorId)]);
export type Party = typeof parties.$inferSelect;

/** A contract with a supplier (BUY) or a customer (SELL). */
export const contracts = pgTable('contracts', {
  id: id(), tenantId: tenantId(),
  /** e.g. "MSA-2026-0004" — per type and year, unique per workspace. */
  number: text('number').notNull(),
  /** The contract's own reference (e.g. from the counterparty or an earlier system). */
  reference: text('reference'),
  title: text('title').notNull(),
  /** BUY (supplier contract) or SELL (customer contract) */
  direction: text('direction').notNull(),
  /** Key in CONTRACT_TYPES (services/contracts/config.ts). */
  type: text('type').notNull(),
  partyId: text('party_id').notNull().references(() => parties.id),
  /** DRAFT · IN_APPROVAL · APPROVED · WITH_PARTY (sent for review) · AGREED · SIGNING · ACTIVE · EXPIRED · TERMINATED */
  status: text('status').notNull().default('DRAFT'),
  /** The template it was drafted from, and the jurisdiction its clauses follow (governing law, disputes, tax). */
  templateId: text('template_id'),
  jurisdiction: text('jurisdiction'),
  /** The drafted wording: each clause with the variant chosen (standard, a fallback or edited). See services/contracts/drafting.ts. */
  draft: jsonb('draft').$type<ContractDraft>(),
  /** An amendment (type 'amendment', parentId = the contract it changes): what it changes when it is signed. */
  amends: jsonb('amends').$type<AmendmentChanges>(),
  /** Renewal and notice alerts already sent (the date each was about), so they go once. */
  alerts: jsonb('alerts').$type<{ expiring?: string; notice?: string }>(),
  value: numeric('value', { precision: 18, scale: 2 }),
  currency: text('currency').notNull(),
  startDate: date('start_date', { mode: 'string' }),
  /** Empty = no fixed end (evergreen). */
  endDate: date('end_date', { mode: 'string' }),
  signedDate: date('signed_date', { mode: 'string' }),
  autoRenew: boolean('auto_renew').notNull().default(false),
  renewalTermMonths: integer('renewal_term_months'),
  noticeDays: integer('notice_days'),
  ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
  /** A statement of work or order under a master agreement. */
  parentId: text('parent_id'),
  /** Created from a sourcing award. */
  sourcingEventId: text('sourcing_event_id'),
  description: text('description'),
  category: text('category'),
  /** MANUAL · IMPORT · AWARD · TEMPLATE */
  source: text('source').notNull().default('MANUAL'),
  terminatedAt: timestamp('terminated_at', { withTimezone: true }),
  terminationReason: text('termination_reason'),
  createdById: text('created_by_id'),
  createdByName: text('created_by_name').notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [uniqueIndex('contracts_tenant_number_uq').on(t.tenantId, t.number), index('contracts_tenant_status_idx').on(t.tenantId, t.status, t.endDate), index('contracts_party_idx').on(t.partyId), index('contracts_parent_idx').on(t.parentId)]);
export type Contract = typeof contracts.$inferSelect;

/** Files on a contract: the signed copy, drafts, annexures. Stored like supplier documents (scanned, random names). */
export const contractFiles = pgTable('contract_files', {
  id: id(), tenantId: tenantId(),
  contractId: text('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  /** SIGNED · DRAFT · ANNEXURE · OTHER */
  kind: text('kind').notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  storagePath: text('storage_path').notNull(),
  storageDriver: text('storage_driver').notNull().default('local'),
  sha256: text('sha256'),
  scanStatus: text('scan_status').notNull().default('SKIPPED'),
  uploadedByName: text('uploaded_by_name').notNull(),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  /** Made by VendorGate from the drafted wording (Word and PDF of the same version). */
  generated: boolean('generated').notNull().default(false),
  version: integer('version'),
}, (t) => [index('contract_files_contract_idx').on(t.contractId)]);
export type ContractFile = typeof contractFiles.$inferSelect;

/** One clause of a drafted contract. `variant`: 'standard', a fallback key, or 'custom' (edited wording). */
export interface DraftClause { clauseId: string; group: string; title: string; variant: string; body: string; required: boolean }
export interface AmendmentChanges { endDate?: string | null; value?: number | null; noticeDays?: number | null; autoRenew?: boolean; renewalTermMonths?: number | null; description?: string | null; appliedAt?: string }
export interface ContractDraft { clauses: DraftClause[]; nonStandard: boolean; fallback: boolean; version: number; generatedVersion?: number; savedAt: string; savedBy: string }

/**
 * Clause library: built-in clauses (India + GCC, seeded per workspace, `builtIn`) and the workspace's own.
 * Clauses with the same `group` are the same clause for different jurisdictions (e.g. governing-law for IN, AE, SA);
 * templates list groups, and a contract picks the clause for its jurisdiction (or 'ALL').
 */
export const contractClauses = pgTable('contract_clauses', {
  id: id(), tenantId: tenantId(),
  group: text('group').notNull(),
  /** IN · AE · SA · ALL */
  jurisdiction: text('jurisdiction').notNull().default('ALL'),
  title: text('title').notNull(),
  /** Area, e.g. Commercial, Legal, Confidentiality. */
  category: text('category').notNull(),
  /** Standard wording with {{merge.fields}}. */
  body: text('body').notNull(),
  /** Pre-approved alternative wordings: [{ key, label, body }]. */
  fallbacks: jsonb('fallbacks').$type<{ key: string; label: string; body: string }[]>().notNull().default([]),
  /** Notes for the person drafting (when to use a fallback, stamp duty…). Not printed. */
  guidance: text('guidance'),
  builtIn: boolean('built_in').notNull().default(false),
  /** ACTIVE · ARCHIVED */
  status: text('status').notNull().default('ACTIVE'),
  updatedByName: text('updated_by_name'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [uniqueIndex('contract_clauses_group_uq').on(t.tenantId, t.group, t.jurisdiction)]);
export type ContractClause = typeof contractClauses.$inferSelect;

/** Contract templates: built from library clauses (CLAUSES) or the workspace's own Word file with merge fields (WORD). */
export const contractTemplates = pgTable('contract_templates', {
  id: id(), tenantId: tenantId(),
  name: text('name').notNull(),
  /** CLAUSES · WORD */
  kind: text('kind').notNull(),
  /** Contract types it is for (keys of CONTRACT_TYPES) and BUY / SELL / BOTH. */
  types: text('types').array().notNull().default(sql`'{}'::text[]`),
  direction: text('direction').notNull().default('BOTH'),
  /** Document heading for CLAUSES templates (merge fields allowed). */
  heading: text('heading'),
  /** Opening paragraph (parties and recitals) for CLAUSES templates. */
  preamble: text('preamble'),
  /** Clause groups in order: [{ group, required }]. A Word template may also print them with {{#clauses}}…{{/clauses}}. */
  sections: jsonb('sections').$type<{ group: string; required: boolean }[]>().notNull().default([]),
  /** WORD: the uploaded file and the merge fields found in it. */
  fileName: text('file_name'), mimeType: text('mime_type'), size: integer('size'), storagePath: text('storage_path'), storageDriver: text('storage_driver'), sha256: text('sha256'),
  fields: text('fields').array().notNull().default(sql`'{}'::text[]`),
  builtIn: boolean('built_in').notNull().default(false),
  /** Built-in templates: their key in library.ts (new built-ins are added to existing workspaces by it). */
  builtInKey: text('built_in_key'),
  /** ACTIVE · ARCHIVED */
  status: text('status').notNull().default('ACTIVE'),
  updatedByName: text('updated_by_name'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => [index('contract_templates_tenant_idx').on(t.tenantId, t.status)]);
export type ContractTemplate = typeof contractTemplates.$inferSelect;

/**
 * People at the other party who may open a contract in the review portal (email link + one-time code), or who
 * sign it. The link token and the session token are stored as SHA-256 only. Onboarded suppliers also see shared
 * contracts in their supplier portal (no reviewer row needed).
 */
export const contractReviewers = pgTable('contract_reviewers', {
  id: id(), tenantId: tenantId(),
  contractId: text('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  linkHash: text('link_hash').notNull().unique(),
  codeHash: text('code_hash'), codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }), codeAttempts: integer('code_attempts').notNull().default(0),
  /** Codes sent and wrong codes, for limits (reset by the hour / day). */
  codesSent: integer('codes_sent').notNull().default(0), codesWindowAt: timestamp('codes_window_at', { withTimezone: true }),
  wrongCodes: integer('wrong_codes').notNull().default(0),
  sessionHash: text('session_hash'), sessionExpiresAt: timestamp('session_expires_at', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('contract_reviewers_contract_idx').on(t.contractId)]);
export type ContractReviewer = typeof contractReviewers.$inferSelect;

/** Each version sent to the other party for review, and their answer. */
export const contractVersions = pgTable('contract_versions', {
  id: id(), tenantId: tenantId(),
  contractId: text('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  number: integer('number').notNull(),
  /** The files sent (contract_files ids). */
  fileIds: text('file_ids').array().notNull().default(sql`'{}'::text[]`),
  note: text('note'),
  sentByName: text('sent_by_name').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  /** OPEN · ACCEPTED · CHANGES_REQUESTED · WITHDRAWN · SUPERSEDED */
  status: text('status').notNull().default('OPEN'),
  response: text('response'),
  respondedByName: text('responded_by_name'),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
}, (t) => [uniqueIndex('contract_versions_uq').on(t.contractId, t.number)]);
export type ContractVersion = typeof contractVersions.$inferSelect;

/** Comments on a contract under review, optionally on one clause and with proposed wording. `internal` = staff only. */
export const contractComments = pgTable('contract_comments', {
  id: id(), tenantId: tenantId(),
  contractId: text('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  versionId: text('version_id'),
  clauseGroup: text('clause_group'),
  /** US · PARTY */
  side: text('side').notNull(),
  authorName: text('author_name').notNull(),
  text: text('text').notNull(),
  proposedText: text('proposed_text'),
  internal: boolean('internal').notNull().default(false),
  /** OPEN · ACCEPTED · DECLINED · RESOLVED */
  status: text('status').notNull().default('OPEN'),
  replyTo: text('reply_to'),
  fileId: text('file_id'),
  createdAt: createdAt(),
}, (t) => [index('contract_comments_contract_idx').on(t.contractId)]);
export type ContractComment = typeof contractComments.$inferSelect;

export interface SignatureSigner { name: string; email: string; side: 'US' | 'PARTY'; order: number; status: 'WAITING' | 'SENT' | 'SIGNED' | 'DECLINED'; signedAt?: string; method?: string;
  /** Link providers: the one-time return code, the provider's process id and where the browser goes afterwards. */
  nonce?: string; processId?: string; processState?: string; returnTo?: string }
/** One request for signature through an e-signature provider (or the built-in test provider). */
export const contractSignatures = pgTable('contract_signatures', {
  id: id(), tenantId: tenantId(),
  contractId: text('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  /** Key in integrations/esign (test · docusign · adobe · zoho · digio · uaepass). */
  provider: text('provider').notNull(),
  externalId: text('external_id'),
  /** SENT · COMPLETED · DECLINED · CANCELLED · EXPIRED · FAILED */
  status: text('status').notNull().default('SENT'),
  signers: jsonb('signers').$type<SignatureSigner[]>().notNull().default([]),
  /** The PDF that was sent and the signed PDF that came back (contract_files ids). */
  documentFileId: text('document_file_id').notNull(),
  signedFileId: text('signed_file_id'),
  /** Status the contract goes back to if this request is cancelled. */
  previousStatus: text('previous_status').notNull(),
  error: text('error'),
  sentByName: text('sent_by_name').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
}, (t) => [index('contract_signatures_contract_idx').on(t.contractId), index('contract_signatures_status_idx').on(t.status)]);
export type ContractSignature = typeof contractSignatures.$inferSelect;

/** What each side has to do under a contract: deliverables, payments, reports, renewals… with owner, due date and reminders. */
export const contractObligations = pgTable('contract_obligations', {
  id: id(), tenantId: tenantId(),
  contractId: text('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  /** DELIVERABLE · PAYMENT · SERVICE_LEVEL · REPORT · COMPLIANCE · OTHER */
  kind: text('kind').notNull(),
  /** Who has to do it: US or PARTY. */
  side: text('side').notNull(),
  ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
  dueDate: date('due_date', { mode: 'string' }).notNull(),
  /** NONE · MONTHLY · QUARTERLY · YEARLY — a done recurring obligation creates the next one. */
  recurrence: text('recurrence').notNull().default('NONE'),
  amount: numeric('amount', { precision: 18, scale: 2 }),
  remindDays: integer('remind_days').notNull().default(7),
  /** OPEN · DONE · MISSED · WAIVED */
  status: text('status').notNull().default('OPEN'),
  note: text('note'),
  doneAt: timestamp('done_at', { withTimezone: true }), doneByName: text('done_by_name'),
  /** Reminder already sent for this due date / overdue notice sent. */
  remindedAt: timestamp('reminded_at', { withTimezone: true }), overdueAt: timestamp('overdue_at', { withTimezone: true }),
  createdByName: text('created_by_name').notNull(),
  createdAt: createdAt(),
}, (t) => [index('contract_obligations_contract_idx').on(t.contractId), index('contract_obligations_due_idx').on(t.tenantId, t.status, t.dueDate)]);
export type ContractObligation = typeof contractObligations.$inferSelect;

/** Agreed prices on a contract (rate contracts, price lists): checked against purchase orders and supplier invoices. */
export const contractPrices = pgTable('contract_prices', {
  id: id(), tenantId: tenantId(),
  contractId: text('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  itemCode: text('item_code'),
  description: text('description').notNull(),
  uom: text('uom'),
  price: numeric('price', { precision: 18, scale: 4 }).notNull(),
  createdAt: createdAt(),
}, (t) => [index('contract_prices_contract_idx').on(t.contractId), index('contract_prices_item_idx').on(t.tenantId, t.itemCode)]);
export type ContractPrice = typeof contractPrices.$inferSelect;

/**
 * An uploaded contract read for its key terms. Names, numbers, amounts and dates are masked locally before any AI
 * sees the text; `sentToAi` is exactly what left the server (shown as "What the AI saw"); suggestions hold real values.
 */
export const contractReadings = pgTable('contract_readings', {
  id: id(), tenantId: tenantId(),
  contractId: text('contract_id').notNull().references(() => contracts.id, { onDelete: 'cascade' }),
  fileId: text('file_id').notNull(),
  /** anthropic · local */
  reader: text('reader').notNull(),
  sentToAi: text('sent_to_ai'),
  suggestions: jsonb('suggestions').$type<{ field: string; value: string | number | boolean; label: string; evidence: string | null }[]>().notNull().default([]),
  notes: jsonb('notes').$type<string[]>().notNull().default([]),
  masked: integer('masked').notNull().default(0),
  appliedFields: text('applied_fields').array().notNull().default(sql`'{}'::text[]`),
  createdByName: text('created_by_name').notNull(),
  createdAt: createdAt(),
}, (t) => [index('contract_readings_contract_idx').on(t.contractId)]);
export type ContractReading = typeof contractReadings.$inferSelect;
