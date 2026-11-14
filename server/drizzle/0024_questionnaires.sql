CREATE TABLE "questionnaire_responses" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"questionnaire_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"questions" jsonb,
	"score" integer,
	"max_score" integer,
	"percent" integer,
	"band" text,
	"knockouts" jsonb,
	"requested_by_name" text,
	"requested_at" timestamp with time zone,
	"due_on" date,
	"submitted_by_name" text,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questionnaires" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"title" text NOT NULL,
	"title_ar" text,
	"description" text,
	"description_ar" text,
	"applies_if" jsonb,
	"required" boolean DEFAULT true NOT NULL,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bands" jsonb DEFAULT '{"low":75,"medium":50}'::jsonb NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"updated_by_name" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "questionnaire_responses" ADD CONSTRAINT "questionnaire_responses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_responses" ADD CONSTRAINT "questionnaire_responses_questionnaire_id_questionnaires_id_fk" FOREIGN KEY ("questionnaire_id") REFERENCES "public"."questionnaires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaire_responses" ADD CONSTRAINT "questionnaire_responses_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questionnaires" ADD CONSTRAINT "questionnaires_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "questionnaire_responses_vendor_idx" ON "questionnaire_responses" USING btree ("vendor_id","questionnaire_id");