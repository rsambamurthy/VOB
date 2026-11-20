ALTER TABLE "po_messages" ALTER COLUMN "po_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "po_messages" ADD COLUMN "event_id" text;--> statement-breakpoint
ALTER TABLE "po_messages" ADD COLUMN "vendor_id" text;--> statement-breakpoint
ALTER TABLE "sourcing_awards" ADD COLUMN "lot_price" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "sourcing_awards" ADD COLUMN "rank" integer;--> statement-breakpoint
ALTER TABLE "sourcing_awards" ADD COLUMN "unit_prices" jsonb;--> statement-breakpoint
ALTER TABLE "sourcing_awards" ADD COLUMN "erp_status" text;--> statement-breakpoint
ALTER TABLE "sourcing_awards" ADD COLUMN "letter_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sourcing_events" ADD COLUMN "award_note" text;--> statement-breakpoint
ALTER TABLE "sourcing_events" ADD COLUMN "award_proposed_by_id" text;--> statement-breakpoint
ALTER TABLE "sourcing_events" ADD COLUMN "award_proposed_by_name" text;--> statement-breakpoint
ALTER TABLE "sourcing_events" ADD COLUMN "award_from_status" text;--> statement-breakpoint
ALTER TABLE "sourcing_events" ADD COLUMN "awarded_at" timestamp with time zone;