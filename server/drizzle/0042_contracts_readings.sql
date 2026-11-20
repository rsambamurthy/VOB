CREATE TABLE "contract_readings" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"file_id" text NOT NULL,
	"reader" text NOT NULL,
	"sent_to_ai" text,
	"suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"masked" integer DEFAULT 0 NOT NULL,
	"applied_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contract_readings" ADD CONSTRAINT "contract_readings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_readings" ADD CONSTRAINT "contract_readings_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_readings_contract_idx" ON "contract_readings" USING btree ("contract_id");