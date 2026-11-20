ALTER TABLE "contract_suggestions" ADD COLUMN "pack" jsonb;--> statement-breakpoint
ALTER TABLE "contract_suggestions" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "contract_suggestions" ADD COLUMN "summary_by" text;--> statement-breakpoint
ALTER TABLE "contract_suggestions" ADD COLUMN "sent_to_ai" text;--> statement-breakpoint
ALTER TABLE "contract_suggestions" ADD COLUMN "pack_at" timestamp with time zone;