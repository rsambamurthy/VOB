CREATE TABLE "contract_suggestions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"action" text,
	"note" text,
	"snooze_until" date,
	"decided_by_name" text,
	"decided_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contract_suggestions" ADD CONSTRAINT "contract_suggestions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_suggestions" ADD CONSTRAINT "contract_suggestions_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contract_suggestions_uq" ON "contract_suggestions" USING btree ("contract_id","kind","key");--> statement-breakpoint
CREATE INDEX "contract_suggestions_open_idx" ON "contract_suggestions" USING btree ("tenant_id","status","severity");