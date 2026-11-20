CREATE TABLE "contract_files" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"storage_path" text NOT NULL,
	"storage_driver" text DEFAULT 'local' NOT NULL,
	"sha256" text,
	"scan_status" text DEFAULT 'SKIPPED' NOT NULL,
	"uploaded_by_name" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"number" text NOT NULL,
	"reference" text,
	"title" text NOT NULL,
	"direction" text NOT NULL,
	"type" text NOT NULL,
	"party_id" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"value" numeric(18, 2),
	"currency" text NOT NULL,
	"start_date" date,
	"end_date" date,
	"signed_date" date,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"renewal_term_months" integer,
	"notice_days" integer,
	"owner_id" text,
	"parent_id" text,
	"sourcing_event_id" text,
	"description" text,
	"category" text,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"terminated_at" timestamp with time zone,
	"termination_reason" text,
	"created_by_id" text,
	"created_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "parties" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"country" text NOT NULL,
	"registration_no" text,
	"tax_no" text,
	"address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"email" text,
	"phone" text,
	"website" text,
	"contacts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vendor_id" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"notes" text,
	"created_by_id" text,
	"created_by_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contract_files" ADD CONSTRAINT "contract_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_files" ADD CONSTRAINT "contract_files_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_files_contract_idx" ON "contract_files" USING btree ("contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_tenant_number_uq" ON "contracts" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "contracts_tenant_status_idx" ON "contracts" USING btree ("tenant_id","status","end_date");--> statement-breakpoint
CREATE INDEX "contracts_party_idx" ON "contracts" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "contracts_parent_idx" ON "contracts" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "parties_tenant_code_uq" ON "parties" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "parties_tenant_kind_idx" ON "parties" USING btree ("tenant_id","kind","name");--> statement-breakpoint
CREATE INDEX "parties_vendor_idx" ON "parties" USING btree ("vendor_id");