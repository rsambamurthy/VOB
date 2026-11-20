CREATE TABLE "contract_obligations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"side" text NOT NULL,
	"owner_id" text,
	"due_date" date NOT NULL,
	"recurrence" text DEFAULT 'NONE' NOT NULL,
	"amount" numeric(18, 2),
	"remind_days" integer DEFAULT 7 NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"note" text,
	"done_at" timestamp with time zone,
	"done_by_name" text,
	"reminded_at" timestamp with time zone,
	"overdue_at" timestamp with time zone,
	"created_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_prices" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"item_code" text,
	"description" text NOT NULL,
	"uom" text,
	"price" numeric(18, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contract_templates" ADD COLUMN "built_in_key" text;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "amends" jsonb;--> statement-breakpoint
ALTER TABLE "contracts" ADD COLUMN "alerts" jsonb;--> statement-breakpoint
ALTER TABLE "po_messages" ADD COLUMN "contract_id" text;--> statement-breakpoint
ALTER TABLE "contract_obligations" ADD CONSTRAINT "contract_obligations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_obligations" ADD CONSTRAINT "contract_obligations_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_obligations" ADD CONSTRAINT "contract_obligations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_prices" ADD CONSTRAINT "contract_prices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_prices" ADD CONSTRAINT "contract_prices_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_obligations_contract_idx" ON "contract_obligations" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "contract_obligations_due_idx" ON "contract_obligations" USING btree ("tenant_id","status","due_date");--> statement-breakpoint
CREATE INDEX "contract_prices_contract_idx" ON "contract_prices" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "contract_prices_item_idx" ON "contract_prices" USING btree ("tenant_id","item_code");--> statement-breakpoint
UPDATE "contract_templates" SET "built_in_key" = CASE "name" WHEN 'Mutual non-disclosure agreement' THEN 'nda' WHEN 'Service / maintenance agreement (AMC)' THEN 'service' WHEN 'Supply / rate contract' THEN 'supply' WHEN 'Master services agreement' THEN 'msa' WHEN 'Sales agreement' THEN 'sales' END WHERE "built_in" = true AND "built_in_key" IS NULL;
