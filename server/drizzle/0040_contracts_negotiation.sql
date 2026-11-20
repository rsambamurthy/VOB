CREATE TABLE "contract_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"version_id" text,
	"clause_group" text,
	"side" text NOT NULL,
	"author_name" text NOT NULL,
	"text" text NOT NULL,
	"proposed_text" text,
	"internal" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"reply_to" text,
	"file_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_reviewers" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"link_hash" text NOT NULL,
	"code_hash" text,
	"code_expires_at" timestamp with time zone,
	"code_attempts" integer DEFAULT 0 NOT NULL,
	"codes_sent" integer DEFAULT 0 NOT NULL,
	"codes_window_at" timestamp with time zone,
	"wrong_codes" integer DEFAULT 0 NOT NULL,
	"session_hash" text,
	"session_expires_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_reviewers_link_hash_unique" UNIQUE("link_hash")
);
--> statement-breakpoint
CREATE TABLE "contract_signatures" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text,
	"status" text DEFAULT 'SENT' NOT NULL,
	"signers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"document_file_id" text NOT NULL,
	"signed_file_id" text,
	"previous_status" text NOT NULL,
	"error" text,
	"sent_by_name" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contract_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"number" integer NOT NULL,
	"file_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"note" text,
	"sent_by_name" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"response" text,
	"responded_by_name" text,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "contract_comments" ADD CONSTRAINT "contract_comments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_comments" ADD CONSTRAINT "contract_comments_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_reviewers" ADD CONSTRAINT "contract_reviewers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_reviewers" ADD CONSTRAINT "contract_reviewers_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_signatures" ADD CONSTRAINT "contract_signatures_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_signatures" ADD CONSTRAINT "contract_signatures_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_versions" ADD CONSTRAINT "contract_versions_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_comments_contract_idx" ON "contract_comments" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "contract_reviewers_contract_idx" ON "contract_reviewers" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "contract_signatures_contract_idx" ON "contract_signatures" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "contract_signatures_status_idx" ON "contract_signatures" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_versions_uq" ON "contract_versions" USING btree ("contract_id","number");