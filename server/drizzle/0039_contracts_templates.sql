CREATE TABLE "contract_clauses" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"group" text NOT NULL,
	"jurisdiction" text DEFAULT 'ALL' NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"body" text NOT NULL,
	"fallbacks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"guidance" text,
	"built_in" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"updated_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"types" text[] DEFAULT '{}'::text[] NOT NULL,
	"direction" text DEFAULT 'BOTH' NOT NULL,
	"heading" text,
	"preamble" text,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"file_name" text,
	"mime_type" text,
	"size" integer,
	"storage_path" text,
	"storage_driver" text,
	"sha256" text,
	"fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"built_in" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"updated_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contract_files" ADD COLUMN "generated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contract_files" ADD COLUMN "version" integer;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "template_id" text;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "jurisdiction" text;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "draft" jsonb;--> statement-breakpoint
ALTER TABLE "contract_clauses" ADD CONSTRAINT "contract_clauses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_templates" ADD CONSTRAINT "contract_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contract_clauses_group_uq" ON "contract_clauses" USING btree ("tenant_id","group","jurisdiction");--> statement-breakpoint
CREATE INDEX "contract_templates_tenant_idx" ON "contract_templates" USING btree ("tenant_id","status");