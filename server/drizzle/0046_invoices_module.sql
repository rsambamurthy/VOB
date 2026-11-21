CREATE TABLE "invoice_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"parent" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"usable" boolean DEFAULT true NOT NULL,
	"owner_id" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ALTER COLUMN "line_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ALTER COLUMN "vendor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ALTER COLUMN "po_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_payments" ALTER COLUMN "vendor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD COLUMN "attachments" jsonb;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "ap" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD COLUMN "line_no" integer;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD COLUMN "item_code" text;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD COLUMN "uom" text;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD COLUMN "hsn" text;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD COLUMN "gl_account" text;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD COLUMN "cost_centre" text;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD COLUMN "project" text;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD COLUMN "task" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "party_id" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "contract_id" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "kind" text DEFAULT 'INVOICE' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "related_invoice_id" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "source" text DEFAULT 'PORTAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "entity_code" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "gl_date" date;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "created_by_id" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "file" jsonb;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "erp_status" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "erp_error" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "erp_holds" jsonb;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "erp_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "emailed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD COLUMN "party_id" text;--> statement-breakpoint
ALTER TABLE "invoice_codes" ADD CONSTRAINT "invoice_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_codes" ADD CONSTRAINT "invoice_codes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_codes_uq" ON "invoice_codes" USING btree ("tenant_id","kind","code");--> statement-breakpoint
CREATE INDEX "invoice_codes_kind_idx" ON "invoice_codes" USING btree ("tenant_id","kind","enabled");--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_invoices_party_idx" ON "supplier_invoices" USING btree ("tenant_id","party_id","invoice_number");--> statement-breakpoint
CREATE INDEX "supplier_invoices_erp_idx" ON "supplier_invoices" USING btree ("tenant_id","erp_status");--> statement-breakpoint
CREATE INDEX "supplier_invoices_related_idx" ON "supplier_invoices" USING btree ("related_invoice_id");--> statement-breakpoint
UPDATE "supplier_invoice_lines" l SET "line_no" = x.rn FROM (SELECT sil.id, row_number() OVER (PARTITION BY sil.invoice_id ORDER BY pl.line_no, sil.id) rn FROM "supplier_invoice_lines" sil LEFT JOIN "po_lines" pl ON pl.id = sil.line_id) x WHERE x.id = l.id AND l."line_no" IS NULL;
