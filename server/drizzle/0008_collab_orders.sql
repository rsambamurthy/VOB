CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_by_id" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "buying_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"auto_accept_days" integer,
	"asn_required" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "po_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"source" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" text NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"unchanged" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"unmapped" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "po_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"po_id" text NOT NULL,
	"erp_id" text NOT NULL,
	"line_no" integer NOT NULL,
	"line_type" text DEFAULT 'GOODS' NOT NULL,
	"item_code" text,
	"description" text NOT NULL,
	"uom" text,
	"quantity" numeric(18, 4) NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"tax_code" text,
	"tax_rate" numeric(18, 4),
	"hsn" text,
	"site_id" text,
	"need_by_date" date,
	"promised_date" date,
	"tolerance_pct" numeric(18, 4),
	"received_qty" numeric(18, 4) DEFAULT '0' NOT NULL,
	"billed_qty" numeric(18, 4) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"acceptance" text DEFAULT 'PENDING' NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" text,
	"accept_note" text
);
--> statement-breakpoint
CREATE TABLE "po_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"po_id" text NOT NULL,
	"kind" text NOT NULL,
	"connector" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"target" text,
	"payload" jsonb,
	"http_status" integer,
	"response" text,
	"error" text,
	"requested_by" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "po_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"po_id" text NOT NULL,
	"line_id" text,
	"erp_id" text NOT NULL,
	"receipt_number" text NOT NULL,
	"receipt_date" date,
	"quantity" numeric(18, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"erp_id" text NOT NULL,
	"po_number" text NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"vendor_id" text,
	"supplier_code" text NOT NULL,
	"supplier_site_code" text,
	"entity_id" text,
	"buying_group_id" text,
	"buyer_name" text,
	"buyer_email" text,
	"po_type" text,
	"currency" text DEFAULT 'INR' NOT NULL,
	"po_date" date,
	"payment_terms" text,
	"incoterms" text,
	"total" numeric(18, 4),
	"status" text DEFAULT 'OPEN' NOT NULL,
	"acceptance" text DEFAULT 'PENDING' NOT NULL,
	"accept_due_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"notes" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reminded_at" timestamp with time zone,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"entity_id" text,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "otp_codes" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "buying_groups" ADD CONSTRAINT "buying_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_imports" ADD CONSTRAINT "po_imports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_lines" ADD CONSTRAINT "po_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_lines" ADD CONSTRAINT "po_lines_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_lines" ADD CONSTRAINT "po_lines_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_messages" ADD CONSTRAINT "po_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_messages" ADD CONSTRAINT "po_messages_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_receipts" ADD CONSTRAINT "po_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_receipts" ADD CONSTRAINT "po_receipts_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_receipts" ADD CONSTRAINT "po_receipts_line_id_po_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."po_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_entity_id_legal_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_buying_group_id_buying_groups_id_fk" FOREIGN KEY ("buying_group_id") REFERENCES "public"."buying_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_entity_id_legal_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_codes" ADD CONSTRAINT "supplier_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_codes" ADD CONSTRAINT "supplier_codes_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_contacts" ADD CONSTRAINT "supplier_contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_contacts" ADD CONSTRAINT "supplier_contacts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "buying_groups_code_uq" ON "buying_groups" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_entities_code_uq" ON "legal_entities" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "po_imports_tenant_idx" ON "po_imports" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "po_lines_erp_uq" ON "po_lines" USING btree ("po_id","erp_id");--> statement-breakpoint
CREATE INDEX "po_lines_po_idx" ON "po_lines" USING btree ("po_id","line_no");--> statement-breakpoint
CREATE INDEX "po_messages_po_idx" ON "po_messages" USING btree ("po_id","created_at");--> statement-breakpoint
CREATE INDEX "po_messages_status_idx" ON "po_messages" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "po_receipts_uq" ON "po_receipts" USING btree ("tenant_id","erp_id");--> statement-breakpoint
CREATE UNIQUE INDEX "po_erp_uq" ON "purchase_orders" USING btree ("tenant_id","erp_id");--> statement-breakpoint
CREATE INDEX "po_number_idx" ON "purchase_orders" USING btree ("tenant_id","po_number");--> statement-breakpoint
CREATE INDEX "po_vendor_idx" ON "purchase_orders" USING btree ("tenant_id","vendor_id","acceptance");--> statement-breakpoint
CREATE INDEX "po_supplier_code_idx" ON "purchase_orders" USING btree ("tenant_id","supplier_code");--> statement-breakpoint
CREATE UNIQUE INDEX "sites_code_uq" ON "sites" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_codes_uq" ON "supplier_codes" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_contacts_uq" ON "supplier_contacts" USING btree ("vendor_id","email");--> statement-breakpoint
CREATE INDEX "supplier_contacts_email_idx" ON "supplier_contacts" USING btree ("tenant_id","email");