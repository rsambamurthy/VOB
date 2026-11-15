ALTER TABLE "vendors" ADD COLUMN "risk_score" integer;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "risk_band" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "risk_signals" jsonb;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "risk_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "last_monitored_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "vendors_tenant_risk_idx" ON "vendors" USING btree ("tenant_id","risk_score");