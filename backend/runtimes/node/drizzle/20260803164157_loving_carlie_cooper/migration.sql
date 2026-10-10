CREATE TABLE "capability_credentials" (
	"workspace_id" text PRIMARY KEY,
	"credentials" text NOT NULL,
	"summary" text DEFAULT '[]' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
