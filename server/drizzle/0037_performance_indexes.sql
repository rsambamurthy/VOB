CREATE INDEX "audit_vendor_idx" ON "audit_logs" USING btree ("vendor_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_event_idx" ON "audit_logs" USING btree (("detail"->>'eventId'));--> statement-breakpoint
CREATE INDEX "audit_subject_idx" ON "audit_logs" USING btree (("detail"->>'subjectId'));--> statement-breakpoint
CREATE INDEX "documents_vendor_idx" ON "documents" USING btree ("vendor_id","status");--> statement-breakpoint
CREATE INDEX "sourcing_bids_best_idx" ON "sourcing_bids" USING btree ("event_id","lot_id","bidder_id","amount","placed_at") WHERE "sourcing_bids"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "vendors_tenant_updated_idx" ON "vendors" USING btree ("tenant_id","updated_at");