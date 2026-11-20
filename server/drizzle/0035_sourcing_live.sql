ALTER TABLE "sourcing_bids" ADD COLUMN "placed_by_name" text;--> statement-breakpoint
ALTER TABLE "sourcing_bids" ADD COLUMN "strike_requested_by_id" text;--> statement-breakpoint
ALTER TABLE "sourcing_bids" ADD COLUMN "strike_requested_by_name" text;--> statement-breakpoint
ALTER TABLE "sourcing_bids" ADD COLUMN "strike_reason" text;--> statement-breakpoint
ALTER TABLE "sourcing_bids" ADD COLUMN "invalidated_by_name" text;--> statement-breakpoint
ALTER TABLE "sourcing_events" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sourcing_events" ADD COLUMN "live_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sourcing_events" ADD COLUMN "reminders" jsonb DEFAULT '[]'::jsonb NOT NULL;