CREATE TYPE "public"."delivery_status" AS ENUM('TEST', 'QUEUED', 'SENT', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."extraction_status" AS ENUM('PENDING', 'DONE', 'FAILED', 'SKIPPED');--> statement-breakpoint
CREATE TABLE "document_extractions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"document_id" text NOT NULL,
	"status" "extraction_status" DEFAULT 'PENDING' NOT NULL,
	"provider" text NOT NULL,
	"test" boolean DEFAULT false NOT NULL,
	"doc_type_detected" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"error" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sms_log" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"to" text NOT NULL,
	"body" text NOT NULL,
	"purpose" text NOT NULL,
	"status" "delivery_status" NOT NULL,
	"provider" text NOT NULL,
	"provider_message_id" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"kind" text NOT NULL,
	"input_hash" text NOT NULL,
	"input_masked" text NOT NULL,
	"status" text NOT NULL,
	"provider" text NOT NULL,
	"test" boolean DEFAULT false NOT NULL,
	"message" text NOT NULL,
	"name_on_record" text,
	"name_match" integer,
	"data" jsonb,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "storage_driver" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "sha256" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "scan_status" text DEFAULT 'SKIPPED' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "status" "delivery_status" DEFAULT 'TEST' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "provider" text DEFAULT 'test' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_extractions" ADD CONSTRAINT "document_extractions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_log" ADD CONSTRAINT "sms_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verifications" ADD CONSTRAINT "verifications_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extractions_vendor_idx" ON "document_extractions" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "verifications_vendor_idx" ON "verifications" USING btree ("vendor_id","kind","created_at");