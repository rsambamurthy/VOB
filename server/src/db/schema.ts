import { pgTable, pgEnum, text, integer, boolean, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import crypto from 'node:crypto';

const id = () => text('id').primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const roleEnum = pgEnum('role', ['ADMIN', 'TAX_MANAGER', 'FINANCE_MANAGER', 'MDM_MANAGER']);
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

export type Role = (typeof roleEnum.enumValues)[number];
export type VendorType = (typeof vendorTypeEnum.enumValues)[number];
export type VendorStatus = (typeof vendorStatusEnum.enumValues)[number];

export const users = pgTable('users', {
  id: id(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  role: roleEnum('role').notNull(),
  createdAt: createdAt(),
});

export const vendors = pgTable('vendors', {
  id: id(),
  code: text('code').notNull().unique(),
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
  createdById: text('created_by_id').notNull().references(() => users.id),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
});

export const otpCodes = pgTable('otp_codes', {
  id: id(),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  used: boolean('used').notNull().default(false),
  createdAt: createdAt(),
});

export const documents = pgTable('documents', {
  id: id(),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  docType: text('doc_type').notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  storagePath: text('storage_path').notNull(),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
});

export const approvalSteps = pgTable('approval_steps', {
  id: id(),
  vendorId: text('vendor_id').notNull().references(() => vendors.id, { onDelete: 'cascade' }),
  cycle: integer('cycle').notNull(),
  level: integer('level').notNull(),
  role: roleEnum('role').notNull(),
  label: text('label').notNull(),
  status: stepStatusEnum('status').notNull(),
  remarks: text('remarks'),
  actedById: text('acted_by_id').references(() => users.id),
  actedAt: timestamp('acted_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('approval_steps_vendor_cycle_idx').on(t.vendorId, t.cycle)]);

export const auditLogs = pgTable('audit_logs', {
  id: id(),
  vendorId: text('vendor_id').references(() => vendors.id, { onDelete: 'cascade' }),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  detail: jsonb('detail'),
  createdAt: createdAt(),
});

/** Prototype stand-in for an email provider: every outgoing email is stored here. */
export const emailOutbox = pgTable('email_outbox', {
  id: id(),
  to: text('to').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  link: text('link'),
  createdAt: createdAt(),
});

export const usersRelations = relations(users, ({ many }) => ({ approvals: many(approvalSteps) }));
export const vendorsRelations = relations(vendors, ({ one, many }) => ({
  createdBy: one(users, { fields: [vendors.createdById], references: [users.id] }),
  documents: many(documents),
  steps: many(approvalSteps),
  audit: many(auditLogs),
}));
export const documentsRelations = relations(documents, ({ one }) => ({ vendor: one(vendors, { fields: [documents.vendorId], references: [vendors.id] }) }));
export const stepsRelations = relations(approvalSteps, ({ one }) => ({
  vendor: one(vendors, { fields: [approvalSteps.vendorId], references: [vendors.id] }),
  actedBy: one(users, { fields: [approvalSteps.actedById], references: [users.id] }),
}));
export const auditRelations = relations(auditLogs, ({ one }) => ({ vendor: one(vendors, { fields: [auditLogs.vendorId], references: [vendors.id] }) }));

export type User = typeof users.$inferSelect;
export type Vendor = typeof vendors.$inferSelect;
