CREATE TABLE "system_licence" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"installed_by" text NOT NULL,
	"notified" jsonb DEFAULT '{}'::jsonb NOT NULL
);
