CREATE TABLE "corrective_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"priority" text DEFAULT 'MEDIUM' NOT NULL,
	"due_on" date NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_label" text,
	"condition" boolean DEFAULT false NOT NULL,
	"raised_by_id" text,
	"raised_by_name" text NOT NULL,
	"response_note" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone,
	"submitted_by_name" text,
	"reviewed_by_name" text,
	"reviewed_at" timestamp with time zone,
	"review_remarks" text,
	"reminded_at" timestamp with time zone,
	"overdue_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "corrective_actions" ADD CONSTRAINT "corrective_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrective_actions" ADD CONSTRAINT "corrective_actions_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrective_actions" ADD CONSTRAINT "corrective_actions_raised_by_id_users_id_fk" FOREIGN KEY ("raised_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "corrective_actions_vendor_idx" ON "corrective_actions" USING btree ("vendor_id","status");--> statement-breakpoint
CREATE INDEX "corrective_actions_tenant_idx" ON "corrective_actions" USING btree ("tenant_id","status","due_on");