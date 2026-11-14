CREATE TABLE "registration_links" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"vendor_type" text,
	"intro" text,
	"notify_emails" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registration_links_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "supplier_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"link_id" text NOT NULL,
	"status" text DEFAULT 'UNVERIFIED' NOT NULL,
	"company_name" text NOT NULL,
	"vendor_type" text NOT NULL,
	"contact_first_name" text NOT NULL,
	"contact_last_name" text NOT NULL,
	"email" text NOT NULL,
	"mobile" text NOT NULL,
	"registration_id" text,
	"website" text,
	"supplies" text,
	"message" text,
	"language" text,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"code_attempts" integer DEFAULT 0 NOT NULL,
	"ip" text,
	"user_agent" text,
	"verified_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by_name" text,
	"decline_reason" text,
	"vendor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "registration_links" ADD CONSTRAINT "registration_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_applications" ADD CONSTRAINT "supplier_applications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_applications" ADD CONSTRAINT "supplier_applications_link_id_registration_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."registration_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_applications" ADD CONSTRAINT "supplier_applications_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_applications_tenant_idx" ON "supplier_applications" USING btree ("tenant_id","status","created_at");