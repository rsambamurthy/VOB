CREATE TABLE "duplicate_dismissals" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"vendor_a" text NOT NULL,
	"vendor_b" text NOT NULL,
	"note" text NOT NULL,
	"by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "identity_keys" text[];--> statement-breakpoint
ALTER TABLE "duplicate_dismissals" ADD CONSTRAINT "duplicate_dismissals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_dismissals" ADD CONSTRAINT "duplicate_dismissals_vendor_a_vendors_id_fk" FOREIGN KEY ("vendor_a") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_dismissals" ADD CONSTRAINT "duplicate_dismissals_vendor_b_vendors_id_fk" FOREIGN KEY ("vendor_b") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "duplicate_dismissals_pair_uq" ON "duplicate_dismissals" USING btree ("tenant_id","vendor_a","vendor_b");--> statement-breakpoint
CREATE INDEX "vendors_identity_keys_idx" ON "vendors" USING gin ("identity_keys");