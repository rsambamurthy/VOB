CREATE TABLE "agreement_acceptances" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"agreement_id" text NOT NULL,
	"version_id" text NOT NULL,
	"version" integer NOT NULL,
	"vendor_id" text NOT NULL,
	"signer_name" text NOT NULL,
	"signer_designation" text NOT NULL,
	"signer_email" text,
	"language" text,
	"content_hash" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"recorded_by_name" text,
	"signed_copy_document_id" text,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agreement_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"agreement_id" text NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"body" text,
	"body_ar" text,
	"file_name" text,
	"mime_type" text,
	"size" integer,
	"storage_path" text,
	"storage_driver" text,
	"content_hash" text NOT NULL,
	"change_note" text,
	"reaccept" boolean DEFAULT false NOT NULL,
	"published_by_name" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agreements" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"title" text NOT NULL,
	"title_ar" text,
	"vendor_types" text[] DEFAULT '{}' NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agreement_acceptances" ADD CONSTRAINT "agreement_acceptances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_acceptances" ADD CONSTRAINT "agreement_acceptances_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_acceptances" ADD CONSTRAINT "agreement_acceptances_version_id_agreement_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."agreement_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_acceptances" ADD CONSTRAINT "agreement_acceptances_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_versions" ADD CONSTRAINT "agreement_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreement_versions" ADD CONSTRAINT "agreement_versions_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agreement_acceptances_vendor_idx" ON "agreement_acceptances" USING btree ("vendor_id","agreement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agreement_versions_uq" ON "agreement_versions" USING btree ("agreement_id","version");--> statement-breakpoint
CREATE INDEX "agreements_tenant_idx" ON "agreements" USING btree ("tenant_id","status");