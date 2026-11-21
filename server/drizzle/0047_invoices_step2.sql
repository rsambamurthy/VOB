CREATE TABLE "invoice_mails" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"message_id" text NOT NULL,
	"via" text NOT NULL,
	"from_address" text,
	"from_name" text,
	"subject" text,
	"received_at" timestamp with time zone NOT NULL,
	"party_id" text,
	"status" text NOT NULL,
	"reason" text,
	"invoice_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"to_address" text,
	"body" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flow_steps" ADD COLUMN "forwarded_by_id" text;--> statement-breakpoint
ALTER TABLE "flow_steps" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "mail_id" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "duplicate_cleared" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_mails" ADD CONSTRAINT "invoice_mails_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_mails" ADD CONSTRAINT "invoice_mails_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_mails_uq" ON "invoice_mails" USING btree ("tenant_id","message_id");--> statement-breakpoint
CREATE INDEX "invoice_mails_tenant_idx" ON "invoice_mails" USING btree ("tenant_id","received_at");--> statement-breakpoint
ALTER TABLE "flow_steps" ADD CONSTRAINT "flow_steps_forwarded_by_id_users_id_fk" FOREIGN KEY ("forwarded_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_invoices_date_idx" ON "supplier_invoices" USING btree ("tenant_id","kind","invoice_date");--> statement-breakpoint
CREATE INDEX "supplier_invoices_file_idx" ON "supplier_invoices" USING btree ("tenant_id",("file"->>'sha256'));--> statement-breakpoint
CREATE INDEX "supplier_invoices_irn_idx" ON "supplier_invoices" USING btree ("tenant_id",lower("einvoice"->>'irn'));