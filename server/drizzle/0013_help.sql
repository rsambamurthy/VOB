CREATE TABLE "help_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text,
	"audience" text NOT NULL,
	"asked_by" text,
	"question" text NOT NULL,
	"answered" boolean DEFAULT false NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "help_topics" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"audience" text DEFAULT 'staff' NOT NULL,
	"keywords" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "help_questions" ADD CONSTRAINT "help_questions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_topics" ADD CONSTRAINT "help_topics_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "help_questions_tenant_idx" ON "help_questions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "help_topics_tenant_idx" ON "help_topics" USING btree ("tenant_id");