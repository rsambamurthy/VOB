CREATE TABLE "erp_connections" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'none' NOT NULL,
	"test_mode" boolean DEFAULT true NOT NULL,
	"auto_push" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets_enc" text,
	"updated_by_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "erp_syncs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"event" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"target" text,
	"request" jsonb,
	"http_status" integer,
	"response" text,
	"error" text,
	"erp_vendor_id" text,
	"requested_by" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "erp_vendor_id" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "erp_sync_status" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "erp_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "erp_connections" ADD CONSTRAINT "erp_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_connections" ADD CONSTRAINT "erp_connections_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_syncs" ADD CONSTRAINT "erp_syncs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erp_syncs" ADD CONSTRAINT "erp_syncs_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "erp_syncs_vendor_idx" ON "erp_syncs" USING btree ("vendor_id","created_at");--> statement-breakpoint
CREATE INDEX "erp_syncs_tenant_status_idx" ON "erp_syncs" USING btree ("tenant_id","status");--> statement-breakpoint
-- Master Data Managers can now see dashboards and reports.
UPDATE "roles" SET "permissions" = "permissions" || '["reports.view"]'::jsonb WHERE "key" = 'MDM_MANAGER' AND NOT ("permissions" ? 'reports.view');
