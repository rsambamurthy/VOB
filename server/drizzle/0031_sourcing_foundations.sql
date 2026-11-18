CREATE TABLE "sourcing_awards" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"event_id" text NOT NULL,
	"lot_id" text NOT NULL,
	"bidder_id" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"share_pct" numeric(5, 2) DEFAULT '100' NOT NULL,
	"status" text DEFAULT 'PROPOSED' NOT NULL,
	"reason" text,
	"approved_at" timestamp with time zone,
	"erp_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sourcing_bidders" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"event_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"alias" text NOT NULL,
	"status" text DEFAULT 'INVITED' NOT NULL,
	"outside" boolean DEFAULT false NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"declaration" jsonb,
	"technical_score" numeric(6, 2),
	"remarks" text
);
--> statement-breakpoint
CREATE TABLE "sourcing_bids" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"event_id" text NOT NULL,
	"lot_id" text NOT NULL,
	"bidder_id" text NOT NULL,
	"seq" integer NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"line_amounts" jsonb,
	"placed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	"invalidated_at" timestamp with time zone,
	"invalidated_reason" text
);
--> statement-breakpoint
CREATE TABLE "sourcing_events" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"number" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"format" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"currency" text NOT NULL,
	"estimated_value" numeric(18, 2),
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"terms_agreement_id" text,
	"questionnaire_id" text,
	"bid_deadline" timestamp with time zone,
	"live_starts_at" timestamp with time zone,
	"live_ends_at" timestamp with time zone,
	"extensions_used" integer DEFAULT 0 NOT NULL,
	"owner_id" text,
	"created_by_name" text NOT NULL,
	"published_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sourcing_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"event_id" text NOT NULL,
	"lot_id" text NOT NULL,
	"position" integer NOT NULL,
	"item_code" text,
	"description" text NOT NULL,
	"quantity" numeric(18, 3) NOT NULL,
	"unit" text NOT NULL,
	"specification" text,
	"target_price" numeric(18, 4)
);
--> statement-breakpoint
CREATE TABLE "sourcing_lots" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"event_id" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"bid_mode" text DEFAULT 'lot' NOT NULL,
	"start_price" numeric(18, 2),
	"reserve_price" numeric(18, 2),
	"best_amount" numeric(18, 2),
	"best_bidder_id" text,
	"closes_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sourcing_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"event_id" text NOT NULL,
	"bidder_id" text NOT NULL,
	"envelope" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"content" jsonb NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_by_name" text NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"opened_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sourcing_awards" ADD CONSTRAINT "sourcing_awards_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_awards" ADD CONSTRAINT "sourcing_awards_event_id_sourcing_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."sourcing_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_awards" ADD CONSTRAINT "sourcing_awards_lot_id_sourcing_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."sourcing_lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_awards" ADD CONSTRAINT "sourcing_awards_bidder_id_sourcing_bidders_id_fk" FOREIGN KEY ("bidder_id") REFERENCES "public"."sourcing_bidders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_bidders" ADD CONSTRAINT "sourcing_bidders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_bidders" ADD CONSTRAINT "sourcing_bidders_event_id_sourcing_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."sourcing_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_bidders" ADD CONSTRAINT "sourcing_bidders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_bids" ADD CONSTRAINT "sourcing_bids_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_bids" ADD CONSTRAINT "sourcing_bids_event_id_sourcing_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."sourcing_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_bids" ADD CONSTRAINT "sourcing_bids_lot_id_sourcing_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."sourcing_lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_bids" ADD CONSTRAINT "sourcing_bids_bidder_id_sourcing_bidders_id_fk" FOREIGN KEY ("bidder_id") REFERENCES "public"."sourcing_bidders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_events" ADD CONSTRAINT "sourcing_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_events" ADD CONSTRAINT "sourcing_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_lines" ADD CONSTRAINT "sourcing_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_lines" ADD CONSTRAINT "sourcing_lines_event_id_sourcing_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."sourcing_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_lines" ADD CONSTRAINT "sourcing_lines_lot_id_sourcing_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."sourcing_lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_lots" ADD CONSTRAINT "sourcing_lots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_lots" ADD CONSTRAINT "sourcing_lots_event_id_sourcing_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."sourcing_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_submissions" ADD CONSTRAINT "sourcing_submissions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_submissions" ADD CONSTRAINT "sourcing_submissions_event_id_sourcing_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."sourcing_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sourcing_submissions" ADD CONSTRAINT "sourcing_submissions_bidder_id_sourcing_bidders_id_fk" FOREIGN KEY ("bidder_id") REFERENCES "public"."sourcing_bidders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sourcing_awards_event_idx" ON "sourcing_awards" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sourcing_bidders_vendor_idx" ON "sourcing_bidders" USING btree ("event_id","vendor_id");--> statement-breakpoint
CREATE INDEX "sourcing_bidders_vendor2_idx" ON "sourcing_bidders" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sourcing_bids_seq_idx" ON "sourcing_bids" USING btree ("event_id","seq");--> statement-breakpoint
CREATE INDEX "sourcing_bids_lot_idx" ON "sourcing_bids" USING btree ("lot_id","amount");--> statement-breakpoint
CREATE UNIQUE INDEX "sourcing_events_number_idx" ON "sourcing_events" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "sourcing_events_status_idx" ON "sourcing_events" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "sourcing_lines_lot_idx" ON "sourcing_lines" USING btree ("lot_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "sourcing_lots_pos_idx" ON "sourcing_lots" USING btree ("event_id","position");--> statement-breakpoint
CREATE INDEX "sourcing_submissions_bidder_idx" ON "sourcing_submissions" USING btree ("bidder_id","envelope","version");