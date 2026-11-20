CREATE TABLE "sourcing_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"event_id" text NOT NULL,
	"bidder_id" text,
	"question" text,
	"answer" text,
	"asked_by_name" text,
	"answered_by_name" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sourcing_bidders" ADD COLUMN "invited_by_name" text;--> statement-breakpoint
ALTER TABLE "sourcing_bidders" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sourcing_bidders" ADD COLUMN "decline_reason" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "bidder_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "bidder_registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sourcing_questions" ADD CONSTRAINT "sourcing_questions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_questions" ADD CONSTRAINT "sourcing_questions_event_id_sourcing_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."sourcing_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_questions" ADD CONSTRAINT "sourcing_questions_bidder_id_sourcing_bidders_id_fk" FOREIGN KEY ("bidder_id") REFERENCES "public"."sourcing_bidders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sourcing_questions_event_idx" ON "sourcing_questions" USING btree ("event_id","created_at");