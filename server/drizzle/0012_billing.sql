CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"number" text NOT NULL,
	"status" text DEFAULT 'DUE' NOT NULL,
	"plan" text NOT NULL,
	"cycle" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"lines" jsonb NOT NULL,
	"subtotal" integer NOT NULL,
	"tax_mode" text NOT NULL,
	"tax_rate" integer DEFAULT 0 NOT NULL,
	"cgst" integer DEFAULT 0 NOT NULL,
	"sgst" integer DEFAULT 0 NOT NULL,
	"igst" integer DEFAULT 0 NOT NULL,
	"total" integer NOT NULL,
	"seller" jsonb NOT NULL,
	"buyer" jsonb NOT NULL,
	"activates_plan" boolean DEFAULT false NOT NULL,
	"payment_link_id" text,
	"payment_link_url" text,
	"paid_at" timestamp with time zone,
	"payment_ref" text,
	"payment_method" text,
	"reminders_sent" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "platform_settings" ADD COLUMN "billing" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "billing" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_tenant_idx" ON "invoices" USING btree ("tenant_id","issued_at");