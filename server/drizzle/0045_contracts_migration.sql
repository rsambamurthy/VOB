CREATE TABLE "contract_inbox" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"storage_path" text NOT NULL,
	"storage_driver" text DEFAULT 'local' NOT NULL,
	"sha256" text,
	"scan_status" text DEFAULT 'SKIPPED' NOT NULL,
	"reason" text NOT NULL,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"uploaded_by_name" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contract_inbox" ADD CONSTRAINT "contract_inbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_inbox_tenant_idx" ON "contract_inbox" USING btree ("tenant_id","uploaded_at");