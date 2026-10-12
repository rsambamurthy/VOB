ALTER TABLE "signups" ADD COLUMN "country" text DEFAULT 'IN' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "block_source" text;