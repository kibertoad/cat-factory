CREATE TABLE "package_registry_connections" (
	"workspace_id" text PRIMARY KEY,
	"entries" text NOT NULL,
	"summary" text DEFAULT '[]' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
