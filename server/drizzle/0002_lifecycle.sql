CREATE TABLE "change_request_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"change_request_id" text NOT NULL,
	"level" integer NOT NULL,
	"role_id" text NOT NULL,
	"label" text NOT NULL,
	"status" "step_status" NOT NULL,
	"assignee_user_id" text,
	"remarks" text,
	"acted_by_id" text,
	"acted_at" timestamp with time zone,
	"sla_hours" integer,
	"activated_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"sensitive" boolean DEFAULT false NOT NULL,
	"remarks" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "status" text DEFAULT 'ACTIVE' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "expires_on" date;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "expiry_notified" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "change_request_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "blocked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "blocked_by_id" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "next_review_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "last_review_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "review_status" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "last_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "change_request_steps" ADD CONSTRAINT "change_request_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_request_steps" ADD CONSTRAINT "change_request_steps_change_request_id_change_requests_id_fk" FOREIGN KEY ("change_request_id") REFERENCES "public"."change_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_request_steps" ADD CONSTRAINT "change_request_steps_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_request_steps" ADD CONSTRAINT "change_request_steps_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_request_steps" ADD CONSTRAINT "change_request_steps_acted_by_id_users_id_fk" FOREIGN KEY ("acted_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cr_steps_pending_idx" ON "change_request_steps" USING btree ("tenant_id","status","role_id");--> statement-breakpoint
CREATE INDEX "change_requests_vendor_idx" ON "change_requests" USING btree ("vendor_id","status");--> statement-breakpoint
CREATE INDEX "change_requests_tenant_idx" ON "change_requests" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_blocked_by_id_users_id_fk" FOREIGN KEY ("blocked_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;