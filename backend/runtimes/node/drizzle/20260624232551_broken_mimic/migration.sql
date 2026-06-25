CREATE TABLE "observability_connections" (
	"workspace_id" text PRIMARY KEY,
	"provider" text NOT NULL,
	"credentials" text NOT NULL,
	"summary" text DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
