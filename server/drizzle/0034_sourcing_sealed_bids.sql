CREATE TABLE "sourcing_openings" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"event_id" text NOT NULL,
	"envelope" text NOT NULL,
	"user_id" text NOT NULL,
	"user_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sourcing_scores" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"event_id" text NOT NULL,
	"bidder_id" text NOT NULL,
	"evaluator_id" text NOT NULL,
	"evaluator_name" text NOT NULL,
	"scores" jsonb NOT NULL,
	"comment" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sourcing_bidders" ADD COLUMN "qualification_note" text;--> statement-breakpoint
ALTER TABLE "sourcing_events" ADD COLUMN "scoring" jsonb;--> statement-breakpoint
ALTER TABLE "sourcing_events" ADD COLUMN "opened" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sourcing_events" ADD COLUMN "technical_done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sourcing_openings" ADD CONSTRAINT "sourcing_openings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_openings" ADD CONSTRAINT "sourcing_openings_event_id_sourcing_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."sourcing_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_openings" ADD CONSTRAINT "sourcing_openings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_scores" ADD CONSTRAINT "sourcing_scores_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_scores" ADD CONSTRAINT "sourcing_scores_event_id_sourcing_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."sourcing_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_scores" ADD CONSTRAINT "sourcing_scores_bidder_id_sourcing_bidders_id_fk" FOREIGN KEY ("bidder_id") REFERENCES "public"."sourcing_bidders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_scores" ADD CONSTRAINT "sourcing_scores_evaluator_id_users_id_fk" FOREIGN KEY ("evaluator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sourcing_openings_uq" ON "sourcing_openings" USING btree ("event_id","envelope","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sourcing_scores_uq" ON "sourcing_scores" USING btree ("event_id","bidder_id","evaluator_id");