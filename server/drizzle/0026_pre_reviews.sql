CREATE TABLE "pre_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"cycle" integer NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"provider" text NOT NULL,
	"live" boolean DEFAULT false NOT NULL,
	"result" jsonb,
	"input_hash" text NOT NULL,
	"error" text,
	"requested_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pre_reviews" ADD CONSTRAINT "pre_reviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pre_reviews" ADD CONSTRAINT "pre_reviews_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pre_reviews_vendor_idx" ON "pre_reviews" USING btree ("vendor_id","created_at");