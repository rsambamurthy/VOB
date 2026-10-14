CREATE TABLE "shipment_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"shipment_id" text NOT NULL,
	"line_id" text NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"received_qty" numeric(18, 4) DEFAULT '0' NOT NULL,
	"batch_no" text
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"po_id" text NOT NULL,
	"number" text NOT NULL,
	"supplier_ref" text,
	"status" text DEFAULT 'SHIPPED' NOT NULL,
	"ship_date" date NOT NULL,
	"expected_date" date,
	"carrier" text,
	"tracking_no" text,
	"vehicle_no" text,
	"eway_bill" text,
	"packages" integer,
	"notes" text,
	"created_by" text NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_invoice_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"line_id" text NOT NULL,
	"quantity" numeric(18, 4) NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"tax_rate" numeric(18, 4),
	"tax_amount" numeric(18, 4) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"po_id" text NOT NULL,
	"shipment_id" text,
	"invoice_number" text NOT NULL,
	"invoice_date" date NOT NULL,
	"currency" text NOT NULL,
	"subtotal" numeric(18, 4) NOT NULL,
	"tax_amount" numeric(18, 4) NOT NULL,
	"total" numeric(18, 4) NOT NULL,
	"status" text DEFAULT 'SUBMITTED' NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"einvoice" jsonb,
	"document_id" text,
	"notes" text,
	"submitted_by" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"erp_invoice_id" text,
	"paid_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"due_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"vendor_id" text NOT NULL,
	"erp_id" text NOT NULL,
	"reference" text NOT NULL,
	"payment_date" date NOT NULL,
	"method" text,
	"currency" text NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"withheld" numeric(18, 4) DEFAULT '0' NOT NULL,
	"notes" text,
	"allocations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "po_receipts" ADD COLUMN "shipment_id" text;--> statement-breakpoint
ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_line_id_po_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."po_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_invoice_id_supplier_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."supplier_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoice_lines" ADD CONSTRAINT "supplier_invoice_lines_line_id_po_lines_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."po_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD CONSTRAINT "supplier_invoices_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipment_lines_shipment_idx" ON "shipment_lines" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "shipment_lines_line_idx" ON "shipment_lines" USING btree ("line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_number_uq" ON "shipments" USING btree ("tenant_id","number");--> statement-breakpoint
CREATE INDEX "shipments_po_idx" ON "shipments" USING btree ("po_id");--> statement-breakpoint
CREATE INDEX "shipments_vendor_idx" ON "shipments" USING btree ("tenant_id","vendor_id","created_at");--> statement-breakpoint
CREATE INDEX "supplier_invoice_lines_invoice_idx" ON "supplier_invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "supplier_invoice_lines_line_idx" ON "supplier_invoice_lines" USING btree ("line_id");--> statement-breakpoint
CREATE INDEX "supplier_invoices_number_idx" ON "supplier_invoices" USING btree ("tenant_id","vendor_id","invoice_number");--> statement-breakpoint
CREATE INDEX "supplier_invoices_po_idx" ON "supplier_invoices" USING btree ("po_id");--> statement-breakpoint
CREATE INDEX "supplier_invoices_status_idx" ON "supplier_invoices" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_payments_erp_uq" ON "supplier_payments" USING btree ("tenant_id","erp_id");--> statement-breakpoint
CREATE INDEX "supplier_payments_vendor_idx" ON "supplier_payments" USING btree ("tenant_id","vendor_id","payment_date");