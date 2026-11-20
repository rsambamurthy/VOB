CREATE TABLE "flow_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"cycle" integer NOT NULL,
	"level" integer NOT NULL,
	"role_id" text NOT NULL,
	"label" text NOT NULL,
	"status" "step_status" NOT NULL,
	"assignee_user_id" text,
	"sla_hours" integer,
	"activated_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"remarks" text,
	"acted_by_id" text,
	"acted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agreements" ADD COLUMN "purpose" text DEFAULT 'onboarding' NOT NULL;--> statement-breakpoint
ALTER TABLE "sourcing_events" ADD COLUMN "terms_note" text;--> statement-breakpoint
ALTER TABLE "sourcing_events" ADD COLUMN "is_template" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sourcing_events" ADD COLUMN "rule_choices" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sourcing_events" ADD COLUMN "approval_cycle" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sourcing_events" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sourcing_events" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "flow_steps" ADD CONSTRAINT "flow_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_steps" ADD CONSTRAINT "flow_steps_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_steps" ADD CONSTRAINT "flow_steps_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_steps" ADD CONSTRAINT "flow_steps_acted_by_id_users_id_fk" FOREIGN KEY ("acted_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flow_steps_subject_idx" ON "flow_steps" USING btree ("subject_type","subject_id","cycle");--> statement-breakpoint
CREATE INDEX "flow_steps_pending_idx" ON "flow_steps" USING btree ("tenant_id","status","role_id");