ALTER TABLE "change_requests" ADD COLUMN "raised_by_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "uploaded_by_id" text;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_raised_by_id_users_id_fk" FOREIGN KEY ("raised_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Existing workspaces: give the new "propose changes" permission to Administrators and Master Data Managers.
UPDATE "roles" SET "permissions" = "permissions" || '["vendors.edit"]'::jsonb WHERE "key" IN ('ADMIN', 'MDM_MANAGER') AND NOT ("permissions" ? 'vendors.edit');
