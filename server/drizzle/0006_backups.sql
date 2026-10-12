CREATE TABLE "system_backups" (
	"id" text PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"storage_driver" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
