CREATE TABLE "public_api_keys" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"label" text NOT NULL,
	"secret_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint,
	"revoked_at" bigint
);
--> statement-breakpoint
ALTER TABLE "blocks" ADD COLUMN "internal" integer;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN "public" integer;--> statement-breakpoint
CREATE INDEX "idx_public_api_keys_workspace" ON "public_api_keys" ("workspace_id");