ALTER TABLE "vendors" ADD COLUMN "consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "consent_version" integer;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "consent_ip" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "erasure_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "erasure_reason" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "erased_at" timestamp with time zone;